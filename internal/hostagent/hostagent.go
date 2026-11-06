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

// Package hostagent runs the host agent: an LLM agent, built with adk-go, that
// answers the user by delegating to A2A agents. Each agent is a tool of the
// host agent, backed by adk-go's remote A2A agent, so the messages the host
// sends are the ones an ADK host would send.
package hostagent

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/agent/remoteagent/v2"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/model/gemini"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"
)

// DefaultModel is the host agent's Gemini model unless another is given.
const DefaultModel = "gemini-flash-lite-latest"

const (
	appName  = "a2a-inspector"
	userID   = "user"
	hostName = "host_agent"
	// maxLLMCalls bounds the model calls of one turn, so a model that keeps
	// calling tools stops.
	maxLLMCalls = 25
	// maxReply bounds the characters of an agent's reply the model gets.
	maxReply = 32 << 10
)

// ErrNoCredentials is returned by NewGeminiModel when the environment has
// no credentials for Gemini.
var ErrNoCredentials = errors.New("no credentials for Gemini: set GOOGLE_API_KEY or GEMINI_API_KEY for the Gemini API, " +
	"or GOOGLE_GENAI_USE_VERTEXAI=true with GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION and Application Default Credentials for Vertex AI")

// NewGeminiModel returns the Gemini model with the credentials in the
// environment, for the Gemini API or for Vertex AI.
func NewGeminiModel(ctx context.Context, name string) (model.LLM, error) {
	m, err := gemini.NewModel(ctx, name, &genai.ClientConfig{})
	if err != nil {
		// The client's errors can include the API key.
		return nil, ErrNoCredentials
	}
	return m, nil
}

// Summary describes an error of Send without the model's details, which can
// name the project it runs in: the model's status, or the limit the turn hit.
func Summary(err error) string {
	var apiErr genai.APIError
	switch {
	case errors.As(err, &apiErr):
		return fmt.Sprintf("The model failed with %d %s.", apiErr.Code, apiErr.Status)
	case errors.Is(err, agent.ErrLLMCallsLimitExceeded):
		return fmt.Sprintf("The host agent made %d model calls, its limit for a turn.", maxLLMCalls)
	}
	return "The host agent's model failed."
}

// Agent is an agent the host agent can delegate to.
type Agent struct {
	// Key identifies the agent across turns, so the host agent continues
	// its conversation with the agent.
	Key         string
	Name        string
	Description string
	// Client sends the host agent's messages, with a context DelegationID
	// reads. Its Destroy is called after every delegation.
	Client remoteagent.A2AClient
	// TaskState returns the state of the task the agent reported last.
	TaskState func() string
}

// Delegation is a message the host agent sends to an agent, and its outcome.
type Delegation struct {
	// ID is the ID of the model's function call.
	ID        string `json:"id"`
	AgentKey  string `json:"agentKey"`
	AgentName string `json:"agentName"`
	Request   string `json:"request"`
	// Status is "working", "done" or "failed".
	Status string `json:"status"`
	// Reply is the text the host agent got back, and Error why it got none.
	Reply string `json:"reply,omitempty"`
	Error string `json:"error,omitempty"`
}

// Event is something the host agent did: Text it wrote, or a Delegation
// that started or ended.
type Event struct {
	// Text is a piece of the answer when Partial, or a whole part of it.
	Text       string
	Partial    bool
	Delegation *Delegation
}

type delegationKey struct{}

// DelegationID returns the ID of the delegation an agent's Client is called
// for, or "".
func DelegationID(ctx context.Context) string {
	id, _ := ctx.Value(delegationKey{}).(string)
	return id
}

// Conversation is a chat with the host agent, kept in memory.
type Conversation struct {
	model    model.LLM
	sessions session.Service
	id       string

	mu sync.Mutex
	// tools are the tool names of the agents, by key, so an agent keeps
	// its name in the conversation.
	tools map[string]string
	// delegates are the host agent's conversations with the agents.
	delegates map[string]*delegate
}

// delegate is the host agent's conversation with one agent: an ADK session
// that remembers the agent's context.
type delegate struct {
	mu        sync.Mutex
	sessionID string
}

// NewConversation starts a conversation with the host agent on m.
func NewConversation(ctx context.Context, m model.LLM) (*Conversation, error) {
	sessions := session.InMemoryService()
	created, err := sessions.Create(ctx, &session.CreateRequest{AppName: appName, UserID: userID})
	if err != nil {
		return nil, fmt.Errorf("creating the session: %w", err)
	}
	return &Conversation{
		model:     m,
		sessions:  sessions,
		id:        created.Session.ID(),
		tools:     map[string]string{},
		delegates: map[string]*delegate{},
	}, nil
}

