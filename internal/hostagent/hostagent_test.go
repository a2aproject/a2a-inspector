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

package hostagent

import (
	"context"
	"errors"
	"fmt"
	"iter"
	"strings"
	"sync"
	"testing"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"
)

// fakeLLM answers each model call with what script returns for it.
type fakeLLM struct {
	script func(call int, req *model.LLMRequest) *genai.Content

	mu       sync.Mutex
	requests []*model.LLMRequest
}

func (f *fakeLLM) Name() string { return "fake" }

func (f *fakeLLM) GenerateContent(_ context.Context, req *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	f.mu.Lock()
	f.requests = append(f.requests, req)
	call := len(f.requests)
	f.mu.Unlock()
	return func(yield func(*model.LLMResponse, error) bool) {
		yield(&model.LLMResponse{Content: f.script(call, req), TurnComplete: true}, nil)
	}
}

// callThen calls the tool with request, then answers with the reply the
// tool returned, or its error.
func callThen(tool, request string) func(int, *model.LLMRequest) *genai.Content {
	return func(_ int, req *model.LLMRequest) *genai.Content {
		last := req.Contents[len(req.Contents)-1]
		for _, p := range last.Parts {
			if r := p.FunctionResponse; r != nil {
				if e, ok := r.Response["error"].(string); ok {
					return genai.NewContentFromText("failed: "+e, genai.RoleModel)
				}
				reply, _ := r.Response["reply"].(string)
				return genai.NewContentFromText("the agent says: "+reply, genai.RoleModel)
			}
		}
		return genai.NewContentFromParts([]*genai.Part{{FunctionCall: &genai.FunctionCall{ID: "call-1", Name: tool, Args: map[string]any{"request": request}}}}, genai.RoleModel)
	}
}

// fakeAgent answers every message with a completed task that echoes it, in
// context "ctx-1", or with err.
type fakeAgent struct {
	err error

	mu          sync.Mutex
	messages    []*a2a.Message
	delegations []string
}

func (f *fakeAgent) SendMessage(ctx context.Context, req *a2a.SendMessageRequest) (a2a.SendMessageResult, error) {
	f.mu.Lock()
	f.messages = append(f.messages, req.Message)
	f.delegations = append(f.delegations, DelegationID(ctx))
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	var text strings.Builder
	for _, p := range req.Message.Parts {
		text.WriteString(p.Text())
	}
	// The answer comes as an artifact and again as the status message, as
	// many agents send it.
	answer := "echo: " + text.String()
	return &a2a.Task{
		ID:        "task-1",
		ContextID: "ctx-1",
		Status:    a2a.TaskStatus{State: a2a.TaskStateCompleted, Message: a2a.NewMessage(a2a.MessageRoleAgent, a2a.NewTextPart(answer))},
		Artifacts: []*a2a.Artifact{{ID: "a-1", Parts: a2a.ContentParts{a2a.NewTextPart(answer)}}},
	}, nil
}

func (f *fakeAgent) SendStreamingMessage(ctx context.Context, req *a2a.SendMessageRequest) iter.Seq2[a2a.Event, error] {
	return func(yield func(a2a.Event, error) bool) {
		res, err := f.SendMessage(ctx, req)
		if err != nil {
			yield(nil, err)
			return
		}
		yield(res, nil)
	}
}

func (f *fakeAgent) CancelTask(context.Context, *a2a.CancelTaskRequest) (*a2a.Task, error) {
	return nil, errors.New("not cancelable")
}

func (f *fakeAgent) Destroy() error { return nil }

// send runs a turn and returns what it emitted.
func send(t *testing.T, c *Conversation, text string, agents []Agent) []Event {
	t.Helper()
	var mu sync.Mutex
	var events []Event
	if err := c.Send(t.Context(), text, agents, func(e Event) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, e)
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	return events
}

// finalText returns the host agent's answer, from the events that aren't partial.
func finalText(events []Event) string {
	var b strings.Builder
	for _, e := range events {
		if !e.Partial {
			b.WriteString(e.Text)
		}
	}
	return b.String()
}

