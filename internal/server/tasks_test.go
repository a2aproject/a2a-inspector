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
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// rpcRecorder is a JSON-RPC agent that records the requests it gets and
// answers each with an empty result.
type rpcRecorder struct {
	mu       sync.Mutex
	requests []rpcRequest
}

type rpcRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params map[string]any  `json:"params"`
}

func (a *rpcRecorder) last(t *testing.T) rpcRequest {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.requests) == 0 {
		t.Fatal("the agent got no request")
	}
	return a.requests[len(a.requests)-1]
}

func newRPCRecorder(t *testing.T) (*rpcRecorder, string) {
	a := &rpcRecorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req rpcRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		a.mu.Lock()
		a.requests = append(a.requests, req)
		a.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{}}`, req.ID)
	}))
	t.Cleanup(srv.Close)
	return a, srv.URL
}

func TestTaskRoutes(t *testing.T) {
	agent, agentURL := newRPCRecorder(t)
	s := newServer(t, Options{})
	conn := s.connect(t, `{"interface":{"url":"`+agentURL+`","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`)
	base := "/api/connections/" + conn.ID
	// The task ID "a:b/c" with ":" and "/", URL-encoded as the UI does.
	const task = "a%3Ab%2Fc"
	tests := []struct {
		method, target, body string
		wantMethod           string
		wantParams           map[string]any
	}{
		{http.MethodGet, base + "/tasks/" + task + "?historyLength=2", "", "GetTask", map[string]any{"id": "a:b/c", "historyLength": 2.0}},
		{http.MethodGet, base + "/tasks/a:b%2Fc:subscribe", "", "SubscribeToTask", map[string]any{"id": "a:b/c"}},
		{http.MethodPost, base + "/tasks/" + task + ":cancel", "", "CancelTask", map[string]any{"id": "a:b/c"}},
		{http.MethodGet, base + "/tasks?contextId=c-1&status=input-required&pageSize=5&pageToken=p&historyLength=0", "", "ListTasks",
			map[string]any{"contextId": "c-1", "status": "TASK_STATE_INPUT_REQUIRED", "pageSize": 5.0, "pageToken": "p", "historyLength": 0.0}},
		{http.MethodGet, base + "/tasks?status=TASK_STATE_COMPLETED", "", "ListTasks", map[string]any{"status": "TASK_STATE_COMPLETED"}},
		{http.MethodPost, base + "/tasks/" + task + "/pushNotificationConfigs", `{"id":"cfg","external":{"url":"https://hooks.example.com/x","token":"tok","authScheme":"Bearer","authCredentials":"cred"}}`,
			"CreateTaskPushNotificationConfig", map[string]any{"taskId": "a:b/c", "id": "cfg", "url": "https://hooks.example.com/x", "token": "tok",
				"authentication": map[string]any{"scheme": "Bearer", "credentials": "cred"}}},
		{http.MethodGet, base + "/tasks/" + task + "/pushNotificationConfigs", "", "ListTaskPushNotificationConfigs", map[string]any{"taskId": "a:b/c"}},
		{http.MethodGet, base + "/tasks/" + task + "/pushNotificationConfigs/cfg%2F1", "", "GetTaskPushNotificationConfig", map[string]any{"taskId": "a:b/c", "id": "cfg/1"}},
		{http.MethodDelete, base + "/tasks/" + task + "/pushNotificationConfigs/cfg", "", "DeleteTaskPushNotificationConfig", map[string]any{"taskId": "a:b/c", "id": "cfg"}},
		{http.MethodGet, base + "/extendedAgentCard", "", "GetExtendedAgentCard", map[string]any{}},
	}
	for _, tc := range tests {
		t.Run(tc.method+" "+tc.target, func(t *testing.T) {
			w := s.do(request{method: tc.method, target: tc.target, body: tc.body, cookie: true})
			if w.Code != http.StatusOK {
				t.Fatalf("got %d %s", w.Code, w.Body)
			}
			got := agent.last(t)
			if got.Method != tc.wantMethod {
				t.Errorf("method = %q, want %q", got.Method, tc.wantMethod)
			}
			for k, want := range tc.wantParams {
				if g := fmt.Sprint(got.Params[k]); g != fmt.Sprint(want) {
					t.Errorf("params[%s] = %s, want %v", k, g, want)
				}
			}
		})
	}

	t.Run("inspector webhook", func(t *testing.T) {
		res := s.call(t, http.MethodPost, base+"/tasks/"+task+"/pushNotificationConfigs", `{"inspectorWebhook":true}`)
		params := agent.last(t).Params
		if res.Webhook == nil || params["url"] != res.Webhook.URL || !strings.HasPrefix(res.Webhook.URL, "http://127.0.0.1:8080/hooks/wh-") {
			t.Fatalf("webhook = %+v, agent got %v", res.Webhook, params)
		}
		wh, ok := s.hooks.webhook(res.Webhook.ID)
		if !ok || params["token"] != wh.token || wh.taskID != "a:b/c" || wh.connectionID != conn.ID {
			t.Errorf("webhook = %+v, agent got %v", wh, params)
		}
	})
	t.Run("delete has no payload", func(t *testing.T) {
		res := s.call(t, http.MethodDelete, base+"/tasks/"+task+"/pushNotificationConfigs/cfg", "")
		if res.Payload != nil || res.Call.Error != nil {
			t.Errorf("delete = %+v", res)
		}
	})

	for _, tc := range []struct {
		method, target, body string
		want                 int
	}{
		{http.MethodPost, base + "/tasks/" + task, "", http.StatusNotFound},
		{http.MethodPost, base + "/tasks/" + task + ":subscribe", "", http.StatusNotFound},
		{http.MethodGet, base + "/tasks/" + task + "?historyLength=x", "", http.StatusBadRequest},
		{http.MethodGet, base + "/tasks?pageSize=-1", "", http.StatusBadRequest},
		{http.MethodGet, base + "/tasks?status=sleeping", "", http.StatusBadRequest},
		{http.MethodPost, base + "/tasks/" + task + "/pushNotificationConfigs", `{}`, http.StatusBadRequest},
		{http.MethodPost, base + "/tasks/" + task + "/pushNotificationConfigs", `{"inspectorWebhook":true,"external":{"url":"https://x"}}`, http.StatusBadRequest},
		{http.MethodPost, base + "/tasks/" + task + "/pushNotificationConfigs", `{"external":{"url":" "}}`, http.StatusBadRequest},
		{http.MethodGet, "/api/connections/conn-unknown/tasks/" + task, "", http.StatusNotFound},
	} {
		if w := s.do(request{method: tc.method, target: tc.target, body: tc.body, cookie: true}); w.Code != tc.want {
			t.Errorf("%s %s = %d, want %d: %s", tc.method, tc.target, w.Code, tc.want, w.Body)
		}
	}
}

func TestTaskOperationFindings(t *testing.T) {
	_, agentURL := newRPCRecorder(t)
	s := newServer(t, Options{})
	// The card declares neither push notifications nor an extended card.
	conn := s.connect(t, `{"card":{"name":"x","capabilities":{},"supportedInterfaces":[{"url":"`+agentURL+`","protocolBinding":"JSONRPC","protocolVersion":"1.0"}]}}`)
	base := "/api/connections/" + conn.ID
	for target, want := range map[string]string{
		base + "/tasks/t/pushNotificationConfigs": "capabilities.pushNotifications",
		base + "/extendedAgentCard":               "capabilities.extendedAgentCard",
	} {
		res := s.call(t, http.MethodGet, target, "")
		if f := res.Call.Findings; len(f) != 1 || f[0].Path != want {
			t.Errorf("%s: findings = %+v, want %s", target, f, want)
		}
	}
	// Without a card, only the protocol version counts.
	bare := s.connect(t, `{"interface":{"url":"`+agentURL+`","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`)
	if res := s.call(t, http.MethodGet, "/api/connections/"+bare.ID+"/tasks/t/pushNotificationConfigs", ""); len(res.Call.Findings) != 0 {
		t.Errorf("findings without a card = %+v", res.Call.Findings)
	}
}

func TestDeleteEnvelopeFindings(t *testing.T) {
	agent := jsonrpcAgent(t, "application/json", `{"jsonrpc":"2.0","id":"someone-else","result":{}}`)
	s := newServer(t, Options{})
	conn := s.connect(t, `{"interface":{"url":"`+agent.URL+`","protocolBinding":"JSONRPC","protocolVersion":"1.0"}}`)
	res := s.call(t, http.MethodDelete, "/api/connections/"+conn.ID+"/tasks/t/pushNotificationConfigs/c", "")
	// A delete has no payload, so the envelope's problems are the call's.
	if res.Payload != nil || res.Call.Error != nil || len(res.Call.Findings) != 1 || res.Call.Findings[0].Rule != "jsonrpc-id" {
		t.Errorf("result = %+v", res)
	}
}

func TestPatchConfig(t *testing.T) {
	s := newServer(t, Options{})
	patch := func(body string) *httptest.ResponseRecorder {
		return s.do(request{method: http.MethodPatch, target: "/api/config", body: body, cookie: true})
	}
	w := patch(`{"webhookBaseUrl":"https://tunnel.example.com/inspector/"}`)
	if cfg := decodeBody[configResponse](t, w); w.Code != http.StatusOK || cfg.WebhookBaseURL != "https://tunnel.example.com/inspector" || cfg.DefaultWebhookBaseURL != "http://127.0.0.1:8080" || cfg.Mode != "local" {
		t.Fatalf("PATCH = %d %+v", w.Code, cfg)
	}
	if _, view := s.hooks.create(&connection{}, "", s.webhookBaseURL()); !strings.HasPrefix(view.URL, "https://tunnel.example.com/inspector/hooks/wh-") {
		t.Errorf("webhook URL = %q", view.URL)
	}
	for _, body := range []string{
		`{"webhookBaseUrl":"tunnel.example.com"}`,
		`{"webhookBaseUrl":"ftp://tunnel.example.com"}`,
		`{"webhookBaseUrl":"https://tunnel.example.com/?a=b"}`,
		`{"webhookBaseUrl":"https://tunnel.example.com/#x"}`,
		`{"webhookBaseUrl":"http://"}`,
		`{}`,
	} {
		if w := patch(body); w.Code != http.StatusBadRequest {
			t.Errorf("PATCH %s = %d, want 400", body, w.Code)
		}
	}
	if got := s.webhookBaseURL(); got != "https://tunnel.example.com/inspector" {
		t.Errorf("after invalid patches: %q", got)
	}
	if cfg := decodeBody[configResponse](t, patch(`{"webhookBaseUrl":""}`)); cfg.WebhookBaseURL != "http://127.0.0.1:8080" {
		t.Errorf("after reset: %q", cfg.WebhookBaseURL)
	}

	wildcard := newServer(t, Options{Host: "0.0.0.0", Port: 9000, WebhookBaseURL: "https://tunnel.example.com/"})
	if got := wildcard.webhookBaseURL(); got != "https://tunnel.example.com" || wildcard.defaultWebhookURL != "http://127.0.0.1:9000" {
		t.Errorf("webhook base URL = %q, default %q", got, wildcard.defaultWebhookURL)
	}
	if _, err := New(Options{Token: testToken, UI: testUI, WebhookBaseURL: "nope"}); err == nil {
		t.Error("New() with an invalid webhook base URL succeeded")
	}
}
