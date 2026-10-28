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
	"log"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/egress"
	"golang.org/x/time/rate"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
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
	// Token is the per-run session token, given to the user in the URL. A
	// hosted inspector has none.
	Token string
	// Hosted runs the inspector as a shared service: every browser gets its
	// own session from a cookie, within Limits, and the features that would
	// expose the server or its environment are off.
	Hosted bool
	Limits Limits
	// Egress, if set, limits which addresses the inspector connects to.
	Egress *egress.Policy
	// Logger, if set, receives hosted-mode events: sessions and blocked
	// destinations. It never gets traffic.
	Logger *log.Logger
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
	// http.DefaultTransport, or the Egress policy's transport, wrapped with
	// WrapHTTPTransport; the inspector records the traffic around it. A
	// transport given here is used as is, so it has to apply the Egress
	// policy to HTTP itself.
	HTTPTransport     http.RoundTripper
	WrapHTTPTransport func(http.RoundTripper) http.RoundTripper
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
	opts Options
	// transport and grpcOptions reach agents, for every session.
	transport   http.RoundTripper
	grpcOptions []grpc.DialOption
	supports    func(binding, version string) bool
	// local is the session of a local inspector; sessions are the ones of a
	// hosted inspector.
	local        *session
	sessions     *sessions
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

// errEgressRate fails requests over Limits.EgressRate.
var errEgressRate = errors.New("the inspector's limit of requests to agents was reached; try again in a moment")

// New returns a Server for opts.
func New(opts Options) (*Server, error) {
	switch {
	case opts.Token == "" && !opts.Hosted:
		return nil, errors.New("server: empty session token")
	case opts.UI == nil:
		return nil, errors.New("server: no UI files")
	case opts.Hosted && (opts.AgentCardURL != "" || opts.Endpoint != nil || len(opts.StartupHeaders) > 0 || opts.WebhookBaseURL != ""):
		return nil, errors.New("server: a hosted inspector has no startup agent, credentials or webhooks")
	}
	s := &Server{
		opts:       opts,
		transport:  opts.HTTPTransport,
		supports:   (&agents.Dialer{Transports: opts.Transports}).Supports,
		mux:        http.NewServeMux(),
		cookieName: fmt.Sprintf("a2a_inspector_%d", opts.Port),
	}
	if s.transport == nil {
		s.transport = http.DefaultTransport
		if opts.Egress != nil {
			s.transport = opts.Egress.Transport()
		}
		if opts.WrapHTTPTransport != nil {
			s.transport = opts.WrapHTTPTransport(s.transport)
		}
	}
	if r := opts.Limits.EgressRate; r > 0 {
		limiter := rate.NewLimiter(rate.Limit(r), max(1, int(2*r)))
		s.transport = &limitedTransport{base: s.transport, limiter: limiter}
		s.grpcOptions = limitedGRPC(limiter)
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
	if opts.Hosted {
		s.anyHost = true
		s.sessions = newSessions(opts.Limits, s.logf)
		go s.sweepSessions()
	} else {
		s.anyHost, s.allowedHosts = allowedHosts(opts.Host, opts.Port)
		s.local = s.newSession("")
		startup, err := s.newStartupConfig()
		if err != nil {
			return nil, err
		}
		s.startup = startup
	}

	s.mux.HandleFunc("GET /api/config", s.handleConfig)
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
	if s.webhooks() {
		s.mux.HandleFunc("PATCH /api/config", s.handlePatchConfig)
		s.mux.HandleFunc("GET /api/hooks", s.handleHooks)
		s.mux.HandleFunc("POST /hooks/{hook}", s.handleHook)
	}
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
	if s.local != nil {
		s.local.close()
	}
	if s.sessions != nil {
		s.sessions.closeAll()
	}
}

// webhooks reports whether the webhook receiver is on. A hosted inspector
// sits behind whatever controls access to it, which agents can't pass.
func (s *Server) webhooks() bool { return !s.opts.Hosted }

func (s *Server) logf(format string, args ...any) {
	if s.opts.Logger != nil {
		s.opts.Logger.Printf(format, args...)
	}
}

// sweepSessions ends idle and old sessions until the server closes.
func (s *Server) sweepSessions() {
	interval := min(cmp.Or(s.opts.Limits.IdleTimeout, time.Minute)/4, 30*time.Second)
	ticker := time.NewTicker(max(interval, time.Second))
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case now := <-ticker.C:
			s.sessions.sweep(now)
		}
	}
}

