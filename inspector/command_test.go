// Copyright 2026 The A2A Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package inspector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2aclient"
	"github.com/a2aproject/a2a-inspector/internal/server"
	"github.com/spf13/pflag"
)

// syncBuffer is a bytes.Buffer safe for the concurrent writes of a running command.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type running struct {
	stdout, stderr *syncBuffer
	opened         chan string
	cancel         context.CancelFunc
	// done is closed when the command returns; err is its result.
	done chan struct{}
	err  error
}

func start(t *testing.T, args ...string) *running {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	r := &running{stdout: &syncBuffer{}, stderr: &syncBuffer{}, opened: make(chan string, 1), done: make(chan struct{}), cancel: cancel}
	cmd := newCommand(Options{}, r.stdout, r.stderr, func(url string) error {
		r.opened <- url
		return nil
	})
	cmd.SetArgs(args)
	go func() {
		r.err = cmd.ExecuteContext(ctx)
		close(r.done)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-r.done:
		case <-time.After(5 * time.Second):
			t.Error("the inspector didn't stop")
		}
	})
	return r
}

var urlRE = regexp.MustCompile(`running at (http://\S+)`)

// waitForURL returns the URL the inspector printed.
func (r *running) waitForURL(t *testing.T) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if m := urlRE.FindStringSubmatch(r.stdout.String()); m != nil {
			return m[1]
		}
		select {
		case <-r.done:
			t.Fatalf("the inspector exited: %v (stderr %q)", r.err, r.stderr.String())
		case <-time.After(10 * time.Millisecond):
		}
	}
	t.Fatalf("no URL printed; stdout %q", r.stdout.String())
	return ""
}