// Send runs one turn: the host agent answers text, delegating to agents.
// emit gets what it does, from several goroutines at once.
func (c *Conversation) Send(ctx context.Context, text string, agents []Agent, emit func(Event)) error {
	tools := make([]tool.Tool, 0, len(agents))
	for _, a := range agents {
		t, err := c.tool(a, emit)
		if err != nil {
			return err
		}
		tools = append(tools, t)
	}
	host, err := llmagent.New(llmagent.Config{
		Name:        hostName,
		Description: "Answers the user by delegating to A2A agents.",
		Model:       c.model,
		InstructionProvider: func(agent.ReadonlyContext) (string, error) {
			return instruction(len(agents)), nil
		},
		Tools: tools,
	})
	if err != nil {
		return fmt.Errorf("creating the host agent: %w", err)
	}
	r, err := runner.New(runner.Config{AppName: appName, Agent: host, SessionService: c.sessions})
	if err != nil {
		return fmt.Errorf("creating the runner: %w", err)
	}
	cfg := agent.RunConfig{StreamingMode: agent.StreamingModeSSE, MaxLLMCalls: maxLLMCalls}
	for ev, err := range r.Run(ctx, userID, c.id, genai.NewContentFromText(text, genai.RoleUser), cfg) {
		if err != nil {
			return err
		}
		if ev.ErrorMessage != "" {
			return errors.New(ev.ErrorMessage)
		}
		if ev.Author != hostName {
			continue
		}
		if t := textOf(ev.Content); t != "" {
			emit(Event{Text: t, Partial: ev.Partial})
		}
	}
	return nil
}

// instruction tells the host agent how to work with the agents.
func instruction(agents int) string {
	if agents == 0 {
		return "You are the host agent of the A2A Inspector, a tool for testing A2A agents. " +
			"You delegate the user's requests to A2A agents, but the user hasn't picked any. " +
			"Tell them to pick agents for you in the inspector, and don't answer requests yourself."
	}
	return `You are the host agent of the A2A Inspector, a tool for testing A2A agents. The user tests agents by chatting with you, and you delegate their requests to the agents. Each of your tools sends a message to one agent and returns its reply.

- Use the agents to answer. Don't answer from your own knowledge what an agent should answer, and don't make up replies.
- An agent sees only the messages you send it, not this conversation, so make each message complete.
- When an agent asks for more information, ask the user, then send their answer to the same agent.
- Say which agent each answer came from. When an agent fails, say so and quote its error.
- When no agent fits a request, say so.
- Write plain text, not Markdown.`
}

// delegateArgs are the arguments of an agent's tool.
type delegateArgs struct {
	Request string `json:"request" jsonschema:"The message for the agent. It sees only the messages you send it, so make it complete."`
}

// tool returns the tool that delegates to a.
func (c *Conversation) tool(a Agent, emit func(Event)) (tool.Tool, error) {
	name := c.toolName(a)
	description := a.Name
	if a.Description != "" {
		description += ": " + a.Description
	}
	return functiontool.New(functiontool.Config{Name: name, Description: "Sends a message to the agent " + description},
		func(tc agent.Context, args delegateArgs) (map[string]any, error) {
			d := &Delegation{ID: tc.FunctionCallID(), AgentKey: a.Key, AgentName: a.Name, Request: args.Request, Status: "working"}
			emit(Event{Delegation: copyOf(d)})
			reply, err := c.delegate(context.WithValue(tc, delegationKey{}, d.ID), a, name, args.Request)
			if err != nil {
				d.Status, d.Error = "failed", err.Error()
				emit(Event{Delegation: copyOf(d)})
				return nil, err
			}
			d.Status, d.Reply = "done", reply
			emit(Event{Delegation: copyOf(d)})
			out := map[string]any{"reply": reply}
			if a.TaskState == nil {
				return out, nil
			}
			switch state := a.TaskState(); state {
			case "":
			case "input-required", "auth-required":
				out["taskState"] = state
				out["note"] = "The agent is waiting for more input. Ask the user, then send their answer to this agent."
			default:
				out["taskState"] = state
			}
			return out, nil
		})
}

func copyOf(d *Delegation) *Delegation {
	c := *d
	return &c
}

// toolName returns a's tool name: its name in the characters function names
// allow, unique in the conversation.
func (c *Conversation) toolName(a Agent) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if name, ok := c.tools[a.Key]; ok {
		return name
	}
	base := functionName(a.Name)
	name := base
	for i := 2; c.taken(name); i++ {
		suffix := fmt.Sprintf("_%d", i)
		name = base[:min(len(base), 64-len(suffix))] + suffix
	}
	c.tools[a.Key] = name
	return name
}

