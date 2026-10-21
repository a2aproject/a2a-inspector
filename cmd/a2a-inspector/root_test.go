package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
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
	cmd := newRootCmd(r.stdout, r.stderr, func(url string) error {
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
	r := start(t, "--port", "0", "-a", "localhost:9999")
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
	resp.Body.Close()
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
	defer resp.Body.Close()
	var config struct {
		AgentCardURL string `json:"agentCardUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&config); err != nil {
		t.Fatal(err)
	}
	if config.AgentCardURL != "http://localhost:9999/.well-known/agent-card.json" {
		t.Errorf("agentCardUrl = %q", config.AgentCardURL)
	}

	resp, err = client.Get(base + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
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

func TestNoOpen(t *testing.T) {
	r := start(t, "--port", "0", "--no-open")
	r.waitForURL(t)
	select {
	case url := <-r.opened:
		t.Errorf("opened %q with --no-open", url)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestPortInUse(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	cmd := newRootCmd(&syncBuffer{}, &syncBuffer{}, func(string) error { return nil })
	cmd.SetArgs([]string{"--port", strconv.Itoa(port)})
	err = cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "already in use") || !strings.Contains(err.Error(), "--port") {
		t.Errorf("Execute() = %v, want a port-in-use error suggesting --port", err)
	}
}

func TestFlagErrors(t *testing.T) {
	for _, args := range [][]string{{"-a", "./card.json"}, {"unexpected"}} {
		cmd := newRootCmd(&syncBuffer{}, &syncBuffer{}, func(string) error { return nil })
		cmd.SetArgs(args)
		if err := cmd.Execute(); err == nil {
			t.Errorf("Execute(%v) succeeded", args)
		}
	}
}

func TestDefaults(t *testing.T) {
	cmd := newRootCmd(&syncBuffer{}, &syncBuffer{}, nil)
	for flag, want := range map[string]string{"port": "8080", "host": "127.0.0.1", "no-open": "false", "agent-card": ""} {
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
	if url := r.waitForURL(t); !strings.HasPrefix(url, "http://127.0.0.1:") {
		t.Errorf("URL = %q, want the loopback address", url)
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
