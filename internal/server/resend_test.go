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
	"testing"

	"github.com/a2aproject/a2a-inspector/internal/traffic"
)

// resendBody is a resend request for an entry, with edit applied to its
// request body or message.
func resendBody(t *testing.T, e *traffic.Entry, edit func(string) string) string {
	t.Helper()
	var body any
	switch {
	case e.HTTP != nil:
		body = map[string]any{"http": map[string]any{"method": e.HTTP.Method, "url": e.HTTP.URL, "headers": e.HTTP.RequestHeaders, "body": edit(e.HTTP.RequestBody)}}
	case e.GRPC != nil:
		body = map[string]any{"grpc": map[string]any{"metadata": e.GRPC.Metadata, "message": json.RawMessage(edit(string(e.GRPC.Messages[0].JSON)))}}
	default:
		t.Fatalf("entry %s has no exchange", e.ID)
	}
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func (s *Server) entry(t *testing.T, id string) *traffic.Entry {
	t.Helper()
	e, ok := s.local.traffic.Get(id)
	if !ok {
		t.Fatalf("traffic entry %q is gone", id)
	}
	return e
}

func (s *Server) resend(t *testing.T, id, body string) []agentResult {
	t.Helper()
	return s.events(t, request{method: http.MethodPost, target: "/api/traffic/" + id + ":resend", body: body, cookie: true})
}

func replace(old, new string) func(string) string {
	return func(s string) string { return strings.ReplaceAll(s, old, new) }
}

func TestResendMatrix(t *testing.T) {
	seen := &seen{}
	s := newServer(t, Options{})
	t.Cleanup(s.Close)
	for _, c := range startAgents(t, seen) {
		t.Run(c.String(), func(t *testing.T) {
			const token = "s3cret-token-0123456789"
			conn := s.connect(t, fmt.Sprintf(`{"card":{"name":"Echo","capabilities":{"streaming":true}},"interface":{"url":%q,"protocolBinding":%q,"protocolVersion":%q},
				"auth":{"bearer":{"value":%q}},"headers":[{"name":"X-Trace","value":"t-1"}]}`, c.url, c.binding, c.version, token))
			sent := s.send(t, conn.ID, `{"compose":{"text":"hello"}}`)
			original := s.entry(t, sent.Call.TrafficEntryID)

			results := s.resend(t, original.ID, resendBody(t, original, replace("hello", "resent")))
			if len(results) != 1 {
				t.Fatalf("got %d results, want 1: %+v", len(results), results)
			}
			res := results[0]
			checkPayload(t, res, c.version)
			if !strings.Contains(string(res.Payload.Raw), "echo: resent") {
				t.Errorf("payload = %s, want the echo of the edited message", res.Payload.Raw)
			}
			if res.Call.TrafficEntryID == original.ID {
				t.Error("the result names the original entry")
			}
			if e := s.entry(t, res.Call.TrafficEntryID); e.ResentFrom != original.ID || e.ConnectionID != conn.ID {
				t.Errorf("new entry resentFrom = %q, connectionId = %q", e.ResentFrom, e.ConnectionID)
			}
			// The masked Authorization went out with the connection's token.
			if got := seen.all(); got[len(got)-1] != "Bearer "+token {
				t.Errorf("the agent got Authorization %q", got[len(got)-1])
			}
			// A resend doesn't continue the chat's conversation.
			if ctx, _ := s.connContext(t, conn.ID); ctx != sent.ContextID {
				t.Errorf("context after the resend = %q, want %q", ctx, sent.ContextID)
			}

			streamed := s.stream(t, conn.ID, `{"compose":{"text":"streamed"}}`)
			streamEntry := s.entry(t, streamed[0].Call.TrafficEntryID)
			events := s.resend(t, streamEntry.ID, resendBody(t, streamEntry, replace("streamed", "again")))
			if len(events) < 3 {
				t.Fatalf("got %d events, want at least 3: %+v", len(events), events)
			}
			for _, e := range events {
				checkPayload(t, e, c.version)
			}
			if last := string(events[len(events)-1].Payload.Raw); !strings.Contains(strings.ToLower(last), "completed") {
				t.Errorf("last event = %s, want the completed status", last)
			}

			failed := s.resend(t, original.ID, resendBody(t, original, replace("hello", "fail")))
			if len(failed) != 1 || failed[0].Call.Error == nil || failed[0].Call.Error.A2AError != "UnsupportedOperationError" {
				t.Errorf("results = %+v, want UnsupportedOperationError", failed)
			}

			// A masked value the connection doesn't have isn't sent.
			unknown := resendBody(t, original, replace("hello", "x"))
			unknown = strings.Replace(unknown, `"name":"X-Trace"`, `"name":"X-Other","value":"••••"},{"name":"X-Trace"`, 1)
			unknown = strings.Replace(unknown, `"name":"x-trace"`, `"name":"x-other","value":"••••"},{"name":"x-trace"`, 1)
			w := s.do(request{method: http.MethodPost, target: "/api/traffic/" + original.ID + ":resend", body: unknown, cookie: true})
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "has no") {
				t.Errorf("resend with an unknown masked header = %d %s", w.Code, w.Body)
			}

			if original.HTTP != nil {
				// Malformed JSON reaches the agent, and its answer is the result.
				bad := s.resend(t, original.ID, resendBody(t, original, func(string) string { return "{" }))
				if len(bad) != 1 || bad[0].Call.Error == nil {
					t.Errorf("results for a malformed body = %+v, want the agent's error", bad)
				}
			} else {
				w := s.do(request{method: http.MethodPost, target: "/api/traffic/" + original.ID + ":resend", body: `{"grpc":{"metadata":[],"message":{"nope":1}}}`, cookie: true})
				if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "doesn't parse") {
					t.Errorf("resend with a bad message = %d %s", w.Code, w.Body)
				}
			}
		})
	}
}

