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
	"bytes"
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"maps"
	"net/http"
	"net/textproto"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2aclient"
	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
	"github.com/a2aproject/a2a-inspector/internal/v03spec"
	"github.com/a2aproject/a2a-inspector/internal/validate"
	"golang.org/x/net/http/httpguts"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
)

// resendRequest is an edited copy of a traffic entry's request.
type resendRequest struct {
	// ConnectionID is the connection to send it on; by default the entry's.
	ConnectionID string `json:"connectionId,omitempty"`
	HTTP         *struct {
		Method  string           `json:"method"`
		URL     string           `json:"url"`
		Headers []traffic.Header `json:"headers"`
		Body    string           `json:"body"`
	} `json:"http,omitempty"`
	// GRPC goes to the entry's method on the connection's target.
	GRPC *struct {
		Metadata []traffic.Header `json:"metadata"`
		// Message is the request as proto JSON, with the v0.3
		// specification's field names for v0.3.
		Message json.RawMessage `json:"message"`
	} `json:"grpc,omitempty"`
}

// operation is how the inspector reads an answer.
type operation struct {
	// kind is empty for an operation the inspector doesn't know.
	kind validate.PayloadKind
	// op is checked against the card's capabilities.
	op     validate.Operation
	stream bool
}

var (
	sendStreaming = operation{kind: validate.StreamResponse, op: validate.SendStreamingMessage, stream: true}
	subscribe     = operation{kind: validate.StreamResponse, op: validate.SubscribeToTask, stream: true}
	createConfig  = operation{kind: validate.TaskPushNotificationConfig, op: validate.CreateTaskPushNotificationConfig}
	getConfig     = operation{kind: validate.TaskPushNotificationConfig, op: validate.GetTaskPushNotificationConfig}
	listConfigs   = operation{kind: validate.ListTaskPushNotificationConfigsResponse, op: validate.ListTaskPushNotificationConfigs}
	deleteConfig  = operation{kind: empty, op: validate.DeleteTaskPushNotificationConfig}
	getExtended   = operation{kind: extendedCard, op: validate.GetExtendedAgentCard}
)

// operations maps JSON-RPC methods, in v1.0 and v0.3 names, and gRPC
// methods to operations.
var operations = map[string]operation{
	"SendMessage":                         {kind: validate.SendMessageResponse},
	"message/send":                        {kind: validate.SendMessageResponse},
	"SendStreamingMessage":                sendStreaming,
	"message/stream":                      sendStreaming,
	"GetTask":                             {kind: validate.Task},
	"tasks/get":                           {kind: validate.Task},
	"CancelTask":                          {kind: validate.Task},
	"tasks/cancel":                        {kind: validate.Task},
	"ListTasks":                           {kind: validate.ListTasksResponse, op: validate.ListTasks},
	"SubscribeToTask":                     subscribe,
	"tasks/resubscribe":                   subscribe,
	"TaskSubscription":                    subscribe,
	"CreateTaskPushNotificationConfig":    createConfig,
	"tasks/pushNotificationConfig/set":    createConfig,
	"GetTaskPushNotificationConfig":       getConfig,
	"tasks/pushNotificationConfig/get":    getConfig,
	"ListTaskPushNotificationConfigs":     listConfigs,
	"ListTaskPushNotificationConfig":      listConfigs,
	"tasks/pushNotificationConfig/list":   listConfigs,
	"DeleteTaskPushNotificationConfig":    deleteConfig,
	"tasks/pushNotificationConfig/delete": deleteConfig,
	"GetExtendedAgentCard":                getExtended,
	"agent/getAuthenticatedExtendedCard":  getExtended,
	"GetAgentCard":                        getExtended,
}

// restOperation names the operation of an HTTP+JSON request after its
// method and the end of its path, in v1.0 or v0.3 form.
func restOperation(method, path string) string {
	switch {
	case strings.HasSuffix(path, "/message:send"):
		return "SendMessage"
	case strings.HasSuffix(path, "/message:stream"):
		return "SendStreamingMessage"
	case strings.HasSuffix(path, ":cancel"):
		return "CancelTask"
	case strings.HasSuffix(path, ":subscribe"):
		return "SubscribeToTask"
	case strings.HasSuffix(path, "/extendedAgentCard"), strings.HasSuffix(path, "/v1/card"):
		return "GetExtendedAgentCard"
	}
	segs := strings.Split(strings.Trim(path, "/"), "/")
	n := len(segs)
	switch {
	case n >= 4 && segs[n-4] == "tasks" && segs[n-2] == "pushNotificationConfigs":
		if method == http.MethodDelete {
			return "DeleteTaskPushNotificationConfig"
		}
		return "GetTaskPushNotificationConfig"
	case n >= 3 && segs[n-3] == "tasks" && segs[n-1] == "pushNotificationConfigs":
		if method == http.MethodPost {
			return "CreateTaskPushNotificationConfig"
		}
		return "ListTaskPushNotificationConfigs"
	case n >= 2 && segs[n-2] == "tasks":
		return "GetTask"
	case segs[n-1] == "tasks":
		return "ListTasks"
	}
	return ""
}

