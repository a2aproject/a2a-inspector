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
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
	"github.com/a2aproject/a2a-inspector/internal/validate"
)

// maxNotifications is how many received push notifications the inspector keeps.
const maxNotifications = 500

// tokenHeaders carry a push notification config's token. a2a-go sends the
// first; most other SDKs send the second, in both versions.
var tokenHeaders = []string{"A2A-Notification-Token", "X-A2A-Notification-Token"}

// webhook is a receiver for push notifications from an agent, at
// /hooks/{id}. Its ID is random, so only the agent it was given to knows the
// URL, and its token tells the agent's notifications from forged ones.
type webhook struct {
	id, token    string
	url          string
	connectionID string
	// version is the protocol version of the interface the config was set on.
	version string
	// taskID is the task the config is for. A config sent with a message
	// gets it from the agent's answer.
	taskID string
	// stale is set when a config of the task was deleted, maybe this
	// webhook's, so the task may no longer notify it.
	stale bool
}

type webhookView struct {
	ID  string `json:"id"`
	URL string `json:"url"`
	// Existing is set when the task already notifies the webhook, so the
	// call sent no push notification config.
	Existing bool `json:"existing,omitempty"`
}

// notification is a push notification the inspector received.
type notification struct {
	ID           string    `json:"id"`
	WebhookID    string    `json:"webhookId"`
	ConnectionID string    `json:"connectionId"`
	TaskID       string    `json:"taskId,omitempty"`
	Time         time.Time `json:"time"`
	// TokenValid is set when the request carried the webhook's token, in
	// TokenHeader.
	TokenValid  bool   `json:"tokenValid"`
	TokenHeader string `json:"tokenHeader,omitempty"`
	// Payload is the body as received. Error is set instead when the body
	// isn't JSON.
	Payload *agentPayload    `json:"payload,omitempty"`
	Error   *callError       `json:"error,omitempty"`
	Headers []traffic.Header `json:"headers"`
	// Conversation is what the connection's next message continues after
	// this notification, set when the notification moved it on.
	Conversation *conversation `json:"conversation,omitempty"`
}

type conversation struct {
	ContextID string     `json:"contextId,omitempty"`
	OpenTask  *taskState `json:"openTask,omitempty"`
}

// hooks keeps the webhooks and the notifications they received, which the
// UI follows live.
type hooks struct {
	mu            sync.Mutex
	webhooks      map[string]*webhook
	notifications []*notification
	next          int
	subs          map[chan *notification]func(*notification) bool
}

func newHooks() *hooks {
	return &hooks{webhooks: map[string]*webhook{}, subs: map[chan *notification]func(*notification) bool{}}
}

// create adds a webhook for a connection, under baseURL.
func (h *hooks) create(conn *connection, taskID, baseURL string) (*webhook, webhookView) {
	_, version := conn.binding()
	id := "wh-" + randomString(16)
	wh := &webhook{id: id, token: randomString(24), url: baseURL + "/hooks/" + id, connectionID: conn.view.ID, version: version, taskID: taskID}
	h.mu.Lock()
	h.webhooks[wh.id] = wh
	h.mu.Unlock()
	return wh, webhookView{ID: wh.id, URL: wh.url}
}

// forTask returns a webhook that a connection's task already notifies,
// under baseURL: after the base URL changes, the agent may not reach the
// older webhooks.
func (h *hooks) forTask(connID, taskID, baseURL string) (webhookView, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, wh := range h.webhooks {
		if taskID != "" && wh.connectionID == connID && wh.taskID == taskID && !wh.stale && wh.url == baseURL+"/hooks/"+wh.id {
			return webhookView{ID: wh.id, URL: wh.url, Existing: true}, true
		}
	}
	return webhookView{}, false
}

// bind gives a webhook created with a message the task of the agent's answer.
func (h *hooks) bind(view *webhookView, res agentResult) {
	if view == nil || view.Existing || res.Payload == nil {
		return
	}
	taskID := taskRefOf(res.Payload.Raw).ID
	h.mu.Lock()
	defer h.mu.Unlock()
	if wh, ok := h.webhooks[view.ID]; ok && wh.taskID == "" {
		wh.taskID = taskID
	}
}

