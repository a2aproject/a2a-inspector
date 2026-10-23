package server

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/traffic"
)

func TestConnectionErrors(t *testing.T) {
	s := newServer(t, Options{})
	tests := []struct {
		name, body, want string
	}{
		{"nothing to connect to", `{}`, `Give \"cardUrl\"`},
		{"unsupported binding", `{"interface":{"url":"ws://a","protocolBinding":"WEBSOCKET","protocolVersion":"1.0"}}`, "doesn't support WEBSOCKET 1.0"},
		{"unsupported version", `{"interface":{"url":"http://a","protocolBinding":"JSONRPC","protocolVersion":"2.0"}}`, "doesn't support JSONRPC 2.0"},
		{"no URL", `{"interface":{"url":" ","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`, "needs a URL"},
		{"two auth presets", `{"interface":{"url":"http://a","protocolBinding":"JSONRPC","protocolVersion":"1.0"},"auth":{"bearer":{"value":"x"},"apiKey":{"header":"X-Key","key":{"value":"y"}}}}`, "takes one of"},
		{"bad header name", `{"interface":{"url":"http://a","protocolBinding":"JSONRPC","protocolVersion":"1.0"},"headers":[{"name":"Bad Header","value":"x"}]}`, "isn't a valid header name"},
		{"unset environment variable", `{"interface":{"url":"http://a","protocolBinding":"JSONRPC","protocolVersion":"1.0"},"auth":{"bearer":{"envVar":"A2A_INSPECTOR_TEST_UNSET"}}}`, "A2A_INSPECTOR_TEST_UNSET isn't set"},
		{"unknown secret", `{"interface":{"url":"http://a","protocolBinding":"JSONRPC","protocolVersion":"1.0"},"auth":{"bearer":{"ref":"sec-99"}}}`, "unknown secret"},
		{"secret with two sources", `{"interface":{"url":"http://a","protocolBinding":"JSONRPC","protocolVersion":"1.0"},"auth":{"bearer":{"value":"x","envVar":"Y"}}}`, "needs exactly one of"},
		{"card without usable interfaces", `{"card":{"name":"x","supportedInterfaces":[{"url":"ws://a","protocolBinding":"WEBSOCKET","protocolVersion":"1.0"}]}}`, "Add a custom interface"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := s.do(request{method: http.MethodPost, target: "/api/connections", body: tt.body, cookie: true})
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), tt.want) {
				t.Errorf("POST /api/connections = %d %s, want 400 with %q", w.Code, w.Body, tt.want)
			}
		})
	}
}

func TestConnectionFromCard(t *testing.T) {
	agent := agentServer(t)
	s := newServer(t, Options{HTTPTransport: agent.Client().Transport})
	conn := s.connect(t, `{"cardUrl":"`+agent.URL+`/.well-known/agent-card.json"}`)
	if conn.Custom || conn.Interface.Source != "supportedInterfaces[0]" || conn.Interface.ProtocolVersion != "0.3" {
		t.Errorf("interface = %+v, want the card's first", conn.Interface)
	}
	if conn.Card == nil || len(conn.AvailableInterfaces) != 2 {
		t.Errorf("card = %+v, interfaces = %+v", conn.Card, conn.AvailableInterfaces)
	}

	// An interface the card lists isn't custom, even when given explicitly.
	listed := s.connect(t, `{"cardUrl":"`+agent.URL+`/.well-known/agent-card.json","interface":{"url":"https://agent.example.com/a2a","protocolBinding":"http+json","protocolVersion":"1.0"}}`)
	if listed.Custom || listed.Interface.ProtocolBinding != "HTTP+JSON" || listed.Interface.Source != "supportedInterfaces[1]" {
		t.Errorf("interface = %+v", listed.Interface)
	}

	if w := s.do(request{target: "/api/connections/" + conn.ID, cookie: true}); w.Code != http.StatusOK {
		t.Errorf("GET = %d", w.Code)
	}
	s.do(request{method: http.MethodDelete, target: "/api/connections/" + conn.ID, cookie: true})
	if w := s.do(request{target: "/api/connections/" + conn.ID, cookie: true}); w.Code != http.StatusNotFound {
		t.Errorf("GET after DELETE = %d, want 404", w.Code)
	}
	w := s.do(request{method: http.MethodPost, target: "/api/connections", body: `{"cardUrl":"` + agent.URL + `/html"}`, cookie: true})
	if w.Code != http.StatusBadGateway {
		t.Errorf("connecting with a broken card URL = %d %s, want 502", w.Code, w.Body)
	}
}

