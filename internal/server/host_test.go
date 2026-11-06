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
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"log"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/egress"
	"github.com/a2aproject/a2a-inspector/internal/hostagent"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"
)

// relayLLM sends every user message to the tool as it is, then answers with
// the tool's reply, or its error. err, if set, fails every call.
type relayLLM struct {
	tool string
	err  error

	mu    sync.Mutex
	calls int
}

func (m *relayLLM) Name() string { return "relay" }

func (m *relayLLM) GenerateContent(_ context.Context, req *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	m.mu.Lock()
	m.calls++
	id := fmt.Sprintf("call-%d", m.calls)
	m.mu.Unlock()
	return func(yield func(*model.LLMResponse, error) bool) {
		if m.err != nil {
			yield(nil, m.err)
			return
		}
		var content *genai.Content
		last := req.Contents[len(req.Contents)-1]
		for _, p := range last.Parts {
			switch {
			case p.FunctionResponse != nil:
				reply, _ := p.FunctionResponse.Response["reply"].(string)
				if e, ok := p.FunctionResponse.Response["error"].(string); ok {
					reply = "error: " + e
				}
				content = genai.NewContentFromText("Echo said: "+reply, genai.RoleModel)
			case p.Text != "":
				content = genai.NewContentFromParts([]*genai.Part{{FunctionCall: &genai.FunctionCall{ID: id, Name: m.tool, Args: map[string]any{"request": p.Text}}}}, genai.RoleModel)
			}
		}
		yield(&model.LLMResponse{Content: content, TurnComplete: true}, nil)
	}
}

// blockingLLM answers once release is closed, or fails when the call's
// context ends. entered is closed when the first call starts.
type blockingLLM struct {
	once    sync.Once
	entered chan struct{}
	release chan struct{}
}

func newBlockingLLM() *blockingLLM {
	return &blockingLLM{entered: make(chan struct{}), release: make(chan struct{})}
}

func (m *blockingLLM) Name() string { return "blocking" }

func (m *blockingLLM) GenerateContent(ctx context.Context, _ *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		m.once.Do(func() { close(m.entered) })
		select {
		case <-m.release:
			yield(&model.LLMResponse{Content: genai.NewContentFromText("done", genai.RoleModel), TurnComplete: true}, nil)
		case <-ctx.Done():
			yield(nil, ctx.Err())
		}
	}
}

// hostTurnEvents is what a turn of the host agent streamed.
type hostTurnEvents struct {
	conversationID string
	text           string
	delegations    []hostagent.Delegation
	results        []delegationResult
	errors         []string
}

func (s *Server) hostTurn(t *testing.T, body string) hostTurnEvents {
	t.Helper()
	return parseHostTurn(t, s.do(request{method: http.MethodPost, target: "/api/host/messages:stream", body: body, cookie: true}))
}

// parseHostTurn reads the events of a turn of the host agent.
func parseHostTurn(t *testing.T, w *httptest.ResponseRecorder) hostTurnEvents {
	t.Helper()
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("host stream = %d %s", w.Code, w.Body)
	}
	var out hostTurnEvents
	for block := range strings.SplitSeq(w.Body.String(), "\n\n") {
		var name, data string
		for line := range strings.SplitSeq(block, "\n") {
			if v, ok := strings.CutPrefix(line, "event: "); ok {
				name = v
			}
			if v, ok := strings.CutPrefix(line, "data: "); ok {
				data = v
			}
		}
		decode := func(v any) {
			if err := json.Unmarshal([]byte(data), v); err != nil {
				t.Fatalf("%s event %q: %v", name, data, err)
			}
		}
		switch name {
		case "conversation":
			var v struct{ ConversationID string }
			decode(&v)
			out.conversationID = v.ConversationID
		case "text":
			var v hostText
			decode(&v)
			if !v.Partial {
				out.text += v.Text
			}
		case "delegation":
			var v hostagent.Delegation
			decode(&v)
			out.delegations = append(out.delegations, v)
		case "result":
			var v delegationResult
			decode(&v)
			out.results = append(out.results, v)
		case "error":
			var v struct{ Message string }
			decode(&v)
			out.errors = append(out.errors, v.Message)
		}
	}
	return out
}