// managedHeaders are set by the inspector from the request itself.
var managedHeaders = map[string]bool{"host": true, "content-length": true, "transfer-encoding": true, "connection": true}

// reservedMetadata are set by gRPC.
var reservedMetadata = map[string]bool{"content-type": true, "te": true, "user-agent": true}

// resend is an edited request ready to go to the agent.
type resend struct {
	tc   *traffic.Call
	op   operation
	send func(ctx context.Context) error
}

// credentials fills in masked header values with the connection's own.
type credentials struct {
	params a2aclient.ServiceParams
	// origin is set when the request goes to the connection's origin, the
	// only one its credentials go to.
	origin bool
	filled map[string]bool
}

// values returns what to send for an edited header: the value as given, or
// the connection's values for one that still has the mask, once per name.
func (c *credentials) values(name, value string) ([]string, error) {
	if !strings.Contains(value, traffic.Masked) {
		return []string{value}, nil
	}
	if !c.origin {
		return nil, fmt.Errorf("the value of %s is masked, and the inspector fills in the connection's credentials only for requests to the agent's own origin; type the value or remove the header", name)
	}
	vals := c.params.Get(name)
	if len(vals) == 0 {
		return nil, fmt.Errorf("the value of %s is masked, and the connection has no %s to fill in; type the value or remove the header", name, name)
	}
	key := strings.ToLower(name)
	if c.filled[key] {
		return nil, nil
	}
	c.filled[key] = true
	return vals, nil
}

// handleTrafficAction serves POST /api/traffic/{id}:resend.
func (s *Server) handleTrafficAction(w http.ResponseWriter, r *http.Request) {
	id, ok := strings.CutSuffix(r.PathValue("id"), ":resend")
	if !ok {
		writeError(w, http.StatusNotFound, "Unknown traffic operation; use :resend.")
		return
	}
	sess := sessionOf(r)
	var req resendRequest
	if !decodeRequest(w, r, &req) {
		return
	}
	entry, ok := sess.traffic.Get(id)
	if !ok {
		writeErrorCode(w, http.StatusNotFound, "unknownEntry", "The exchange is no longer in the traffic log.")
		return
	}
	connID := cmp.Or(req.ConnectionID, entry.ConnectionID)
	if connID == "" {
		writeError(w, http.StatusBadRequest, "Only exchanges with an agent can be resent, not card requests.")
		return
	}
	conn, release, ok := sess.conns.acquire(connID)
	if !ok {
		writeErrorCode(w, http.StatusNotFound, "unknownConnection", "Unknown connection. Connect to the agent again.")
		return
	}
	defer release()
	rs, err := s.prepareResend(sess, conn, entry, req)
	if err != nil {
		writeError(w, http.StatusBadRequest, capitalize(err.Error())+".")
		return
	}
	s.runResend(w, r, sess, conn, rs)
}

func (s *Server) prepareResend(sess *session, conn *connection, entry *traffic.Entry, req resendRequest) (*resend, error) {
	binding, _ := conn.binding()
	params, secrets, err := conn.params()
	if err != nil {
		return nil, err
	}
	tc := &traffic.Call{ConnectionID: conn.view.ID, Secrets: secrets, ResentFrom: entry.ID}
	creds := &credentials{params: params, filled: map[string]bool{}}
	switch {
	case entry.HTTP != nil:
		if binding != agents.BindingJSONRPC && binding != agents.BindingHTTPJSON {
			return nil, fmt.Errorf("the connection uses %s, and this exchange was over HTTP", binding)
		}
		if req.HTTP == nil {
			return nil, errors.New(`"http" is required to resend this exchange`)
		}
		return s.prepareHTTP(sess, conn, tc, creds, req.HTTP.Method, req.HTTP.URL, req.HTTP.Headers, req.HTTP.Body)
	case entry.GRPC != nil:
		if binding != agents.BindingGRPC {
			return nil, fmt.Errorf("the connection uses %s, and this exchange was over gRPC", binding)
		}
		if req.GRPC == nil {
			return nil, errors.New(`"grpc" is required to resend this exchange`)
		}
		return s.prepareGRPC(sess, conn, tc, creds, entry.GRPC.FullMethod, req.GRPC.Metadata, req.GRPC.Message)
	}
	return nil, errors.New("this exchange can't be resent")
}

