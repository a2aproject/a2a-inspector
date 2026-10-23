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
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"mime"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
	"github.com/a2aproject/a2a-inspector/internal/validate"
	"google.golang.org/grpc/codes"
)

// sendTimeout bounds a non-streaming call; streams last until the UI stops them.
const sendTimeout = 5 * time.Minute

// Payload kinds the server reads itself instead of with validate.Payload.
const (
	// extendedCard is the result of GetExtendedAgentCard, checked as a card.
	extendedCard validate.PayloadKind = "AgentCard"
	// empty is the result of DeleteTaskPushNotificationConfig.
	empty validate.PayloadKind = "Empty"
)

type sendRequest struct {
	Compose *agents.Compose `json:"compose,omitempty"`
	// RawMessage replaces Compose with a message written in the connection's
	// own version and binding format. HTTP bindings send it byte for byte.
	RawMessage *string `json:"rawMessage,omitempty"`
	Options    struct {
		// NewContext starts a new conversation instead of continuing the
		// connection's context and open task.
		NewContext bool `json:"newContext,omitempty"`
		// NewTask starts a new task in the conversation instead of
		// continuing the open task.
		NewTask bool `json:"newTask,omitempty"`
		// PushNotifications asks the agent to send the task's updates to a
		// new webhook of the inspector, unless the task it continues already
		// notifies one.
		PushNotifications   bool     `json:"pushNotifications,omitempty"`
		ReturnImmediately   bool     `json:"returnImmediately,omitempty"`
		HistoryLength       *int     `json:"historyLength,omitempty"`
		AcceptedOutputModes []string `json:"acceptedOutputModes,omitempty"`
	} `json:"options"`
}

// agentResult is what every agent operation returns, and what each event of
// a stream carries.
type agentResult struct {
	Payload *agentPayload `json:"payload,omitempty"`
	Call    call          `json:"call"`
	// ContextID and OpenTask are what the connection's next message
	// continues after this result: the conversation and the task waiting
	// for the user.
	ContextID string     `json:"contextId,omitempty"`
	OpenTask  *taskState `json:"openTask,omitempty"`
	// Webhook is the inspector's receiver that the call's push notification
	// config points to, or with Existing the one the task already notifies.
	Webhook *webhookView `json:"webhook,omitempty"`
}

// sendCall is a send request ready to go to the agent.
type sendCall struct {
	conn    *connection
	req     *a2a.SendMessageRequest
	tc      *traffic.Call
	webhook *webhookView
}

func (s *Server) buildSend(conn *connection, req sendRequest) (*a2a.SendMessageRequest, []byte, error) {
	var msg *a2a.Message
	var raw []byte
	switch {
	case req.RawMessage != nil && req.Compose != nil:
		return nil, nil, errors.New(`give either "compose" or "rawMessage"`)
	case req.RawMessage != nil:
		if binding, _ := conn.binding(); agents.CoreBinding(binding) == "" {
			return nil, nil, fmt.Errorf("raw messages need a JSONRPC, HTTP+JSON or GRPC interface, not %s", binding)
		}
		raw = []byte(*req.RawMessage)
		// a2a-go sends this one; the recorder replaces it with raw.
		msg = a2a.NewMessage(a2a.MessageRoleUser, a2a.NewTextPart(""))
	case req.Compose != nil:
		var err error
		if msg, err = req.Compose.Message(); err != nil {
			return nil, nil, err
		}
		if contextID, open := conn.conversation(); !req.Options.NewContext {
			msg.ContextID = contextID
			if open != nil && !req.Options.NewTask {
				msg.TaskID = a2a.TaskID(open.ID)
			}
		}
	default:
		return nil, nil, errors.New(`"compose" or "rawMessage" is required`)
	}
	out := &a2a.SendMessageRequest{Message: msg}
	o := req.Options
	if o.ReturnImmediately || o.HistoryLength != nil || len(o.AcceptedOutputModes) > 0 {
		out.Config = &a2a.SendMessageConfig{
			ReturnImmediately:   o.ReturnImmediately,
			HistoryLength:       o.HistoryLength,
			AcceptedOutputModes: o.AcceptedOutputModes,
		}
	}
	return out, raw, nil
}

