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

package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2acompat/a2av0"
	"github.com/a2aproject/a2a-go/v2/a2asrv"
)

const (
	testToken = "test-token"
	testPort  = 8080
	testHost  = "127.0.0.1:8080"
)

var testUI = fstest.MapFS{
	"index.html":    {Data: []byte("<!doctype html><title>A2A Inspector</title>")},
	"assets/app.js": {Data: []byte("console.log('app')")},
}

func newServer(t *testing.T, opts Options) *Server {
	t.Helper()
	if opts.Token == "" {
		opts.Token = testToken
	}
	if opts.Port == 0 {
		opts.Port = testPort
	}
	if opts.Host == "" {
		opts.Host = "127.0.0.1"
	}
	if opts.UI == nil {
		opts.UI = testUI
	}
	s, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

type request struct {
	method  string
	target  string
	body    string
	host    string
	cookie  bool
	headers map[string]string
}

func (s *Server) do(req request) *httptest.ResponseRecorder {
	if req.method == "" {
		req.method = http.MethodGet
	}
	r := httptest.NewRequest(req.method, req.target, strings.NewReader(req.body))
	r.Host = testHost
	if req.host != "" {
		r.Host = req.host
	}
	if req.body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if req.cookie {
		r.AddCookie(&http.Cookie{Name: s.cookieName, Value: testToken})
	}
	for k, v := range req.headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func decodeBody[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("decoding %q: %v", w.Body.String(), err)
	}
	return v
}

func TestNew(t *testing.T) {
	if _, err := New(Options{UI: testUI}); err == nil {
		t.Error("New() without a token succeeded")
	}
	if _, err := New(Options{Token: testToken}); err == nil {
		t.Error("New() without UI files succeeded")
	}
}

func TestSession(t *testing.T) {
	s := newServer(t, Options{})

	t.Run("valid token sets the cookie and drops the token from the URL", func(t *testing.T) {
		w := s.do(request{target: "/?token=" + testToken + "&agent=x"})
		if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/?agent=x" {
			t.Fatalf("got %d to %q, want 303 to /?agent=x", w.Code, w.Header().Get("Location"))
		}
		cookies := w.Result().Cookies()
		if len(cookies) != 1 {
			t.Fatalf("got %d cookies, want 1", len(cookies))
		}
		c := cookies[0]
		if c.Name != "a2a_inspector_8080" || c.Value != testToken || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" {
			t.Errorf("cookie = %+v", c)
		}
	})
	t.Run("invalid token redirects without a cookie", func(t *testing.T) {
		w := s.do(request{target: "/?token=wrong"})
		if w.Code != http.StatusSeeOther || len(w.Result().Cookies()) != 0 {
			t.Errorf("got %d with cookies %v", w.Code, w.Result().Cookies())
		}
	})
	t.Run("redirect stays on this host", func(t *testing.T) {
		w := s.do(request{target: "//evil.example.com/?token=" + testToken})
		if loc := w.Header().Get("Location"); loc != "/evil.example.com/" {
			t.Errorf("Location = %q", loc)
		}
	})
	t.Run("API needs the cookie", func(t *testing.T) {
		if w := s.do(request{target: "/api/config"}); w.Code != http.StatusUnauthorized {
			t.Errorf("without cookie: %d, want 401", w.Code)
		}
		if w := s.do(request{target: "/api/config", headers: map[string]string{"Cookie": "a2a_inspector_8080=wrong"}}); w.Code != http.StatusUnauthorized {
			t.Errorf("with a wrong cookie: %d, want 401", w.Code)
		}
		if w := s.do(request{target: "/api/config", cookie: true}); w.Code != http.StatusOK {
			t.Errorf("with cookie: %d, want 200", w.Code)
		}
	})
	t.Run("the cookie name includes the port", func(t *testing.T) {
		other := newServer(t, Options{Port: 9090})
		r := request{target: "/api/config", host: "127.0.0.1:9090", headers: map[string]string{"Cookie": "a2a_inspector_8080=" + testToken}}
		if w := other.do(r); w.Code != http.StatusUnauthorized {
			t.Errorf("cookie for port 8080 on port 9090: %d, want 401", w.Code)
		}
	})
}

