package server

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
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

type sendRequest struct {
	Compose *agents.Compose `json:"compose,omitempty"`
	// RawMessage replaces Compose with a message written in the connection's
	// own version and binding format. HTTP bindings send it byte for byte.
	RawMessage *string `json:"rawMessage,omitempty"`
	Options    struct {
		// NewContext starts a new conversation instead of continuing the
		// connection's context.
		NewContext          bool     `json:"newContext,omitempty"`
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
	// ContextID is the conversation the connection continues after this result.
	ContextID string `json:"contextId,omitempty"`
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
		if !req.Options.NewContext {
			msg.ContextID = conn.currentContextID()
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
func (s *Server) prepareSend(w http.ResponseWriter, r *http.Request) (*connection, *a2a.SendMessageRequest, *traffic.Call, bool) {
	conn, ok := s.connection(w, r)
	if !ok {
		return nil, nil, nil, false
	}
	var req sendRequest
	if !decodeRequest(w, r, &req) {
		return nil, nil, nil, false
	}
	sendReq, raw, err := s.buildSend(conn, req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, nil, nil, false
	}
	_, secrets, err := conn.params()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, nil, nil, false
	}
	if req.Options.NewContext {
		conn.mu.Lock()
		conn.contextID = ""
		conn.mu.Unlock()
	}
	return conn, sendReq, &traffic.Call{ConnectionID: conn.view.ID, Secrets: secrets, MessageOverride: raw}, true
}

func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	conn, req, tc, ok := s.prepareSend(w, r)
	if !ok {
		return
	}
	callCtx, stop := s.callContext(r)
	defer stop()
	ctx, cancel := context.WithTimeout(callCtx, sendTimeout)
	defer cancel()
	start := time.Now()
	decoded, err := conn.client.SendMessage(traffic.WithCall(ctx, tc), req)
	res := s.unaryResult(conn, tc, start, validate.SendMessageResponse, decoded, err)
	conn.setContextID(contextIDOf(res.Payload))
	res.ContextID = conn.currentContextID()
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	conn, req, tc, ok := s.prepareSend(w, r)
	if !ok {
		return
	}
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

	binding, version := conn.binding()
	var opFindings []validate.Finding
	if conn.cardDoc != nil {
		opFindings = validate.OperationFindings(conn.cardDoc, version, validate.SendStreamingMessage)
	}
	var mu sync.Mutex
	emitted, failed := 0, false
	emit := func(res agentResult) {
		mu.Lock()
		defer mu.Unlock()
		if emitted == 0 {
			res.Call.Findings = append(opFindings, res.Call.Findings...)
		}
		conn.setContextID(contextIDOf(res.Payload))
		res.ContextID = conn.currentContextID()
		emitted++
		failed = failed || res.Call.Error != nil
		data, _ := json.Marshal(res)
		fmt.Fprintf(w, "data: %s\n\n", data)
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

	ctx, stop := s.callContext(r)
	defer stop()
	var streamErr error
	for event, err := range conn.client.SendStreamingMessage(traffic.WithCall(ctx, tc), req) {
		if err != nil {
			streamErr = err
			break
		}
		if tc.LastEntryID() == "" {
			// A transport the inspector can't record, such as one an
			// internal build adds: show what a2a-go decoded.
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
		if ok && entry.Error != "" {
			res.Call.Error.Message = entry.Error + " (" + res.Call.Error.Message + ")"
		}
	default:
		res.Call.Error = &callError{Message: "The stream ended without any events."}
	}
	emit(res)
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
		res.Call.Error = errorFrom(err)
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
		if res.Payload != nil && kind == validate.StreamResponse {
			res.Payload.Validation = validate.Merge(res.Payload.Validation, validate.Finding{
				Severity: validate.SeverityError,
				Rule:     "content-type",
				Message:  "The agent answered a streaming request without text/event-stream.",
			})
		}
	}
	if res.Payload != nil && err != nil {
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
	return &agentPayload{
		ProtocolVersion: version,
		Raw:             json.RawMessage(raw),
		Validation:      validate.Payload(raw, validate.PayloadInput{ProtocolVersion: version, Binding: binding, Kind: kind}),
	}
}

func (s *Server) httpPayload(entry *traffic.Entry, version, binding string, kind validate.PayloadKind, err error) (*agentPayload, *callError) {
	h := entry.HTTP
	if h.Status == 0 {
		return nil, &callError{Message: cmp.Or(entry.Error, errMessage(err), "No response.")}
	}
	body := []byte(h.ResponseBody)
	if h.Truncated {
		return nil, &callError{Code: h.Status, Message: fmt.Sprintf("The response is larger than %d MiB, more than the inspector shows.", traffic.MaxBodySize>>20)}
	}
	if h.Status < 200 || h.Status > 299 {
		return nil, httpError(h.Status, body, err)
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
		ce := &callError{A2AError: a2aErrorName(err), Message: cmp.Or(g.StatusMessage, entry.Error, errMessage(err))}
		if c, ok := grpcCode(g.StatusCode); ok {
			ce.Code = int(c)
			ce.Raw = map[string]any{"code": g.StatusCode, "message": g.StatusMessage, "trailers": g.Trailers}
		}
		return nil, ce
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

// contextIDOf finds the contextId of a task, message or event in any of the
// payload forms: top level (v0.3 JSON-RPC) or one level down (ProtoJSON).
func contextIDOf(p *agentPayload) string {
	if p == nil {
		return ""
	}
	var obj map[string]any
	if json.Unmarshal(p.Raw, &obj) != nil {
		return ""
	}
	if id, ok := obj["contextId"].(string); ok {
		return id
	}
	for _, v := range obj {
		if inner, ok := v.(map[string]any); ok {
			if id, ok := inner["contextId"].(string); ok {
				return id
			}
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