// prepareSend decodes and builds a send request, or writes an error response.
func (s *Server) prepareSend(w http.ResponseWriter, r *http.Request) (*sendCall, bool) {
	conn, ok := s.connection(w, r)
	if !ok {
		return nil, false
	}
	var req sendRequest
	if !decodeRequest(w, r, &req) {
		return nil, false
	}
	sendReq, raw, err := s.buildSend(conn, req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, false
	}
	_, secrets, err := conn.params()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, false
	}
	sc := &sendCall{conn: conn, req: sendReq, tc: &traffic.Call{ConnectionID: conn.view.ID, Secrets: secrets, MessageOverride: raw}}
	if req.Options.PushNotifications {
		base := s.webhookBaseURL()
		if view, ok := s.hooks.forTask(conn.view.ID, string(sendReq.Message.TaskID), base); ok {
			// A second config would make the agent notify twice.
			sc.webhook = &view
		} else {
			wh, view := s.hooks.create(conn, "", base)
			if sendReq.Config == nil {
				sendReq.Config = &a2a.SendMessageConfig{}
			}
			sendReq.Config.PushConfig = &a2a.PushConfig{URL: view.URL, Token: wh.token}
			sc.webhook = &view
		}
	}
	if req.Options.NewContext || req.Options.NewTask {
		conn.reset(req.Options.NewContext)
	}
	return sc, true
}

func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	sc, ok := s.prepareSend(w, r)
	if !ok {
		return
	}
	callCtx, stop := s.callContext(r)
	defer stop()
	ctx, cancel := context.WithTimeout(callCtx, sendTimeout)
	defer cancel()
	start := time.Now()
	decoded, err := sc.conn.client.SendMessage(traffic.WithCall(ctx, sc.tc), sc.req)
	res := s.unaryResult(sc.conn, sc.tc, start, validate.SendMessageResponse, decoded, err)
	sc.conn.settle(&res, true)
	s.hooks.bind(sc.webhook, res)
	res.Webhook = s.dropWebhook(ctx, sc.webhook, res)
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	sc, ok := s.prepareSend(w, r)
	if !ok {
		return
	}
	s.streamEvents(w, r, streamCall{
		conn:    sc.conn,
		tc:      sc.tc,
		op:      validate.SendStreamingMessage,
		own:     true,
		webhook: sc.webhook,
		run: func(ctx context.Context) iter.Seq2[a2a.Event, error] {
			return sc.conn.client.SendStreamingMessage(ctx, sc.req)
		},
	})
}

// streamCall is a streaming call to an agent.
type streamCall struct {
	conn *connection
	tc   *traffic.Call
	// op is checked against the card's capabilities.
	op validate.Operation
	// own is set for replies to the conversation's own messages.
	own     bool
	webhook *webhookView
	run     func(ctx context.Context) iter.Seq2[a2a.Event, error]
}

