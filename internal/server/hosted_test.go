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
	"sync"
	"testing"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/egress"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
	"golang.org/x/time/rate"
)

const messageResult = `{"jsonrpc":"2.0","id":1,"result":{"message":{"messageId":"m","role":"ROLE_AGENT","parts":[{"text":"hi"}]}}}`

func newHosted(t *testing.T, limits Limits) *Server {
	t.Helper()
	s := newServer(t, Options{Hosted: true, Limits: limits})
	t.Cleanup(s.Close)
	return s
}

// browser makes requests to a hosted inspector with its own cookie, as one
// browser would.
type browser struct {
	s      *Server
	cookie string
}

func (b *browser) do(req request) *httptest.ResponseRecorder {
	if req.method == "" {
		req.method = http.MethodGet
	}
	r := httptest.NewRequest(req.method, req.target, strings.NewReader(req.body))
	r.Host = "inspector.example.com"
	if req.body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if b.cookie != "" {
		r.AddCookie(&http.Cookie{Name: hostedCookie, Value: b.cookie})
	}
	for k, v := range req.headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	b.s.ServeHTTP(w, r)
	for _, c := range w.Result().Cookies() {
		if c.Name == hostedCookie {
			b.cookie = c.Value
		}
	}
	return w
}

func (b *browser) connect(t *testing.T, url string) connectionResponse {
	t.Helper()
	w := b.do(request{method: http.MethodPost, target: "/api/connections", body: `{"interface":{"url":"` + url + `","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`})
	if w.Code != http.StatusCreated {
		t.Fatalf("POST /api/connections = %d %s", w.Code, w.Body)
	}
	return decodeBody[connectionResponse](t, w)
}

func entries(l *traffic.Log) int {
	snapshot, _, cancel := l.Subscribe(nil)
	cancel()
	return len(snapshot)
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	return decodeBody[errorResponse](t, w).Error.Code
}

