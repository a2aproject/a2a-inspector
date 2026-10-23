package validate

import (
	"encoding/json"
	"slices"
	"testing"
)

func rules(r Report) []string {
	var out []string
	for _, f := range r.Findings {
		out = append(out, string(f.Severity)+" "+f.Path+" "+f.Rule)
	}
	return out
}

func TestPayload(t *testing.T) {
	t.Parallel()
	const (
		v10Task = `{"id":"t","contextId":"c","status":{"state":"TASK_STATE_WORKING"}}`
		v10Msg  = `{"messageId":"m","role":"ROLE_AGENT","parts":[{"text":"hi"}]}`
	)
	tests := []struct {
		name string
		raw  string
		in   PayloadInput
		want []string
	}{
		{"v1.0 task", `{"task":` + v10Task + `}`, PayloadInput{"1.0", "JSONRPC", SendMessageResponse}, nil},
		{"v1.0 empty response", `{}`, PayloadInput{"1.0", "GRPC", SendMessageResponse}, []string{"ERROR  oneof"}},
		{"v1.0 both members", `{"task":` + v10Task + `,"message":` + v10Msg + `}`, PayloadInput{"1.0", "HTTP+JSON", SendMessageResponse}, []string{"ERROR  proto"}},
		{"v1.0 stream event with an unknown field", `{"statusUpdate":{"taskId":"t","contextId":"c","status":{"state":"TASK_STATE_COMPLETED"}},"final":true}`, PayloadInput{"1.0", "JSONRPC", StreamResponse}, []string{"WARNING final unknown-field"}},
		{"v1.0 part without content", `{"message":{"messageId":"m","role":"ROLE_AGENT","parts":[{"mediaType":"text/plain"}]}}`, PayloadInput{"1.0", "JSONRPC", SendMessageResponse}, []string{"ERROR message.parts[0] oneof"}},
		{"v0.3 JSON-RPC message", `{"kind":"message","messageId":"m","role":"agent","parts":[{"kind":"text","text":"hi"}]}`, PayloadInput{"0.3", "JSONRPC", SendMessageResponse}, nil},
		{"v0.3 JSON-RPC wrong kind", `{"kind":"status-update","taskId":"t"}`, PayloadInput{"0.3", "JSONRPC", SendMessageResponse}, []string{"ERROR kind kind"}},
		{"v0.3 JSON-RPC task missing fields", `{"kind":"task","id":"t"}`, PayloadInput{"0.3", "JSONRPC", StreamResponse}, []string{"ERROR contextId required", "ERROR status required"}},
		{"v0.3 proto message with spec names", `{"message":{"messageId":"m","role":"ROLE_AGENT","content":[{"text":"hi"}]}}`, PayloadInput{"0.3", "HTTP+JSON", SendMessageResponse}, nil},
		{"v0.3 proto message with the stub's names", `{"message":{"messageId":"m","role":"ROLE_AGENT","parts":[{"text":"hi"}]}}`, PayloadInput{"0.3", "GRPC", SendMessageResponse}, []string{"WARNING message.parts unknown-field"}},
		{"v0.3 proto bad enum", `{"task":{"id":"t","contextId":"c","status":{"state":"WORKING"}}}`, PayloadInput{"0.3", "HTTP+JSON", StreamResponse}, []string{"ERROR  proto"}},
		{"v1.0 task", v10Task, PayloadInput{"1.0", "GRPC", Task}, nil},
		{"v1.0 task list", `{"tasks":[` + v10Task + `],"nextPageToken":"","pageSize":50,"totalSize":1}`, PayloadInput{"1.0", "HTTP+JSON", ListTasksResponse}, nil},
		{"v1.0 empty task list", `{}`, PayloadInput{"1.0", "GRPC", ListTasksResponse}, nil},
		{"v1.0 push config", `{"id":"p","taskId":"t","url":"https://example.com/hook","token":"x"}`, PayloadInput{"1.0", "JSONRPC", TaskPushNotificationConfig}, nil},
		{"v1.0 push config list", `{"configs":[{"id":"p","taskId":"t","url":"https://example.com/hook"}]}`, PayloadInput{"1.0", "JSONRPC", ListTaskPushNotificationConfigsResponse}, nil},
		{"v0.3 JSON-RPC task", `{"kind":"task","id":"t","contextId":"c","status":{"state":"working"}}`, PayloadInput{"0.3", "JSONRPC", Task}, nil},
		{"v0.3 JSON-RPC message where a task belongs", `{"kind":"message","messageId":"m","role":"agent","parts":[]}`, PayloadInput{"0.3", "JSONRPC", Task}, []string{"ERROR kind kind"}},
		{"v0.3 JSON-RPC push config", `{"taskId":"t","pushNotificationConfig":{"url":"https://example.com/hook"}}`, PayloadInput{"0.3", "JSONRPC", TaskPushNotificationConfig}, nil},
		{"v0.3 JSON-RPC push config list", `[{"taskId":"t","pushNotificationConfig":{"url":"https://example.com/hook"}},{"taskId":"t"}]`, PayloadInput{"0.3", "JSONRPC", ListTaskPushNotificationConfigsResponse}, []string{"ERROR [1].pushNotificationConfig required"}},
		{"v0.3 JSON-RPC task list", `{"tasks":[]}`, PayloadInput{"0.3", "JSONRPC", ListTasksResponse}, []string{"INFO  operation-version"}},
		{"v0.3 proto push config list", `{"configs":[{"name":"tasks/t/pushNotificationConfigs/p","pushNotificationConfig":{"url":"https://example.com/hook"}}]}`, PayloadInput{"0.3", "HTTP+JSON", ListTaskPushNotificationConfigsResponse}, nil},
		{"not an object", `[]`, PayloadInput{"1.0", "JSONRPC", SendMessageResponse}, []string{"ERROR  object"}},
		{"v1.0 push config list as an array", `[]`, PayloadInput{"1.0", "JSONRPC", ListTaskPushNotificationConfigsResponse}, []string{"ERROR  object"}},
		{"not JSON", `{`, PayloadInput{"0.3", "JSONRPC", SendMessageResponse}, []string{"ERROR  json"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := Payload([]byte(tt.raw), tt.in)
			if !slices.Equal(rules(got), tt.want) {
				t.Errorf("Payload() = %v, want %v\n%+v", rules(got), tt.want, got.Findings)
			}
		})
	}
}

func TestJSONRPCEnvelope(t *testing.T) {
	t.Parallel()
	id := json.RawMessage(`"req-1"`)
	tests := []struct {
		body string
		want int
	}{
		{`{"jsonrpc":"2.0","id":"req-1","result":{}}`, 0},
		{`{"jsonrpc":"2.0","id":"req-1","error":{"code":1,"message":"x"}}`, 0},
		{`{"jsonrpc":"1.0","id":"req-1","result":{}}`, 1},
		{`{"jsonrpc":"2.0","id":"req-2","result":{}}`, 1},
		{`{"jsonrpc":"2.0","result":{}}`, 1},
		{`{"jsonrpc":"2.0","id":"req-1"}`, 1},
	}
	for _, tt := range tests {
		if got := JSONRPCEnvelope([]byte(tt.body), id); len(got) != tt.want {
			t.Errorf("JSONRPCEnvelope(%s) = %+v, want %d findings", tt.body, got, tt.want)
		}
	}
}