func (s *Server) prepareHTTP(sess *session, conn *connection, tc *traffic.Call, creds *credentials, method, rawURL string, headers []traffic.Header, body string) (*resend, error) {
	method = strings.ToUpper(strings.TrimSpace(method))
	if !httpguts.ValidHeaderFieldName(method) {
		return nil, fmt.Errorf("%q isn't an HTTP method", method)
	}
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("%q isn't an http or https URL", rawURL)
	}
	if base, err := url.Parse(conn.view.Interface.URL); err == nil {
		creds.origin = agents.SameOrigin(u, base)
	}
	header := http.Header{}
	for _, h := range headers {
		name := strings.TrimSpace(h.Name)
		if !httpguts.ValidHeaderFieldName(name) {
			return nil, fmt.Errorf("%q isn't a valid header name", h.Name)
		}
		if managedHeaders[strings.ToLower(name)] {
			return nil, fmt.Errorf("the inspector sets %s itself", name)
		}
		vals, err := creds.values(name, h.Value)
		if err != nil {
			return nil, err
		}
		for _, v := range vals {
			if !httpguts.ValidHeaderFieldValue(v) {
				return nil, fmt.Errorf("the value of %s has characters a header can't have", name)
			}
			header.Add(textproto.CanonicalMIMEHeaderKey(name), v)
		}
	}
	// Like the connection's own headers, secrets don't follow a redirect to
	// another origin.
	tc.Headers = slices.Collect(maps.Keys(creds.params))
	for name := range header {
		if traffic.IsSecretHeader(name) {
			tc.Headers = append(tc.Headers, name)
		}
	}

	binding, _ := conn.binding()
	name := restOperation(method, u.Path)
	if binding == agents.BindingJSONRPC {
		var rpc struct {
			Method string `json:"method"`
		}
		_ = json.Unmarshal([]byte(body), &rpc)
		name = rpc.Method
	}
	op, known := operations[name]
	if !known {
		op.stream = strings.Contains(header.Get("Accept"), "text/event-stream")
	}
	return &resend{tc: tc, op: op, send: func(ctx context.Context) error {
		var reqBody io.Reader = http.NoBody
		if body != "" {
			reqBody = bytes.NewReader([]byte(body))
		}
		req, err := http.NewRequestWithContext(ctx, method, u.String(), reqBody)
		if err != nil {
			return err
		}
		req.Header = header.Clone()
		resp, err := sess.client.Do(req)
		if err != nil {
			return err
		}
		defer func() { _ = resp.Body.Close() }()
		// Reading the body records an event stream as it arrives.
		_, err = io.Copy(io.Discard, resp.Body)
		return err
	}}, nil
}

func (s *Server) prepareGRPC(sess *session, conn *connection, tc *traffic.Call, creds *credentials, fullMethod string, headers []traffic.Header, message json.RawMessage) (*resend, error) {
	method, err := grpcMethod(fullMethod)
	if err != nil {
		return nil, err
	}
	in, err := protoregistry.GlobalTypes.FindMessageByName(method.Input().FullName())
	if err != nil {
		return nil, fmt.Errorf("the inspector doesn't know %s", method.Input().FullName())
	}
	out, err := protoregistry.GlobalTypes.FindMessageByName(method.Output().FullName())
	if err != nil {
		return nil, fmt.Errorf("the inspector doesn't know %s", method.Output().FullName())
	}
	if len(message) == 0 || string(message) == "null" {
		return nil, errors.New(`"grpc.message" is required`)
	}
	msg := in.New().Interface()
	if err := protojson.Unmarshal(v03spec.ToStub(method.Input(), message), msg); err != nil {
		return nil, fmt.Errorf("the message doesn't parse as %s: %v", method.Input().FullName(), err)
	}
	// The target is the connection's own, so its credentials can go there.
	creds.origin = true
	md := metadata.MD{}
	for _, h := range headers {
		name := strings.ToLower(strings.TrimSpace(h.Name))
		if !validHeaderName(name) {
			return nil, fmt.Errorf("%q isn't a valid metadata key", h.Name)
		}
		if strings.HasPrefix(name, "grpc-") || reservedMetadata[name] {
			return nil, fmt.Errorf("gRPC sets %s itself", name)
		}
		filled := strings.Contains(h.Value, traffic.Masked)
		vals, err := creds.values(name, h.Value)
		if err != nil {
			return nil, err
		}
		for _, v := range vals {
			if strings.HasSuffix(name, "-bin") && !filled {
				b, err := base64.StdEncoding.DecodeString(v)
				if err != nil {
					return nil, fmt.Errorf("%s is binary metadata; give its value in base64", name)
				}
				v = string(b)
			}
			md.Append(name, v)
		}
	}
	return &resend{tc: tc, op: operations[string(method.Name())], send: func(ctx context.Context) error {
		cc, err := sess.dialer.GRPCConn(conn.view.Interface.URL)
		if err != nil {
			return err
		}
		defer func() { _ = cc.Close() }()
		ctx = metadata.NewOutgoingContext(ctx, md)
		if !method.IsStreamingServer() {
			return cc.Invoke(ctx, fullMethod, msg, out.New().Interface())
		}
		return recvAll(ctx, cc, fullMethod, msg, out)
	}}, nil
}

