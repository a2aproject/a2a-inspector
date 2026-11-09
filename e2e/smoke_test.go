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

//go:build e2e

package e2e

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"iter"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2asrv"
)

// echo answers every message with a task that echoes its text in an artifact.
func echo() a2asrv.AgentExecutor {
	return a2asrv.AgentExecutorFunc(func(_ context.Context, ec *a2asrv.ExecutorContext) iter.Seq2[a2a.Event, error] {
		return func(yield func(a2a.Event, error) bool) {
			var text strings.Builder
			for _, p := range ec.Message.Parts {
				if t, ok := p.Content.(a2a.Text); ok {
					text.WriteString(string(t))
				}
			}
			if !yield(a2a.NewSubmittedTask(ec, ec.Message), nil) {
				return
			}
			if !yield(a2a.NewArtifactEvent(ec, a2a.NewTextPart("echo: "+text.String())), nil) {
				return
			}
			yield(a2a.NewStatusUpdateEvent(ec, a2a.TaskStateCompleted, nil), nil)
		}
	})
}

// startAgent serves the echo agent over JSON-RPC, with its card at the
// well-known path, and returns its base URL.
func startAgent(t *testing.T) string {
	t.Helper()
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	card := &a2a.AgentCard{
		Name:                "Echo",
		Description:         "Echoes every message",
		Version:             "1.0.0",
		SupportedInterfaces: []*a2a.AgentInterface{a2a.NewAgentInterface(srv.URL+"/a2a", a2a.TransportProtocolJSONRPC)},
		Capabilities:        a2a.AgentCapabilities{Streaming: true},
		DefaultInputModes:   []string{"text/plain"},
		DefaultOutputModes:  []string{"text/plain"},
		Skills:              []a2a.AgentSkill{{ID: "echo", Name: "Echo", Description: "Echoes the text", Tags: []string{"echo"}}},
	}
	mux.Handle("/.well-known/agent-card.json", a2asrv.NewStaticAgentCardHandler(card))
	mux.Handle("/a2a", a2asrv.NewJSONRPCHandler(a2asrv.NewHandler(echo())))
	return srv.URL
}

// build builds the a2a-inspector binary.
func build(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "a2a-inspector")
	if out, err := exec.Command("go", "build", "-o", bin, "github.com/a2aproject/a2a-inspector").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

var urlRE = regexp.MustCompile(`running at (\S+)`)

// inspector is a running a2a-inspector with a client that holds its session cookie.
type inspector struct {
	base   string
	client *http.Client
}

// start runs the binary on a free port and opens a session with the URL it prints.
func start(t *testing.T, bin string) *inspector {
	t.Helper()
	cmd := exec.Command(bin, "--port", "0", "--no-open")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Signal(os.Interrupt)
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = cmd.Process.Kill()
			t.Errorf("the inspector didn't stop on an interrupt; stderr:\n%s", stderr.String())
		}
	})

	found := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if m := urlRE.FindStringSubmatch(scanner.Text()); m != nil {
				found <- m[1]
				break
			}
		}
		_, _ = io.Copy(io.Discard, stdout)
	}()
	var startURL string
	select {
	case startURL = <-found:
	case <-time.After(30 * time.Second):
		t.Fatalf("the inspector printed no URL; stderr:\n%s", stderr.String())
	}

	u, err := url.Parse(startURL)
	if err != nil {
		t.Fatal(err)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	in := &inspector{base: u.Scheme + "://" + u.Host, client: &http.Client{Jar: jar, Timeout: 30 * time.Second}}
	// The token in the URL turns into a session cookie, and the UI loads.
	resp, err := in.client.Get(startURL)
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(page), "<title>A2A Inspector</title>") {
		t.Fatalf("GET %s = %d %.200s", startURL, resp.StatusCode, page)
	}
	return in
}