func TestDelegation(t *testing.T) {
	llm := &fakeLLM{script: callThen("Echo_Agent", "hello there")}
	c, err := NewConversation(t.Context(), llm)
	if err != nil {
		t.Fatal(err)
	}
	remote := &fakeAgent{}
	state := "completed"
	agents := []Agent{{Key: "agent-1", Name: "Echo Agent", Description: "Echoes messages.", Client: remote, TaskState: func() string { return state }}}

	events := send(t, c, "say hello", agents)
	var delegations []Delegation
	for _, e := range events {
		if e.Delegation != nil {
			delegations = append(delegations, *e.Delegation)
		}
	}
	text := finalText(events)
	want := []Delegation{
		{ID: "call-1", AgentKey: "agent-1", AgentName: "Echo Agent", Request: "hello there", Status: "working"},
		{ID: "call-1", AgentKey: "agent-1", AgentName: "Echo Agent", Request: "hello there", Status: "done", Reply: "echo: hello there"},
	}
	if len(delegations) != 2 || delegations[0] != want[0] || delegations[1] != want[1] {
		t.Errorf("delegations = %+v, want %+v", delegations, want)
	}
	if text != "the agent says: echo: hello there" {
		t.Errorf("text = %q", text)
	}
	if len(remote.messages) != 1 || remote.delegations[0] != "call-1" {
		t.Fatalf("the agent got %d messages for delegations %q", len(remote.messages), remote.delegations)
	}
	if got := remote.messages[0].Parts[0].Text(); got != "hello there" {
		t.Errorf("the agent got %q", got)
	}
	if remote.messages[0].ContextID != "" {
		t.Errorf("the first message has context %q", remote.messages[0].ContextID)
	}

	// The tool's declaration carries the agent's name and description.
	decl := llm.requests[0].Config.Tools[0].FunctionDeclarations[0]
	if decl.Name != "Echo_Agent" || !strings.Contains(decl.Description, "Echo Agent: Echoes messages.") {
		t.Errorf("declaration = %s: %q", decl.Name, decl.Description)
	}

	// The next delegation continues the agent's context, and the host agent
	// hears about a task waiting for input.
	state = "input-required"
	send(t, c, "again", agents)
	if len(remote.messages) != 2 || remote.messages[1].ContextID != "ctx-1" {
		t.Fatalf("second message = %+v, want context ctx-1", remote.messages[len(remote.messages)-1])
	}
	last := llm.requests[len(llm.requests)-1].Contents
	resp := last[len(last)-1].Parts[0].FunctionResponse
	if resp == nil || resp.Response["taskState"] != "input-required" || resp.Response["note"] == nil {
		t.Errorf("function response = %+v, want the task state and a note", resp)
	}
}

func TestDelegationFails(t *testing.T) {
	llm := &fakeLLM{script: callThen("Broken", "hi")}
	c, err := NewConversation(t.Context(), llm)
	if err != nil {
		t.Fatal(err)
	}
	remote := &fakeAgent{err: errors.New("connection refused")}
	events := send(t, c, "hi", []Agent{{Key: "a", Name: "Broken", Client: remote}})
	var failed *Delegation
	for _, e := range events {
		if e.Delegation != nil && e.Delegation.Status == "failed" {
			failed = e.Delegation
		}
	}
	text := finalText(events)
	if failed == nil || !strings.Contains(failed.Error, "connection refused") {
		t.Fatalf("failed delegation = %+v", failed)
	}
	if !strings.Contains(text, "connection refused") {
		t.Errorf("text = %q, want the host agent to hear the error", text)
	}
}

func TestNoAgents(t *testing.T) {
	llm := &fakeLLM{script: func(int, *model.LLMRequest) *genai.Content {
		return genai.NewContentFromText("Pick some agents first.", genai.RoleModel)
	}}
	c, err := NewConversation(t.Context(), llm)
	if err != nil {
		t.Fatal(err)
	}
	send(t, c, "hi", nil)
	if got := llm.requests[0].Config.SystemInstruction.Parts[0].Text; !strings.Contains(got, "hasn't picked any") {
		t.Errorf("instruction = %q", got)
	}
}

func TestToolNames(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"Currency Agent", "Currency_Agent"},
		{"  weather -- bot!  ", "weather_bot"},
		{"42 things", "agent_42_things"},
		{"日本語", "agent"},
		{strings.Repeat("a", 80), strings.Repeat("a", 64)},
	} {
		if got := functionName(tc.in); got != tc.want {
			t.Errorf("functionName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}

	c := &Conversation{tools: map[string]string{}}
	first := c.toolName(Agent{Key: "1", Name: "Echo"})
	second := c.toolName(Agent{Key: "2", Name: "Echo"})
	again := c.toolName(Agent{Key: "1", Name: "Renamed"})
	if first != "Echo" || second != "Echo_2" || again != "Echo" {
		t.Errorf("tool names = %q, %q, %q", first, second, again)
	}
}

func TestSummary(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{fmt.Errorf("failed to call model: %w", genai.APIError{Code: 403, Status: "PERMISSION_DENIED", Message: "denied on projects/operator-project"}), "The model failed with 403 PERMISSION_DENIED."},
		{fmt.Errorf("run: %w", agent.ErrLLMCallsLimitExceeded), "The host agent made 25 model calls, its limit for a turn."},
		{errors.New("dial tcp: connection refused"), "The host agent's model failed."},
	} {
		if got := Summary(tc.err); got != tc.want {
			t.Errorf("Summary(%v) = %q, want %q", tc.err, got, tc.want)
		}
	}
}

func TestClip(t *testing.T) {
	if got := clip("héllo", 5); got != "héllo" {
		t.Errorf("clip at the length = %q", got)
	}
	if got := clip("héllo world", 5); got != "héllo [cut by the inspector]" {
		t.Errorf("clip = %q", got)
	}
}