// callContext is the context of a call to an agent: it ends with the
// request, or when the session ends or the server closes.
func (s *Server) callContext(r *http.Request) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(sessionOf(r).ctx, cancel)
	return ctx, func() {
		stop()
		cancel()
	}
}

// limitedTransport fails requests over the inspector's rate of requests to agents.
type limitedTransport struct {
	base    http.RoundTripper
	limiter *rate.Limiter
}

func (t *limitedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !t.limiter.Allow() {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, errEgressRate
	}
	return t.base.RoundTrip(req)
}

// limitedGRPC fails gRPC calls over the inspector's rate of requests to agents.
func limitedGRPC(limiter *rate.Limiter) []grpc.DialOption {
	exhausted := status.Error(codes.ResourceExhausted, errEgressRate.Error())
	return []grpc.DialOption{
		grpc.WithChainUnaryInterceptor(func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
			if !limiter.Allow() {
				return exhausted
			}
			return invoker(ctx, method, req, reply, cc, opts...)
		}),
		grpc.WithChainStreamInterceptor(func(ctx context.Context, desc *grpc.StreamDesc, cc *grpc.ClientConn, method string, streamer grpc.Streamer, opts ...grpc.CallOption) (grpc.ClientStream, error) {
			if !limiter.Allow() {
				return nil, exhausted
			}
			return streamer(ctx, desc, cc, method, opts...)
		}),
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
	if s.webhooks() && strings.HasPrefix(path.Clean(r.URL.Path), "/hooks/") {
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
		sess, ok := s.apiSession(w, r)
		if !ok {
			return
		}
		if sess.limiter != nil && !sess.limiter.Allow() {
			writeError(w, http.StatusTooManyRequests, "Too many requests. Wait a moment and try again.")
			return
		}
		if s.opts.Hosted {
			r.Body = http.MaxBytesReader(w, r.Body, hostedRequestSize)
		}
		sess.begin()
		defer sess.end()
		r = r.WithContext(context.WithValue(r.Context(), sessionKey{}, sess))
	} else if token := r.URL.Query().Get("token"); token != "" && !s.opts.Hosted && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		s.startSession(w, r, token)
		return
	}
	s.mux.ServeHTTP(w, r)
}

// apiSession returns the session of an API request, or writes why it has
// none. A hosted inspector starts a session for a browser without one, and
// replaces a session that ended with a new one: the answer is then 401 with
// the code "sessionRenewed", so the UI knows its connections are gone.
func (s *Server) apiSession(w http.ResponseWriter, r *http.Request) (*session, bool) {
	if !s.opts.Hosted {
		if !s.authenticated(r) {
			writeError(w, http.StatusUnauthorized, "No valid session. Open the URL the inspector printed when it started.")
			return nil, false
		}
		return s.local, true
	}
	var stale string
	if c, err := r.Cookie(hostedCookie); err == nil {
		if sess := s.sessions.get(c.Value); sess != nil {
			return sess, true
		}
		stale = c.Value
	}
	sess, err := s.sessions.renew(stale, func() *session { return s.newSession(randomString(32)) })
	switch {
	case errors.Is(err, errTooManySessions):
		writeError(w, http.StatusTooManyRequests, capitalize(err.Error())+".")
		return nil, false
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, capitalize(err.Error())+".")
		return nil, false
	}
	http.SetCookie(w, &http.Cookie{
		Name:     hostedCookie,
		Value:    sess.id,
		Path:     "/",
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	if stale != "" {
		writeErrorCode(w, http.StatusUnauthorized, "sessionRenewed",
			"Your session ended, so the inspector started a new one. Its connections and the credentials you entered are gone.")
		return nil, false
	}
	return sess, true
}

// sameOrigin rejects requests a browser sends on behalf of another site. The
// session cookie is SameSite=Strict, so this is a second line of defense.
// The inspector may be reached through an https front end, such as a tunnel
// or a hosting platform.
func sameOrigin(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "none":
	default:
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		return strings.EqualFold(origin, "http://"+r.Host) || strings.EqualFold(origin, "https://"+r.Host)
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
