package inspector

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/server"
	"github.com/a2aproject/a2a-inspector/ui"
	"github.com/spf13/cobra"
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
}

func newCommand(opts Options, stdout, stderr io.Writer, open func(url string) error) *cobra.Command {
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
	for _, t := range opts.Transports {
		if t.AddFlags != nil {
			t.AddFlags(fs)
		}
	}
	return cmd
}

func run(ctx context.Context, opts Options, f flags, stdout, stderr io.Writer, open func(string) error) error {
	sopts, err := serverOptions(opts, f)
	if err != nil {
		return err
	}
	token, err := newToken()
	if err != nil {
		return err
	}
	ln, err := listen(f.host, f.port)
	if err != nil {
		return err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	sopts.Host, sopts.Port, sopts.Token, sopts.UI = f.host, port, token, ui.FS()
	handler, err := server.New(sopts)
	if err != nil {
		ln.Close()
		return err
	}
	defer handler.Close()

	if !agents.IsLoopbackHost(f.host) {
		fmt.Fprintf(stderr, "Warning: listening on %s, so other machines can reach the inspector. "+
			"Anyone with the URL below can use it to send requests from this machine, "+
			"with the credentials given to it and its environment variables.\n", f.host)
	}
	inspectorURL := startURL(f.host, port, token)
	fmt.Fprintf(stdout, "A2A Inspector is running at %s\nPress Ctrl+C to stop.\n", inspectorURL)
	if !f.noOpen {
		if err := open(inspectorURL); err != nil {
			fmt.Fprintf(stderr, "Couldn't open a browser (%v). Open the URL above.\n", err)
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

// serverOptions checks the flags and turns them and opts into server options.
func serverOptions(opts Options, f flags) (server.Options, error) {
	var so server.Options
	for _, t := range opts.Transports {
		so.Transports = append(so.Transports, agents.Transport{Binding: string(t.Protocol), Version: agents.Version10, Factory: t.Factory})
		if t.CompatFactory != nil {
			so.Transports = append(so.Transports, agents.Transport{Binding: string(t.Protocol), Version: agents.Version03, Factory: t.CompatFactory})
		}
	}
	if opts.WrapHTTPTransport != nil {
		so.HTTPTransport = opts.WrapHTTPTransport(http.DefaultTransport)
	}
	dialer := &agents.Dialer{Transports: so.Transports}

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