// post sends a JSON request to the API and checks the status.
func (in *inspector) post(t *testing.T, path string, body any, want int) *http.Response {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := in.client.Post(in.base+path, "application/json", bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != want {
		msg, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		t.Fatalf("POST %s = %d %s, want %d", path, resp.StatusCode, msg, want)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func (in *inspector) call(t *testing.T, path string, body, out any, want int) {
	t.Helper()
	if err := json.NewDecoder(in.post(t, path, body, want).Body).Decode(out); err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
}

type finding struct {
	Severity string `json:"severity"`
	Rule     string `json:"rule"`
	Message  string `json:"message"`
}

type payload struct {
	Raw        json.RawMessage `json:"raw"`
	Validation struct {
		Findings []finding `json:"findings"`
	} `json:"validation"`
}

type result struct {
	Payload *payload `json:"payload"`
	Call    struct {
		TrafficEntryID string          `json:"trafficEntryId"`
		Error          json.RawMessage `json:"error"`
		Findings       []finding       `json:"findings"`
	} `json:"call"`
}

// check fails unless the result is a payload without findings, recorded in
// the traffic log. The echo agent's answers are valid, so a finding is a bug.
func check(t *testing.T, res result) {
	t.Helper()
	switch {
	case string(res.Call.Error) != "null" && len(res.Call.Error) > 0:
		t.Fatalf("call error: %s", res.Call.Error)
	case res.Payload == nil:
		t.Fatal("no payload")
	case len(res.Payload.Validation.Findings) > 0 || len(res.Call.Findings) > 0:
		t.Errorf("findings for %s: %+v %+v", res.Payload.Raw, res.Payload.Validation.Findings, res.Call.Findings)
	case res.Call.TrafficEntryID == "":
		t.Error("no traffic entry")
	}
}

func TestSmoke(t *testing.T) {
	bin := build(t)
	for _, args := range [][]string{{"--version"}, {"info"}} {
		out, err := exec.Command(bin, args...).Output()
		if err != nil || len(out) == 0 {
			t.Fatalf("a2a-inspector %s = %q, %v", args[0], out, err)
		}
	}
	agent := startAgent(t)
	in := start(t, bin)

	var resolved struct {
		Payload    *payload `json:"payload"`
		Interfaces []struct {
			ProtocolBinding string `json:"protocolBinding"`
		} `json:"interfaces"`
		Call struct {
			Error json.RawMessage `json:"error"`
		} `json:"call"`
	}
	in.call(t, "/api/card:resolve", map[string]string{"url": agent}, &resolved, http.StatusOK)
	if resolved.Payload == nil || len(resolved.Interfaces) != 1 || resolved.Interfaces[0].ProtocolBinding != "JSONRPC" {
		t.Fatalf("card:resolve = %+v, error %s", resolved, resolved.Call.Error)
	}
	for _, f := range resolved.Payload.Validation.Findings {
		if f.Severity == "ERROR" {
			t.Errorf("card finding: %+v", f)
		}
	}

	var conn struct {
		ID string `json:"id"`
	}
	in.call(t, "/api/connections", map[string]string{"cardUrl": agent + "/.well-known/agent-card.json"}, &conn, http.StatusCreated)

	var sent result
	in.call(t, "/api/connections/"+conn.ID+"/messages:send", map[string]any{"compose": map[string]string{"text": "hello"}}, &sent, http.StatusOK)
	check(t, sent)
	if !strings.Contains(string(sent.Payload.Raw), "echo: hello") {
		t.Errorf("send = %s, want the echo", sent.Payload.Raw)
	}

	resp := in.post(t, "/api/connections/"+conn.ID+"/messages:stream", map[string]any{"compose": map[string]string{"text": "streamed"}}, http.StatusOK)
	var events []result
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(nil, 1<<20)
	for scanner.Scan() {
		data, ok := strings.CutPrefix(scanner.Text(), "data: ")
		if !ok {
			continue
		}
		var res result
		if err := json.Unmarshal([]byte(data), &res); err != nil {
			t.Fatalf("event %q: %v", data, err)
		}
		check(t, res)
		events = append(events, res)
	}
	if len(events) != 3 {
		t.Fatalf("got %d events, want the task, the artifact and the completed status", len(events))
	}
	if !strings.Contains(string(events[1].Payload.Raw), "echo: streamed") || !strings.Contains(string(events[2].Payload.Raw), "COMPLETED") {
		t.Errorf("events = %s, %s", events[1].Payload.Raw, events[2].Payload.Raw)
	}
}
