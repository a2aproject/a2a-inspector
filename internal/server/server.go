// Package server serves the inspector's embedded UI and the private JSON API
// the UI uses. It isn't an A2A service: the UI never talks to agents itself.
package server

import (
	"cmp"
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
)

// contentSecurityPolicy allows only the inspector's own scripts, styles and API.
const contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
	"font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// Options configures a Server.
type Options struct {
	// Host is the address the server listens on. It decides which Host
	// headers are accepted.
	Host string
	// Port is the port the server listens on. It's part of the session
	// cookie's name, because browsers share cookies across ports.
	Port int
	// Token is the per-run session token, given to the user in the URL.
	Token string
	// AgentCardURL, if set, is the agent the UI opens on start.
	AgentCardURL string
	// Endpoint, if set, is an interface the UI connects to on start without
	// a card.
	Endpoint *agents.Interface
	// Preferences pick the interface of the AgentCardURL agent.
	Preferences Preferences
	// StartupHeaders are sent to the agent opened on start, from --auth and
	// --svc-param.
	StartupHeaders []StartupHeader
	// UI holds the built UI, with index.html at its root.
	UI fs.FS
	// HTTPTransport sends the inspector's requests to agents. It defaults to
	// http.DefaultTransport; the inspector records the traffic around it.
	HTTPTransport http.RoundTripper
	// Transports adds protocol bindings beyond the core ones.
	Transports []agents.Transport
	// WebhookBaseURL is the URL agents reach the inspector's webhook
	// receiver under, such as a tunnel. It defaults to the inspector's own
	// address.
	WebhookBaseURL string
}

// Preferences choose among a card's interfaces, from --transport and --a2a-version.
type Preferences struct {
	// Bindings are protocol bindings, most preferred first.
	Bindings []string `json:"bindings,omitempty"`
	Version  string   `json:"version,omitempty"`
}

// StartupHeader is a header given on the command line.
type StartupHeader struct {
	Name, Value string
	// Secret keeps the value out of the UI.
	Secret bool
}

// Server is the inspector's HTTP handler.
type Server struct {
	opts         Options
	traffic      *traffic.Log
	client       *http.Client
	dialer       *agents.Dialer
	secrets      *secretStore
	conns        *connections
	hooks        *hooks
	startup      *startupConfig
	mux          *http.ServeMux
	cookieName   string
	anyHost      bool
	allowedHosts map[string]bool
	// defaultWebhookURL is the inspector's own address. webhookURL replaces
	// it when set, from the options or the UI.
	defaultWebhookURL string
	webhookMu         sync.Mutex
	webhookURL        string
	// ctx ends when the server closes; calls to agents and the traffic feed
	// end with it, so shutting down doesn't wait for agents.
	ctx    context.Context
	cancel context.CancelFunc
}

