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
	"errors"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/a2aproject/a2a-inspector/internal/egress"
	"github.com/a2aproject/a2a-inspector/internal/serve/servetest"
)

func TestMain(m *testing.M) {
	servetest.RunIfFake()
	os.Exit(m.Run())
}

const (
	serveCardV10 = `{"name":"Weather","description":"Forecasts","version":"1.0.0",` +
		`"supportedInterfaces":[{"url":"https://weather.example.com/a2a","protocolBinding":"JSONRPC","protocolVersion":"1.0"}],` +
		`"capabilities":{"streaming":true},"defaultInputModes":["text/plain"],"defaultOutputModes":["text/plain"],` +
		`"skills":[{"id":"forecast","name":"Forecast","description":"Tells the weather","tags":["weather"]}]}`
	serveCardV03 = `{"name":"Weather","description":"Forecasts","version":"1.0.0","protocolVersion":"0.3.0",` +
		`"url":"https://weather.example.com/a2a","preferredTransport":"GRPC",` +
		`"capabilities":{"streaming":true},"defaultInputModes":["text/plain"],"defaultOutputModes":["text/plain"],` +
		`"skills":[{"id":"forecast","name":"Forecast","description":"Tells the weather","tags":["weather"]}]}`
)

// newServeServer returns a local inspector whose echo agents are the fake
// a2a-cli in mode.
func newServeServer(t *testing.T, mode string) *Server {
	t.Helper()
	t.Setenv(servetest.Env, mode)
	s := newServer(t, Options{})
	s.echo.LookPath = servetest.LookPath
	t.Cleanup(s.Close)
	return s
}

func startEcho(t *testing.T, s *Server, body string) echoAgentView {
	t.Helper()
	w := s.do(request{method: http.MethodPost, target: "/api/serve", body: body, cookie: true})
	if w.Code != http.StatusCreated {
		t.Fatalf("POST /api/serve = %d %s", w.Code, w.Body)
	}
	return decodeBody[echoAgentView](t, w)
}

// artifactTexts returns the text parts of the artifacts anywhere in v.
func artifactTexts(v any) []string {
	var out []string
	switch v := v.(type) {
	case map[string]any:
		for k, item := range v {
			if k == "artifacts" {
				for _, a := range item.([]any) {
					for _, p := range a.(map[string]any)["parts"].([]any) {
						if text, ok := p.(map[string]any)["text"].(string); ok {
							out = append(out, text)
						}
					}
				}
				continue
			}
			out = append(out, artifactTexts(item)...)
		}
	case []any:
		for _, item := range v {
			out = append(out, artifactTexts(item)...)
		}
	}
	return out
}

func TestServe(t *testing.T) {
	s := newServeServer(t, servetest.Serve)
	if cfg := decodeBody[configResponse](t, s.do(request{target: "/api/config", cookie: true})); !cfg.Features.Serve {
		t.Error("features.serve = false in a local inspector")
	}

	for _, tc := range []struct {
		name, body, binding, version string
	}{
		{"JSON-RPC from the request", `{"card":` + serveCardV10 + `,"interface":{"protocolBinding":"jsonrpc","protocolVersion":"1.0.0"},"source":"urn:uuid:1"}`, "JSONRPC", "1.0"},
		{"gRPC v0.3 from the card", `{"card":` + serveCardV03 + `,"source":"urn:uuid:1"}`, "GRPC", "0.3"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			echo := startEcho(t, s, tc.body)
			if echo.Interface.ProtocolBinding != tc.binding || echo.Interface.ProtocolVersion != tc.version || echo.Source != "urn:uuid:1" || echo.Name != "Weather" {
				t.Fatalf("echo agent = %+v", echo)
			}
			list := decodeBody[struct{ Agents []echoAgentView }](t, s.do(request{target: "/api/serve", cookie: true}))
			if !slices.ContainsFunc(list.Agents, func(a echoAgentView) bool { return a.ID == echo.ID && a.Command == echo.Command }) {
				t.Errorf("GET /api/serve = %+v, want %s", list.Agents, echo.ID)
			}

			// The inspector reaches it as any other agent, through its card.
			resolved := decodeBody[cardResolveResponse](t, s.do(request{method: http.MethodPost, target: "/api/card:resolve", body: `{"url":"` + echo.CardURL + `"}`, cookie: true}))
			if resolved.Call.Error != nil || len(resolved.Interfaces) != 1 || resolved.Interfaces[0].URL != echo.Interface.URL {
				t.Fatalf("card:resolve = %+v %+v, want the echo agent's interface", resolved.Call.Error, resolved.Interfaces)
			}
			w := s.do(request{method: http.MethodPost, target: "/api/connections", body: `{"cardUrl":"` + echo.CardURL + `"}`, cookie: true})
			if w.Code != http.StatusCreated {
				t.Fatalf("POST /api/connections = %d %s", w.Code, w.Body)
			}
			conn := decodeBody[connectionResponse](t, w)
			res := decodeBody[agentResult](t, s.do(request{method: http.MethodPost, target: "/api/connections/" + conn.ID + "/messages:send", body: `{"compose":{"text":"hello echo"}}`, cookie: true}))
			if res.Call.Error != nil || res.Payload == nil {
				t.Fatalf("send: %+v", res.Call.Error)
			}
			var raw any
			_ = json.Unmarshal(res.Payload.Raw, &raw)
			if texts := artifactTexts(raw); !slices.Equal(texts, []string{"hello echo"}) {
				t.Errorf("artifact texts = %q, want the message echoed", texts)
			}

			if w := s.do(request{method: http.MethodDelete, target: "/api/serve/" + echo.ID, cookie: true}); w.Code != http.StatusNoContent {
				t.Errorf("DELETE = %d %s", w.Code, w.Body)
			}
			if w := s.do(request{method: http.MethodDelete, target: "/api/serve/" + echo.ID, cookie: true}); w.Code != http.StatusNotFound {
				t.Errorf("second DELETE = %d, want 404", w.Code)
			}
		})
	}

	t.Run("HTTP+JSON for a card without interfaces", func(t *testing.T) {
		echo := startEcho(t, s, `{"card":{"name":"Bare"}}`)
		if echo.Interface.ProtocolBinding != "HTTP+JSON" || echo.Interface.ProtocolVersion != "1.0" {
			t.Errorf("interface = %+v, want HTTP+JSON 1.0", echo.Interface)
		}
	})
}