func TestHostCheck(t *testing.T) {
	s := newServer(t, Options{})
	for host, want := range map[string]int{
		"127.0.0.1:8080":    http.StatusOK,
		"localhost:8080":    http.StatusOK,
		"LOCALHOST:8080":    http.StatusOK,
		"[::1]:8080":        http.StatusOK,
		"127.0.0.1:9999":    http.StatusMisdirectedRequest,
		"evil.example:8080": http.StatusMisdirectedRequest,
		"127.0.0.1":         http.StatusMisdirectedRequest,
	} {
		if w := s.do(request{target: "/", host: host}); w.Code != want {
			t.Errorf("Host %q: %d, want %d", host, w.Code, want)
		}
	}

	wildcard := newServer(t, Options{Host: "0.0.0.0"})
	if w := wildcard.do(request{target: "/", host: "inspector.example:8080"}); w.Code != http.StatusOK {
		t.Errorf("listening on all addresses, Host inspector.example: %d, want 200", w.Code)
	}
	specific := newServer(t, Options{Host: "192.168.1.5"})
	for host, want := range map[string]int{"192.168.1.5:8080": http.StatusOK, "localhost:8080": http.StatusOK, "evil.example:8080": http.StatusMisdirectedRequest} {
		if w := specific.do(request{target: "/", host: host}); w.Code != want {
			t.Errorf("listening on 192.168.1.5, Host %q: %d, want %d", host, w.Code, want)
		}
	}
}

func TestCrossOriginRequests(t *testing.T) {
	s := newServer(t, Options{})
	tests := []struct {
		name    string
		method  string
		headers map[string]string
		want    int
	}{
		{"same origin fetch", http.MethodPost, map[string]string{"Sec-Fetch-Site": "same-origin", "Origin": "http://" + testHost}, http.StatusOK},
		{"non-browser client", http.MethodPost, nil, http.StatusOK},
		{"typed into the address bar", http.MethodGet, map[string]string{"Sec-Fetch-Site": "none"}, http.StatusOK},
		{"cross-site fetch", http.MethodPost, map[string]string{"Sec-Fetch-Site": "cross-site"}, http.StatusForbidden},
		{"other port on this machine", http.MethodPost, map[string]string{"Sec-Fetch-Site": "same-site"}, http.StatusForbidden},
		{"foreign Origin", http.MethodPost, map[string]string{"Origin": "http://evil.example"}, http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := request{method: tc.method, target: "/api/config", cookie: true, headers: tc.headers}
			if tc.method == http.MethodPost {
				r.target = "/api/card:validate"
				r.body = `{"card": {"name": "x"}}`
			}
			if w := s.do(r); w.Code != tc.want {
				t.Errorf("got %d, want %d: %s", w.Code, tc.want, w.Body)
			}
		})
	}
	t.Run("JSON content type required", func(t *testing.T) {
		w := s.do(request{method: http.MethodPost, target: "/api/card:validate", cookie: true, body: "card=x", headers: map[string]string{"Content-Type": "application/x-www-form-urlencoded"}})
		if w.Code != http.StatusUnsupportedMediaType {
			t.Errorf("got %d, want 415", w.Code)
		}
	})
}

func TestResponseHeaders(t *testing.T) {
	s := newServer(t, Options{})
	for _, target := range []string{"/", "/assets/app.js", "/api/config"} {
		w := s.do(request{target: target, cookie: true, headers: map[string]string{"Origin": "http://" + testHost}})
		h := w.Header()
		if !strings.Contains(h.Get("Content-Security-Policy"), "script-src 'self'") || h.Get("X-Content-Type-Options") != "nosniff" || h.Get("X-Frame-Options") != "DENY" {
			t.Errorf("%s: missing security headers: %v", target, h)
		}
		for name := range h {
			if strings.HasPrefix(name, "Access-Control-") {
				t.Errorf("%s: unexpected CORS header %s", target, name)
			}
		}
	}
}

