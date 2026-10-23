package server

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2acompat/a2av0"
	a2agrpcv0 "github.com/a2aproject/a2a-go/v2/a2agrpc/v0"
	a2agrpcv1 "github.com/a2aproject/a2a-go/v2/a2agrpc/v1"
	"github.com/a2aproject/a2a-go/v2/a2asrv"
	"github.com/a2aproject/a2a-go/v2/a2asrv/push"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
	"github.com/a2aproject/a2a-inspector/internal/validate"
	"google.golang.org/grpc"
)

// seen records what the test agent received.
type seen struct {
	mu   sync.Mutex
	auth []string
	// continued are the tasks that messages continued.
	continued []string
}

func (s *seen) add(v []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.auth = append(s.auth, v...)
}

func (s *seen) all() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.auth...)
}

func (s *seen) continuedTask(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.continued = append(s.continued, id)
}

func (s *seen) continuedTasks() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.continued...)
}

func textOf(m *a2a.Message) string {
	var b strings.Builder
	for _, p := range m.Parts {
		if t, ok := p.Content.(a2a.Text); ok {
			b.WriteString(string(t))
		}
	}
	return b.String()
}

// echoExecutor answers "fail" with an error, "ask" with a task that needs
// input (a new one, or the task it continues), any other message to an
// existing task by completing it, and anything else with a task that echoes
// the text in an artifact.
func echoExecutor(seen *seen) a2asrv.AgentExecutor {
	return a2asrv.AgentExecutorFunc(func(ctx context.Context, ec *a2asrv.ExecutorContext) iter.Seq2[a2a.Event, error] {
		return func(yield func(a2a.Event, error) bool) {
			if auth, ok := ec.ServiceParams.Get("authorization"); ok {
				seen.add(auth)
			}
			text := textOf(ec.Message)
			if text == "fail" {
				yield(nil, a2a.ErrUnsupportedOperation)
				return
			}
			if ec.StoredTask != nil {
				seen.continuedTask(string(ec.TaskID))
			} else if !yield(a2a.NewSubmittedTask(ec, ec.Message), nil) {
				return
			}
			if text == "ask" {
				yield(a2a.NewStatusUpdateEvent(ec, a2a.TaskStateInputRequired, a2a.NewMessageForTask(a2a.MessageRoleAgent, ec, a2a.NewTextPart("What else?"))), nil)
				return
			}
			if !yield(a2a.NewStatusUpdateEvent(ec, a2a.TaskStateWorking, nil), nil) {
				return
			}
			if !yield(a2a.NewArtifactEvent(ec, a2a.NewTextPart("echo: "+text)), nil) {
				return
			}
			yield(a2a.NewStatusUpdateEvent(ec, a2a.TaskStateCompleted, nil), nil)
		}
	})
}

type combo struct {
	binding, version, url string
	// rawMessage is a message in the combination's own wire format.
	rawMessage string
}

func (c combo) String() string { return c.binding + " " + c.version }

// testUser authenticates every caller as the same user.
type testUser struct {
	a2asrv.PassthroughCallInterceptor
}

func (testUser) Before(ctx context.Context, callCtx *a2asrv.CallContext, _ *a2asrv.Request) (context.Context, any, error) {
	callCtx.User = a2asrv.NewAuthenticatedUser("tester", nil)
	return ctx, nil, nil
}

// extendedCardName is the name of the test agent's extended card.
const extendedCardName = "Test agent, extended"