func TestRun(t *testing.T) {
	r := start(t, "--port", "0", "-a", "localhost:9999", "--webhook-url", "https://tunnel.example.com/")
	startURL := r.waitForURL(t)
	if !strings.HasPrefix(startURL, "http://127.0.0.1:") || !strings.Contains(startURL, "/?token=") {
		t.Fatalf("URL = %q", startURL)
	}
	select {
	case opened := <-r.opened:
		if opened != startURL {
			t.Errorf("opened %q, want %q", opened, startURL)
		}
	case <-time.After(time.Second):
		t.Error("the browser wasn't opened")
	}

	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(startURL)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusSeeOther || len(resp.Cookies()) != 1 {
		t.Fatalf("GET start URL = %d with cookies %v", resp.StatusCode, resp.Cookies())
	}

	base := strings.SplitN(startURL, "/?", 2)[0]
	req, _ := http.NewRequest(http.MethodGet, base+"/api/config", nil)
	req.AddCookie(resp.Cookies()[0])
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var config struct {
		AgentCardURL          string `json:"agentCardUrl"`
		WebhookBaseURL        string `json:"webhookBaseUrl"`
		DefaultWebhookBaseURL string `json:"defaultWebhookBaseUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&config); err != nil {
		t.Fatal(err)
	}
	if config.AgentCardURL != "http://localhost:9999/.well-known/agent-card.json" {
		t.Errorf("agentCardUrl = %q", config.AgentCardURL)
	}
	if config.WebhookBaseURL != "https://tunnel.example.com" || config.DefaultWebhookBaseURL != base {
		t.Errorf("webhookBaseUrl = %q, defaultWebhookBaseUrl = %q, want the flag and %q", config.WebhookBaseURL, config.DefaultWebhookBaseURL, base)
	}

	resp, err = client.Get(base + "/")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
		t.Errorf("GET / = %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}

	r.cancel()
	select {
	case <-r.done:
		if r.err != nil {
			t.Errorf("run() after cancel = %v, want nil", r.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the inspector didn't stop")
	}
}

func TestStopWithIdleConnection(t *testing.T) {
	r := start(t, "--port", "0", "--no-open")
	u, err := url.Parse(r.waitForURL(t))
	if err != nil {
		t.Fatal(err)
	}
	// A connection that never sends a request, like a browser's preconnect.
	conn, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	time.Sleep(100 * time.Millisecond)

	r.cancel()
	select {
	case <-r.done:
		if r.err != nil {
			t.Errorf("run() after cancel = %v, want nil", r.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the inspector didn't stop")
	}
}

func TestNoOpen(t *testing.T) {
	r := start(t, "--port", "0", "--no-open")
	r.waitForURL(t)
	select {
	case opened := <-r.opened:
		t.Errorf("opened %q with --no-open", opened)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestPortInUse(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	port := ln.Addr().(*net.TCPAddr).Port

	cmd := newCommand(Options{}, &syncBuffer{}, &syncBuffer{}, func(string) error { return nil })
	cmd.SetArgs([]string{"--port", strconv.Itoa(port)})
	err = cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "already in use") || !strings.Contains(err.Error(), "--port") {
		t.Errorf("Execute() = %v, want a port-in-use error suggesting --port", err)
	}
}

func TestFlagErrors(t *testing.T) {
	for _, args := range [][]string{{"-a", "./card.json"}, {"unexpected"}} {
		cmd := newCommand(Options{}, &syncBuffer{}, &syncBuffer{}, func(string) error { return nil })
		cmd.SetArgs(args)
		if err := cmd.Execute(); err == nil {
			t.Errorf("Execute(%v) succeeded", args)
		}
	}
}

func TestDefaults(t *testing.T) {
	cmd := newCommand(Options{}, &syncBuffer{}, &syncBuffer{}, nil)
	for flag, want := range map[string]string{"port": "8080", "host": "127.0.0.1", "no-open": "false", "agent-card": "", "webhook-url": ""} {
		if got := cmd.Flags().Lookup(flag).DefValue; got != want {
			t.Errorf("--%s default = %q, want %q", flag, got, want)
		}
	}
	if cmd.Flags().ShorthandLookup("a").Name != "agent-card" {
		t.Error("-a isn't --agent-card")
	}
}

func TestNetworkWarning(t *testing.T) {
	r := start(t, "--host", "0.0.0.0", "--port", "0", "--no-open")
	if u := r.waitForURL(t); !strings.HasPrefix(u, "http://127.0.0.1:") {
		t.Errorf("URL = %q, want the loopback address", u)
	}
	if !strings.Contains(r.stderr.String(), "Warning: listening on 0.0.0.0") {
		t.Errorf("stderr = %q, want a warning", r.stderr.String())
	}
}

func TestStartURL(t *testing.T) {
	tests := []struct {
		host string
		want string
	}{
		{"127.0.0.1", "http://127.0.0.1:8080/?token=t"},
		{"localhost", "http://localhost:8080/?token=t"},
		{"::1", "http://[::1]:8080/?token=t"},
		{"0.0.0.0", "http://127.0.0.1:8080/?token=t"},
		{"::", "http://127.0.0.1:8080/?token=t"},
	}
	for _, tc := range tests {
		if got := startURL(tc.host, 8080, "t"); got != tc.want {
			t.Errorf("startURL(%q) = %q, want %q", tc.host, got, tc.want)
		}
	}
}

func TestServerOptions(t *testing.T) {
	custom := Transport{
		Protocol: "CUSTOM",
		Factory: a2aclient.TransportFactoryFn(func(context.Context, *a2a.AgentCard, *a2a.AgentInterface) (a2aclient.Transport, error) {
			return nil, errors.New("not in tests")
		}),
	}
	opts := Options{Transports: []Transport{custom}}
	tests := []struct {
		name    string
		flags   flags
		wantErr string
		check   func(t *testing.T, so server.Options)
	}{
		{name: "endpoint", flags: flags{endpoint: "localhost:9000", transports: []string{"grpc"}, a2aVersion: "0.3"}, check: func(t *testing.T, so server.Options) {
			if e := so.Endpoint; e == nil || e.URL != "localhost:9000" || e.ProtocolBinding != "GRPC" || e.ProtocolVersion != "0.3" {
				t.Errorf("endpoint = %+v", e)
			}
		}},
		{name: "endpoint defaults to 1.0", flags: flags{endpoint: "http://a", transports: []string{"rest"}}, check: func(t *testing.T, so server.Options) {
			if e := so.Endpoint; e.ProtocolBinding != "HTTP+JSON" || e.ProtocolVersion != "1.0" {
				t.Errorf("endpoint = %+v", e)
			}
		}},
		{name: "custom transport", flags: flags{endpoint: "custom://agent", transports: []string{"custom"}}, check: func(t *testing.T, so server.Options) {
			if so.Endpoint.ProtocolBinding != "CUSTOM" || len(so.Transports) != 1 {
				t.Errorf("endpoint = %+v, transports = %+v", so.Endpoint, so.Transports)
			}
		}},
		{name: "card with preferences and headers", flags: flags{agentCard: "localhost:9999", transports: []string{"grpc", "jsonrpc"}, auth: "Bearer t", svcParams: []string{"X-Tenant=acme", "X-Api-Key:k"}}, check: func(t *testing.T, so server.Options) {
			if so.AgentCardURL != "http://localhost:9999/.well-known/agent-card.json" || !slices.Equal(so.Preferences.Bindings, []string{"GRPC", "JSONRPC"}) {
				t.Errorf("options = %+v", so)
			}
			want := []server.StartupHeader{{Name: "X-Tenant", Value: "acme"}, {Name: "X-Api-Key", Value: "k", Secret: true}, {Name: "Authorization", Value: "Bearer t", Secret: true}}
			if !slices.Equal(so.StartupHeaders, want) {
				t.Errorf("headers = %+v, want %+v", so.StartupHeaders, want)
			}
		}},
		{name: "endpoint and card", flags: flags{agentCard: "a", endpoint: "b", transports: []string{"rest"}}, wantErr: "mutually exclusive"},
		{name: "endpoint without transport", flags: flags{endpoint: "http://a"}, wantErr: "exactly one --transport"},
		{name: "endpoint with two transports", flags: flags{endpoint: "http://a", transports: []string{"rest", "grpc"}}, wantErr: "exactly one --transport"},
		{name: "unknown transport", flags: flags{endpoint: "http://a", transports: []string{"carrier-pigeon"}}, wantErr: "unknown transport"},
		{name: "unknown version", flags: flags{endpoint: "http://a", transports: []string{"rest"}, a2aVersion: "2"}, wantErr: "--a2a-version"},
		{name: "custom transport without v0.3", flags: flags{endpoint: "custom://agent", transports: []string{"custom"}, a2aVersion: "0.3"}, wantErr: "doesn't support version 0.3"},
		{name: "transport without agent", flags: flags{transports: []string{"rest"}}, wantErr: "need --agent-card or --endpoint"},
		{name: "auth without agent", flags: flags{auth: "Bearer t"}, wantErr: "need --agent-card or --endpoint"},
		{name: "bad service parameter", flags: flags{agentCard: "a.example.com", svcParams: []string{"novalue"}}, wantErr: "key=value"},
		{name: "webhook URL", flags: flags{webhookURL: "https://tunnel.example.com/inspector/"}, check: func(t *testing.T, so server.Options) {
			if so.WebhookBaseURL != "https://tunnel.example.com/inspector" {
				t.Errorf("webhook base URL = %q", so.WebhookBaseURL)
			}
		}},
		{name: "relative webhook URL", flags: flags{webhookURL: "tunnel.example.com"}, wantErr: "--webhook-url"},
		{name: "webhook URL with a query", flags: flags{webhookURL: "http://tunnel.example.com/?a=b"}, wantErr: "query"},
		{name: "webhook URL with another scheme", flags: flags{webhookURL: "ftp://tunnel.example.com"}, wantErr: "http or https"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			so, err := serverOptions(opts, tt.flags)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("serverOptions() error = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("serverOptions() error = %v", err)
			}
			tt.check(t, so)
		})
	}
}

func TestTransportFlags(t *testing.T) {
	var option string
	cmd := newCommand(Options{Transports: []Transport{{Protocol: "CUSTOM", AddFlags: func(fs *pflag.FlagSet) {
		fs.StringVar(&option, "custom-option", "", "Option of the custom transport")
	}}}}, &syncBuffer{}, &syncBuffer{}, nil)
	if err := cmd.ParseFlags([]string{"--custom-option", "value"}); err != nil || option != "value" {
		t.Errorf("ParseFlags() = %v, option = %q", err, option)
	}
}

func TestRunHosted(t *testing.T) {
	r := start(t, "--hosted", "--host", "127.0.0.1", "--port", "0", "--max-sessions", "3", "--client-header", "X-Forwarded-For")
	re := regexp.MustCompile(`hosted mode on (\S+)`)
	var addr string
	deadline := time.Now().Add(5 * time.Second)
	for addr == "" && time.Now().Before(deadline) {
		if m := re.FindStringSubmatch(r.stdout.String()); m != nil {
			addr = m[1]
		}
		time.Sleep(10 * time.Millisecond)
	}
	if addr == "" || strings.Contains(r.stdout.String(), "token=") {
		t.Fatalf("stdout = %q", r.stdout.String())
	}
	select {
	case opened := <-r.opened:
		t.Errorf("opened %q in hosted mode", opened)
	default:
	}
	if !strings.Contains(r.stderr.String(), "egress public; limits: 3 sessions") ||
		!strings.Contains(r.stderr.String(), "per client from X-Forwarded-For (1 trusted proxies) 10 sessions, 50 requests/s to agents") {
		t.Errorf("stderr = %q, want the limits", r.stderr.String())
	}
	resp, err := http.Get("http://" + addr + "/api/config")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var config struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&config); err != nil || config.Mode != "hosted" {
		t.Errorf("config = %+v, %v", config, err)
	}
	if !strings.Contains(r.stderr.String(), "session started (1 active)") {
		t.Errorf("stderr = %q, want the new session logged", r.stderr.String())
	}
}

func TestHostedDefaults(t *testing.T) {
	env := func(port string) func(string) string {
		return func(string) string { return port }
	}
	f := flags{host: "127.0.0.1", port: 8080, given: map[string]bool{}}
	if err := hostedDefaults(&f, env("9090")); err != nil || f.host != "0.0.0.0" || f.port != 9090 {
		t.Errorf("hostedDefaults() = %v, %s:%d", err, f.host, f.port)
	}
	f = flags{host: "127.0.0.1", port: 8081, given: map[string]bool{"host": true, "port": true}}
	if err := hostedDefaults(&f, env("9090")); err != nil || f.host != "127.0.0.1" || f.port != 8081 {
		t.Errorf("hostedDefaults() with flags = %v, %s:%d", err, f.host, f.port)
	}
	f = flags{given: map[string]bool{}}
	if err := hostedDefaults(&f, env("http")); err == nil {
		t.Error("hostedDefaults() accepted $PORT=http")
	}
}

func TestHostedServerOptions(t *testing.T) {
	limits := server.Limits{MaxSessions: 5, IdleTimeout: time.Minute}
	so, err := serverOptions(Options{}, flags{hosted: true, limits: limits, trafficMiB: 2, egressAllow: []string{"10.1.0.0/16"}})
	if err != nil || !so.Hosted || so.Egress == nil || so.Limits.MaxSessions != 5 || so.Limits.TrafficBytes != 2<<20 {
		t.Errorf("hosted options = %+v, %v", so, err)
	}
	if so, err := serverOptions(Options{}, flags{}); err != nil || so.Egress != nil || so.Hosted {
		t.Errorf("local options = %+v, %v; want no egress policy", so, err)
	}
	if so, err := serverOptions(Options{}, flags{egress: "public"}); err != nil || so.Egress == nil {
		t.Errorf("local --egress=public = %+v, %v", so, err)
	}
	perClient := server.Limits{ClientHeader: " X-Forwarded-For ", TrustedProxies: 2, ClientSessions: 3}
	given := map[string]bool{"client-header": true, "trusted-proxies": true, "client-max-sessions": true}
	if so, err := serverOptions(Options{}, flags{hosted: true, limits: perClient, given: given}); err != nil ||
		so.Limits.ClientHeader != "X-Forwarded-For" || so.Limits.TrustedProxies != 2 || so.Limits.ClientSessions != 3 {
		t.Errorf("limits per client = %+v, %v", so.Limits, err)
	}
	for _, tc := range []struct {
		f    flags
		want string
	}{
		{flags{hosted: true, agentCard: "x", given: map[string]bool{"agent-card": true}}, "--agent-card doesn't work with --hosted"},
		{flags{hosted: true, given: map[string]bool{"auth": true}}, "--auth doesn't work with --hosted"},
		{flags{given: map[string]bool{"max-sessions": true}}, "--max-sessions needs --hosted"},
		{flags{given: map[string]bool{"client-header": true}}, "--client-header needs --hosted"},
		{flags{hosted: true, given: map[string]bool{"client-max-sessions": true}}, "--client-max-sessions needs --client-header"},
		{flags{hosted: true, limits: server.Limits{ClientHeader: "X-Forwarded-For"}}, "--trusted-proxies must be at least 1"},
		{flags{egressAllow: []string{"10.0.0.0/8"}}, "--egress-allow needs --egress=public"},
		{flags{hosted: true, egress: "none"}, `--egress: "none"`},
		{flags{hosted: true, egressAllow: []string{"not a host"}}, "--egress-allow"},
	} {
		if _, err := serverOptions(Options{}, tc.f); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("serverOptions(%+v) = %v, want %q", tc.f, err, tc.want)
		}
	}
}