func TestHostedSessions(t *testing.T) {
	s := newHosted(t, Limits{IdleTimeout: 10 * time.Minute})
	agent := jsonrpcAgent(t, "application/json", messageResult)

	t.Run("the page doesn't start a session", func(t *testing.T) {
		b := &browser{s: s}
		if w := b.do(request{target: "/"}); w.Code != http.StatusOK || len(w.Result().Cookies()) != 0 {
			t.Errorf("GET / = %d with cookies %v", w.Code, w.Result().Cookies())
		}
		if w := b.do(request{target: "/?token=x"}); w.Code != http.StatusOK || len(w.Result().Cookies()) != 0 {
			t.Errorf("GET /?token = %d with cookies %v, want the page", w.Code, w.Result().Cookies())
		}
	})

	t.Run("the first API call starts one", func(t *testing.T) {
		b := &browser{s: s}
		w := b.do(request{target: "/api/config"})
		if w.Code != http.StatusOK {
			t.Fatalf("GET /api/config = %d %s", w.Code, w.Body)
		}
		c := w.Result().Cookies()[0]
		if c.Name != hostedCookie || !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || len(c.Value) < 40 {
			t.Errorf("cookie = %+v", c)
		}
		cfg := decodeBody[configResponse](t, w)
		if cfg.Mode != "hosted" || cfg.Features != (features{}) || cfg.IdleTimeoutSeconds != 600 || cfg.Startup != nil || cfg.WebhookBaseURL != "" {
			t.Errorf("config = %+v", cfg)
		}
		if w := b.do(request{target: "/api/config"}); w.Code != http.StatusOK || len(w.Result().Cookies()) != 0 {
			t.Errorf("second call = %d with cookies %v, want the same session", w.Code, w.Result().Cookies())
		}
	})

	t.Run("browsers don't see each other's connections or traffic", func(t *testing.T) {
		alice, bob := &browser{s: s}, &browser{s: s}
		conn := alice.connect(t, agent.URL)
		bob.do(request{target: "/api/config"})
		if w := bob.do(request{target: "/api/connections/" + conn.ID}); w.Code != http.StatusNotFound {
			t.Errorf("bob reading alice's connection = %d", w.Code)
		}
		if w := alice.do(request{method: http.MethodPost, target: "/api/connections/" + conn.ID + "/messages:send", body: `{"compose":{"text":"hi"}}`}); w.Code != http.StatusOK {
			t.Fatalf("send = %d %s", w.Code, w.Body)
		}
		if n := entries(s.sessions.get(alice.cookie).traffic); n != 1 {
			t.Errorf("alice has %d traffic entries, want 1", n)
		}
		if n := entries(s.sessions.get(bob.cookie).traffic); n != 0 {
			t.Errorf("bob has %d traffic entries, want 0", n)
		}
	})

	t.Run("an ended session is renewed once for parallel requests", func(t *testing.T) {
		b := &browser{s: s}
		b.do(request{target: "/api/config"})
		old := b.cookie
		s.sessions.mu.Lock()
		s.sessions.endLocked(s.sessions.items[old], "test")
		s.sessions.mu.Unlock()

		w := b.do(request{target: "/api/config"})
		if w.Code != http.StatusUnauthorized || errorCode(t, w) != "sessionRenewed" || b.cookie == old {
			t.Fatalf("after the session ended = %d %s, cookie changed %v", w.Code, w.Body, b.cookie != old)
		}
		renewed := b.cookie
		other := &browser{s: s, cookie: old}
		if w := other.do(request{target: "/api/traffic"}); w.Code != http.StatusUnauthorized || other.cookie != renewed {
			t.Errorf("parallel request = %d, cookie %q, want the same new session %q", w.Code, other.cookie, renewed)
		}
		if w := b.do(request{target: "/api/config"}); w.Code != http.StatusOK {
			t.Errorf("with the new cookie = %d", w.Code)
		}
	})

	t.Run("an unknown cookie gets a new session too", func(t *testing.T) {
		b := &browser{s: s, cookie: "forged"}
		if w := b.do(request{target: "/api/config"}); w.Code != http.StatusUnauthorized || b.cookie == "forged" {
			t.Errorf("forged cookie = %d, cookie %q", w.Code, b.cookie)
		}
	})
}

func TestHostedSessionExpiry(t *testing.T) {
	s := newHosted(t, Limits{IdleTimeout: time.Minute, MaxAge: time.Hour})
	idle, busy, old := &browser{s: s}, &browser{s: s}, &browser{s: s}
	for _, b := range []*browser{idle, busy, old} {
		b.do(request{target: "/api/config"})
	}
	busySession := s.sessions.get(busy.cookie)
	busySession.begin()
	defer busySession.end()
	s.sessions.get(old.cookie).created = time.Now().Add(-2 * time.Hour)

	s.sessions.sweep(time.Now().Add(2 * time.Minute))
	if s.sessions.get(idle.cookie) != nil {
		t.Error("the idle session survived")
	}
	if s.sessions.get(busy.cookie) == nil {
		t.Error("the session with an open request ended")
	}
	if s.sessions.get(old.cookie) != nil {
		t.Error("the session past its maximum age survived")
	}
	select {
	case <-busySession.ctx.Done():
		t.Error("the busy session's context ended")
	default:
	}
}

func TestHostedSessionCap(t *testing.T) {
	s := newHosted(t, Limits{MaxSessions: 2})
	first, second := &browser{s: s}, &browser{s: s}
	first.do(request{target: "/api/config"})
	time.Sleep(10 * time.Millisecond)
	second.do(request{target: "/api/config"})

	third := &browser{s: s}
	if w := third.do(request{target: "/api/config"}); w.Code != http.StatusOK {
		t.Fatalf("third browser = %d %s", w.Code, w.Body)
	}
	if s.sessions.get(first.cookie) != nil || s.sessions.get(second.cookie) == nil {
		t.Error("the cap didn't replace the session idle the longest")
	}

	// With every session busy, there's no room.
	for _, b := range []*browser{second, third} {
		sess := s.sessions.get(b.cookie)
		sess.begin()
		t.Cleanup(sess.end)
	}
	if w := (&browser{s: s}).do(request{target: "/api/config"}); w.Code != http.StatusServiceUnavailable {
		t.Errorf("fourth browser = %d %s, want 503", w.Code, w.Body)
	}
}