// startAgents serves one echo agent on all six combinations of binding and
// version, with push notifications and an extended card.
func startAgents(t *testing.T, seen *seen) []combo {
	t.Helper()
	extended := testCard()
	extended.Name = extendedCardName
	handler := a2asrv.NewHandler(echoExecutor(seen),
		a2asrv.WithLogger(slog.New(slog.DiscardHandler)),
		// a2a-go refuses webhooks on loopback addresses unless allowed.
		a2asrv.WithPushNotifications(push.NewInMemoryStore(), push.NewHTTPPushSender(&push.HTTPSenderConfig{AllowPrivateNetworks: true})),
		a2asrv.WithExtendedAgentCard(extended),
		// a2a-go's task store lists tasks only for an authenticated user.
		a2asrv.WithCallInterceptors(testUser{}),
	)
	serveHTTP := func(h http.Handler) string {
		srv := httptest.NewServer(h)
		t.Cleanup(srv.Close)
		return srv.URL
	}
	serveGRPC := func(register func(*grpc.Server)) string {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		s := grpc.NewServer()
		register(s)
		go func() { _ = s.Serve(ln) }()
		t.Cleanup(s.Stop)
		return ln.Addr().String()
	}
	const (
		v10Raw      = `{"messageId":"m-raw","role":"ROLE_USER","parts":[{"text":"raw hi"}]}`
		v03ProtoRaw = `{"messageId":"m-raw","role":"ROLE_USER","content":[{"text":"raw hi"}]}`
	)
	return []combo{
		{"JSONRPC", "1.0", serveHTTP(a2asrv.NewJSONRPCHandler(handler)), v10Raw},
		{"HTTP+JSON", "1.0", serveHTTP(a2asrv.NewRESTHandler(handler)), v10Raw},
		{"GRPC", "1.0", serveGRPC(a2agrpcv1.NewHandler(handler).RegisterWith), v10Raw},
		{"JSONRPC", "0.3", serveHTTP(a2av0.NewJSONRPCHandler(handler)), `{"kind":"message","messageId":"m-raw","role":"user","parts":[{"kind":"text","text":"raw hi"}]}`},
		{"HTTP+JSON", "0.3", serveHTTP(a2av0.NewRESTHandler(handler)), v03ProtoRaw},
		{"GRPC", "0.3", serveGRPC(a2agrpcv0.NewHandler(handler).RegisterWith), v03ProtoRaw},
	}
}

func (s *Server) connect(t *testing.T, body string) connectionResponse {
	t.Helper()
	w := s.do(request{method: http.MethodPost, target: "/api/connections", body: body, cookie: true})
	if w.Code != http.StatusCreated {
		t.Fatalf("POST /api/connections = %d %s", w.Code, w.Body)
	}
	return decodeBody[connectionResponse](t, w)
}

func (s *Server) send(t *testing.T, connID, body string) agentResult {
	t.Helper()
	w := s.do(request{method: http.MethodPost, target: "/api/connections/" + connID + "/messages:send", body: body, cookie: true})
	if w.Code != http.StatusOK {
		t.Fatalf("messages:send = %d %s", w.Code, w.Body)
	}
	return decodeBody[agentResult](t, w)
}

func (s *Server) stream(t *testing.T, connID, body string) []agentResult {
	t.Helper()
	return s.events(t, request{method: http.MethodPost, target: "/api/connections/" + connID + "/messages:stream", body: body, cookie: true})
}

// events makes an API call that answers with agentResult events.
func (s *Server) events(t *testing.T, req request) []agentResult {
	t.Helper()
	w := s.do(req)
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("%s = %d %q %s", req.target, w.Code, w.Header().Get("Content-Type"), w.Body)
	}
	var out []agentResult
	for _, event := range strings.Split(w.Body.String(), "\n\n") {
		data, ok := strings.CutPrefix(strings.TrimSpace(event), "data: ")
		if !ok {
			continue
		}
		var res agentResult
		if err := json.Unmarshal([]byte(data), &res); err != nil {
			t.Fatalf("event %q: %v", data, err)
		}
		out = append(out, res)
	}
	return out
}