func TestServeErrors(t *testing.T) {
	s := newServeServer(t, servetest.Serve)
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"no card", `{}`, http.StatusBadRequest},
		{"unsupported binding", `{"card":` + serveCardV10 + `,"interface":{"protocolBinding":"WEBSOCKET","protocolVersion":"1.0"}}`, http.StatusBadRequest},
		{"unsupported version", `{"card":` + serveCardV10 + `,"interface":{"protocolBinding":"JSONRPC","protocolVersion":"2.0"}}`, http.StatusBadRequest},
		{"unreadable card", `{"card":{"skills":"none"}}`, http.StatusUnprocessableEntity},
		{"long source", `{"card":` + serveCardV10 + `,"source":"` + strings.Repeat("x", maxSourceLength+1) + `"}`, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if w := s.do(request{method: http.MethodPost, target: "/api/serve", body: tc.body, cookie: true}); w.Code != tc.status {
				t.Errorf("POST /api/serve = %d %s, want %d", w.Code, w.Body, tc.status)
			}
		})
	}

	t.Run("a2a-cli exits", func(t *testing.T) {
		s := newServeServer(t, servetest.Fail)
		w := s.do(request{method: http.MethodPost, target: "/api/serve", body: `{"card":` + serveCardV10 + `}`, cookie: true})
		if w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), "boom") {
			t.Errorf("POST /api/serve = %d %s, want 422 with a2a-cli's output", w.Code, w.Body)
		}
	})

	t.Run("not installed", func(t *testing.T) {
		s.echo.LookPath = func(string) (string, error) { return "", errors.New("not found") }
		w := s.do(request{method: http.MethodPost, target: "/api/serve", body: `{"card":` + serveCardV10 + `}`, cookie: true})
		resp := decodeBody[serveErrorResponse](t, w)
		if w.Code != http.StatusConflict || resp.Error.Code != "serveNotInstalled" || !strings.Contains(resp.Error.InstallHint, "go install") ||
			!strings.HasPrefix(resp.Error.Command, "a2a server --card") || !strings.Contains(resp.Error.Command, "--serve-transport jsonrpc") {
			t.Errorf("POST /api/serve = %d %+v", w.Code, resp.Error)
		}
	})
}

func TestServeWithEgressPolicy(t *testing.T) {
	for allow, want := range map[string]bool{"": false, "127.0.0.1": true, "127.0.0.0/8": true} {
		var list []string
		if allow != "" {
			list = []string{allow}
		}
		policy, err := egress.New(list)
		if err != nil {
			t.Fatal(err)
		}
		s := newServer(t, Options{Egress: policy})
		if cfg := decodeBody[configResponse](t, s.do(request{target: "/api/config", cookie: true})); cfg.Features.Serve != want {
			t.Errorf("allowing %q: features.serve = %v, want %v", allow, cfg.Features.Serve, want)
		}
		w := s.do(request{target: "/api/serve", cookie: true})
		if (w.Code == http.StatusOK) != want {
			t.Errorf("allowing %q: GET /api/serve = %d", allow, w.Code)
		}
		s.Close()
	}
}

func TestServeHosted(t *testing.T) {
	b := &browser{s: newHosted(t, Limits{})}
	if cfg := decodeBody[configResponse](t, b.do(request{target: "/api/config"})); cfg.Features.Serve {
		t.Error("features.serve = true in a hosted inspector")
	}
	if w := b.do(request{method: http.MethodPost, target: "/api/serve", body: `{"card":` + serveCardV10 + `}`}); w.Code != http.StatusNotFound {
		t.Errorf("POST /api/serve = %d, want 404 in a hosted inspector", w.Code)
	}
}

func TestCloseStopsEchoAgents(t *testing.T) {
	s := newServeServer(t, servetest.Serve)
	echo := startEcho(t, s, `{"card":`+serveCardV10+`}`)
	s.Close()
	if resp, err := http.Get(echo.CardURL); err == nil {
		_ = resp.Body.Close()
		t.Error("the echo agent still serves its card after Close")
	}
}
