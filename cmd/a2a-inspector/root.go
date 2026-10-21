package main

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

type options struct {
	agentCard string
	host      string
	port      int
	noOpen    bool
}

func newRootCmd(stdout, stderr io.Writer, open func(url string) error) *cobra.Command {
	var opts options
	cmd := &cobra.Command{
		Use:   "a2a-inspector",
		Short: "Inspect, debug and test A2A agents in the browser",
		Long: "a2a-inspector serves a web UI for inspecting, debugging and testing A2A agents, and opens it in the browser.\n" +
			"It listens on 127.0.0.1 and protects its API with a token in the URL it prints.",
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return run(cmd.Context(), opts, stdout, stderr, open)
		},
	}
	f := cmd.Flags()
	f.StringVarP(&opts.agentCard, "agent-card", "a", "", "Agent Card to open on start: host/origin or full card URL")
	f.StringVar(&opts.host, "host", "127.0.0.1", "Address to listen on; anything but loopback makes the inspector reachable from other machines")
	f.IntVar(&opts.port, "port", defaultPort, "Port to listen on")
	f.BoolVar(&opts.noOpen, "no-open", false, "Don't open the browser")
	return cmd
}

func run(ctx context.Context, opts options, stdout, stderr io.Writer, open func(string) error) error {
	var cardURL string
	if opts.agentCard != "" {
		u, err := agents.NormalizeCardURL(opts.agentCard)
		if err != nil {
			return fmt.Errorf("--agent-card: %w", err)
		}
		cardURL = u
	}
	token, err := newToken()
	if err != nil {
		return err
	}
	ln, err := listen(opts.host, opts.port)
	if err != nil {
		return err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	handler, err := server.New(server.Options{Host: opts.host, Port: port, Token: token, AgentCardURL: cardURL, UI: ui.FS()})
	if err != nil {
		ln.Close()
		return err
	}

	if !agents.IsLoopbackHost(opts.host) {
		fmt.Fprintf(stderr, "Warning: listening on %s, so other machines can reach the inspector. "+
			"Anyone with the URL below can use it to send requests from this machine.\n", opts.host)
	}
	inspectorURL := startURL(opts.host, port, token)
	fmt.Fprintf(stdout, "A2A Inspector is running at %s\nPress Ctrl+C to stop.\n", inspectorURL)
	if !opts.noOpen {
		if err := open(inspectorURL); err != nil {
			fmt.Fprintf(stderr, "Couldn't open a browser (%v). Open the URL above.\n", err)
		}
	}

	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	select {
	case err := <-served:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
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
