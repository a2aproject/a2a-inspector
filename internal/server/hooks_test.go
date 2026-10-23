package server

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/traffic"
)

// sseEvent is one server-sent event.
type sseEvent struct{ name, data string }

// follow opens an event stream of a served inspector and returns its events.
func follow(t *testing.T, s *Server, rawURL string) <-chan sseEvent {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, rawURL, nil)
	req.AddCookie(&http.Cookie{Name: s.cookieName, Value: testToken})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d", rawURL, resp.StatusCode)
	}
	events := make(chan sseEvent, 256)
	go func() {
		defer close(events)
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(nil, 4<<20)
		var name string
		for sc.Scan() {
			line := sc.Text()
			if v, ok := strings.CutPrefix(line, "event: "); ok {
				name = v
			} else if v, ok := strings.CutPrefix(line, "data: "); ok {
				events <- sseEvent{name, v}
			}
		}
	}()
	return events
}

func nextEvent(t *testing.T, events <-chan sseEvent) sseEvent {
	t.Helper()
	select {
	case e, ok := <-events:
		if !ok {
			t.Fatal("the event stream ended")
		}
		return e
	case <-time.After(10 * time.Second):
		t.Fatal("no event")
		return sseEvent{}
	}
}

// waitNotification returns the first notification event that matches.
func waitNotification(t *testing.T, events <-chan sseEvent, match func(notification) bool) notification {
	t.Helper()
	for {
		e := nextEvent(t, events)
		if e.name != "notification" {
			t.Fatalf("event = %+v, want notifications", e)
		}
		var n notification
		if err := json.Unmarshal([]byte(e.data), &n); err != nil {
			t.Fatal(err)
		}
		if n.Payload != nil && match(n) {
			return n
		}
	}
}

// deliver posts a notification to a webhook the way an agent does: from
// another host and without the session cookie.
func (s *Server) deliver(path, body string, headers map[string]string) *httptest.ResponseRecorder {
	h := map[string]string{"Content-Type": "application/json"}
	for k, v := range headers {
		h[k] = v
	}
	return s.do(request{method: http.MethodPost, target: path, body: body, host: "agent.example:443", headers: h})
}

const inputRequiredTask = `{"id":"t-1","contextId":"ctx-1","status":{"state":"TASK_STATE_INPUT_REQUIRED"}}`

