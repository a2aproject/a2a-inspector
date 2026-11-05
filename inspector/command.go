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
	"cmp"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/egress"
	"github.com/a2aproject/a2a-inspector/internal/server"
	"github.com/a2aproject/a2a-inspector/ui"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// defaultPort is fixed, because the browser keeps saved agents per address,
// and matches the port of the previous inspector and its Docker image.
const defaultPort = 8080

type flags struct {
	agentCard  string
	endpoint   string
	transports []string
	a2aVersion string
	auth       string
	svcParams  []string
	host       string
	port       int
	noOpen     bool
	webhookURL string

	hosted      bool
	egress      string
	egressAllow []string
	limits      server.Limits
	trafficMiB  int
	// given lists the flags set on the command line.
	given map[string]bool
}

// hostedFlags are the limits, which only a hosted inspector applies.
var hostedFlags = []string{
	"max-sessions", "session-idle-timeout", "session-max-age", "max-connections", "max-streams",
	"traffic-buffer-mib", "request-rate", "session-egress-rate", "egress-rate", "max-stream-duration",
	"client-header", "trusted-proxies", "client-max-sessions", "client-egress-rate",
}

// clientFlags configure the limits per client, which need --client-header.
var clientFlags = []string{"trusted-proxies", "client-max-sessions", "client-egress-rate"}

// startupFlags configure an agent and credentials for a single user, which a
// hosted inspector doesn't have.
var startupFlags = []string{"agent-card", "endpoint", "transport", "a2a-version", "auth", "svc-param", "webhook-url"}

func newCommand(opts Options, stdout, stderr io.Writer, open func(rawURL string) error) *cobra.Command {
	var f flags
	cmd := &cobra.Command{
		Use:   "a2a-inspector",
		Short: "Inspect, debug and test A2A agents in the browser",
		Long: "a2a-inspector serves a web UI for inspecting, debugging and testing A2A agents, and opens it in the browser.\n" +
			"It listens on 127.0.0.1 and protects its API with a token in the URL it prints.",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			f.given = map[string]bool{}
			cmd.Flags().Visit(func(fl *pflag.Flag) { f.given[fl.Name] = true })
			return run(cmd.Context(), opts, f, stdout, stderr, open)
		},
	}
	fs := cmd.Flags()
	fs.StringVarP(&f.agentCard, "agent-card", "a", "", "Agent Card to open on start: host/origin or full card URL")
	fs.StringVarP(&f.endpoint, "endpoint", "e", "", "Agent interface URL to open on start without a card; requires a single --transport flag")
	fs.StringArrayVar(&f.transports, "transport", nil, "Transport: rest, jsonrpc or grpc. With --endpoint, the interface's binding; with --agent-card, the preferred bindings, highest first (repeatable)")
	fs.StringVar(&f.a2aVersion, "a2a-version", "", "A2A protocol version, 1.0 or 0.3: of the --endpoint interface (default 1.0), or the preferred one in the card")
	fs.StringVar(&f.auth, "auth", "", "Shorthand for --svc-param Authorization=<creds>")
	fs.StringArrayVar(&f.svcParams, "svc-param", nil, "Service parameter key=value sent to the agent opened on start (repeatable)")
	fs.StringVar(&f.host, "host", "127.0.0.1", "Address to listen on; anything but loopback makes the inspector reachable from other machines")
	fs.IntVar(&f.port, "port", defaultPort, "Port to listen on")
	fs.BoolVar(&f.noOpen, "no-open", false, "Don't open the browser")
	fs.StringVar(&f.webhookURL, "webhook-url", "", "Base URL agents use to reach the inspector's webhook receiver, such as a tunnel; default: the inspector's own address")
	fs.BoolVar(&f.hosted, "hosted", false, "Run as a shared service for many users, each in their own session, within the limits below. "+
		"Listens on all addresses and $PORT (default 8080), and turns off the webhook receiver and environment-variable secrets")
	fs.StringVar(&f.egress, "egress", "", `Addresses the inspector connects to: "any", or "public" to block loopback, private, link-local (cloud metadata) and other non-public addresses (default "public" with --hosted, otherwise "any")`)
	fs.StringArrayVar(&f.egressAllow, "egress-allow", nil, "With --egress=public, a CIDR block, IP address, host name or *.domain the inspector may still reach (repeatable)")
	fs.IntVar(&f.limits.MaxSessions, "max-sessions", 500, "Hosted: sessions kept at once; a new one replaces the session idle the longest")
	fs.DurationVar(&f.limits.IdleTimeout, "session-idle-timeout", 10*time.Minute, "Hosted: how long a session lives without an open tab or a request")
	fs.DurationVar(&f.limits.MaxAge, "session-max-age", 8*time.Hour, "Hosted: how long a session lives at most")
	fs.IntVar(&f.limits.Connections, "max-connections", 20, "Hosted: connections to agents per session; a new one replaces the one used the longest ago")
	fs.IntVar(&f.limits.Streams, "max-streams", 8, "Hosted: streams open at once per session, the UI's traffic feed included")
	fs.IntVar(&f.trafficMiB, "traffic-buffer-mib", 4, "Hosted: MiB of traffic log kept per session")
	fs.Float64Var(&f.limits.RequestRate, "request-rate", 5, "Hosted: API requests per second per session")
	fs.Float64Var(&f.limits.SessionEgressRate, "session-egress-rate", 10, "Hosted: requests to agents per second per session")
	fs.Float64Var(&f.limits.EgressRate, "egress-rate", 200, "Hosted: requests to agents per second, over all sessions")
	fs.DurationVar(&f.limits.StreamDuration, "max-stream-duration", 30*time.Minute, "Hosted: how long a stream from an agent lasts at most")
	fs.StringVar(&f.limits.ClientHeader, "client-header", "", "Hosted: request header that identifies a client, set by the proxy in front of the inspector, "+
		"such as X-Forwarded-For or a header with the signed-in user; turns on the limits per client below")
	fs.IntVar(&f.limits.TrustedProxies, "trusted-proxies", 1, "Hosted: proxies that add an entry to --client-header; the client is the entry that many from the end")
	fs.IntVar(&f.limits.ClientSessions, "client-max-sessions", 10, "Hosted: sessions per client; a new one replaces the client's session idle the longest")
	fs.Float64Var(&f.limits.ClientEgressRate, "client-egress-rate", 50, "Hosted: requests to agents per second per client, over its sessions")
	for _, t := range opts.Transports {
		if t.AddFlags != nil {
			t.AddFlags(fs)
		}
	}
	return cmd
}