func TestHostedRateLimits(t *testing.T) {
	t.Run("new sessions", func(t *testing.T) {
		s := newHosted(t, Limits{})
		s.sessions.create = rate.NewLimiter(0, 2)
		for i := range 3 {
			w := (&browser{s: s}).do(request{target: "/api/config"})
			if want := map[bool]int{true: http.StatusOK, false: http.StatusTooManyRequests}[i < 2]; w.Code != want {
				t.Errorf("session %d = %d, want %d", i, w.Code, want)
			}
		}
	})
	t.Run("requests per session", func(t *testing.T) {
		s := newHosted(t, Limits{RequestRate: 1})
		b := &browser{s: s}
		codes := []int{}
		for range 6 {
			codes = append(codes, b.do(request{target: "/api/config"}).Code)
		}
		// A burst of four, then 429.
		if codes[3] != http.StatusOK || codes[5] != http.StatusTooManyRequests {
			t.Errorf("codes = %v", codes)
		}
	})
	t.Run("requests to agents", func(t *testing.T) {
		agent := jsonrpcAgent(t, "application/json", messageResult)
		s := newHosted(t, Limits{EgressRate: 0.01})
		b := &browser{s: s}
		conn := b.connect(t, agent.URL)
		send := func() agentResult {
			w := b.do(request{method: http.MethodPost, target: "/api/connections/" + conn.ID + "/messages:send", body: `{"compose":{"text":"hi"}}`})
			return decodeBody[agentResult](t, w)
		}
		if res := send(); res.Call.Error != nil {
			t.Fatalf("first send: %+v", res.Call.Error)
		}
		if res := send(); res.Call.Error == nil || !strings.Contains(res.Call.Error.Message, "limit of requests to agents") {
			t.Errorf("second send error = %+v", res.Call.Error)
		}
	})
	t.Run("request body size", func(t *testing.T) {
		s := newHosted(t, Limits{})
		big := `{"card":` + `"` + strings.Repeat("x", hostedRequestSize) + `"}`
		if w := (&browser{s: s}).do(request{method: http.MethodPost, target: "/api/card:validate", body: big}); w.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("large body = %d", w.Code)
		}
	})
}