func TestHookReceiver(t *testing.T) {
	s := newServer(t, Options{})
	conn := s.connect(t, `{"interface":{"url":"http://127.0.0.1:1","protocolBinding":"JSONRPC","protocolVersion":"1.0"},"contextId":"ctx-1"}`)
	c := mustConnection(t, s, conn.ID)
	wh, view := s.hooks.create(c, "t-1", s.webhookBaseURL())
	if view.URL != "http://127.0.0.1:8080/hooks/"+wh.id {
		t.Errorf("webhook URL = %q", view.URL)
	}
	path := "/hooks/" + wh.id
	last := func() *notification {
		t.Helper()
		snapshot, _, cancel := s.hooks.subscribe(func(*notification) bool { return true })
		cancel()
		if len(snapshot) == 0 {
			t.Fatal("no notification")
		}
		return snapshot[len(snapshot)-1]
	}

	t.Run("unknown webhook", func(t *testing.T) {
		if w := s.deliver("/hooks/wh-unknown", `{}`, nil); w.Code != http.StatusNotFound {
			t.Errorf("got %d, want 404", w.Code)
		}
	})
	t.Run("tokens", func(t *testing.T) {
		for _, tc := range []struct {
			name, header, token string
			valid               bool
		}{
			{"a2a-go header", "A2A-Notification-Token", wh.token, true},
			{"X- header", "X-A2A-Notification-Token", wh.token, true},
			{"wrong token", "X-A2A-Notification-Token", "wrong", false},
			{"no token", "", "", false},
		} {
			headers := map[string]string{}
			if tc.header != "" {
				headers[tc.header] = tc.token
			}
			w := s.deliver(path, `{"statusUpdate":{"taskId":"t-1","contextId":"ctx-1","status":{"state":"TASK_STATE_WORKING"}}}`, headers)
			if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Errorf("%s: got %d with headers %v", tc.name, w.Code, w.Header())
			}
			n := last()
			if n.TokenValid != tc.valid || n.TokenHeader != tc.header || n.TaskID != "t-1" || n.ConnectionID != conn.ID || n.WebhookID != wh.id {
				t.Errorf("%s: notification = %+v", tc.name, n)
			}
			for _, h := range n.Headers {
				if strings.Contains(h.Value, wh.token) {
					t.Errorf("%s: header %s = %q isn't masked", tc.name, h.Name, h.Value)
				}
			}
		}
	})
	t.Run("masked headers", func(t *testing.T) {
		s.deliver(path, `{"task":`+inputRequiredTask+`}`, map[string]string{"Authorization": "Bearer agent-secret"})
		var auth, token string
		for _, h := range last().Headers {
			switch h.Name {
			case "Authorization":
				auth = h.Value
			case "A2a-Notification-Token":
				token = h.Value
			}
		}
		if auth != "Bearer "+traffic.Masked || token != "" {
			t.Errorf("Authorization = %q, token = %q", auth, token)
		}
	})
	t.Run("not JSON", func(t *testing.T) {
		if w := s.deliver(path, `not json`, nil); w.Code != http.StatusOK {
			t.Fatalf("got %d", w.Code)
		}
		if n := last(); n.Payload != nil || n.Error == nil || n.TaskID != "t-1" {
			t.Errorf("notification = %+v, want an error and the webhook's task", n)
		}
	})
	t.Run("conversation", func(t *testing.T) {
		// Without a valid token, the notification doesn't move the conversation.
		s.deliver(path, `{"task":`+inputRequiredTask+`}`, map[string]string{"A2A-Notification-Token": "wrong"})
		if _, open := c.conversation(); open != nil || last().Conversation != nil {
			t.Fatalf("open task = %+v after a forged notification", open)
		}
		s.deliver(path, `{"task":`+inputRequiredTask+`}`, map[string]string{"A2A-Notification-Token": wh.token})
		n := last()
		if n.Conversation == nil || n.Conversation.ContextID != "ctx-1" || n.Conversation.OpenTask == nil || n.Conversation.OpenTask.ID != "t-1" {
			t.Errorf("conversation = %+v", n.Conversation)
		}
		// The same state again changes nothing.
		s.deliver(path, `{"task":`+inputRequiredTask+`}`, map[string]string{"A2A-Notification-Token": wh.token})
		if n := last(); n.Conversation != nil {
			t.Errorf("conversation = %+v, want none", n.Conversation)
		}
		s.deliver(path, `{"statusUpdate":{"taskId":"t-1","contextId":"ctx-1","status":{"state":"TASK_STATE_COMPLETED"}}}`, map[string]string{"A2A-Notification-Token": wh.token})
		if n := last(); n.Conversation == nil || n.Conversation.OpenTask != nil || n.Conversation.ContextID != "ctx-1" {
			t.Errorf("conversation = %+v, want the task closed", n.Conversation)
		}
	})
	t.Run("formats", func(t *testing.T) {
		for _, tc := range []struct{ body, version, rule string }{
			{`{"task":` + inputRequiredTask + `}`, "1.0", ""},
			{`{"kind":"task","id":"t-1","contextId":"ctx-1","status":{"state":"input-required"}}`, "0.3", "notification-version"},
			{`{"id":"t-1"}`, "1.0", ""},
		} {
			s.deliver(path, tc.body, nil)
			p := last().Payload
			if p == nil || p.ProtocolVersion != tc.version {
				t.Errorf("%s: payload = %+v", tc.body, p)
				continue
			}
			var rules []string
			for _, f := range p.Validation.Findings {
				rules = append(rules, f.Rule)
			}
			if tc.rule != "" && !strings.Contains(strings.Join(rules, ","), tc.rule) {
				t.Errorf("%s: rules %v, want %s", tc.body, rules, tc.rule)
			}
		}
	})
}