func TestHostAgent(t *testing.T) {
	seen := &seen{}
	s := newServer(t, Options{HostModel: &relayLLM{tool: "Echo"}})
	t.Cleanup(s.Close)
	for _, c := range startAgents(t, seen) {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s streaming=%t", c, streaming), func(t *testing.T) {
				card := fmt.Sprintf(`{"name":"Echo","description":"Echoes messages.","capabilities":{"streaming":%t}}`, streaming)
				conn := s.connect(t, fmt.Sprintf(`{"card":%s,"interface":{"url":%q,"protocolBinding":%q,"protocolVersion":%q},
					"auth":{"bearer":{"value":"host-secret-token"}}}`, card, c.url, c.binding, c.version))
				agents := fmt.Sprintf(`[{"id":"agent-1","connectionId":%q}]`, conn.ID)

				turn := s.hostTurn(t, `{"text":"hello","agents":`+agents+`}`)
				if len(turn.errors) > 0 || turn.conversationID == "" {
					t.Fatalf("turn = %+v", turn)
				}
				if len(turn.delegations) != 2 || turn.delegations[1].Status != "done" || turn.delegations[1].AgentName != "Echo" {
					t.Fatalf("delegations = %+v", turn.delegations)
				}
				if !strings.Contains(turn.delegations[1].Reply, "echo: hello") || !strings.Contains(turn.text, "echo: hello") {
					t.Errorf("reply = %q, text = %q", turn.delegations[1].Reply, turn.text)
				}
				if len(turn.results) == 0 || streaming && len(turn.results) < 3 {
					t.Fatalf("got %d results", len(turn.results))
				}
				for _, r := range turn.results {
					checkPayload(t, r.Result, c.version)
					if r.DelegationID != turn.delegations[0].ID {
						t.Errorf("result for delegation %q, want %q", r.DelegationID, turn.delegations[0].ID)
					}
					entry, ok := s.local.traffic.Get(r.Result.Call.TrafficEntryID)
					if !ok || entry.Origin != traffic.OriginHost || entry.ConnectionID != conn.ID {
						t.Fatalf("traffic entry = %+v", entry)
					}
					if (entry.HTTP != nil && strings.Contains(fmt.Sprint(entry.HTTP.RequestHeaders), "host-secret-token")) ||
						(entry.GRPC != nil && strings.Contains(fmt.Sprint(entry.GRPC.Metadata), "host-secret-token")) {
						t.Error("the traffic log shows the token")
					}
				}
				if got := seen.all(); got[len(got)-1] != "Bearer host-secret-token" {
					t.Errorf("the agent got Authorization %q", got[len(got)-1])
				}

				// A task waiting for input is continued by the host agent's next
				// message to the agent.
				next := fmt.Sprintf(`{"conversationId":%q,"text":%%q,"agents":%s}`, turn.conversationID, agents)
				asked := s.hostTurn(t, fmt.Sprintf(next, "ask"))
				ref := taskOf(t, asked.results[len(asked.results)-1].Result)
				if ref.State != "input-required" {
					t.Fatalf("task = %+v, want input-required", ref)
				}
				answered := s.hostTurn(t, fmt.Sprintf(next, "the answer"))
				if len(answered.errors) > 0 || !slices.Contains(seen.continuedTasks(), ref.ID) {
					t.Errorf("continued tasks = %q, want %q; errors %q", seen.continuedTasks(), ref.ID, answered.errors)
				}

				// The host agent's conversation with the agent is its own.
				w := s.do(request{target: "/api/connections/" + conn.ID, cookie: true})
				if got := decodeBody[connectionResponse](t, w); got.ContextID != "" || got.OpenTask != nil {
					t.Errorf("the connection's conversation = %q %+v, want none", got.ContextID, got.OpenTask)
				}
			})
		}
	}
}

func TestHostAgentErrors(t *testing.T) {
	s := newServer(t, Options{HostModel: &relayLLM{tool: "Echo"}})
	t.Cleanup(s.Close)
	conn := s.connect(t, `{"interface":{"url":"http://127.0.0.1:1/a2a","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`)
	for _, tc := range []struct {
		name, body string
		status     int
		code       string
	}{
		{"no text", `{"text":"  ","agents":[]}`, http.StatusBadRequest, ""},
		{"duplicate agents", fmt.Sprintf(`{"text":"hi","agents":[{"id":"a","connectionId":%q},{"id":"a","connectionId":%q}]}`, conn.ID, conn.ID), http.StatusBadRequest, ""},
		{"unknown conversation", `{"conversationId":"host-99","text":"hi","agents":[]}`, http.StatusNotFound, "unknownConversation"},
		{"unknown connection", `{"text":"hi","agents":[{"id":"a","connectionId":"conn-99"}]}`, http.StatusNotFound, "unknownConnection"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := s.do(request{method: http.MethodPost, target: "/api/host/messages:stream", body: tc.body, cookie: true})
			if w.Code != tc.status {
				t.Fatalf("status = %d %s, want %d", w.Code, w.Body, tc.status)
			}
			if got := decodeBody[errorResponse](t, w).Error.Code; got != tc.code {
				t.Errorf("code = %q, want %q", got, tc.code)
			}
		})
	}

	// None of the failed requests left a conversation behind.
	if n := len(s.local.host.byID); n != 0 {
		t.Errorf("%d conversations after failed requests, want none", n)
	}

	// An agent that can't be reached fails the delegation, and the host
	// agent hears why.
	turn := s.hostTurn(t, fmt.Sprintf(`{"text":"hi","agents":[{"id":"a","connectionId":%q,"name":"Echo"}]}`, conn.ID))
	if len(turn.delegations) != 2 || turn.delegations[1].Status != "failed" || turn.delegations[1].Error == "" {
		t.Fatalf("delegations = %+v", turn.delegations)
	}
	if len(turn.results) != 1 || turn.results[0].Result.Call.Error == nil {
		t.Errorf("results = %+v, want the failed call", turn.results)
	}
	if !strings.Contains(turn.text, "error:") {
		t.Errorf("text = %q", turn.text)
	}
}