func checkPayload(t *testing.T, res agentResult, version string) {
	t.Helper()
	if res.Call.Error != nil {
		t.Fatalf("call error = %+v", res.Call.Error)
	}
	if res.Payload == nil {
		t.Fatal("no payload")
	}
	if res.Payload.ProtocolVersion != version {
		t.Errorf("payload version = %q, want %q", res.Payload.ProtocolVersion, version)
	}
	// a2a-go's own responses are valid, so any finding is a validator bug.
	if f := res.Payload.Validation.Findings; len(f) > 0 {
		t.Errorf("findings for %s: %+v", res.Payload.Raw, f)
	}
	if len(res.Call.Findings) > 0 {
		t.Errorf("call findings = %+v", res.Call.Findings)
	}
	if res.Call.TrafficEntryID == "" {
		t.Error("no traffic entry")
	}
}

func TestAgentMatrix(t *testing.T) {
	seen := &seen{}
	// Served over HTTP, so agents can deliver push notifications to it.
	s := newServer(t, Options{Host: "0.0.0.0"})
	inspector := httptest.NewServer(s)
	t.Cleanup(inspector.Close)
	t.Cleanup(s.Close)
	if w := s.do(request{method: http.MethodPatch, target: "/api/config", body: `{"webhookBaseUrl":"` + inspector.URL + `"}`, cookie: true}); w.Code != http.StatusOK {
		t.Fatalf("PATCH /api/config = %d %s", w.Code, w.Body)
	}
	for _, c := range startAgents(t, seen) {
		t.Run(c.String(), func(t *testing.T) {
			const token = "s3cret-token-0123456789"
			conn := s.connect(t, fmt.Sprintf(`{"interface":{"url":%q,"protocolBinding":%q,"protocolVersion":%q},
				"auth":{"bearer":{"value":%q}},"headers":[{"name":"X-Trace","value":"t-1"}]}`, c.url, c.binding, c.version, token))
			if !conn.Custom || conn.Auth == nil || conn.Auth.Secret.Masked != traffic.Masked+"6789" {
				t.Errorf("connection = %+v", conn)
			}

			res := s.send(t, conn.ID, `{"compose":{"text":"hello"}}`)
			checkPayload(t, res, c.version)
			if !strings.Contains(string(res.Payload.Raw), "echo: hello") {
				t.Errorf("payload = %s, want the echo", res.Payload.Raw)
			}
			if res.ContextID == "" {
				t.Error("no context ID after the first message")
			}
			if got := seen.all(); len(got) == 0 || got[len(got)-1] != "Bearer "+token {
				t.Errorf("the agent got Authorization %q", got)
			}

			events := s.stream(t, conn.ID, `{"compose":{"text":"streamed"}}`)
			if len(events) < 3 {
				t.Fatalf("got %d events, want at least 3: %+v", len(events), events)
			}
			for _, e := range events {
				checkPayload(t, e, c.version)
				if e.ContextID != res.ContextID {
					t.Errorf("event context = %q, want the conversation's %q", e.ContextID, res.ContextID)
				}
			}
			if last := string(events[len(events)-1].Payload.Raw); !strings.Contains(strings.ToLower(last), "completed") {
				t.Errorf("last event = %s, want the completed status", last)
			}

			webhooks := s.hooks.count()
			failed := s.send(t, conn.ID, `{"compose":{"text":"fail"},"options":{"pushNotifications":true}}`)
			if failed.Call.Error == nil || failed.Payload != nil {
				t.Fatalf("result = %+v, want an error", failed)
			}
			if failed.Call.Error.A2AError != "UnsupportedOperationError" {
				t.Errorf("error = %+v, want UnsupportedOperationError", failed.Call.Error)
			}
			// The agent rejected the message, so the webhook created for it is gone.
			if failed.Webhook != nil || s.hooks.count() != webhooks {
				t.Errorf("webhook = %+v, %d webhooks, want %d", failed.Webhook, s.hooks.count(), webhooks)
			}

			// A new connection, as after changing the settings, can continue the conversation.
			again := s.connect(t, fmt.Sprintf(`{"interface":{"url":%q,"protocolBinding":%q,"protocolVersion":%q},"contextId":%q}`, c.url, c.binding, c.version, res.ContextID))
			if next := s.send(t, again.ID, `{"compose":{"text":"again"}}`); next.ContextID != res.ContextID {
				t.Errorf("context after reconnecting = %q, want %q", next.ContextID, res.ContextID)
			}

			raw := s.send(t, conn.ID, fmt.Sprintf(`{"rawMessage":%q}`, c.rawMessage))
			checkPayload(t, raw, c.version)
			if !strings.Contains(string(raw.Payload.Raw), "echo: raw hi") {
				t.Errorf("payload = %s, want the echo of the raw message", raw.Payload.Raw)
			}

			entry, ok := s.traffic.Get(raw.Call.TrafficEntryID)
			if !ok {
				t.Fatal("the traffic entry is gone")
			}
			var headers []traffic.Header
			switch {
			case entry.HTTP != nil:
				if !strings.Contains(entry.HTTP.RequestBody, c.rawMessage) {
					t.Errorf("request body = %s, want the raw message byte for byte", entry.HTTP.RequestBody)
				}
				headers = entry.HTTP.RequestHeaders
			case entry.GRPC != nil:
				if !strings.Contains(entry.GRPC.FullMethod, "SendMessage") || len(entry.GRPC.Messages) != 2 {
					t.Errorf("gRPC entry = %+v", entry.GRPC)
				}
				headers = entry.GRPC.Metadata
			}
			var auth, trace string
			for _, h := range headers {
				switch strings.ToLower(h.Name) {
				case "authorization":
					auth = h.Value
				case "x-trace":
					trace = h.Value
				}
			}
			if auth != "Bearer "+traffic.Masked || trace != "t-1" {
				t.Errorf("recorded Authorization = %q, X-Trace = %q", auth, trace)
			}

			w := s.do(request{method: http.MethodDelete, target: "/api/connections/" + conn.ID, cookie: true})
			if w.Code != http.StatusNoContent {
				t.Errorf("DELETE = %d", w.Code)
			}

			checkTaskLifecycle(t, s, inspector.URL, c, seen)
		})
	}
}

