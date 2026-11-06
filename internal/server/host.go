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
	"cmp"
	"context"
	"errors"
	"fmt"
	"iter"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-inspector/internal/hostagent"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
	"github.com/a2aproject/a2a-inspector/internal/validate"
	"google.golang.org/adk/v2/model"
)

const (
	// hostTurnTimeout bounds a turn, its delegations included.
	hostTurnTimeout = 10 * time.Minute
	// maxHostConversations is how many conversations a session keeps.
	maxHostConversations = 10
	// maxHostAgents is how many agents the host agent can delegate to.
	maxHostAgents = 50
	// maxAgentDescription and maxAgentName bound the characters of what the
	// model gets about an agent.
	maxAgentDescription = 2000
	maxAgentName        = 200
	// maxHostText bounds a message, which goes to the model whole.
	maxHostText = 32 << 10
)

type hostRequest struct {
	// ConversationID continues a conversation; without it, a new one starts.
	ConversationID string      `json:"conversationId,omitempty"`
	Text           string      `json:"text"`
	Agents         []hostAgent `json:"agents"`
}

// hostAgent is an agent the host agent can delegate to.
type hostAgent struct {
	// ID is the UI's ID of the agent, which keeps the host agent's
	// conversation with it across turns.
	ID           string `json:"id"`
	ConnectionID string `json:"connectionId"`
	// Name is the agent's name in the UI, by default the card's.
	Name string `json:"name,omitempty"`
}

type hostText struct {
	Text    string `json:"text"`
	Partial bool   `json:"partial,omitempty"`
}

// delegationResult is the result of a call the host agent made to an agent.
type delegationResult struct {
	DelegationID string      `json:"delegationId"`
	Result       agentResult `json:"result"`
}

// hostConversations are a session's conversations with the host agent.
type hostConversations struct {
	// busy is set while the host agent answers a message; a session has
	// one turn at a time, which bounds the model calls it makes.
	busy atomic.Bool

	mu   sync.Mutex
	next int
	byID map[string]*hostConversation
	// order lists the conversations, used the longest ago first.
	order []string
}

type hostConversation struct {
	id   string
	conv *hostagent.Conversation

	mu sync.Mutex
	// agents are the host agent's conversations with the agents, by the
	// UI's agent ID.
	agents map[string]*delegateClient
}

// start starts a conversation. At the limit, it drops the one used the
// longest ago.
func (hc *hostConversations) start(ctx context.Context, m model.LLM) (*hostConversation, error) {
	conv, err := hostagent.NewConversation(ctx, m)
	if err != nil {
		return nil, err
	}
	hc.mu.Lock()
	defer hc.mu.Unlock()
	hc.next++
	c := &hostConversation{id: fmt.Sprintf("host-%d", hc.next), conv: conv, agents: map[string]*delegateClient{}}
	hc.byID[c.id] = c
	hc.order = append(hc.order, c.id)
	for i := 0; len(hc.order) > maxHostConversations && i < len(hc.order); {
		if hc.order[i] == c.id {
			i++
			continue
		}
		delete(hc.byID, hc.order[i])
		hc.order = slices.Delete(hc.order, i, i+1)
	}
	return c, nil
}

func (hc *hostConversations) get(id string) (*hostConversation, bool) {
	hc.mu.Lock()
	defer hc.mu.Unlock()
	c, ok := hc.byID[id]
	if ok {
		hc.order = append(slices.DeleteFunc(hc.order, func(o string) bool { return o == id }), id)
	}
	return c, ok
}

// agent returns the host agent's view of an agent, reached through conn in
// this turn.
func (c *hostConversation) agent(s *Server, sess *session, a hostAgent, conn *connection) hostagent.Agent {
	c.mu.Lock()
	d := c.agents[a.ID]
	if d == nil {
		d = &delegateClient{s: s, sess: sess}
		c.agents[a.ID] = d
	}
	c.mu.Unlock()
	d.use(conn)
	name, description := describeAgent(conn.cardDoc)
	return hostagent.Agent{
		Key:         a.ID,
		Name:        clipRunes(cmp.Or(strings.TrimSpace(a.Name), name, "Agent"), maxAgentName),
		Description: description,
		Client:      d,
		TaskState:   d.taskState,
	}
}

// describeAgent returns the name of the agent in its card, and a description
// with its skills.
func describeAgent(card map[string]any) (name, description string) {
	name, _ = card["name"].(string)
	description, _ = card["description"].(string)
	skills, _ := card["skills"].([]any)
	var names []string
	for _, sk := range skills {
		m, _ := sk.(map[string]any)
		n, _ := m["name"].(string)
		d, _ := m["description"].(string)
		switch {
		case n != "" && d != "":
			names = append(names, n+" ("+d+")")
		case n != "":
			names = append(names, n)
		}
	}
	if len(names) > 0 {
		description = strings.TrimSpace(description + " Skills: " + strings.Join(names, "; "))
	}
	return name, clipRunes(description, maxAgentDescription)
}