func TestHookSecurity(t *testing.T) {
	s := newServer(t, Options{})
	conn := s.connect(t, `{"interface":{"url":"http://127.0.0.1:1","protocolBinding":"JSONRPC","protocolVersion":"0.3"}}`)
	wh, _ := s.hooks.create(mustConnection(t, s, conn.ID), "", s.webhookBaseURL())
	cross := map[string]string{"Origin": "http://evil.example", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json"}
	if w := s.do(request{method: http.MethodPost, target: "/hooks/" + wh.id, body: `{}`, host: "evil.example", headers: cross}); w.Code != http.StatusOK {
		t.Errorf("foreign Host, Origin and no cookie on /hooks/: %d, want 200", w.Code)
	}
	if w := s.do(request{target: "/api/hooks", host: "evil.example", cookie: true}); w.Code != http.StatusMisdirectedRequest {
		t.Errorf("foreign Host on /api/hooks: %d, want 421", w.Code)
	}
	if w := s.do(request{target: "/api/hooks"}); w.Code != http.StatusUnauthorized {
		t.Errorf("no cookie on /api/hooks: %d, want 401", w.Code)
	}
	// A path that only looks like a webhook still gets the API's checks.
	if w := s.do(request{target: "/hooks/../api/config", host: "evil.example"}); w.Code != http.StatusMisdirectedRequest {
		t.Errorf("/hooks/../api/config: %d, want 421", w.Code)
	}
	if w := s.do(request{target: "/hooks/" + wh.id, host: "evil.example"}); w.Code != http.StatusNotFound {
		t.Errorf("GET on a webhook: %d, want 404", w.Code)
	}
}

func TestWebhookFollowsReplacement(t *testing.T) {
	s := newServer(t, Options{})
	const iface = `"interface":{"url":"http://127.0.0.1:1","protocolBinding":"JSONRPC","protocolVersion":"1.0"},"contextId":"ctx-1"`
	old := s.connect(t, `{`+iface+`}`)
	wh, _ := s.hooks.create(mustConnection(t, s, old.ID), "t-1", s.webhookBaseURL())
	// A settings change replaces the connection; the agent still notifies the old webhook.
	s.do(request{method: http.MethodDelete, target: "/api/connections/" + old.ID, cookie: true})
	replacement := s.connect(t, `{`+iface+`,"replaces":"`+old.ID+`"}`)
	s.deliver("/hooks/"+wh.id, inputRequiredTask, map[string]string{"A2A-Notification-Token": wh.token})

	snapshot, _, cancel := s.hooks.subscribe(func(*notification) bool { return true })
	cancel()
	if n := snapshot[len(snapshot)-1]; n.ConnectionID != replacement.ID || n.Conversation == nil || n.Conversation.OpenTask == nil {
		t.Errorf("notification = %+v", n)
	}
	if _, open := mustConnection(t, s, replacement.ID).conversation(); open == nil || open.ID != "t-1" {
		t.Errorf("open task of the replacement = %+v", open)
	}
}

func TestWebhookForTask(t *testing.T) {
	s := newServer(t, Options{})
	const iface = `{"interface":{"url":"http://127.0.0.1:1","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`
	conn, other := s.connect(t, iface), s.connect(t, iface)
	base := s.webhookBaseURL()
	_, view := s.hooks.create(mustConnection(t, s, conn.ID), "", base)
	if _, ok := s.hooks.forTask(conn.ID, "t-1", base); ok {
		t.Fatal("a webhook created with a message stands for a task before the answer")
	}
	s.hooks.bind(&view, agentResult{Payload: &agentPayload{Raw: json.RawMessage(`{"task":` + inputRequiredTask + `}`)}})
	if got, ok := s.hooks.forTask(conn.ID, "t-1", base); !ok || got.ID != view.ID || got.URL != view.URL || !got.Existing {
		t.Errorf("forTask = %+v, %v, want %+v", got, ok, view)
	}
	for name, args := range map[string][3]string{
		"other connection": {other.ID, "t-1", base},
		"no task":          {conn.ID, "", base},
		"other base URL":   {conn.ID, "t-1", "https://tunnel.example.com"},
	} {
		if _, ok := s.hooks.forTask(args[0], args[1], args[2]); ok {
			t.Errorf("%s: found a webhook", name)
		}
	}
	s.hooks.configDeleted(conn.ID, "t-1")
	if _, ok := s.hooks.forTask(conn.ID, "t-1", base); ok {
		t.Error("found a webhook after a config of the task was deleted")
	}
	// It still receives, to show whether the agent ignored the delete.
	if w := s.deliver("/hooks/"+view.ID, `{"task":`+inputRequiredTask+`}`, nil); w.Code != http.StatusOK {
		t.Errorf("delivery after the delete = %d", w.Code)
	}
}

func (h *hooks) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.webhooks)
}