func run(ctx context.Context, opts Options, f flags, stdout, stderr io.Writer, open func(string) error) error {
	if f.hosted {
		if err := hostedDefaults(&f, os.Getenv); err != nil {
			return err
		}
	}
	sopts, err := serverOptions(opts, f)
	if err != nil {
		return err
	}
	if f.hosted {
		logger := log.New(stderr, "", log.LstdFlags)
		sopts.Logger = logger
		if sopts.Egress != nil {
			sopts.Egress.OnBlock = func(_ string, err error) { logger.Print(err) }
		}
	}
	var token string
	if !f.hosted {
		if token, err = newToken(); err != nil {
			return err
		}
	}
	ln, err := listen(f.host, f.port)
	if err != nil {
		return err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	sopts.Host, sopts.Port, sopts.Token, sopts.UI = f.host, port, token, ui.FS()
	handler, err := server.New(sopts)
	if err != nil {
		_ = ln.Close()
		return err
	}
	defer handler.Close()

	switch {
	case f.hosted:
		l := sopts.Limits
		_, _ = fmt.Fprintf(stdout, "A2A Inspector is running in hosted mode on %s\n", net.JoinHostPort(f.host, strconv.Itoa(port)))
		perClient := "no limits per client"
		if l.ClientHeader != "" {
			perClient = fmt.Sprintf("per client from %s (%d trusted proxies) %d sessions, %g requests/s to agents",
				l.ClientHeader, l.TrustedProxies, l.ClientSessions, l.ClientEgressRate)
		}
		sopts.Logger.Printf("egress %s; limits: %d sessions, idle %s, max age %s; per session %d connections, %d streams, %d MiB traffic, %g requests/s, %g requests/s to agents; %s; %g requests/s to agents in all; streams up to %s",
			egressMode(f), l.MaxSessions, l.IdleTimeout, l.MaxAge, l.Connections, l.Streams, l.TrafficBytes>>20, l.RequestRate, l.SessionEgressRate, perClient, l.EgressRate, l.StreamDuration)
	default:
		if !agents.IsLoopbackHost(f.host) {
			_, _ = fmt.Fprintf(stderr, "Warning: listening on %s, so other machines can reach the inspector. "+
				"Anyone with the URL below can use it to send requests from this machine, "+
				"with the credentials given to it and its environment variables.\n", f.host)
		}
		inspectorURL := startURL(f.host, port, token)
		_, _ = fmt.Fprintf(stdout, "A2A Inspector is running at %s\nPress Ctrl+C to stop.\n", inspectorURL)
		if !f.noOpen {
			if err := open(inspectorURL); err != nil {
				_, _ = fmt.Fprintf(stderr, "Couldn't open a browser (%v). Open the URL above.\n", err)
			}
		}
	}

	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	srv.RegisterOnShutdown(handler.Close)
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	select {
	case err := <-served:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return srv.Close()
	}
}

// hostedDefaults listens on all addresses and on $PORT, as hosting
// platforms expect, unless the flags say otherwise.
func hostedDefaults(f *flags, getenv func(string) string) error {
	if !f.given["host"] {
		f.host = "0.0.0.0"
	}
	if p := getenv("PORT"); p != "" && !f.given["port"] {
		port, err := strconv.Atoi(p)
		if err != nil || port < 0 || port > 65535 {
			return fmt.Errorf("$PORT: %q isn't a port number", p)
		}
		f.port = port
	}
	return nil
}

func egressMode(f flags) string {
	if f.egress == "" && f.hosted {
		return "public"
	}
	return cmp.Or(f.egress, "any")
}

// serverOptions checks the flags and turns them and opts into server options.
func serverOptions(opts Options, f flags) (server.Options, error) {
	var so server.Options
	for _, t := range opts.Transports {
		so.Transports = append(so.Transports, agents.Transport{Binding: string(t.Protocol), Version: agents.Version10, Factory: t.Factory})
		if t.CompatFactory != nil {
			so.Transports = append(so.Transports, agents.Transport{Binding: string(t.Protocol), Version: agents.Version03, Factory: t.CompatFactory})
		}
	}
	so.WrapHTTPTransport = opts.WrapHTTPTransport
	dialer := &agents.Dialer{Transports: so.Transports}

	for _, name := range hostedFlags {
		if f.given[name] && !f.hosted {
			return so, fmt.Errorf("--%s needs --hosted", name)
		}
	}
	if f.hosted {
		for _, name := range startupFlags {
			if f.given[name] {
				return so, fmt.Errorf("--%s doesn't work with --hosted: a shared inspector has no startup agent, credentials or webhooks", name)
			}
		}
		so.Hosted = true
		so.Limits = f.limits
		so.Limits.TrafficBytes = f.trafficMiB << 20
		so.Limits.ClientHeader = strings.TrimSpace(f.limits.ClientHeader)
		switch {
		case so.Limits.ClientHeader == "":
			for _, name := range clientFlags {
				if f.given[name] {
					return so, fmt.Errorf("--%s needs --client-header", name)
				}
			}
		case so.Limits.TrustedProxies < 1:
			return so, errors.New("--trusted-proxies must be at least 1")
		}
	}
	switch egressMode(f) {
	case "any":
		if len(f.egressAllow) > 0 {
			return so, errors.New("--egress-allow needs --egress=public")
		}
	case "public":
		policy, err := egress.New(f.egressAllow)
		if err != nil {
			return so, fmt.Errorf("--egress-allow: %w", err)
		}
		so.Egress = policy
	default:
		return so, fmt.Errorf(`--egress: %q isn't "any" or "public"`, f.egress)
	}

	switch f.a2aVersion {
	case "", agents.Version10, agents.Version03:
	default:
		return so, fmt.Errorf("--a2a-version: %q isn't supported; use %s or %s", f.a2aVersion, agents.Version10, agents.Version03)
	}
	bindings := make([]string, 0, len(f.transports))
	for _, t := range f.transports {
		b, err := parseTransport(t, dialer)
		if err != nil {
			return so, err
		}
		bindings = append(bindings, b)
	}

	switch {
	case f.agentCard != "" && f.endpoint != "":
		return so, errors.New("--endpoint and --agent-card are mutually exclusive")
	case f.agentCard != "":
		u, err := agents.NormalizeCardURL(f.agentCard)
		if err != nil {
			return so, fmt.Errorf("--agent-card: %w", err)
		}
		so.AgentCardURL = u
		so.Preferences = server.Preferences{Bindings: bindings, Version: f.a2aVersion}
	case f.endpoint != "":
		if len(bindings) != 1 {
			return so, errors.New("--endpoint needs exactly one --transport (rest, jsonrpc or grpc)")
		}
		version := f.a2aVersion
		if version == "" {
			version = agents.Version10
		}
		if !dialer.Supports(bindings[0], version) {
			return so, fmt.Errorf("--transport %s doesn't support version %s", f.transports[0], version)
		}
		so.Endpoint = &agents.Interface{URL: f.endpoint, ProtocolBinding: bindings[0], ProtocolVersion: version, Supported: true, Source: "custom"}
	case len(bindings) > 0 || f.a2aVersion != "":
		return so, errors.New("--transport and --a2a-version need --agent-card or --endpoint")
	}

	for _, p := range f.svcParams {
		k, v, ok := cutServiceParam(p)
		if !ok || k == "" {
			return so, fmt.Errorf("--svc-param: expected key=value, got %q", p)
		}
		so.StartupHeaders = append(so.StartupHeaders, server.StartupHeader{Name: k, Value: v, Secret: looksSecret(k)})
	}
	if f.auth != "" {
		so.StartupHeaders = append(so.StartupHeaders, server.StartupHeader{Name: "Authorization", Value: f.auth, Secret: true})
	}
	if len(so.StartupHeaders) > 0 && so.AgentCardURL == "" && so.Endpoint == nil {
		return so, errors.New("--auth and --svc-param need --agent-card or --endpoint")
	}
	if f.webhookURL != "" {
		u, err := server.NormalizeWebhookBaseURL(f.webhookURL)
		if err != nil {
			return so, fmt.Errorf("--webhook-url: %w", err)
		}
		so.WebhookBaseURL = u
	}
	return so, nil
}

// parseTransport maps a --transport value to a protocol binding.
func parseTransport(s string, dialer *agents.Dialer) (string, error) {
	switch strings.ToLower(s) {
	case "rest":
		return agents.BindingHTTPJSON, nil
	case "jsonrpc":
		return agents.BindingJSONRPC, nil
	case "grpc":
		return agents.BindingGRPC, nil
	}
	if b := agents.CoreBinding(s); b != "" {
		return b, nil
	}
	for _, t := range dialer.Transports {
		if strings.EqualFold(t.Binding, s) {
			return t.Binding, nil
		}
	}
	return "", fmt.Errorf("--transport: unknown transport %q; use rest, jsonrpc or grpc", s)
}

// cutServiceParam splits "key=value" or "key:value" at the first separator.
func cutServiceParam(kv string) (key, value string, ok bool) {
	i := strings.IndexAny(kv, "=:")
	if i < 0 {
		return "", "", false
	}
	return strings.TrimSpace(kv[:i]), kv[i+1:], true
}

// looksSecret reports whether a service parameter probably carries a
// credential, in which case the UI only sees it masked.
func looksSecret(name string) bool {
	name = strings.ToLower(name)
	for _, word := range []string{"auth", "token", "key", "secret", "password", "cookie", "credential", "session"} {
		if strings.Contains(name, word) {
			return true
		}
	}
	return false
}

func listen(host string, port int) (net.Listener, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		if isAddrInUse(err) {
			return nil, fmt.Errorf("port %d is already in use, maybe by another inspector; pick another one with --port", port)
		}
		return nil, err
	}
	return ln, nil
}

func isAddrInUse(err error) bool {
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	// Windows reports WSAEADDRINUSE, which syscall.EADDRINUSE doesn't match.
	msg := err.Error()
	return strings.Contains(msg, "address already in use") || strings.Contains(msg, "Only one usage of each socket address")
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generating the session token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// startURL is the URL the user opens. When the inspector listens on all
// addresses, it points to the loopback address.
func startURL(host string, port int, token string) string {
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	u := url.URL{
		Scheme:   "http",
		Host:     net.JoinHostPort(host, strconv.Itoa(port)),
		Path:     "/",
		RawQuery: url.Values{"token": {token}}.Encode(),
	}
	return u.String()
}