// clipRunes cuts s to max characters.
func clipRunes(s string, max int) string {
	if r := []rune(s); len(r) > max {
		return string(r[:max]) + "…"
	}
	return s
}

func (s *Server) handleHostStream(w http.ResponseWriter, r *http.Request) {
	sess := sessionOf(r)
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming isn't supported by this server.")
		return
	}
	var req hostRequest
	if !decodeRequest(w, r, &req) {
		return
	}
	text := strings.TrimSpace(req.Text)
	ids := map[string]bool{}
	for _, a := range req.Agents {
		if a.ID == "" || ids[a.ID] {
			writeError(w, http.StatusBadRequest, "Every agent needs an ID of its own.")
			return
		}
		ids[a.ID] = true
	}
	switch {
	case text == "":
		writeError(w, http.StatusBadRequest, `"text" is required.`)
		return
	case len(text) > maxHostText:
		writeError(w, http.StatusBadRequest, fmt.Sprintf("A message to the host agent can be %d KiB at most.", maxHostText>>10))
		return
	case len(req.Agents) > maxHostAgents:
		writeError(w, http.StatusBadRequest, fmt.Sprintf("The host agent can delegate to %d agents at most.", maxHostAgents))
		return
	}

	if !sess.host.busy.CompareAndSwap(false, true) {
		writeError(w, http.StatusConflict, "The host agent is still answering the last message.")
		return
	}
	defer sess.host.busy.Store(false)
	var c *hostConversation
	if req.ConversationID != "" {
		if c, ok = sess.host.get(req.ConversationID); !ok {
			writeErrorCode(w, http.StatusNotFound, "unknownConversation", "The inspector no longer has this conversation with the host agent. Start a new one.")
			return
		}
	}

	// The turn holds the connections, so they aren't replaced or destroyed
	// while the host agent uses them.
	var releases []func()
	defer func() {
		for _, release := range releases {
			release()
		}
	}()
	conns := make([]*connection, 0, len(req.Agents))
	for _, a := range req.Agents {
		conn, release, ok := sess.conns.acquire(a.ConnectionID)
		if !ok {
			writeErrorCode(w, http.StatusNotFound, "unknownConnection", "Unknown connection "+a.ConnectionID+". Connect to the agent again.")
			return
		}
		releases = append(releases, release)
		conns = append(conns, conn)
	}
	if !s.openStream(w, sess) {
		return
	}
	defer sess.closeStream()
	if c == nil {
		var err error
		if c, err = sess.host.start(r.Context(), s.opts.HostModel); err != nil {
			writeError(w, http.StatusInternalServerError, capitalize(err.Error())+".")
			return
		}
	}
	agents := make([]hostagent.Agent, len(req.Agents))
	for i, a := range req.Agents {
		agents[i] = c.agent(s, sess, a, conns[i])
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	// A shared inspector's limit for streams bounds the turn too.
	limit := hostTurnTimeout
	if d := s.opts.Limits.StreamDuration; d > 0 && d < limit {
		limit = d
	}
	ctx, cancel := context.WithTimeout(r.Context(), limit)
	defer cancel()
	stop := context.AfterFunc(sess.ctx, cancel)
	defer stop()
	turn := &hostTurn{w: w, flusher: flusher}
	defer turn.close()
	ctx = context.WithValue(ctx, hostTurnKey{}, turn)

	turn.send("conversation", map[string]string{"conversationId": c.id})
	err := c.conv.Send(ctx, text, agents, func(e hostagent.Event) {
		if e.Delegation != nil {
			turn.send("delegation", e.Delegation)
			return
		}
		turn.send("text", hostText{Text: e.Text, Partial: e.Partial})
	})
	switch {
	case err == nil:
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		turn.send("error", map[string]string{"message": fmt.Sprintf("The inspector stopped the host agent after %s, its limit for a turn.", limit)})
	case ctx.Err() != nil:
		// The user stopped the turn, or the session ended.
	default:
		turn.send("error", map[string]string{"message": s.hostError(err)})
	}
}

// hostError is what the user sees of an error that ended a turn. A shared
// inspector logs the model's details, which can name its project, instead.
func (s *Server) hostError(err error) string {
	if !s.opts.Hosted {
		return err.Error()
	}
	s.logf("host agent: %v", err)
	return hostagent.Summary(err)
}

type hostTurnKey struct{}

// hostTurn writes the events of a turn of the host agent as server-sent
// events, from any goroutine, until the turn ends.
type hostTurn struct {
	mu      sync.Mutex
	w       http.ResponseWriter
	flusher http.Flusher
	closed  bool
}

func (t *hostTurn) send(event string, v any) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.closed && writeEvent(t.w, event, v) {
		t.flusher.Flush()
	}
}

func (t *hostTurn) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closed = true
}