func TestSecrets(t *testing.T) {
	t.Setenv("A2A_INSPECTOR_TEST_TOKEN", "env-token-value-123456")
	s := newServer(t, Options{})
	const iface = `"interface":{"url":"http://127.0.0.1:1","protocolBinding":"JSONRPC","protocolVersion":"1.0"}`
	conn := s.connect(t, `{`+iface+`,"auth":{"basic":{"username":"ann","password":{"envVar":"A2A_INSPECTOR_TEST_TOKEN"}}},
		"headers":[{"name":"X-Key","secret":{"value":"short"}}]}`)
	auth := conn.Auth
	if auth == nil || auth.Type != "basic" || auth.Username != "ann" || auth.Secret.EnvVar != "A2A_INSPECTOR_TEST_TOKEN" || auth.Secret.Masked != traffic.Masked+"3456" {
		t.Fatalf("auth = %+v", auth)
	}
	if h := conn.Headers[0]; h.Secret == nil || h.Secret.Masked != traffic.Masked || h.Value != "" {
		t.Errorf("header = %+v, want a masked secret", h)
	}

	// A reference reuses the stored secret, so the UI never needs the value.
	again := s.connect(t, `{`+iface+`,"auth":{"bearer":{"ref":"`+auth.Secret.Ref+`"}}}`)
	if again.Auth.Secret.Ref != auth.Secret.Ref {
		t.Errorf("ref = %q, want %q", again.Auth.Secret.Ref, auth.Secret.Ref)
	}
	params, secrets, err := mustConnection(t, s, again.ID).params()
	if err != nil {
		t.Fatal(err)
	}
	if got := params.Get("Authorization"); len(got) != 1 || got[0] != "Bearer env-token-value-123456" {
		t.Errorf("Authorization = %q", got)
	}
	if len(secrets) == 0 {
		t.Error("no secrets to mask")
	}

	// Environment variables are read on every call.
	if err := os.Unsetenv("A2A_INSPECTOR_TEST_TOKEN"); err != nil {
		t.Fatal(err)
	}
	w := s.do(request{method: http.MethodPost, target: "/api/connections/" + again.ID + "/messages:send", body: `{"compose":{"text":"hi"}}`, cookie: true})
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "A2A_INSPECTOR_TEST_TOKEN") {
		t.Errorf("send without the variable = %d %s", w.Code, w.Body)
	}
}

func mustConnection(t *testing.T, s *Server, id string) *connection {
	t.Helper()
	c, ok := s.conns.get(id)
	if !ok {
		t.Fatalf("no connection %s", id)
	}
	return c
}

func TestStartupConfig(t *testing.T) {
	const secret = "Bearer cli-token-0123456789"
	s := newServer(t, Options{
		AgentCardURL:   "http://localhost:9999/.well-known/agent-card.json",
		Preferences:    Preferences{Bindings: []string{"GRPC"}, Version: "0.3"},
		StartupHeaders: []StartupHeader{{Name: "Authorization", Value: secret, Secret: true}, {Name: "X-Tenant", Value: "acme"}},
	})
	w := s.do(request{target: "/api/config", cookie: true})
	if strings.Contains(w.Body.String(), "cli-token") {
		t.Fatalf("config leaks the secret: %s", w.Body)
	}
	cfg := decodeBody[configResponse](t, w)
	st := cfg.Startup
	if st == nil || st.Preferences == nil || st.Preferences.Version != "0.3" || len(st.Headers) != 2 {
		t.Fatalf("startup = %+v", st)
	}
	if h := st.Headers[0]; h.Name != "Authorization" || h.Secret == nil || h.Secret.Masked != traffic.Masked+"6789" {
		t.Errorf("header = %+v", h)
	}
	if h := st.Headers[1]; h.Value != "acme" || h.Secret != nil {
		t.Errorf("header = %+v", h)
	}
	if v, err := s.secrets.resolve(st.Headers[0].Secret.Ref); err != nil || v != secret {
		t.Errorf("resolve() = %q, %v", v, err)
	}
}