func (c *Conversation) taken(name string) bool {
	for _, n := range c.tools {
		if n == name {
			return true
		}
	}
	return false
}

// functionName turns a name into a function name: letters, digits and
// underscores, starting with a letter, at most 64 characters.
func functionName(name string) string {
	var b strings.Builder
	underscore := false
	for _, r := range name {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			if underscore && b.Len() > 0 {
				b.WriteByte('_')
			}
			b.WriteRune(r)
			underscore = false
		} else {
			underscore = true
		}
	}
	out := b.String()
	if out == "" || out[0] >= '0' && out[0] <= '9' {
		out = "agent_" + out
	}
	return strings.TrimSuffix(out[:min(len(out), 64)], "_")
}

// delegate sends request to a through adk-go's remote A2A agent, in the
// host agent's conversation with a, and returns the agent's reply.
func (c *Conversation) delegate(ctx context.Context, a Agent, name, request string) (string, error) {
	d, err := c.delegateSession(ctx, a.Key)
	if err != nil {
		return "", err
	}
	// The same agent called twice at once would mix up its context.
	d.mu.Lock()
	defer d.mu.Unlock()
	remote, err := remoteagent.NewA2A(remoteagent.A2AConfig{
		Name:        name,
		Description: a.Description,
		AgentCard:   &a2a.AgentCard{Name: a.Name, Description: a.Description},
		ClientProvider: func(context.Context, *a2a.AgentCard) (remoteagent.A2AClient, error) {
			return a.Client, nil
		},
	})
	if err != nil {
		return "", fmt.Errorf("creating the remote agent: %w", err)
	}
	r, err := runner.New(runner.Config{AppName: appName, Agent: remote, SessionService: c.sessions})
	if err != nil {
		return "", fmt.Errorf("creating the runner: %w", err)
	}
	var parts []string
	var failure string
	for ev, err := range r.Run(ctx, userID, d.sessionID, genai.NewContentFromText(request, genai.RoleUser), agent.RunConfig{StreamingMode: agent.StreamingModeSSE}) {
		if err != nil {
			return "", err
		}
		if ev.ErrorMessage != "" {
			failure = ev.ErrorMessage
		}
		// Partial events are pieces of the ones that follow them.
		if ev.Partial || ev.Content == nil {
			continue
		}
		// Agents often send their answer as an artifact and again in the
		// status message.
		for _, p := range ev.Content.Parts {
			if t := partText(p); t != "" && !slices.Contains(parts, t) {
				parts = append(parts, t)
			}
		}
	}
	if failure != "" {
		return "", errors.New(failure)
	}
	return clip(strings.Join(parts, "\n"), maxReply), nil
}

// clip cuts s to max characters, and says so.
func clip(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + " [cut by the inspector]"
}

// delegateSession returns the host agent's conversation with the agent,
// started on first use.
func (c *Conversation) delegateSession(ctx context.Context, key string) (*delegate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if d, ok := c.delegates[key]; ok {
		return d, nil
	}
	created, err := c.sessions.Create(ctx, &session.CreateRequest{AppName: appName, UserID: userID})
	if err != nil {
		return nil, fmt.Errorf("creating the session: %w", err)
	}
	d := &delegate{sessionID: created.Session.ID()}
	c.delegates[key] = d
	return d, nil
}

// textOf returns the text the model wrote, without its thoughts.
func textOf(content *genai.Content) string {
	if content == nil {
		return ""
	}
	var b strings.Builder
	for _, p := range content.Parts {
		if p != nil && !p.Thought {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

// partText returns what a part of an agent's reply says: its text, the JSON
// of a data part, or the name of a file.
func partText(p *genai.Part) string {
	switch {
	case p == nil || p.Thought:
		return ""
	case p.Text != "":
		return p.Text
	case p.InlineData != nil && strings.HasPrefix(p.InlineData.MIMEType, "text/"):
		// adk-go wraps the JSON of a data part in tags.
		text := strings.TrimPrefix(string(p.InlineData.Data), "<a2a_datapart_json>")
		return strings.TrimSuffix(text, "</a2a_datapart_json>")
	case p.InlineData != nil:
		return fmt.Sprintf("[file %s, %s]", p.InlineData.DisplayName, p.InlineData.MIMEType)
	case p.FileData != nil:
		return fmt.Sprintf("[file %s]", p.FileData.FileURI)
	}
	return ""
}