func TestHostedStreamLimit(t *testing.T) {
	s := newHosted(t, Limits{Streams: 1})
	inspector := httptest.NewServer(s)
	defer inspector.Close()
	b := &browser{s: s}
	b.do(request{target: "/api/config"})

	get := func(path string) *http.Response {
		req, _ := http.NewRequest(http.MethodGet, inspector.URL+path, nil)
		req.AddCookie(&http.Cookie{Name: hostedCookie, Value: b.cookie})
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	feed := get("/api/traffic")
	if feed.StatusCode != http.StatusOK {
		t.Fatalf("first feed = %d", feed.StatusCode)
	}
	second := get("/api/traffic")
	_ = second.Body.Close()
	if second.StatusCode != http.StatusTooManyRequests {
		t.Errorf("second feed = %d, want 429", second.StatusCode)
	}
	_ = feed.Body.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		resp := get("/api/traffic")
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the stream slot wasn't freed after the feed closed")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestHostedConnectionCap(t *testing.T) {
	agent := jsonrpcAgent(t, "application/json", messageResult)
	s := newHosted(t, Limits{Connections: 2})
	b := &browser{s: s}
	first := b.connect(t, agent.URL)
	time.Sleep(10 * time.Millisecond)
	second := b.connect(t, agent.URL)
	time.Sleep(10 * time.Millisecond)
	// Using the first makes the second the one used the longest ago.
	b.do(request{target: "/api/connections/" + first.ID})
	b.connect(t, agent.URL)
	if w := b.do(request{target: "/api/connections/" + second.ID}); w.Code != http.StatusNotFound || errorCode(t, w) != "unknownConnection" {
		t.Errorf("the least recently used connection = %d %s, want it replaced", w.Code, w.Body)
	}
	if w := b.do(request{target: "/api/connections/" + first.ID}); w.Code != http.StatusOK {
		t.Errorf("the recently used connection = %d", w.Code)
	}

	// Connections with calls in progress stay; with all of them busy, there's no room.
	sess := s.sessions.get(b.cookie)
	for _, c := range sess.conns.all() {
		t.Cleanup(c.use())
	}
	w := b.do(request{method: http.MethodPost, target: "/api/connections", body: `{"interface":{"url":"` + agent.URL + `","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`})
	if w.Code != http.StatusTooManyRequests {
		t.Errorf("connection with every slot streaming = %d %s", w.Code, w.Body)
	}
}

func TestHostedSwitches(t *testing.T) {
	agent := jsonrpcAgent(t, "application/json", messageResult)
	s := newHosted(t, Limits{})
	b := &browser{s: s}
	conn := b.connect(t, agent.URL)

	for _, req := range []request{
		{method: http.MethodPost, target: "/hooks/wh-x", body: "{}"},
		{target: "/api/hooks"},
		{method: http.MethodPatch, target: "/api/config", body: `{"webhookBaseUrl":"https://x"}`},
	} {
		// The UI's file server answers POST /hooks/... with 405.
		if w := b.do(req); w.Code != http.StatusNotFound && w.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s %s = %d, want it unrouted", req.method, req.target, w.Code)
		}
	}
	for _, req := range []request{
		{method: http.MethodPost, target: "/api/connections/" + conn.ID + "/tasks/t-1/pushNotificationConfigs", body: `{"inspectorWebhook":true}`},
		{method: http.MethodPost, target: "/api/connections/" + conn.ID + "/messages:send", body: `{"compose":{"text":"hi"},"options":{"pushNotifications":true}}`},
	} {
		if w := b.do(req); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "no webhook receiver") {
			t.Errorf("%s = %d %s", req.target, w.Code, w.Body)
		}
	}
	t.Setenv("A2A_INSPECTOR_TEST_SECRET", "operator-secret")
	w := b.do(request{method: http.MethodPost, target: "/api/connections", body: `{"interface":{"url":"` + agent.URL + `","protocolBinding":"JSONRPC","protocolVersion":"1.0"},"auth":{"bearer":{"envVar":"A2A_INSPECTOR_TEST_SECRET"}}}`})
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "environment variables") {
		t.Errorf("envVar secret = %d %s", w.Code, w.Body)
	}
	if _, err := New(Options{Hosted: true, UI: testUI, AgentCardURL: "https://agent.example.com"}); err == nil {
		t.Error("New() accepted a startup agent in hosted mode")
	}
}

func TestHostedEgress(t *testing.T) {
	policy, err := egress.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	s := newServer(t, Options{Hosted: true, Egress: policy})
	t.Cleanup(s.Close)
	b := &browser{s: s}

	for _, u := range []string{"http://169.254.169.254/", "http://127.0.0.1:1/", "http://10.0.0.1/", "http://[fd00:ec2::254]/"} {
		w := b.do(request{method: http.MethodPost, target: "/api/card:resolve", body: `{"url":"` + u + `"}`})
		res := decodeBody[cardResolveResponse](t, w)
		if res.Call.Error == nil || !strings.Contains(res.Call.Error.Message, "egress policy") {
			t.Errorf("card:resolve %s error = %+v, want blocked", u, res.Call.Error)
		}
	}

	grpcConn := func(url string) *httptest.ResponseRecorder {
		return b.do(request{method: http.MethodPost, target: "/api/connections", body: `{"interface":{"url":"` + url + `","protocolBinding":"GRPC","protocolVersion":"1.0"}}`})
	}
	if w := grpcConn("unix:///var/run/agent.sock"); w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "host:port") {
		t.Errorf("unix socket target = %d %s", w.Code, w.Body)
	}
	w := grpcConn("10.0.0.1:443")
	if w.Code != http.StatusCreated {
		t.Fatalf("gRPC connection = %d %s", w.Code, w.Body)
	}
	conn := decodeBody[connectionResponse](t, w)
	w = b.do(request{method: http.MethodPost, target: "/api/connections/" + conn.ID + "/messages:send", body: `{"compose":{"text":"hi"}}`})
	if res := decodeBody[agentResult](t, w); res.Call.Error == nil || !strings.Contains(res.Call.Error.Message, "egress policy") {
		t.Errorf("gRPC send to a private address = %+v", res.Call.Error)
	}
}