// New returns a Server for opts.
func New(opts Options) (*Server, error) {
	if opts.Token == "" {
		return nil, errors.New("server: empty session token")
	}
	if opts.UI == nil {
		return nil, errors.New("server: no UI files")
	}
	log := traffic.NewLog(0)
	// No client timeout: streams last as long as the UI follows them, and
	// each call bounds itself with its context.
	client := &http.Client{Transport: &traffic.Transport{Log: log, Base: opts.HTTPTransport}}
	s := &Server{
		opts:    opts,
		traffic: log,
		client:  client,
		dialer: &agents.Dialer{
			HTTPClient:      client,
			GRPCDialOptions: log.DialOptions(),
			Transports:      opts.Transports,
		},
		secrets:    newSecretStore(),
		conns:      &connections{items: map[string]*connection{}},
		hooks:      newHooks(),
		mux:        http.NewServeMux(),
		cookieName: fmt.Sprintf("a2a_inspector_%d", opts.Port),
	}
	s.defaultWebhookURL = "http://" + net.JoinHostPort(loopbackIfUnspecified(opts.Host), strconv.Itoa(opts.Port))
	if opts.WebhookBaseURL != "" {
		u, err := NormalizeWebhookBaseURL(opts.WebhookBaseURL)
		if err != nil {
			return nil, fmt.Errorf("server: %w", err)
		}
		s.webhookURL = u
	}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	s.anyHost, s.allowedHosts = allowedHosts(opts.Host, opts.Port)
	startup, err := s.newStartupConfig()
	if err != nil {
		return nil, err
	}
	s.startup = startup

	s.mux.HandleFunc("GET /api/config", s.handleConfig)
	s.mux.HandleFunc("PATCH /api/config", s.handlePatchConfig)
	s.mux.HandleFunc("POST /api/card:resolve", s.handleCardResolve)
	s.mux.HandleFunc("POST /api/card:validate", s.handleCardValidate)
	s.mux.HandleFunc("POST /api/connections", s.handleCreateConnection)
	s.mux.HandleFunc("GET /api/connections/{id}", s.handleGetConnection)
	s.mux.HandleFunc("DELETE /api/connections/{id}", s.handleDeleteConnection)
	s.mux.HandleFunc("POST /api/connections/{id}/messages:send", s.handleSend)
	s.mux.HandleFunc("POST /api/connections/{id}/messages:stream", s.handleStream)
	s.mux.HandleFunc("GET /api/connections/{id}/tasks", s.handleListTasks)
	s.mux.HandleFunc("GET /api/connections/{id}/tasks/{task}", s.handleGetTask)
	s.mux.HandleFunc("POST /api/connections/{id}/tasks/{task}", s.handleTaskAction)
	s.mux.HandleFunc("POST /api/connections/{id}/tasks/{task}/pushNotificationConfigs", s.handleCreatePushConfig)
	s.mux.HandleFunc("GET /api/connections/{id}/tasks/{task}/pushNotificationConfigs", s.handleListPushConfigs)
	s.mux.HandleFunc("GET /api/connections/{id}/tasks/{task}/pushNotificationConfigs/{config}", s.handleGetPushConfig)
	s.mux.HandleFunc("DELETE /api/connections/{id}/tasks/{task}/pushNotificationConfigs/{config}", s.handleDeletePushConfig)
	s.mux.HandleFunc("GET /api/connections/{id}/extendedAgentCard", s.handleExtendedCard)
	s.mux.HandleFunc("GET /api/traffic", s.handleTraffic)
	s.mux.HandleFunc("GET /api/hooks", s.handleHooks)
	s.mux.HandleFunc("POST /hooks/{hook}", s.handleHook)
	s.mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "Unknown API endpoint.")
	})
	s.mux.HandleFunc("/", s.handleUI)
	return s, nil
}

// Close ends the long-lived streams, such as the traffic feed, so the HTTP
// server can shut down, and closes the connections to agents.
func (s *Server) Close() {
	s.cancel()
	s.conns.mu.Lock()
	defer s.conns.mu.Unlock()
	for id, c := range s.conns.items {
		_ = c.client.Destroy()
		delete(s.conns.items, id)
	}
}

// callContext is the context of a call to an agent: it ends with the request
// or when the server closes.
func (s *Server) callContext(r *http.Request) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(s.ctx, cancel)
	return ctx, func() {
		stop()
		cancel()
	}
}

// webhookBaseURL returns the URL webhooks are created under.
func (s *Server) webhookBaseURL() string {
	s.webhookMu.Lock()
	defer s.webhookMu.Unlock()
	return cmp.Or(s.webhookURL, s.defaultWebhookURL)
}

// setWebhookBaseURL changes the URL new webhooks are created under; ""
// goes back to the default.
func (s *Server) setWebhookBaseURL(u string) {
	s.webhookMu.Lock()
	defer s.webhookMu.Unlock()
	s.webhookURL = u
}