// connContext returns the context and open task the connection's next message continues.
func (s *Server) connContext(t *testing.T, id string) (string, *taskState) {
	t.Helper()
	w := s.do(request{target: "/api/connections/" + id, cookie: true})
	conn := decodeBody[connectionResponse](t, w)
	return conn.ContextID, conn.OpenTask
}

func TestResendRules(t *testing.T) {
	agents := startAgents(t, &seen{})
	jsonrpc, grpcAgent := agents[0], agents[2]
	s := newServer(t, Options{Limits: Limits{Streams: 1}})
	t.Cleanup(s.Close)
	conn := s.connect(t, fmt.Sprintf(`{"interface":{"url":%q,"protocolBinding":"JSONRPC","protocolVersion":"1.0"},"auth":{"bearer":{"value":"s3cret-token"}}}`, jsonrpc.url))
	sent := s.send(t, conn.ID, `{"compose":{"text":"hello"}}`)
	original := s.entry(t, sent.Call.TrafficEntryID)
	post := func(id, body string) *httptest.ResponseRecorder {
		return s.do(request{method: http.MethodPost, target: "/api/traffic/" + id + ":resend", body: body, cookie: true})
	}
	httpBody := func(url string, headers []traffic.Header) string {
		b, _ := json.Marshal(map[string]any{"http": map[string]any{"method": "POST", "url": url, "headers": headers, "body": original.HTTP.RequestBody}})
		return string(b)
	}

	t.Run("credentials stay with the agent's origin", func(t *testing.T) {
		other := strings.Replace(original.HTTP.URL, "127.0.0.1", "localhost", 1)
		w := post(original.ID, httpBody(other, original.HTTP.RequestHeaders))
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "own origin") {
			t.Errorf("masked Authorization to another origin = %d %s", w.Code, w.Body)
		}
		// A typed value goes anywhere.
		var typed []traffic.Header
		for _, h := range original.HTTP.RequestHeaders {
			if h.Name == "Authorization" {
				h.Value = "Bearer typed"
			}
			typed = append(typed, h)
		}
		if res := s.resend(t, original.ID, httpBody(other, typed)); len(res) != 1 || res[0].Call.Error != nil {
			t.Errorf("results = %+v", res)
		}
	})

	t.Run("refused edits", func(t *testing.T) {
		for name, body := range map[string]string{
			"managed header": httpBody(original.HTTP.URL, []traffic.Header{{Name: "Host", Value: "example.com"}}),
			"bad header":     httpBody(original.HTTP.URL, []traffic.Header{{Name: "X-Bad", Value: "a\nb"}}),
			"bad URL":        httpBody("ftp://example.com", nil),
			"no http":        `{"grpc":{"metadata":[],"message":{}}}`,
		} {
			if w := post(original.ID, body); w.Code != http.StatusBadRequest {
				t.Errorf("%s: %d %s, want 400", name, w.Code, w.Body)
			}
		}
		if w := post("tr-999", httpBody(original.HTTP.URL, nil)); w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "unknownEntry") {
			t.Errorf("unknown entry = %d %s", w.Code, w.Body)
		}
		if w := s.do(request{method: http.MethodPost, target: "/api/traffic/" + original.ID + ":replay", body: "{}", cookie: true}); w.Code != http.StatusNotFound {
			t.Errorf(":replay = %d, want 404", w.Code)
		}
	})

	t.Run("card requests can't be resent", func(t *testing.T) {
		res := decodeBody[cardResolveResponse](t, s.do(request{method: http.MethodPost, target: "/api/card:resolve", body: `{"url":"` + jsonrpc.url + `"}`, cookie: true}))
		if w := post(res.Call.TrafficEntryID, httpBody(jsonrpc.url, nil)); w.Code != http.StatusBadRequest {
			t.Errorf("card request = %d %s, want 400", w.Code, w.Body)
		}
	})

	t.Run("another connection", func(t *testing.T) {
		const token = "n3w-token"
		next := s.connect(t, fmt.Sprintf(`{"interface":{"url":%q,"protocolBinding":"JSONRPC","protocolVersion":"1.0"},"auth":{"bearer":{"value":%q}}}`, jsonrpc.url, token))
		body := strings.Replace(resendBody(t, original, replace("hello", "again")), "{", `{"connectionId":"`+next.ID+`",`, 1)
		res := s.resend(t, original.ID, body)
		if len(res) != 1 || s.entry(t, res[0].Call.TrafficEntryID).ConnectionID != next.ID {
			t.Errorf("results = %+v, want them on %s", res, next.ID)
		}
		g := s.connect(t, fmt.Sprintf(`{"interface":{"url":%q,"protocolBinding":"GRPC","protocolVersion":"1.0"}}`, grpcAgent.url))
		body = strings.Replace(resendBody(t, original, replace("hello", "again")), "{", `{"connectionId":"`+g.ID+`",`, 1)
		if w := post(original.ID, body); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "GRPC") {
			t.Errorf("HTTP exchange on a gRPC connection = %d %s", w.Code, w.Body)
		}
		gsent := s.send(t, g.ID, `{"compose":{"text":"hello"}}`)
		for name, metadata := range map[string]string{"reserved": `[{"name":"grpc-timeout","value":"1S"}]`, "binary": `[{"name":"x-data-bin","value":"%%"}]`} {
			if w := post(gsent.Call.TrafficEntryID, `{"grpc":{"metadata":`+metadata+`,"message":{}}}`); w.Code != http.StatusBadRequest {
				t.Errorf("%s metadata = %d %s, want 400", name, w.Code, w.Body)
			}
		}
	})

	t.Run("streams count against the session", func(t *testing.T) {
		streamed := s.stream(t, conn.ID, `{"compose":{"text":"streamed"}}`)
		entry := s.entry(t, streamed[0].Call.TrafficEntryID)
		if !s.local.openStream(1) {
			t.Fatal("couldn't take the session's only stream")
		}
		defer s.local.closeStream()
		if w := post(entry.ID, resendBody(t, entry, replace("streamed", "again"))); w.Code != http.StatusTooManyRequests {
			t.Errorf("stream resend at the limit = %d %s, want 429", w.Code, w.Body)
		}
		// A unary call isn't a stream.
		if res := s.resend(t, original.ID, resendBody(t, original, replace("hello", "unary"))); len(res) != 1 || res[0].Call.Error != nil {
			t.Errorf("unary resend at the stream limit = %+v", res)
		}
	})

	t.Run("unknown operations", func(t *testing.T) {
		body := resendBody(t, original, func(b string) string { return strings.Replace(b, `"SendMessage"`, `"DoSomething"`, 1) })
		res := s.resend(t, original.ID, body)
		if len(res) != 1 || res[0].Payload != nil || len(res[0].Call.Findings) != 1 || res[0].Call.Findings[0].Rule != "operation" {
			t.Errorf("results = %+v, want the entry with an info finding", res)
		}
	})
}