// jsonrpcAgent answers every request with the same JSON-RPC response.
func jsonrpcAgent(t *testing.T, contentType, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestStreamWithoutStream(t *testing.T) {
	s := newServer(t, Options{})
	// The card says the agent can't stream, and the agent answers with a plain JSON-RPC error.
	agent := jsonrpcAgent(t, "application/json", `{"jsonrpc":"2.0","id":null,"error":{"code":-32601,"message":"Method not found"}}`)
	conn := s.connect(t, `{"card":{"name":"x","capabilities":{"streaming":false},"supportedInterfaces":[{"url":"`+agent.URL+`","protocolBinding":"JSONRPC","protocolVersion":"1.0"}]}}`)
	events := s.stream(t, conn.ID, `{"compose":{"text":"hi"}}`)
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1: %+v", len(events), events)
	}
	e := events[0]
	if e.Call.Error == nil || e.Call.Error.A2AError != "MethodNotFoundError" || e.Call.Error.Code != -32601 {
		t.Errorf("error = %+v", e.Call.Error)
	}
	if len(e.Call.Findings) != 1 || e.Call.Findings[0].Rule != "capability" {
		t.Errorf("call findings = %+v, want the missing streaming capability", e.Call.Findings)
	}

	// An agent that answers a send with a broken response still shows what it sent.
	broken := jsonrpcAgent(t, "text/plain", `{"jsonrpc":"1.0","id":"other","result":{"message":{"messageId":"m","role":"ROLE_AGENT","parts":[{"text":"hi"}]}}}`)
	conn = s.connect(t, `{"interface":{"url":"`+broken.URL+`","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`)
	res := s.send(t, conn.ID, `{"compose":{"text":"hi"}}`)
	if res.Payload == nil {
		t.Fatalf("result = %+v, want the payload", res)
	}
	rules := map[string]bool{}
	for _, f := range res.Payload.Validation.Findings {
		rules[f.Rule] = true
	}
	for _, want := range []string{"jsonrpc", "jsonrpc-id", "content-type"} {
		if !rules[want] {
			t.Errorf("findings = %+v, want %q", res.Payload.Validation.Findings, want)
		}
	}
}