// dropWebhook removes the webhook a call created when the agent rejected the
// call or never got it, and returns the webhook to report. After a cancel or
// a timeout the agent may have taken the config, so the webhook stays.
func (s *Server) dropWebhook(ctx context.Context, view *webhookView, res agentResult) *webhookView {
	if view == nil || view.Existing || res.Call.Error == nil || !res.Call.Error.rejected || ctx.Err() != nil {
		return view
	}
	s.hooks.mu.Lock()
	delete(s.hooks.webhooks, view.ID)
	s.hooks.mu.Unlock()
	return nil
}

// configDeleted marks a connection's webhooks for a task stale after one
// of the task's configs was deleted. They keep receiving, which shows
// whether the agent still notifies them.
func (h *hooks) configDeleted(connID, taskID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, wh := range h.webhooks {
		if wh.connectionID == connID && wh.taskID == taskID {
			wh.stale = true
		}
	}
}

// webhook returns a copy of a webhook, since move can change it.
func (h *hooks) webhook(id string) (webhook, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	wh, ok := h.webhooks[id]
	if !ok {
		return webhook{}, false
	}
	return *wh, true
}

// move gives the webhooks of one connection to another that replaces it.
func (h *hooks) move(from, to string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, wh := range h.webhooks {
		if wh.connectionID == from {
			wh.connectionID = to
		}
	}
}

func (h *hooks) add(n *notification) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.next++
	n.ID = "nt-" + strconv.Itoa(h.next)
	h.notifications = append(h.notifications, n)
	if len(h.notifications) > maxNotifications {
		h.notifications = slices.Delete(h.notifications, 0, len(h.notifications)-maxNotifications)
	}
	for ch, filter := range h.subs {
		if !filter(n) {
			continue
		}
		select {
		case ch <- n:
		default:
			// Too far behind: the UI reconnects and gets a new snapshot.
			delete(h.subs, ch)
			close(ch)
		}
	}
}

// subscribe returns the notifications that pass filter and a channel with
// the later ones. The channel is closed when cancel is called or the
// subscriber falls behind.
func (h *hooks) subscribe(filter func(*notification) bool) ([]*notification, <-chan *notification, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	snapshot := []*notification{}
	for _, n := range h.notifications {
		if filter(n) {
			snapshot = append(snapshot, n)
		}
	}
	ch := make(chan *notification, 64)
	h.subs[ch] = filter
	return snapshot, ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if _, ok := h.subs[ch]; ok {
			delete(h.subs, ch)
			close(ch)
		}
	}
}

func randomString(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b) // crypto/rand.Read doesn't fail.
	return base64.RawURLEncoding.EncodeToString(b)
}

// handleHook receives a push notification. It answers 200 to every request
// for a known webhook, also one with a wrong token, which the UI shows as
// such; the agent learns nothing from the answer.
func (s *Server) handleHook(w http.ResponseWriter, r *http.Request) {
	wh, ok := s.hooks.webhook(r.PathValue("hook"))
	if !ok {
		http.Error(w, "Unknown webhook.", http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, traffic.MaxBodySize))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "The notification is too large.", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "Couldn't read the notification.", http.StatusBadRequest)
		}
		return
	}
	n := &notification{
		WebhookID:    wh.id,
		ConnectionID: wh.connectionID,
		Time:         time.Now(),
		Headers:      maskedHeaders(r.Header, wh.token),
	}
	for _, name := range tokenHeaders {
		if v := r.Header.Get(name); v != "" {
			n.TokenHeader = name
			n.TokenValid = subtle.ConstantTimeCompare([]byte(v), []byte(wh.token)) == 1
			break
		}
	}
	n.Payload, n.Error = s.notificationPayload(body, wh.version)
	if n.Payload != nil {
		n.TaskID = taskRefOf(n.Payload.Raw).ID
		if conn, ok := s.conns.get(wh.connectionID); ok && n.TokenValid {
			before := conversationOf(conn)
			conn.observe(n.Payload.Raw, false)
			if after := conversationOf(conn); !conversationEqual(before, after) {
				n.Conversation = &after
			}
		}
	}
	n.TaskID = cmp.Or(n.TaskID, wh.taskID)
	s.hooks.add(n)
	w.WriteHeader(http.StatusOK)
}