func TestHostAgentModelError(t *testing.T) {
	modelErr := fmt.Errorf("failed to call model: %w", genai.APIError{Code: 403, Status: "PERMISSION_DENIED", Message: "denied on projects/operator-project"})
	s := newServer(t, Options{HostModel: &relayLLM{err: modelErr}})
	t.Cleanup(s.Close)
	turn := s.hostTurn(t, `{"text":"hi","agents":[]}`)
	if len(turn.errors) != 1 || !strings.Contains(turn.errors[0], "operator-project") {
		t.Errorf("errors = %q, want the whole error locally", turn.errors)
	}

	// A shared inspector shows only the status, and logs the rest.
	var logged strings.Builder
	hosted := newServer(t, Options{Hosted: true, HostModel: &relayLLM{err: modelErr}, Logger: log.New(&logged, "", 0)})
	t.Cleanup(hosted.Close)
	turn = parseHostTurn(t, (&browser{s: hosted}).do(request{method: http.MethodPost, target: "/api/host/messages:stream", body: `{"text":"hi","agents":[]}`}))
	if len(turn.errors) != 1 || turn.errors[0] != "The model failed with 403 PERMISSION_DENIED." {
		t.Errorf("hosted errors = %q", turn.errors)
	}
	if !strings.Contains(logged.String(), "operator-project") {
		t.Errorf("log = %q, want the model's error", logged.String())
	}

	// A message is bounded.
	w := s.do(request{method: http.MethodPost, target: "/api/host/messages:stream", body: `{"text":"` + strings.Repeat("x", maxHostText+1) + `","agents":[]}`, cookie: true})
	if w.Code != http.StatusBadRequest {
		t.Errorf("long message = %d, want 400", w.Code)
	}
}

func TestHostAgentConfig(t *testing.T) {
	on := newServer(t, Options{HostModel: &relayLLM{}})
	got := decodeBody[configResponse](t, on.do(request{target: "/api/config", cookie: true}))
	if !got.Features.Host || got.Host == nil || got.Host.Model != "relay" {
		t.Errorf("config with a model = %+v %+v", got.Features, got.Host)
	}

	off := newServer(t, Options{HostUnavailable: "No credentials."})
	got = decodeBody[configResponse](t, off.do(request{target: "/api/config", cookie: true}))
	if got.Features.Host || got.Host == nil || got.Host.Unavailable != "No credentials." {
		t.Errorf("config without a model = %+v %+v", got.Features, got.Host)
	}
	if w := off.do(request{method: http.MethodPost, target: "/api/host/messages:stream", body: `{"text":"hi"}`, cookie: true}); w.Code != http.StatusNotFound {
		t.Errorf("host stream without a model = %d", w.Code)
	}
}