func TestUIFiles(t *testing.T) {
	s := newServer(t, Options{})
	tests := []struct {
		target, cache string
		code          int
		body          string
	}{
		{"/", "no-cache", http.StatusOK, "A2A Inspector"},
		{"/assets/app.js", "immutable", http.StatusOK, "console.log"},
		{"/missing.js", "", http.StatusNotFound, ""},
		{"/assets", "", http.StatusNotFound, ""},
	}
	for _, tc := range tests {
		w := s.do(request{target: tc.target})
		if w.Code != tc.code || !strings.Contains(w.Header().Get("Cache-Control"), tc.cache) || !strings.Contains(w.Body.String(), tc.body) {
			t.Errorf("GET %s = %d, Cache-Control %q, body %q", tc.target, w.Code, w.Header().Get("Cache-Control"), w.Body)
		}
	}
	w := s.do(request{target: "/api/nope", cookie: true})
	if w.Code != http.StatusNotFound || !strings.Contains(w.Header().Get("Content-Type"), "json") {
		t.Errorf("GET /api/nope = %d %s", w.Code, w.Header().Get("Content-Type"))
	}
}

func TestConfig(t *testing.T) {
	s := newServer(t, Options{AgentCardURL: "https://agent.example.com/.well-known/agent-card.json"})
	w := s.do(request{target: "/api/config", cookie: true})
	got := decodeBody[configResponse](t, w)
	if got.Mode != "local" || got.AgentCardURL != "https://agent.example.com/.well-known/agent-card.json" || got.Features.Serve || !got.Features.Webhooks {
		t.Errorf("config = %+v", got)
	}
	if got.WebhookBaseURL != "http://127.0.0.1:8080" || got.DefaultWebhookBaseURL != "http://127.0.0.1:8080" {
		t.Errorf("webhook base URLs = %q, %q", got.WebhookBaseURL, got.DefaultWebhookBaseURL)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", w.Header().Get("Cache-Control"))
	}
}

func testCard() *a2a.AgentCard {
	return &a2a.AgentCard{
		Name:        "Test agent",
		Description: "An agent for tests",
		Version:     "1.0.0",
		SupportedInterfaces: []*a2a.AgentInterface{
			{URL: "https://agent.example.com/v03", ProtocolBinding: a2a.TransportProtocolJSONRPC, ProtocolVersion: a2av0.Version},
			a2a.NewAgentInterface("https://agent.example.com/a2a", a2a.TransportProtocolHTTPJSON),
		},
		DefaultInputModes:  []string{"text/plain"},
		DefaultOutputModes: []string{"text/plain"},
		Skills:             []a2a.AgentSkill{{ID: "echo", Name: "Echo", Description: "Echoes back", Tags: []string{"echo"}}},
	}
}

func agentServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle("/.well-known/agent-card.json", a2asrv.NewStaticAgentCardHandler(testCard()))
	mux.Handle("/compat/card.json", a2asrv.NewAgentCardHandler(a2av0.NewStaticAgentCardProducer(testCard())))
	mux.HandleFunc("/html", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "<html>not a card</html>")
	})
	mux.HandleFunc("/array.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "[]")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestCardResolve(t *testing.T) {
	agent := agentServer(t)
	s := newServer(t, Options{HTTPTransport: agent.Client().Transport})
	resolve := func(t *testing.T, url string) (*httptest.ResponseRecorder, cardResolveResponse) {
		t.Helper()
		body, _ := json.Marshal(cardResolveRequest{URL: url})
		w := s.do(request{method: http.MethodPost, target: "/api/card:resolve", cookie: true, body: string(body)})
		if w.Code != http.StatusOK {
			return w, cardResolveResponse{}
		}
		return w, decodeBody[cardResolveResponse](t, w)
	}

	t.Run("v1.0 card", func(t *testing.T) {
		_, got := resolve(t, agent.URL)
		if got.Call.Error != nil || got.Payload == nil {
			t.Fatalf("resolve = %+v", got)
		}
		if got.CardURL != agent.URL+"/.well-known/agent-card.json" || got.Payload.ProtocolVersion != "1.0" {
			t.Errorf("cardUrl %q, protocolVersion %q", got.CardURL, got.Payload.ProtocolVersion)
		}
		if len(got.Interfaces) != 2 || got.DefaultInterface == nil || *got.DefaultInterface != 0 || got.Interfaces[1].ProtocolBinding != "HTTP+JSON" {
			t.Errorf("interfaces %+v, default %v", got.Interfaces, got.DefaultInterface)
		}
		var card map[string]any
		if err := json.Unmarshal(got.Payload.Raw, &card); err != nil || card["name"] != "Test agent" {
			t.Errorf("raw card = %s", got.Payload.Raw)
		}
		for _, f := range got.Payload.Validation.Findings {
			if f.Severity == "ERROR" {
				t.Errorf("unexpected error finding: %+v", f)
			}
		}
	})
	t.Run("v1.0 card with v0.3 fields", func(t *testing.T) {
		_, got := resolve(t, agent.URL+"/compat/card.json")
		if got.Payload == nil || strings.Join(got.Versions, ",") != "1.0,0.3" {
			t.Errorf("versions = %v, payload %v", got.Versions, got.Payload)
		}
	})
	t.Run("agent failures are reported in call.error", func(t *testing.T) {
		tests := []struct {
			url  string
			code int
		}{
			{agent.URL + "/missing.json", http.StatusNotFound},
			{agent.URL + "/html", 0},
			{"http://127.0.0.1:1", 0},
		}
		for _, tc := range tests {
			_, got := resolve(t, tc.url)
			if got.Call.Error == nil || got.Call.Error.Code != tc.code || got.Payload != nil {
				t.Errorf("resolve(%s) = %+v, error %+v", tc.url, got, got.Call.Error)
			}
		}
	})
	t.Run("a card that isn't an object is a validation finding", func(t *testing.T) {
		_, got := resolve(t, agent.URL+"/array.json")
		if got.Payload == nil || len(got.Payload.Validation.Findings) != 1 || got.Payload.Validation.Findings[0].Rule != "card-object" {
			t.Errorf("resolve = %+v", got.Payload)
		}
	})
	t.Run("invalid input", func(t *testing.T) {
		for _, url := range []string{"", "./card.json", "ftp://agent.example.com"} {
			if w, _ := resolve(t, url); w.Code != http.StatusBadRequest {
				t.Errorf("resolve(%q) = %d, want 400", url, w.Code)
			}
		}
		w := s.do(request{method: http.MethodPost, target: "/api/card:resolve", cookie: true, body: "{"})
		if w.Code != http.StatusBadRequest {
			t.Errorf("malformed body: %d, want 400", w.Code)
		}
	})
}

func TestCardValidate(t *testing.T) {
	s := newServer(t, Options{})
	validateCard := func(body string) (*httptest.ResponseRecorder, cardValidateResponse) {
		w := s.do(request{method: http.MethodPost, target: "/api/card:validate", cookie: true, body: body})
		if w.Code != http.StatusOK {
			return w, cardValidateResponse{}
		}
		return w, decodeBody[cardValidateResponse](t, w)
	}
	card, _ := json.Marshal(testCard())

	_, got := validateCard(`{"card": ` + string(card) + `}`)
	if got.ProtocolVersion != "1.0" || len(got.Interfaces) != 2 || got.DefaultInterface == nil {
		t.Errorf("validate = %+v", got)
	}
	for _, f := range got.Validation.Findings {
		if f.Severity == "ERROR" || f.Rule == "content-type" {
			t.Errorf("unexpected finding %+v", f)
		}
	}

	_, got = validateCard(`{"card": {"name": "x"}, "protocolVersion": "0.3"}`)
	if got.ProtocolVersion != "0.3" || len(got.Validation.Findings) == 0 || got.Validation.Findings[0].Rule != "required" {
		t.Errorf("forced v0.3 validate = %+v", got)
	}

	_, got = validateCard(`{"card": "not a card"}`)
	if len(got.Validation.Findings) != 1 || got.Validation.Findings[0].Rule != "card-object" {
		t.Errorf("validate string = %+v", got)
	}

	for _, body := range []string{`{}`, `{"card": null}`, `{"card": {}, "protocolVersion": "2.0"}`} {
		if w, _ := validateCard(body); w.Code != http.StatusBadRequest {
			t.Errorf("validate(%s) = %d, want 400", body, w.Code)
		}
	}
}