// call makes an API call that returns an agentResult.
func (s *Server) call(t *testing.T, method, target, body string) agentResult {
	t.Helper()
	w := s.do(request{method: method, target: target, body: body, cookie: true})
	if w.Code != http.StatusOK {
		t.Fatalf("%s %s = %d %s", method, target, w.Code, w.Body)
	}
	return decodeBody[agentResult](t, w)
}

// taskOf returns the task ID and state a result's payload is about.
func taskOf(t *testing.T, res agentResult) taskRef {
	t.Helper()
	if res.Payload == nil {
		t.Fatalf("no payload: %+v", res.Call)
	}
	return taskRefOf(res.Payload.Raw)
}

// checkTaskLifecycle covers task continuation, the task operations, push
// notifications and the extended card on one combination.
func checkTaskLifecycle(t *testing.T, s *Server, inspectorURL string, c combo, seen *seen) {
	conn := s.connect(t, fmt.Sprintf(`{"interface":{"url":%q,"protocolBinding":%q,"protocolVersion":%q}}`, c.url, c.binding, c.version))
	base := "/api/connections/" + conn.ID
	hooks := follow(t, s, inspectorURL+"/api/hooks?connectionId="+conn.ID)
	if e := nextEvent(t, hooks); e.name != "snapshot" || e.data != fmt.Sprintf(`{"conversations":{%q:{}},"notifications":[]}`, conn.ID) {
		t.Fatalf("first hooks event = %+v", e)
	}

	// A task that needs input becomes the open task.
	asked := s.send(t, conn.ID, `{"compose":{"text":"ask"}}`)
	checkPayload(t, asked, c.version)
	task := taskOf(t, asked)
	if task.State != "input-required" || asked.OpenTask == nil || asked.OpenTask.ID != task.ID || asked.OpenTask.State != "input-required" {
		t.Fatalf("open task = %+v after %s", asked.OpenTask, asked.Payload.Raw)
	}
	if got := s.connect(t, fmt.Sprintf(`{"interface":{"url":%q,"protocolBinding":%q,"protocolVersion":%q},"contextId":%q,"openTask":{"id":%q,"state":"input-required"}}`,
		c.url, c.binding, c.version, asked.ContextID, task.ID)); got.OpenTask == nil || got.OpenTask.ID != task.ID {
		t.Errorf("reconnected open task = %+v", got.OpenTask)
	}

	got := s.call(t, http.MethodGet, base+"/tasks/"+url.PathEscape(task.ID)+"?historyLength=1", "")
	checkPayload(t, got, c.version)
	if ref := taskOf(t, got); ref.ID != task.ID || ref.State != "input-required" {
		t.Errorf("GetTask = %s", got.Payload.Raw)
	}

	// a2a-go answers a subscription to a task that isn't running with the
	// task itself, so the stream ends.
	events := s.events(t, request{target: base + "/tasks/" + url.PathEscape(task.ID) + ":subscribe", cookie: true})
	if len(events) != 1 {
		t.Fatalf("subscription events = %+v", events)
	}
	checkPayload(t, events[0], c.version)
	if ref := taskOf(t, events[0]); ref.ID != task.ID || events[0].OpenTask == nil || events[0].OpenTask.ID != task.ID {
		t.Errorf("subscription event = %s with open task %+v", events[0].Payload.Raw, events[0].OpenTask)
	}

	// Push notification configs.
	configs := base + "/tasks/" + url.PathEscape(task.ID) + "/pushNotificationConfigs"
	created := s.call(t, http.MethodPost, configs, `{"inspectorWebhook":true,"id":"cfg-1"}`)
	checkPayload(t, created, c.version)
	if created.Webhook == nil || !strings.HasPrefix(created.Webhook.URL, inspectorURL+"/hooks/wh-") || !strings.Contains(string(created.Payload.Raw), created.Webhook.URL) {
		t.Fatalf("created = %s with webhook %+v", created.Payload.Raw, created.Webhook)
	}
	gotConfig := s.call(t, http.MethodGet, configs+"/cfg-1", "")
	checkPayload(t, gotConfig, c.version)
	listed := s.call(t, http.MethodGet, configs, "")
	checkPayload(t, listed, c.version)
	for _, res := range []agentResult{gotConfig, listed} {
		if raw := string(res.Payload.Raw); !strings.Contains(raw, "cfg-1") || !strings.Contains(raw, created.Webhook.URL) {
			t.Errorf("config = %s, want cfg-1", raw)
		}
	}

	// The follow-up continues the open task, which then completes.
	more := s.send(t, conn.ID, `{"compose":{"text":"more"}}`)
	checkPayload(t, more, c.version)
	if ref := taskOf(t, more); ref.ID != task.ID || ref.State != "completed" || more.OpenTask != nil {
		t.Errorf("follow-up = %s with open task %+v", more.Payload.Raw, more.OpenTask)
	}
	if got := seen.continuedTasks(); !slices.Contains(got, task.ID) {
		t.Errorf("the agent continued %v, want %s", got, task.ID)
	}
	n := waitNotification(t, hooks, func(n notification) bool {
		return n.WebhookID == created.Webhook.ID && strings.Contains(strings.ToLower(string(n.Payload.Raw)), "completed")
	})
	checkNotification(t, n, c.version, task.ID)

	deleted := s.call(t, http.MethodDelete, configs+"/cfg-1", "")
	if deleted.Call.Error != nil || deleted.Payload != nil || deleted.Call.TrafficEntryID == "" {
		t.Errorf("delete = %+v", deleted)
	}
	// a2a-go's JSON-RPC server leaves out a nil result ("result,omitempty"),
	// which JSON-RPC 2.0 requires on success.
	wantRules := []string{}
	if c.binding == "JSONRPC" {
		wantRules = []string{"jsonrpc"}
	}
	if got := ruleNames(deleted.Call.Findings); !slices.Equal(got, wantRules) {
		t.Errorf("delete findings = %v, want %v", got, wantRules)
	}
	if listed := s.call(t, http.MethodGet, configs, ""); listed.Payload == nil || strings.Contains(string(listed.Payload.Raw), "cfg-1") {
		t.Errorf("configs after delete = %+v", listed)
	}

	// Canceling the open task closes it.
	asked = s.send(t, conn.ID, `{"compose":{"text":"ask"}}`)
	task = taskOf(t, asked)
	canceled := s.call(t, http.MethodPost, base+"/tasks/"+url.PathEscape(task.ID)+":cancel", "")
	checkPayload(t, canceled, c.version)
	if ref := taskOf(t, canceled); ref.ID != task.ID || !strings.HasPrefix(ref.State, "cancel") || canceled.OpenTask != nil {
		t.Errorf("cancel = %s with open task %+v", canceled.Payload.Raw, canceled.OpenTask)
	}

	// newTask starts a new task instead of continuing the open one.
	asked = s.send(t, conn.ID, `{"compose":{"text":"ask"}}`)
	task = taskOf(t, asked)
	fresh := s.send(t, conn.ID, `{"compose":{"text":"fresh"},"options":{"newTask":true}}`)
	checkPayload(t, fresh, c.version)
	if ref := taskOf(t, fresh); ref.ID == task.ID || ref.State != "completed" || fresh.OpenTask != nil || fresh.ContextID != asked.ContextID {
		t.Errorf("new task = %s with open task %+v", fresh.Payload.Raw, fresh.OpenTask)
	}
	if slices.Contains(seen.continuedTasks(), task.ID) {
		t.Errorf("the agent continued %s despite newTask", task.ID)
	}

	// A push config sent with the message.
	pushed := s.send(t, conn.ID, `{"compose":{"text":"hello"},"options":{"pushNotifications":true}}`)
	checkPayload(t, pushed, c.version)
	if pushed.Webhook == nil {
		t.Fatal("no webhook for pushNotifications")
	}
	n = waitNotification(t, hooks, func(n notification) bool {
		return n.WebhookID == pushed.Webhook.ID && strings.Contains(strings.ToLower(string(n.Payload.Raw)), "completed")
	})
	checkNotification(t, n, c.version, taskOf(t, pushed).ID)

	// A follow-up with push notifications to a task that already notifies a
	// webhook sends no second config, which would double every notification.
	watched := s.stream(t, conn.ID, `{"compose":{"text":"ask"},"options":{"pushNotifications":true}}`)[0]
	watchedConfigs := base + "/tasks/" + url.PathEscape(taskOf(t, watched).ID) + "/pushNotificationConfigs"
	if watched.Webhook == nil || watched.Webhook.Existing {
		t.Fatalf("webhook = %+v, want a new one", watched.Webhook)
	}
	reused := s.send(t, conn.ID, `{"compose":{"text":"ask"},"options":{"pushNotifications":true}}`)
	if reused.Webhook == nil || reused.Webhook.ID != watched.Webhook.ID || reused.Webhook.URL != watched.Webhook.URL || !reused.Webhook.Existing {
		t.Errorf("webhook of the follow-up = %+v, want the existing %+v", reused.Webhook, watched.Webhook)
	}
	listed = s.call(t, http.MethodGet, watchedConfigs, "")
	checkPayload(t, listed, c.version)
	ids := configIDs.FindAllStringSubmatch(string(listed.Payload.Raw), -1)
	if len(ids) != 1 || !strings.Contains(string(listed.Payload.Raw), watched.Webhook.URL) {
		t.Fatalf("configs = %s, want one for %s", listed.Payload.Raw, watched.Webhook.URL)
	}
	// Once a config of the task is deleted, the next follow-up sends a new one.
	s.call(t, http.MethodDelete, watchedConfigs+"/"+url.PathEscape(ids[0][1]), "")
	renewed := s.send(t, conn.ID, `{"compose":{"text":"more"},"options":{"pushNotifications":true}}`)
	if renewed.Webhook == nil || renewed.Webhook.ID == watched.Webhook.ID || renewed.Webhook.Existing {
		t.Fatalf("webhook after the delete = %+v, want a new one", renewed.Webhook)
	}
	listed = s.call(t, http.MethodGet, watchedConfigs, "")
	checkPayload(t, listed, c.version)
	if raw := string(listed.Payload.Raw); len(configIDs.FindAllString(raw, -1)) != 1 || !strings.Contains(raw, renewed.Webhook.URL) {
		t.Errorf("configs after the delete = %s, want one for %s", raw, renewed.Webhook.URL)
	}

	card := s.call(t, http.MethodGet, base+"/extendedAgentCard", "")
	checkPayload(t, card, c.version)
	if !strings.Contains(string(card.Payload.Raw), extendedCardName) {
		t.Errorf("extended card = %s", card.Payload.Raw)
	}

	list := s.call(t, http.MethodGet, base+"/tasks?contextId="+url.QueryEscape(asked.ContextID)+"&status=completed&pageSize=10", "")
	if c.version == "0.3" {
		// The call is sent anyway, with a finding.
		if f := list.Call.Findings; len(f) != 1 || f[0].Rule != "operation-version" {
			t.Errorf("ListTasks findings = %+v, want operation-version", f)
		}
		list.Call.Findings = nil
		if c.binding == "JSONRPC" {
			// a2a-go's v0.3 JSON-RPC client refuses ListTasks without sending it.
			if list.Call.Error == nil || list.Call.Error.A2AError != "UnsupportedOperationError" || list.Payload != nil {
				t.Errorf("ListTasks = %+v, want UnsupportedOperationError", list)
			}
			return
		}
		// a2a-go's v0.3 proto has ListTasks, which the v0.3.0 specification
		// doesn't, so its HTTP+JSON and gRPC transports answer it.
	}
	checkPayload(t, list, c.version)
	if raw := string(list.Payload.Raw); !strings.Contains(raw, taskOf(t, fresh).ID) || strings.Contains(raw, task.ID) {
		t.Errorf("ListTasks = %s, want the completed tasks only", raw)
	}
}