// grpcMethod looks up a method by its full name, "/package.Service/Method".
func grpcMethod(fullMethod string) (protoreflect.MethodDescriptor, error) {
	service, name, _ := strings.Cut(strings.TrimPrefix(fullMethod, "/"), "/")
	d, err := protoregistry.GlobalFiles.FindDescriptorByName(protoreflect.FullName(service))
	sd, ok := d.(protoreflect.ServiceDescriptor)
	if err != nil || !ok || sd.Methods().ByName(protoreflect.Name(name)) == nil {
		return nil, fmt.Errorf("the inspector doesn't know the gRPC method %s", fullMethod)
	}
	md := sd.Methods().ByName(protoreflect.Name(name))
	if md.IsStreamingClient() {
		return nil, fmt.Errorf("the inspector can't resend %s, which streams from the client", fullMethod)
	}
	return md, nil
}

// recvAll makes a server-streaming call and reads every message.
func recvAll(ctx context.Context, cc *grpc.ClientConn, fullMethod string, msg proto.Message, out protoreflect.MessageType) error {
	cs, err := cc.NewStream(ctx, &grpc.StreamDesc{ServerStreams: true}, fullMethod)
	if err != nil {
		return err
	}
	// After io.EOF from SendMsg, RecvMsg reports why the stream ended.
	if err := cs.SendMsg(msg); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if err := cs.CloseSend(); err != nil {
		return err
	}
	for {
		if err := cs.RecvMsg(out.New().Interface()); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

// runResend sends an edited request and answers with a result for every
// event of the answer, or for the whole answer, as server-sent events.
func (s *Server) runResend(w http.ResponseWriter, r *http.Request, sess *session, conn *connection, rs *resend) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming isn't supported by this server.")
		return
	}
	if rs.op.stream {
		if !s.openStream(w, sess) {
			return
		}
		defer sess.closeStream()
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx, stop := s.callContext(r, conn)
	defer stop()
	var cancel context.CancelFunc
	switch d := s.opts.Limits.StreamDuration; {
	case !rs.op.stream:
		ctx, cancel = context.WithTimeout(ctx, sendTimeout)
	case d > 0:
		ctx, cancel = context.WithTimeoutCause(ctx, d, errStreamLimit)
	default:
		ctx, cancel = context.WithCancel(ctx)
	}
	defer cancel()

	first := s.operationFindings(conn, rs.op.op)
	if rs.op.kind == "" {
		first = append(first, validate.Finding{
			Severity: validate.SeverityInfo,
			Rule:     "operation",
			Message:  "The inspector doesn't know this operation, so it doesn't check the answer.",
		})
	}
	var mu sync.Mutex
	emit := func(res agentResult) {
		mu.Lock()
		defer mu.Unlock()
		res.Call.Findings, first = append(first, res.Call.Findings...), nil
		data, _ := json.Marshal(res)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}

	if rs.op.stream && rs.op.kind != "" {
		run := func(ctx context.Context) iter.Seq2[a2a.Event, error] {
			return func(yield func(a2a.Event, error) bool) {
				if err := rs.send(ctx); err != nil {
					yield(nil, err)
				}
			}
		}
		s.runStream(ctx, sess, conn, rs.tc, run, emit, nil)
		return
	}
	start := time.Now()
	err := rs.send(traffic.WithCall(ctx, rs.tc))
	if rs.op.kind == "" {
		// An unknown operation's answer is read only for an error, which
		// an event stream isn't.
		if e, ok := sess.traffic.Get(rs.tc.LastEntryID()); ok && e.HTTP != nil && traffic.IsEventStream(headerValue(e.HTTP.ResponseHeaders, "Content-Type")) {
			emit(agentResult{Call: call{TrafficEntryID: e.ID, LatencyMs: time.Since(start).Milliseconds()}})
			return
		}
	}
	emit(s.unaryResult(sess, conn, rs.tc, start, cmp.Or(rs.op.kind, empty), nil, err))
}