func TestTrafficFeed(t *testing.T) {
	agent := agentServer(t)
	s := newServer(t, Options{Host: "0.0.0.0", HTTPTransport: agent.Client().Transport})
	inspector := httptest.NewServer(s)
	defer inspector.Close()
	defer s.Close()

	req, _ := http.NewRequest(http.MethodGet, inspector.URL+"/api/traffic", nil)
	req.AddCookie(&http.Cookie{Name: s.cookieName, Value: testToken})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	events := make(chan [2]string, 16)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		var name string
		for sc.Scan() {
			line := sc.Text()
			if v, ok := strings.CutPrefix(line, "event: "); ok {
				name = v
			} else if v, ok := strings.CutPrefix(line, "data: "); ok {
				events <- [2]string{name, v}
			}
		}
		close(events)
	}()
	next := func() [2]string {
		t.Helper()
		select {
		case e := <-events:
			return e
		case <-time.After(5 * time.Second):
			t.Fatal("no traffic event")
			return [2]string{}
		}
	}
	if e := next(); e[0] != "snapshot" || e[1] != `{"entries":[]}` {
		t.Fatalf("first event = %v", e)
	}

	body := `{"url":"` + agent.URL + `","headers":[{"name":"X-Token","secret":{"value":"card-secret"}}]}`
	if w := s.do(request{method: http.MethodPost, target: "/api/card:resolve", body: body, cookie: true}); w.Code != http.StatusOK {
		t.Fatalf("card:resolve = %d", w.Code)
	}
	var entry traffic.Entry
	for !entry.Done() {
		e := next()
		if e[0] != "entry" {
			t.Fatalf("event = %v, want entries", e)
		}
		if err := json.Unmarshal([]byte(e[1]), &entry); err != nil {
			t.Fatal(err)
		}
	}
	if entry.HTTP == nil || entry.HTTP.Status != http.StatusOK || !strings.HasSuffix(entry.HTTP.URL, "/.well-known/agent-card.json") {
		t.Errorf("entry = %+v", entry.HTTP)
	}
	for _, h := range entry.HTTP.RequestHeaders {
		if h.Name == "X-Token" && h.Value != traffic.Masked {
			t.Errorf("X-Token recorded as %q", h.Value)
		}
	}

	// Closing the server ends the feed, so it can shut down.
	s.Close()
	for range events {
	}
}

func TestCardResolveWithAuth(t *testing.T) {
	card := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer card-token-0123456789" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(testCard())
	}))
	defer card.Close()
	s := newServer(t, Options{})
	w := s.do(request{method: http.MethodPost, target: "/api/card:resolve", cookie: true,
		body: `{"url":"` + card.URL + `","auth":{"bearer":{"value":"card-token-0123456789"}}}`})
	res := decodeBody[cardResolveResponse](t, w)
	if res.Call.Error != nil || res.Payload == nil {
		t.Fatalf("card:resolve = %+v, want the card", res)
	}
}