func TestRestOperation(t *testing.T) {
	for _, tt := range []struct{ method, path, want string }{
		{"POST", "/message:send", "SendMessage"},
		{"POST", "/tenant/message:stream", "SendStreamingMessage"},
		{"POST", "/v1/tasks/t-1:cancel", "CancelTask"},
		{"GET", "/tasks/t-1:subscribe", "SubscribeToTask"},
		{"GET", "/tasks/t-1", "GetTask"},
		{"GET", "/v1/tasks/t-1", "GetTask"},
		{"GET", "/tasks", "ListTasks"},
		{"POST", "/tasks/t-1/pushNotificationConfigs", "CreateTaskPushNotificationConfig"},
		{"GET", "/tasks/t-1/pushNotificationConfigs", "ListTaskPushNotificationConfigs"},
		{"GET", "/tasks/t-1/pushNotificationConfigs/c-1", "GetTaskPushNotificationConfig"},
		{"DELETE", "/tasks/t-1/pushNotificationConfigs/c-1", "DeleteTaskPushNotificationConfig"},
		{"GET", "/extendedAgentCard", "GetExtendedAgentCard"},
		{"GET", "/v1/card", "GetExtendedAgentCard"},
		{"GET", "/", ""},
	} {
		if got := restOperation(tt.method, tt.path); got != tt.want {
			t.Errorf("restOperation(%s, %s) = %q, want %q", tt.method, tt.path, got, tt.want)
		}
	}
}
