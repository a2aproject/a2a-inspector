package validate

import (
	"bytes"
	"cmp"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

// PayloadKind is the protocol message an agent response is read as, named
// after the v1.0 proto message.
type PayloadKind string

const (
	// SendMessageResponse is the result of SendMessage: a Task or a Message.
	SendMessageResponse PayloadKind = "SendMessageResponse"
	// StreamResponse is one event of a stream: a Task, a Message, a status
	// update or an artifact update.
	StreamResponse PayloadKind = "StreamResponse"
	// Task is the result of GetTask and CancelTask.
	Task PayloadKind = "Task"
	// ListTasksResponse is the result of ListTasks, which v0.3 doesn't have.
	ListTasksResponse PayloadKind = "ListTasksResponse"
	// TaskPushNotificationConfig is the result of creating or getting a push
	// notification config.
	TaskPushNotificationConfig PayloadKind = "TaskPushNotificationConfig"
	// ListTaskPushNotificationConfigsResponse is the result of listing a
	// task's push notification configs.
	ListTaskPushNotificationConfigsResponse PayloadKind = "ListTaskPushNotificationConfigsResponse"
)

// PayloadInput tells Payload how to read an agent response.
type PayloadInput struct {
	ProtocolVersion string
	Binding         string
	Kind            PayloadKind
}

// v03Kinds maps the kind discriminator of v0.3 JSON-RPC results to their
// schema definitions, per payload kind.
var v03Kinds = map[PayloadKind][]string{
	Task:                {"task"},
	SendMessageResponse: {"task", "message"},
	StreamResponse:      {"task", "message", "status-update", "artifact-update"},
}

var v03Definitions = map[string]string{
	"task":            "Task",
	"message":         "Message",
	"status-update":   "TaskStatusUpdateEvent",
	"artifact-update": "TaskArtifactUpdateEvent",
}

// v03Untagged maps payload kinds without a kind discriminator to their v0.3
// schema definitions.
var v03Untagged = map[PayloadKind]string{
	TaskPushNotificationConfig: "TaskPushNotificationConfig",
	// v0.3 JSON-RPC returns the configs as a bare array.
	ListTaskPushNotificationConfigsResponse: "ListTaskPushNotificationConfigSuccessResponse/properties/result",
}

// v03ProtoNames maps payload kinds to v0.3 proto messages where the names differ.
var v03ProtoNames = map[PayloadKind]string{
	ListTaskPushNotificationConfigsResponse: "ListTaskPushNotificationConfigResponse",
}

// Payload validates an agent response as it arrived on the wire: the result
// of a JSON-RPC response, the body of an HTTP+JSON response, the data of a
// server-sent event, or a gRPC message as proto3 JSON.
//
// v1.0 payloads are ProtoJSON of the lf.a2a.v1 messages on every binding.
// v0.3 JSON-RPC results follow the v0.3 JSON Schema, and v0.3 HTTP+JSON and
// gRPC payloads are ProtoJSON of the v0.3 a2a.v1 messages.
func Payload(raw []byte, in PayloadInput) Report {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return newReport([]Finding{{Severity: SeverityError, Rule: "json", Message: "The payload isn't valid JSON: " + err.Error()}})
	}
	v03JSONRPC := in.ProtocolVersion != agents.Version10 && agents.CoreBinding(in.Binding) == agents.BindingJSONRPC
	if _, ok := doc.(map[string]any); !ok && !(v03JSONRPC && in.Kind == ListTaskPushNotificationConfigsResponse) {
		return newReport([]Finding{{Severity: SeverityError, Rule: "object", Message: "The payload must be a JSON object."}})
	}
	switch {
	case in.ProtocolVersion == agents.Version10:
		return newReport(checkV10(raw, doc, "lf.a2a.v1."+string(in.Kind), false))
	case v03JSONRPC:
		return newReport(checkV03Result(doc, in.Kind))
	default:
		return newReport(checkV03Proto(raw, doc, "a2a.v1."+cmp.Or(v03ProtoNames[in.Kind], string(in.Kind))))
	}
}

func checkV03Result(doc any, kind PayloadKind) []Finding {
	allowed, tagged := v03Kinds[kind]
	if !tagged {
		if def, ok := v03Untagged[kind]; ok {
			return schemaFindings(v03Schema(def), doc)
		}
		return []Finding{{Severity: SeverityInfo, Rule: "operation-version", Message: fmt.Sprintf("v0.3 JSON-RPC has no %s, so the response isn't checked.", kind)}}
	}
	obj := doc.(map[string]any)
	k, _ := obj["kind"].(string)
	if !slices.Contains(allowed, k) {
		msg := fmt.Sprintf("Expected \"kind\" to be %s.", quoteList(allowed))
		if _, ok := obj["kind"]; ok {
			msg = fmt.Sprintf("%s isn't a valid kind here; expected %s.", formatJSON(obj["kind"]), quoteList(allowed))
		}
		return []Finding{{Severity: SeverityError, Path: "kind", Rule: "kind", Message: msg}}
	}
	return schemaFindings(v03Schema(v03Definitions[k]), doc)
}

func formatJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

// JSONRPCEnvelope checks the envelope of a JSON-RPC response: its version,
// that it has exactly one of result and error, and that its id matches the
// request's.
func JSONRPCEnvelope(body []byte, requestID json.RawMessage) []Finding {
	var env map[string]json.RawMessage
	if err := json.Unmarshal(body, &env); err != nil {
		return []Finding{{Severity: SeverityError, Rule: "jsonrpc", Message: "The response isn't a JSON-RPC object: " + err.Error()}}
	}
	var out []Finding
	if v := env["jsonrpc"]; string(v) != `"2.0"` {
		out = append(out, Finding{Severity: SeverityError, Rule: "jsonrpc", Message: `The JSON-RPC response must have "jsonrpc": "2.0".`})
	}
	_, hasResult := env["result"]
	_, hasError := env["error"]
	if hasResult == hasError {
		out = append(out, Finding{Severity: SeverityError, Rule: "jsonrpc", Message: `The JSON-RPC response must have either "result" or "error".`})
	}
	if requestID != nil && !jsonEqual(env["id"], requestID) {
		got := string(env["id"])
		if got == "" {
			got = "no id"
		}
		out = append(out, Finding{Severity: SeverityError, Rule: "jsonrpc-id", Message: fmt.Sprintf("The response has %s; the request's id was %s.", got, requestID)})
	}
	return out
}

func jsonEqual(a, b json.RawMessage) bool {
	var va, vb any
	return json.Unmarshal(a, &va) == nil && json.Unmarshal(b, &vb) == nil && reflect.DeepEqual(va, vb)
}

// Merge adds findings to a report, keeping its order.
func Merge(r Report, findings ...Finding) Report {
	if len(findings) == 0 {
		return r
	}
	return newReport(append(slices.Clone(r.Findings), findings...))
}