func TestCloseEndsStreams(t *testing.T) {
	// The agent starts a stream and never ends it.
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer agent.Close()
	s := newServer(t, Options{})
	conn := s.connect(t, `{"interface":{"url":"`+agent.URL+`","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.do(request{method: http.MethodPost, target: "/api/connections/" + conn.ID + "/messages:stream", body: `{"compose":{"text":"hi"}}`, cookie: true})
	}()
	time.Sleep(200 * time.Millisecond)
	s.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream didn't end when the server closed")
	}
}

func TestTaskRefOf(t *testing.T) {
	tests := []struct {
		name, raw string
		want      taskRef
	}{
		{"v1.0 wrapped task", `{"task":{"id":"t","contextId":"c","status":{"state":"TASK_STATE_INPUT_REQUIRED"}}}`, taskRef{"t", "c", "input-required"}},
		{"v1.0 status update", `{"statusUpdate":{"taskId":"t","contextId":"c","status":{"state":"TASK_STATE_AUTH_REQUIRED"}}}`, taskRef{"t", "c", "auth-required"}},
		{"v1.0 message", `{"message":{"messageId":"m","taskId":"t","contextId":"c"}}`, taskRef{"t", "c", ""}},
		{"bare task", `{"id":"t","contextId":"c","status":{"state":"TASK_STATE_COMPLETED"}}`, taskRef{"t", "c", "completed"}},
		{"v0.3 task", `{"kind":"task","id":"t","contextId":"c","status":{"state":"input-required"}}`, taskRef{"t", "c", "input-required"}},
		{"v0.3 status update", `{"kind":"status-update","taskId":"t","contextId":"c","status":{"state":"canceled"}}`, taskRef{"t", "c", "canceled"}},
		{"v0.3 message", `{"kind":"message","messageId":"m","contextId":"c"}`, taskRef{"", "c", ""}},
		{"v0.3 proto message", `{"msg":{"messageId":"m","taskId":"t","contextId":"c"}}`, taskRef{"t", "c", ""}},
		{"v0.3 proto snake case", `{"status_update":{"task_id":"t","context_id":"c","status":{"state":"TASK_STATE_WORKING"}}}`, taskRef{"t", "c", "working"}},
		{"not an object", `[]`, taskRef{}},
	}
	for _, tc := range tests {
		if got := taskRefOf(json.RawMessage(tc.raw)); got != tc.want {
			t.Errorf("%s: taskRefOf() = %+v, want %+v", tc.name, got, tc.want)
		}
	}
}

func TestObserve(t *testing.T) {
	c := &connection{}
	open := func() string {
		_, o := c.conversation()
		if o == nil {
			return ""
		}
		return o.ID + " " + o.State
	}
	// A reply to the conversation's own message sets the context and the open task.
	c.observe(json.RawMessage(`{"kind":"task","id":"t-1","contextId":"c-1","status":{"state":"input-required"}}`), true)
	if ctx, _ := c.conversation(); ctx != "c-1" || open() != "t-1 input-required" {
		t.Fatalf("conversation = %q, %q", ctx, open())
	}
	// A task in another context doesn't replace it, unless it's a reply.
	c.observe(json.RawMessage(`{"task":{"id":"t-2","contextId":"c-2","status":{"state":"TASK_STATE_INPUT_REQUIRED"}}}`), false)
	if ctx, _ := c.conversation(); ctx != "c-1" || open() != "t-1 input-required" {
		t.Errorf("after a foreign task: %q, %q", ctx, open())
	}
	// Another task of the conversation that waits for the user takes over.
	c.observe(json.RawMessage(`{"statusUpdate":{"taskId":"t-3","contextId":"c-1","status":{"state":"TASK_STATE_AUTH_REQUIRED"}}}`), false)
	if open() != "t-3 auth-required" {
		t.Errorf("open task = %q, want t-3", open())
	}
	// Other tasks moving on leave it open; the open task moving on closes it.
	c.observe(json.RawMessage(`{"id":"t-1","contextId":"c-1","status":{"state":"TASK_STATE_COMPLETED"}}`), false)
	if open() != "t-3 auth-required" {
		t.Errorf("open task = %q after another task completed", open())
	}
	c.observe(json.RawMessage(`{"status_update":{"task_id":"t-3","context_id":"c-1","status":{"state":"TASK_STATE_WORKING"}}}`), false)
	if open() != "" {
		t.Errorf("open task = %q after it moved on", open())
	}
}

func TestNewContextClearsConversation(t *testing.T) {
	var gotTaskID, gotContextID string
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Params struct {
				Message struct{ TaskID, ContextID string }
			}
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotTaskID, gotContextID = req.Params.Message.TaskID, req.Params.Message.ContextID
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"message":{"messageId":"r","role":"ROLE_AGENT","parts":[{"text":"ok"}]}}}`)
	}))
	defer agent.Close()
	s := newServer(t, Options{})
	conn := s.connect(t, `{"interface":{"url":"`+agent.URL+`","protocolBinding":"JSONRPC","protocolVersion":"1.0"},"contextId":"c-1","openTask":{"id":"t-1","state":"input-required"}}`)
	if conn.ContextID != "c-1" || conn.OpenTask == nil || conn.OpenTask.ID != "t-1" {
		t.Fatalf("connection = %+v", conn)
	}
	s.send(t, conn.ID, `{"compose":{"text":"continue"}}`)
	if gotTaskID != "t-1" || gotContextID != "c-1" {
		t.Errorf("the agent got task %q in context %q, want t-1 in c-1", gotTaskID, gotContextID)
	}
	res := s.send(t, conn.ID, `{"compose":{"text":"new"},"options":{"newContext":true}}`)
	if gotTaskID != "" || gotContextID != "" || res.OpenTask != nil || res.ContextID != "" {
		t.Errorf("the agent got task %q in context %q; result has %q and %+v", gotTaskID, gotContextID, res.ContextID, res.OpenTask)
	}
}