func conversationOf(c *connection) conversation {
	contextID, open := c.conversation()
	return conversation{ContextID: contextID, OpenTask: open}
}

func conversationEqual(a, b conversation) bool {
	return a.ContextID == b.ContextID && (a.OpenTask == nil) == (b.OpenTask == nil) && (a.OpenTask == nil || *a.OpenTask == *b.OpenTask)
}

// maskedHeaders lists request headers with secret values masked.
func maskedHeaders(h http.Header, secrets ...string) []traffic.Header {
	out := []traffic.Header{}
	for _, name := range slices.Sorted(maps.Keys(h)) {
		for _, v := range h[name] {
			out = append(out, traffic.Header{Name: name, Value: traffic.MaskValue(name, v, secrets)})
		}
	}
	return out
}

// v10Events are the members of a v1.0 StreamResponse.
var v10Events = []string{"task", "message", "statusUpdate", "artifactUpdate"}

// notificationPayload reads and validates a push notification's body. v1.0
// agents send a StreamResponse. v0.3 doesn't define the payload; agents
// usually send the task, as v0.3 JSON-RPC writes it. The format is read from
// the body, since some agents send v1.0 notifications for configs set over a
// v0.3 interface.
func (s *Server) notificationPayload(body []byte, version string) (*agentPayload, *callError) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(body, &obj); err != nil {
		return nil, &callError{Message: "The notification isn't a JSON object: " + err.Error(), Raw: excerpt(body)}
	}
	format := version
	_, tagged := obj["kind"]
	switch {
	case slices.ContainsFunc(v10Events, func(k string) bool { _, ok := obj[k]; return ok }):
		format = agents.Version10
	case tagged:
		format = agents.Version03
	}
	var p *agentPayload
	if format == agents.Version03 && !tagged {
		p = &agentPayload{ProtocolVersion: format, Raw: body, Validation: validate.Merge(validate.Report{Findings: []validate.Finding{}}, validate.Finding{
			Severity: validate.SeverityInfo,
			Rule:     "notification",
			Message:  "v0.3 doesn't define the notification payload, and this one is neither a task nor an event, so it isn't checked.",
		})}
	} else {
		// Tagged v0.3 payloads follow the v0.3 JSON-RPC forms.
		p = s.payload(body, format, agents.BindingJSONRPC, validate.StreamResponse)
	}
	if format != version {
		p.Validation = validate.Merge(p.Validation, validate.Finding{
			Severity: validate.SeverityInfo,
			Rule:     "notification-version",
			Message:  fmt.Sprintf("The notification is in the v%s format, but the config was set over a v%s interface.", format, version),
		})
	}
	return p, nil
}

// handleHooks streams received push notifications as server-sent events: a
// "snapshot" of the ones so far, with what every connection's next message
// continues, then a "notification" event for each new one. connectionId and
// taskId filter them.
func (s *Server) handleHooks(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming isn't supported by this server.")
		return
	}
	connID, taskID := r.URL.Query().Get("connectionId"), r.URL.Query().Get("taskId")
	snapshot, updates, cancel := s.hooks.subscribe(func(n *notification) bool {
		return (connID == "" || n.ConnectionID == connID) && (taskID == "" || n.TaskID == taskID)
	})
	defer cancel()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	conversations := map[string]conversation{}
	for _, c := range s.conns.all() {
		if connID == "" || c.view.ID == connID {
			conversations[c.view.ID] = conversationOf(c)
		}
	}
	if !writeEvent(w, "snapshot", map[string]any{"notifications": snapshot, "conversations": conversations}) {
		return
	}
	flusher.Flush()

	keepAlive := time.NewTicker(keepAliveInterval)
	defer keepAlive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case <-keepAlive.C:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
		case n, ok := <-updates:
			if !ok || !writeEvent(w, "notification", n) {
				return
			}
		}
		flusher.Flush()
	}
}
