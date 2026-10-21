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
	"strings"
	"sync"
	"testing"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2acompat/a2av0"
	a2agrpcv0 "github.com/a2aproject/a2a-go/v2/a2agrpc/v0"
	a2agrpcv1 "github.com/a2aproject/a2a-go/v2/a2agrpc/v1"
	"github.com/a2aproject/a2a-go/v2/a2asrv"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
	"google.golang.org/grpc"
)

// seenAuth records the Authorization values the test agent received.
type seenAuth struct {
	mu     sync.Mutex
	values []string
}

func (s *seenAuth) add(v []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values = append(s.values, v...)
}

func (s *seenAuth) all() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.values...)
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

// echoExecutor answers "fail" with an error, and anything else with a task
// that echoes the text in an artifact.
func echoExecutor(seen *seenAuth) a2asrv.AgentExecutor {
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
			if !yield(a2a.NewSubmittedTask(ec, ec.Message), nil) {
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

// startAgents serves one echo agent on all six combinations of binding and version.
func startAgents(t *testing.T, seen *seenAuth) []combo {
	t.Helper()
	handler := a2asrv.NewHandler(echoExecutor(seen), a2asrv.WithLogger(slog.New(slog.DiscardHandler)))
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
	w := s.do(request{method: http.MethodPost, target: "/api/connections/" + connID + "/messages:stream", body: body, cookie: true})
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("messages:stream = %d %q %s", w.Code, w.Header().Get("Content-Type"), w.Body)
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
	seen := &seenAuth{}
	s := newServer(t, Options{})
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

			failed := s.send(t, conn.ID, `{"compose":{"text":"fail"}}`)
			if failed.Call.Error == nil || failed.Payload != nil {
				t.Fatalf("result = %+v, want an error", failed)
			}
			if failed.Call.Error.A2AError != "UnsupportedOperationError" {
				t.Errorf("error = %+v, want UnsupportedOperationError", failed.Call.Error)
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
		})
	}
}