// configIDs finds the config IDs in a ListTaskPushNotificationConfigs
// result, in any version's form; "taskId" doesn't match.
var configIDs = regexp.MustCompile(`"id":\s*"([^"]+)"`)

// ruleNames lists the rules of findings, in order.
func ruleNames(findings []validate.Finding) []string {
	out := []string{}
	for _, f := range findings {
		out = append(out, f.Rule)
	}
	return out
}

// checkNotification checks a push notification from a2a-go.
func checkNotification(t *testing.T, n notification, version, taskID string) {
	t.Helper()
	if !n.TokenValid || n.TokenHeader != "A2A-Notification-Token" || n.TaskID != taskID || n.Payload == nil {
		t.Errorf("notification = %+v", n)
		return
	}
	for _, h := range n.Headers {
		if h.Name == "A2a-Notification-Token" && h.Value != traffic.Masked {
			t.Errorf("token header recorded as %q", h.Value)
		}
	}
	// a2a-go sends v1.0 notifications whatever the config's version.
	f := n.Payload.Validation.Findings
	switch {
	case version == "1.0" && len(f) > 0:
		t.Errorf("findings for %s: %+v", n.Payload.Raw, f)
	case version == "0.3" && (len(f) != 1 || f[0].Rule != "notification-version" || f[0].Severity != validate.SeverityInfo):
		t.Errorf("findings for %s: %+v, want only notification-version", n.Payload.Raw, f)
	}
}