// NormalizeWebhookBaseURL checks that u is an absolute http or https URL
// without a query or fragment, and drops a trailing slash.
func NormalizeWebhookBaseURL(u string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(u))
	switch {
	case err != nil:
		return "", fmt.Errorf("invalid webhook base URL: %w", err)
	case parsed.Scheme != "http" && parsed.Scheme != "https", parsed.Host == "":
		return "", fmt.Errorf("the webhook base URL %q must be an absolute http or https URL", u)
	case parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "":
		return "", fmt.Errorf("the webhook base URL %q can't have a query or fragment", u)
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

// loopbackIfUnspecified returns 127.0.0.1 for the all-addresses host, where
// the inspector is reachable through loopback.
func loopbackIfUnspecified(host string) string {
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		return "127.0.0.1"
	}
	return host
}

// allowedHosts returns the Host header values the server accepts. When it
// listens on all addresses, any host can reach it and every Host is accepted;
// the session token still protects the API.
func allowedHosts(host string, port int) (anyHost bool, hosts map[string]bool) {
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		return true, nil
	}
	p := strconv.Itoa(port)
	hosts = map[string]bool{}
	for _, h := range []string{"127.0.0.1", "localhost", "::1", host} {
		hosts[strings.ToLower(net.JoinHostPort(h, p))] = true
	}
	return false, hosts
}

// ServeHTTP applies the security checks and routes the request.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Security-Policy", contentSecurityPolicy)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")

	// Agents deliver push notifications from wherever the webhook URL
	// reaches, such as through a tunnel or from a container, so the Host,
	// origin and session checks don't apply. The webhook's random ID and
	// token protect it.
	if strings.HasPrefix(path.Clean(r.URL.Path), "/hooks/") {
		h.Set("Cache-Control", "no-store")
		s.mux.ServeHTTP(w, r)
		return
	}

	// A Host the server doesn't know means the request came through a name
	// that only resolves to this machine, as in DNS rebinding.
	if !s.anyHost && !s.allowedHosts[strings.ToLower(r.Host)] {
		http.Error(w, "Unknown Host header.", http.StatusMisdirectedRequest)
		return
	}

	if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
		h.Set("Cache-Control", "no-store")
		if !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "Cross-origin requests aren't allowed.")
			return
		}
		if !s.authenticated(r) {
			writeError(w, http.StatusUnauthorized, "No valid session. Open the URL the inspector printed when it started.")
			return
		}
	} else if token := r.URL.Query().Get("token"); token != "" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		s.startSession(w, r, token)
		return
	}
	s.mux.ServeHTTP(w, r)
}

// sameOrigin rejects requests a browser sends on behalf of another site. The
// session cookie is SameSite=Strict, so this is a second line of defense.
func sameOrigin(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "none":
	default:
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		return strings.EqualFold(origin, "http://"+r.Host)
	}
	return true
}

func (s *Server) authenticated(r *http.Request) bool {
	c, err := r.Cookie(s.cookieName)
	return err == nil && s.validToken(c.Value)
}

func (s *Server) validToken(token string) bool {
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.opts.Token)) == 1
}

// startSession exchanges the token in the URL for a cookie and redirects to
// the same page without the token, so it doesn't stay in the address bar.
func (s *Server) startSession(w http.ResponseWriter, r *http.Request, token string) {
	if s.validToken(token) {
		http.SetCookie(w, &http.Cookie{
			Name:     s.cookieName,
			Value:    s.opts.Token,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})
	}
	query := r.URL.Query()
	query.Del("token")
	// One leading slash, so the redirect can't point to another host.
	target := url.URL{Path: "/" + strings.TrimLeft(r.URL.Path, "/"), RawQuery: query.Encode()}
	http.Redirect(w, r, target.String(), http.StatusSeeOther)
}

func (s *Server) handleUI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed.", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	info, err := fs.Stat(s.opts.UI, name)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	switch {
	case name == "index.html":
		w.Header().Set("Cache-Control", "no-cache")
	case strings.HasPrefix(name, "assets/"):
		// Vite puts a content hash in every asset name.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeFileFS(w, r, s.opts.UI, name)
}