func TestRedirects(t *testing.T) {
	var mu sync.Mutex
	var got http.Header
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = r.Header.Clone()
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"name":"moved"}`)
	}))
	defer other.Close()
	sameOrigin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/card" {
			http.Redirect(w, r, "/moved", http.StatusFound)
			return
		}
		if r.URL.Path == "/elsewhere" {
			http.Redirect(w, r, other.URL+"/card", http.StatusFound)
			return
		}
		mu.Lock()
		got = r.Header.Clone()
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"name":"here"}`)
	}))
	defer sameOrigin.Close()
	s := newServer(t, Options{})
	resolve := func(url string) cardResolveResponse {
		body, _ := json.Marshal(map[string]any{
			"url":     url,
			"auth":    map[string]any{"apiKey": map[string]any{"header": "X-API-Key", "key": map[string]any{"value": "key-0123456789abcdef"}}},
			"headers": []map[string]any{{"name": "X-Tenant", "value": "acme"}},
		})
		return decodeBody[cardResolveResponse](t, s.do(request{method: http.MethodPost, target: "/api/card:resolve", body: string(body), cookie: true}))
	}

	if res := resolve(sameOrigin.URL + "/card"); res.Call.Error != nil || got.Get("X-API-Key") == "" || got.Get("X-Tenant") != "acme" {
		t.Errorf("same-origin redirect: error %+v, headers %v; want the configured headers kept", res.Call.Error, got)
	}
	if res := resolve(sameOrigin.URL + "/elsewhere"); res.Call.Error != nil || got.Get("X-API-Key") != "" || got.Get("X-Tenant") != "" {
		t.Errorf("cross-origin redirect: error %+v, headers %v; want the configured headers dropped", res.Call.Error, got)
	}

	tlsAgent := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/card", http.StatusFound)
	}))
	defer tlsAgent.Close()
	s = newServer(t, Options{HTTPTransport: tlsAgent.Client().Transport})
	if res := resolve(tlsAgent.URL + "/card"); res.Call.Error == nil || !strings.Contains(res.Call.Error.Message, "redirect from https") {
		t.Errorf("https to http redirect with credentials: error = %+v", res.Call.Error)
	}
}

func TestStreamDurationLimit(t *testing.T) {
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer agent.Close()
	s := newServer(t, Options{Limits: Limits{StreamDuration: 200 * time.Millisecond}})
	conn := s.connect(t, `{"interface":{"url":"`+agent.URL+`","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`)
	events := s.stream(t, conn.ID, `{"compose":{"text":"hi"}}`)
	if len(events) != 1 || events[0].Call.Error == nil || !strings.Contains(events[0].Call.Error.Message, "ended the stream after 200ms") {
		t.Errorf("events = %+v", events)
	}
}

func TestOriginOverHTTPS(t *testing.T) {
	s := newServer(t, Options{})
	w := s.do(request{method: http.MethodPost, target: "/api/card:validate", body: `{"card":{}}`, cookie: true, headers: map[string]string{"Origin": "https://" + testHost}})
	if w.Code != http.StatusOK {
		t.Errorf("same host over https = %d %s", w.Code, w.Body)
	}
}