// streamEvents answers with the events of a streaming call as server-sent
// events, one agentResult each, read from the wire as they arrive.
func (s *Server) streamEvents(w http.ResponseWriter, r *http.Request, sc streamCall) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming isn't supported by this server.")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	conn, tc := sc.conn, sc.tc
	binding, version := conn.binding()
	opFindings := s.operationFindings(conn, sc.op)
	ctx, stop := s.callContext(r)
	defer stop()
	var mu sync.Mutex
	emitted, failed := 0, false
	emit := func(res agentResult) {
		mu.Lock()
		defer mu.Unlock()
		if emitted == 0 {
			res.Call.Findings = append(opFindings, res.Call.Findings...)
			// A rejection as the first result ends the stream.
			res.Webhook = s.dropWebhook(ctx, sc.webhook, res)
		}
		conn.settle(&res, sc.own)
		s.hooks.bind(sc.webhook, res)
		emitted++
		failed = failed || res.Call.Error != nil
		data, _ := json.Marshal(res)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}

	start := time.Now()
	requestIDs := map[string]json.RawMessage{}
	tc.OnFrame = func(entryID string, f traffic.Frame) {
		id, ok := requestIDs[entryID]
		if !ok {
			if e, found := s.traffic.Get(entryID); found && e.HTTP != nil {
				id = jsonrpcRequestID(e.HTTP.RequestBody)
			}
			requestIDs[entryID] = id
		}
		res := agentResult{Call: call{TrafficEntryID: entryID, LatencyMs: time.Since(start).Milliseconds()}}
		res.Payload, res.Call.Error = s.eventPayload([]byte(f.Data), binding, version, id)
		emit(res)
	}
	tc.OnMessage = func(entryID string, m traffic.GRPCMessage) {
		emit(agentResult{
			Call:    call{TrafficEntryID: entryID, LatencyMs: time.Since(start).Milliseconds()},
			Payload: s.payload(m.JSON, version, binding, validate.StreamResponse),
		})
	}

	var streamErr error
	for event, err := range sc.run(traffic.WithCall(ctx, tc)) {
		if err != nil {
			streamErr = err
			break
		}
		if tc.LastEntryID() == "" {
			// A transport the inspector can't record: show what a2a-go
			// decoded.
			emit(s.decodedResult(start, binding, validate.StreamResponse, a2a.StreamResponse{Event: event}))
		}
	}
	if ctx.Err() != nil {
		return
	}
	mu.Lock()
	done := failed || (emitted > 0 && streamErr == nil)
	mu.Unlock()
	if done {
		return
	}
	// The agent answered without a stream, the stream failed, or it ended
	// without events.
	entry, ok := s.traffic.Get(tc.LastEntryID())
	if ok && (entry.GRPC != nil || (entry.HTTP != nil && !traffic.IsEventStream(headerValue(entry.HTTP.ResponseHeaders, "Content-Type")))) {
		emit(s.unaryResult(conn, tc, start, validate.StreamResponse, nil, streamErr))
		return
	}
	res := agentResult{Call: call{TrafficEntryID: tc.LastEntryID(), LatencyMs: time.Since(start).Milliseconds()}}
	switch {
	case streamErr != nil:
		res.Call.Error = errorFrom(streamErr)
		// Without a traffic entry, the request never left; with one, the
		// agent started a stream.
		res.Call.Error.rejected = !ok
		if ok && entry.Error != "" {
			res.Call.Error.Message = entry.Error + " (" + res.Call.Error.Message + ")"
		}
	default:
		res.Call.Error = &callError{Message: "The stream ended without any events."}
	}
	emit(res)
}

// operationFindings reports what the card and the protocol version say
// against an operation. Without a card, only the version counts.
func (s *Server) operationFindings(conn *connection, op validate.Operation) []validate.Finding {
	if op == "" {
		return nil
	}
	_, version := conn.binding()
	findings := validate.OperationFindings(conn.cardDoc, version, op)
	if conn.cardDoc == nil {
		findings = slices.DeleteFunc(findings, func(f validate.Finding) bool { return f.Rule == "capability" })
	}
	return findings
}

// unaryResult builds the result of a call from its last traffic entry: the
// payload as received, or the error the agent or network gave. decoded is
// what a2a-go made of the response, used when there's no traffic entry.
func (s *Server) unaryResult(conn *connection, tc *traffic.Call, start time.Time, kind validate.PayloadKind, decoded any, err error) agentResult {
	binding, version := conn.binding()
	res := agentResult{Call: call{TrafficEntryID: tc.LastEntryID(), LatencyMs: time.Since(start).Milliseconds()}}
	entry, ok := s.traffic.Get(res.Call.TrafficEntryID)
	switch {
	case !ok && err != nil:
		// a2a-go failed before sending, or on a transport the inspector
		// can't record.
		res.Call.Error = errorFrom(err)
		res.Call.Error.rejected = true
	case !ok && decoded != nil:
		if r, isResult := decoded.(a2a.SendMessageResult); isResult {
			decoded = a2a.StreamResponse{Event: r}
		}
		return s.decodedResult(start, binding, kind, decoded)
	case !ok:
		res.Call.Error = &callError{Message: "The stream ended without any events."}
	case entry.GRPC != nil:
		res.Payload, res.Call.Error = s.grpcPayload(entry, version, binding, kind, err)
	default:
		res.Payload, res.Call.Error = s.httpPayload(entry, version, binding, kind, err)
		if kind == empty && res.Call.Error == nil && binding == agents.BindingJSONRPC {
			// A delete has no payload to carry the envelope's findings.
			res.Call.Findings = validate.JSONRPCEnvelope([]byte(entry.HTTP.ResponseBody), jsonrpcRequestID(entry.HTTP.RequestBody))
		}
		if res.Payload != nil && kind == validate.StreamResponse {
			res.Payload.Validation = validate.Merge(res.Payload.Validation, validate.Finding{
				Severity: validate.SeverityError,
				Rule:     "content-type",
				Message:  "The agent answered a streaming request without text/event-stream.",
			})
		}
	}
	if res.Call.Error == nil && err != nil {
		res.Call.Findings = append(res.Call.Findings, validate.Finding{
			Severity: validate.SeverityWarning,
			Rule:     "a2a-go",
			Message:  "a2a-go couldn't read the response: " + err.Error(),
		})
	}
	return res
}