func TestWebhookOfFailedCall(t *testing.T) {
	s := newServer(t, Options{})
	const rpcError = `{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Task not found"}}`
	connect := func(url string) string {
		return s.connect(t, `{"interface":{"url":"`+url+`","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`).ID
	}
	const push = `{"compose":{"text":"hi"},"options":{"pushNotifications":true}}`
	for _, tc := range []struct {
		name, url string
		// kept is set when the agent may have taken the config.
		kept bool
	}{
		{"error answer", jsonrpcAgent(t, "application/json", rpcError).URL, false},
		{"no answer", "http://127.0.0.1:1", false},
		{"unreadable answer", jsonrpcAgent(t, "application/json", `not json`).URL, true},
	} {
		connID := connect(tc.url)
		before := s.hooks.count()
		results := map[string]agentResult{
			"send":   s.send(t, connID, push),
			"stream": s.stream(t, connID, push)[0],
			"config": s.call(t, http.MethodPost, "/api/connections/"+connID+"/tasks/t-1/pushNotificationConfigs", `{"inspectorWebhook":true}`),
		}
		for op, res := range results {
			if res.Call.Error == nil || (res.Webhook != nil) != tc.kept {
				t.Errorf("%s, %s: error %+v, webhook %+v", tc.name, op, res.Call.Error, res.Webhook)
			}
		}
		want := before
		if tc.kept {
			want += len(results)
		}
		if got := s.hooks.count(); got != want {
			t.Errorf("%s: %d webhooks, want %d", tc.name, got, want)
		}
	}
	// An error as the first event of a stream.
	before := s.hooks.count()
	if res := s.stream(t, connect(jsonrpcAgent(t, "text/event-stream", "data: "+rpcError+"\n\n").URL), push)[0]; res.Call.Error == nil || res.Webhook != nil || s.hooks.count() != before {
		t.Errorf("error event: error %+v, webhook %+v, %d webhooks, want %d", res.Call.Error, res.Webhook, s.hooks.count(), before)
	}

	// A failed follow-up leaves the webhook the task already notifies.
	rejecting := jsonrpcAgent(t, "application/json", rpcError)
	conn := s.connect(t, `{"interface":{"url":"`+rejecting.URL+`","protocolBinding":"JSONRPC","protocolVersion":"1.0"},"contextId":"ctx-1","openTask":{"id":"t-1","state":"input-required"}}`)
	_, view := s.hooks.create(mustConnection(t, s, conn.ID), "t-1", s.webhookBaseURL())
	if res := s.send(t, conn.ID, push); res.Webhook == nil || res.Webhook.ID != view.ID || !res.Webhook.Existing {
		t.Errorf("webhook = %+v, want the existing %+v", res.Webhook, view)
	}
	if _, ok := s.hooks.webhook(view.ID); !ok {
		t.Error("the failed follow-up removed the task's webhook")
	}
}

func TestHooksFeed(t *testing.T) {
	s := newServer(t, Options{Host: "0.0.0.0"})
	inspector := httptest.NewServer(s)
	defer inspector.Close()
	defer s.Close()
	conn := s.connect(t, `{"interface":{"url":"http://127.0.0.1:1","protocolBinding":"JSONRPC","protocolVersion":"1.0"},"contextId":"ctx-a"}`)
	other := s.connect(t, `{"interface":{"url":"http://127.0.0.1:1","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`)
	wh1, _ := s.hooks.create(mustConnection(t, s, conn.ID), "t-1", s.webhookBaseURL())
	wh2, _ := s.hooks.create(mustConnection(t, s, other.ID), "t-2", s.webhookBaseURL())
	s.deliver("/hooks/"+wh1.id, `{"task":{"id":"t-1","contextId":"c","status":{"state":"TASK_STATE_WORKING"}}}`, nil)

	all := follow(t, s, inspector.URL+"/api/hooks")
	byConn := follow(t, s, inspector.URL+"/api/hooks?connectionId="+other.ID)
	byTask := follow(t, s, inspector.URL+"/api/hooks?taskId=t-1")
	snapshot := func(events <-chan sseEvent) ([]notification, map[string]conversation) {
		t.Helper()
		e := nextEvent(t, events)
		var body struct {
			Notifications []notification
			Conversations map[string]conversation
		}
		if err := json.Unmarshal([]byte(e.data), &body); e.name != "snapshot" || err != nil {
			t.Fatalf("event = %+v (%v), want a snapshot", e, err)
		}
		return body.Notifications, body.Conversations
	}
	// The snapshot also has what each connection's next message continues.
	if n, c := snapshot(all); len(n) != 1 || n[0].TaskID != "t-1" || len(c) != 2 || c[conn.ID].ContextID != "ctx-a" {
		t.Errorf("snapshot = %+v, conversations = %+v", n, c)
	}
	if n, c := snapshot(byConn); len(n) != 0 || len(c) != 1 || c[other.ID].ContextID != "" {
		t.Errorf("snapshot for the other connection = %+v, conversations = %+v", n, c)
	}
	if n, _ := snapshot(byTask); len(n) != 1 {
		t.Errorf("snapshot for t-1 = %+v", n)
	}

	// Delivered over HTTP to the served inspector, as an agent would.
	resp, err := http.Post(inspector.URL+"/hooks/"+wh2.id, "application/json", strings.NewReader(`{"task":{"id":"t-2","contextId":"c","status":{"state":"TASK_STATE_COMPLETED"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	for name, events := range map[string]<-chan sseEvent{"all": all, "connection": byConn} {
		if n := waitNotification(t, events, func(notification) bool { return true }); n.TaskID != "t-2" || n.ConnectionID != other.ID {
			t.Errorf("%s: notification = %+v", name, n)
		}
	}
	s.deliver("/hooks/"+wh1.id, `{"task":{"id":"t-1","contextId":"c","status":{"state":"TASK_STATE_COMPLETED"}}}`, nil)
	if n := waitNotification(t, byTask, func(notification) bool { return true }); n.TaskID != "t-1" {
		t.Errorf("task filter: notification = %+v", n)
	}
}