func TestHostAgentHosted(t *testing.T) {
	agent := startAgents(t, &seen{})[0]
	for _, tc := range []struct {
		name  string
		allow []string
	}{
		{"loopback blocked", nil},
		{"loopback allowed", []string{"127.0.0.1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy, err := egress.New(tc.allow)
			if err != nil {
				t.Fatal(err)
			}
			s := newServer(t, Options{Hosted: true, Egress: policy, HostModel: &relayLLM{tool: "Echo"}})
			t.Cleanup(s.Close)
			alice, bob := &browser{s: s}, &browser{s: s}
			if cfg := decodeBody[configResponse](t, alice.do(request{target: "/api/config"})); !cfg.Features.Host || cfg.Host == nil || cfg.Host.Model != "relay" {
				t.Fatalf("hosted config = %+v %+v", cfg.Features, cfg.Host)
			}
			conn := alice.connect(t, agent.url)
			stream := func(b *browser, body string) *httptest.ResponseRecorder {
				return b.do(request{method: http.MethodPost, target: "/api/host/messages:stream", body: body})
			}
			turn := parseHostTurn(t, stream(alice, fmt.Sprintf(`{"text":"hello","agents":[{"id":"a","connectionId":%q,"name":"Echo"}]}`, conn.ID)))
			last := turn.delegations[len(turn.delegations)-1]

			if tc.allow == nil {
				// The host agent can't reach what the egress policy blocks.
				if last.Status != "failed" || !strings.Contains(last.Error, "egress policy") {
					t.Errorf("delegation = %+v, want blocked by the egress policy", last)
				}
				return
			}
			if last.Status != "done" || !strings.Contains(last.Reply, "echo: hello") {
				t.Fatalf("delegation = %+v", last)
			}
			// Another browser's session has neither the conversation nor the
			// connection, and its traffic log stays empty.
			if w := stream(bob, fmt.Sprintf(`{"conversationId":%q,"text":"hi","agents":[]}`, turn.conversationID)); w.Code != http.StatusNotFound || errorCode(t, w) != "unknownConversation" {
				t.Errorf("another session's conversation = %d %s", w.Code, w.Body)
			}
			if w := stream(bob, fmt.Sprintf(`{"text":"hi","agents":[{"id":"a","connectionId":%q}]}`, conn.ID)); w.Code != http.StatusNotFound || errorCode(t, w) != "unknownConnection" {
				t.Errorf("another session's connection = %d %s", w.Code, w.Body)
			}
			if n := entries(s.sessions.get(bob.cookie).traffic); n != 0 {
				t.Errorf("the other session's traffic log has %d entries", n)
			}
			if n := entries(s.sessions.get(alice.cookie).traffic); n == 0 {
				t.Error("the delegation isn't in the session's traffic log")
			}
		})
	}
}

func TestHostAgentLimits(t *testing.T) {
	t.Run("one turn at a time per session", func(t *testing.T) {
		llm := newBlockingLLM()
		s := newServer(t, Options{HostModel: llm})
		t.Cleanup(s.Close)
		done := make(chan *httptest.ResponseRecorder)
		go func() {
			done <- s.do(request{method: http.MethodPost, target: "/api/host/messages:stream", body: `{"text":"first","agents":[]}`, cookie: true})
		}()
		<-llm.entered
		// A new conversation doesn't get around the limit.
		w := s.do(request{method: http.MethodPost, target: "/api/host/messages:stream", body: `{"text":"second","agents":[]}`, cookie: true})
		if w.Code != http.StatusConflict {
			t.Errorf("second turn = %d %s, want 409", w.Code, w.Body)
		}
		close(llm.release)
		if turn := parseHostTurn(t, <-done); turn.text != "done" {
			t.Errorf("first turn = %+v", turn)
		}
		if n := len(s.local.host.byID); n != 1 {
			t.Errorf("%d conversations, want the first one only", n)
		}
	})

	t.Run("turns end at the stream duration", func(t *testing.T) {
		s := newServer(t, Options{Hosted: true, Limits: Limits{StreamDuration: 50 * time.Millisecond}, HostModel: newBlockingLLM()})
		t.Cleanup(s.Close)
		turn := parseHostTurn(t, (&browser{s: s}).do(request{method: http.MethodPost, target: "/api/host/messages:stream", body: `{"text":"hi","agents":[]}`}))
		if len(turn.errors) != 1 || !strings.Contains(turn.errors[0], "after 50ms") {
			t.Errorf("errors = %q, want the turn stopped at the limit", turn.errors)
		}
	})

	t.Run("streams to agents count against the session", func(t *testing.T) {
		agent := startAgents(t, &seen{})[0]
		policy, err := egress.New([]string{"127.0.0.1"})
		if err != nil {
			t.Fatal(err)
		}
		// The turn itself takes the only stream.
		s := newServer(t, Options{Hosted: true, Egress: policy, Limits: Limits{Streams: 1}, HostModel: &relayLLM{tool: "Echo"}})
		t.Cleanup(s.Close)
		b := &browser{s: s}
		w := b.do(request{method: http.MethodPost, target: "/api/connections",
			body: `{"card":{"name":"Echo","capabilities":{"streaming":true}},"interface":{"url":"` + agent.url + `","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`})
		conn := decodeBody[connectionResponse](t, w)
		turn := parseHostTurn(t, b.do(request{method: http.MethodPost, target: "/api/host/messages:stream", body: `{"text":"hi","agents":[{"id":"a","connectionId":"` + conn.ID + `"}]}`}))
		if last := turn.delegations[len(turn.delegations)-1]; last.Status != "failed" || !strings.Contains(last.Error, "streams open") {
			t.Errorf("delegation = %+v, want refused at the stream limit", last)
		}
	})
}
