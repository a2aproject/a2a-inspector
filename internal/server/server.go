// Package server serves the inspector's embedded UI and the private JSON API
// the UI uses. It isn't an A2A service: the UI never talks to agents itself.
package server

import (
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
	"time"
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
	// UI holds the built UI, with index.html at its root.
	UI fs.FS
	// HTTPClient fetches agent cards. It defaults to a client with a
	// 30-second timeout.
	HTTPClient *http.Client
}

// Server is the inspector's HTTP handler.
type Server struct {
	opts         Options
	client       *http.Client
	mux          *http.ServeMux
	cookieName   string
	anyHost      bool
	allowedHosts map[string]bool
}

// New returns a Server for opts.
func New(opts Options) (*Server, error) {
	if opts.Token == "" {
		return nil, errors.New("server: empty session token")
	}
	if opts.UI == nil {
		return nil, errors.New("server: no UI files")
	}
	s := &Server{
		opts:       opts,
		client:     opts.HTTPClient,
		mux:        http.NewServeMux(),
		cookieName: fmt.Sprintf("a2a_inspector_%d", opts.Port),
	}
	if s.client == nil {
		s.client = &http.Client{Timeout: 30 * time.Second}
	}
	s.anyHost, s.allowedHosts = allowedHosts(opts.Host, opts.Port)

	s.mux.HandleFunc("GET /api/config", s.handleConfig)
	s.mux.HandleFunc("POST /api/card:resolve", s.handleCardResolve)
	s.mux.HandleFunc("POST /api/card:validate", s.handleCardValidate)
	s.mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "Unknown API endpoint.")
	})
	s.mux.HandleFunc("/", s.handleUI)
	return s, nil
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