func (s *Server) decodedResult(start time.Time, binding string, kind validate.PayloadKind, decoded any) agentResult {
	res := agentResult{Call: call{LatencyMs: time.Since(start).Milliseconds()}}
	if kind == empty {
		return res
	}
	raw, err := json.Marshal(decoded)
	if err != nil {
		res.Call.Error = &callError{Message: "Couldn't encode the response: " + err.Error()}
		return res
	}
	// a2a-go's types are v1.0, whatever version the transport speaks.
	res.Payload = s.payload(raw, agents.Version10, binding, kind)
	res.Call.Findings = []validate.Finding{{
		Severity: validate.SeverityInfo,
		Rule:     "decoded",
		Message:  "The inspector can't record this transport, so this is the response as a2a-go decoded it, in v1.0 form.",
	}}
	return res
}

func (s *Server) payload(raw []byte, version, binding string, kind validate.PayloadKind) *agentPayload {
	if kind == extendedCard {
		// A card has its own format, which can differ from the interface's.
		p, _ := s.describeCard(raw, validate.CardInput{}, "")
		return p
	}
	return &agentPayload{
		ProtocolVersion: version,
		Raw:             json.RawMessage(raw),
		Validation:      validate.Payload(raw, validate.PayloadInput{ProtocolVersion: version, Binding: binding, Kind: kind}),
	}
}

func (s *Server) httpPayload(entry *traffic.Entry, version, binding string, kind validate.PayloadKind, err error) (*agentPayload, *callError) {
	h := entry.HTTP
	if h.Status == 0 {
		return nil, &callError{Message: cmp.Or(entry.Error, errMessage(err), "No response."), rejected: true}
	}
	body := []byte(h.ResponseBody)
	if h.Truncated {
		return nil, &callError{Code: h.Status, Message: fmt.Sprintf("The response is larger than %d MiB, more than the inspector shows.", traffic.MaxBodySize>>20)}
	}
	if h.Status < 200 || h.Status > 299 {
		return nil, httpError(h.Status, body, err)
	}
	if kind == empty {
		return nil, nil
	}
	var findings []validate.Finding
	if mediaType, _, perr := mime.ParseMediaType(headerValue(h.ResponseHeaders, "Content-Type")); perr != nil || mediaType != "application/json" {
		findings = append(findings, validate.Finding{
			Severity: validate.SeverityWarning,
			Rule:     "content-type",
			Message:  fmt.Sprintf("The response was served as %q; A2A responses are application/json.", headerValue(h.ResponseHeaders, "Content-Type")),
		})
	}
	if binding == agents.BindingJSONRPC {
		p, ce := s.jsonrpcPayload(body, version, binding, kind, jsonrpcRequestID(h.RequestBody))
		if p != nil {
			p.Validation = validate.Merge(p.Validation, findings...)
		}
		return p, ce
	}
	if !json.Valid(body) {
		return nil, &callError{Code: h.Status, Message: "The response isn't valid JSON.", Raw: excerpt(body)}
	}
	p := s.payload(body, version, binding, kind)
	p.Validation = validate.Merge(p.Validation, findings...)
	return p, nil
}

// jsonrpcPayload takes the result out of a JSON-RPC response.
func (s *Server) jsonrpcPayload(body []byte, version, binding string, kind validate.PayloadKind, requestID json.RawMessage) (*agentPayload, *callError) {
	var env struct {
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, &callError{Message: "The response isn't a JSON-RPC response: " + err.Error(), Raw: excerpt(body)}
	}
	if env.Error != nil && string(env.Error) != "null" {
		return nil, jsonrpcError(env.Error)
	}
	if env.Result == nil {
		return nil, &callError{Message: "The JSON-RPC response has neither a result nor an error.", Raw: json.RawMessage(body)}
	}
	if kind == empty {
		return nil, nil
	}
	p := s.payload(env.Result, version, binding, kind)
	p.Validation = validate.Merge(p.Validation, validate.JSONRPCEnvelope(body, requestID)...)
	return p, nil
}