// delegateClient calls an agent for the host agent, through the agent's
// connection, so calls are recorded and validated like the user's own.
type delegateClient struct {
	s    *Server
	sess *session
	// thread is the host agent's conversation with the agent, apart from
	// the user's own on the connection.
	thread thread

	mu   sync.Mutex
	conn *connection
	// state is the task state the agent reported last in the delegation.
	state string
}

// use makes the client call the agent through conn.
func (d *delegateClient) use(conn *connection) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.conn = conn
}

func (d *delegateClient) taskState() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.state
}

// prepare makes a message continue the task waiting for input, as the
// user's messages do, and returns the call to record the request with.
func (d *delegateClient) prepare(req *a2a.SendMessageRequest) (*connection, *traffic.Call, error) {
	d.mu.Lock()
	conn := d.conn
	d.state = ""
	d.mu.Unlock()
	contextID, open := d.thread.conversation()
	if m := req.Message; m != nil && open != nil && m.TaskID == "" && (m.ContextID == "" || m.ContextID == contextID) {
		m.ContextID, m.TaskID = contextID, a2a.TaskID(open.ID)
	}
	tc, err := conn.call()
	if err != nil {
		return nil, nil, err
	}
	tc.Origin = traffic.OriginHost
	return conn, tc, nil
}

// record follows the conversation through a result and shows it in the turn.
func (d *delegateClient) record(ctx context.Context, res agentResult) {
	if res.Payload != nil {
		d.thread.observe(res.Payload.Raw, true)
		if ref := taskRefOf(res.Payload.Raw); ref.State != "" {
			d.mu.Lock()
			d.state = ref.State
			d.mu.Unlock()
		}
	}
	res.ContextID, res.OpenTask = d.thread.conversation()
	if t, ok := ctx.Value(hostTurnKey{}).(*hostTurn); ok {
		t.send("result", delegationResult{DelegationID: hostagent.DelegationID(ctx), Result: res})
	}
}

func (d *delegateClient) SendMessage(ctx context.Context, req *a2a.SendMessageRequest) (a2a.SendMessageResult, error) {
	conn, tc, err := d.prepare(req)
	if err != nil {
		return nil, err
	}
	ctx, stop := linkContext(ctx, conn)
	defer stop()
	start := time.Now()
	decoded, err := conn.client.SendMessage(traffic.WithCall(ctx, tc), req)
	d.record(ctx, d.s.unaryResult(d.sess, conn, tc, start, validate.SendMessageResponse, decoded, err))
	return decoded, err
}

// SendStreamingMessage streams when the agent's card declares streaming, and
// sends the message without it otherwise.
func (d *delegateClient) SendStreamingMessage(ctx context.Context, req *a2a.SendMessageRequest) iter.Seq2[a2a.Event, error] {
	return func(yield func(a2a.Event, error) bool) {
		d.mu.Lock()
		streams := cardStreams(d.conn.cardDoc)
		d.mu.Unlock()
		if !streams {
			res, err := d.SendMessage(ctx, req)
			if err != nil {
				yield(nil, err)
				return
			}
			yield(res, nil)
			return
		}
		// Streams to agents count against the session's limit too.
		if limit := d.s.opts.Limits.Streams; !d.sess.openStream(limit) {
			yield(nil, fmt.Errorf("this session already has %d streams open, the inspector's limit", limit))
			return
		}
		defer d.sess.closeStream()
		conn, tc, err := d.prepare(req)
		if err != nil {
			yield(nil, err)
			return
		}
		ctx, stop := linkContext(ctx, conn)
		defer stop()
		d.s.runStream(ctx, d.sess, conn, tc, func(ctx context.Context) iter.Seq2[a2a.Event, error] {
			return conn.client.SendStreamingMessage(ctx, req)
		}, func(res agentResult) { d.record(ctx, res) }, yield)
	}
}

func (d *delegateClient) CancelTask(ctx context.Context, req *a2a.CancelTaskRequest) (*a2a.Task, error) {
	d.mu.Lock()
	conn := d.conn
	d.mu.Unlock()
	tc, err := conn.call()
	if err != nil {
		return nil, err
	}
	tc.Origin = traffic.OriginHost
	ctx, stop := linkContext(ctx, conn)
	defer stop()
	start := time.Now()
	task, err := conn.client.CancelTask(traffic.WithCall(ctx, tc), req)
	var decoded any
	if err == nil {
		decoded = task
	}
	d.record(ctx, d.s.unaryResult(d.sess, conn, tc, start, validate.Task, decoded, err))
	return task, err
}

// Destroy leaves the connection to the UI, which owns it.
func (d *delegateClient) Destroy() error { return nil }

// cardStreams reports whether a card declares streaming.
func cardStreams(card map[string]any) bool {
	caps, _ := card["capabilities"].(map[string]any)
	streaming, _ := caps["streaming"].(bool)
	return streaming
}