// eventPayload reads the data of one server-sent event.
func (s *Server) eventPayload(data []byte, binding, version string, requestID json.RawMessage) (*agentPayload, *callError) {
	if binding == agents.BindingJSONRPC {
		return s.jsonrpcPayload(data, version, binding, validate.StreamResponse, requestID)
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, &callError{Message: "The event isn't valid JSON: " + err.Error(), Raw: excerpt(data)}
	}
	if errBody, ok := probe["error"]; ok && len(probe) == 1 {
		ce := httpError(0, data, nil)
		if ce.Message == "" {
			ce.Message = "The agent sent an error: " + string(errBody)
		}
		return nil, ce
	}
	return s.payload(data, version, binding, validate.StreamResponse), nil
}

func (s *Server) grpcPayload(entry *traffic.Entry, version, binding string, kind validate.PayloadKind, err error) (*agentPayload, *callError) {
	g := entry.GRPC
	if g.StatusCode != codes.OK.String() {
		ce := &callError{A2AError: a2aErrorName(err), Message: cmp.Or(g.StatusMessage, entry.Error, errMessage(err)), rejected: true}
		if c, ok := grpcCode(g.StatusCode); ok {
			ce.Code = int(c)
			ce.Raw = map[string]any{"code": g.StatusCode, "message": g.StatusMessage, "trailers": g.Trailers}
		}
		return nil, ce
	}
	if kind == empty {
		return nil, nil
	}
	for i := len(g.Messages) - 1; i >= 0; i-- {
		if !g.Messages[i].FromClient {
			return s.payload(g.Messages[i].JSON, version, binding, kind), nil
		}
	}
	return nil, &callError{Message: "The agent sent no message."}
}

func grpcCode(name string) (codes.Code, bool) {
	for c := codes.OK; c <= codes.Unauthenticated; c++ {
		if c.String() == name {
			return c, true
		}
	}
	return 0, false
}

func headerValue(headers []traffic.Header, name string) string {
	for _, h := range headers {
		if strings.EqualFold(h.Name, name) {
			return h.Value
		}
	}
	return ""
}

func jsonrpcRequestID(body string) json.RawMessage {
	var req struct {
		ID json.RawMessage `json:"id"`
	}
	if json.Unmarshal([]byte(body), &req) != nil {
		return nil
	}
	return req.ID
}

// taskRef is what a payload says about a task.
type taskRef struct {
	ID, ContextID string
	// State is lower case with dashes, as v0.3 JSON-RPC writes it: "input-required".
	State string
}

// eventWrappers name the member ProtoJSON wraps each payload in, with the
// v0.3 proto's names, and its kind.
var eventWrappers = []struct{ name, kind string }{
	{"task", "task"},
	{"message", "message"},
	{"msg", "message"},
	{"statusUpdate", "status-update"},
	{"status_update", "status-update"},
	{"artifactUpdate", "artifact-update"},
	{"artifact_update", "artifact-update"},
}

// taskRefOf reads a task, message or event in any of the payload forms:
// tagged with "kind" (v0.3 JSON-RPC) or wrapped in a member named after its
// type (ProtoJSON). A bare task, as GetTask returns it, has no wrapper.
func taskRefOf(raw json.RawMessage) taskRef {
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return taskRef{}
	}
	kind, _ := obj["kind"].(string)
	if kind == "" {
		kind = "task"
		for _, w := range eventWrappers {
			if inner, ok := obj[w.name].(map[string]any); ok {
				obj, kind = inner, w.kind
				break
			}
		}
	}
	ref := taskRef{ContextID: stringField(obj, "contextId", "context_id")}
	if kind == "task" {
		ref.ID = stringField(obj, "id")
	} else {
		ref.ID = stringField(obj, "taskId", "task_id")
	}
	if status, ok := obj["status"].(map[string]any); ok {
		state, _ := status["state"].(string)
		ref.State = strings.ReplaceAll(strings.ToLower(strings.TrimPrefix(state, "TASK_STATE_")), "_", "-")
	}
	return ref
}

// stringField returns the first of the named members that's a string.
func stringField(obj map[string]any, names ...string) string {
	for _, n := range names {
		if v, ok := obj[n].(string); ok {
			return v
		}
	}
	return ""
}

func errMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
