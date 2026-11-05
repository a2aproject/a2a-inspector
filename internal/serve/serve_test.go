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

package serve

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/serve/servetest"
)

func TestMain(m *testing.M) {
	servetest.RunIfFake()
	os.Exit(m.Run())
}

const v10Card = `{
  "name": "Weather",
  "description": "Forecasts",
  "version": "1.0.0",
  "supportedInterfaces": [{"url": "https://weather.example.com/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}],
  "capabilities": {"streaming": true},
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [{"id": "forecast", "name": "Forecast", "description": "Tells the weather", "tags": ["weather"]}]
}`

const v03Card = `{
  "name": "Weather 0.3",
  "description": "Forecasts",
  "version": "1.0.0",
  "protocolVersion": "0.3.0",
  "url": "https://weather.example.com/a2a",
  "preferredTransport": "JSONRPC",
  "capabilities": {"streaming": true},
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [{"id": "forecast", "name": "Forecast", "description": "Tells the weather", "tags": ["weather"]}]
}`

func newRunner(t *testing.T, mode string) *Runner {
	t.Helper()
	t.Setenv(servetest.Env, mode)
	r := &Runner{LookPath: servetest.LookPath}
	t.Cleanup(r.Close)
	return r
}

func fetchCard(t *testing.T, cardURL string) (map[string]any, error) {
	t.Helper()
	resp, err := http.Get(cardURL)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var card map[string]any
	if err := json.Unmarshal(body, &card); err != nil {
		return nil, err
	}
	return card, nil
}

func TestStart(t *testing.T) {
	r := newRunner(t, servetest.Serve)
	for _, tc := range []struct {
		card, binding, version, url, transport string
	}{
		{v10Card, agents.BindingJSONRPC, agents.Version10, "http://127.0.0.1:", "jsonrpc"},
		{v10Card, agents.BindingHTTPJSON, agents.Version10, "http://127.0.0.1:", "rest"},
		{v10Card, agents.BindingGRPC, agents.Version10, "127.0.0.1:", "grpc"},
		{v03Card, agents.BindingJSONRPC, agents.Version03, "http://127.0.0.1:", "jsonrpc"},
		{v03Card, agents.BindingHTTPJSON, agents.Version03, "http://127.0.0.1:", "rest"},
		{v03Card, agents.BindingGRPC, agents.Version03, "127.0.0.1:", "grpc"},
	} {
		t.Run(tc.binding+" "+tc.version, func(t *testing.T) {
			a, err := r.Start(context.Background(), []byte(tc.card), tc.binding, tc.version, "urn:uuid:1")
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(a.Interface.URL, tc.url) || a.Interface.ProtocolBinding != tc.binding || a.Interface.ProtocolVersion != tc.version {
				t.Errorf("interface = %+v, want %s... %s %s", a.Interface, tc.url, tc.binding, tc.version)
			}
			if a.Source != "urn:uuid:1" || !strings.HasPrefix(a.Name, "Weather") {
				t.Errorf("source, name = %q, %q", a.Source, a.Name)
			}
			if !strings.Contains(a.Command, "--echo") || !strings.Contains(a.Command, "--serve-transport "+tc.transport) {
				t.Errorf("command = %q", a.Command)
			}
			if !strings.HasPrefix(a.CardURL, "http://127.0.0.1:") {
				t.Errorf("card URL = %q, want one on 127.0.0.1", a.CardURL)
			}
			card, err := fetchCard(t, a.CardURL)
			if err != nil {
				t.Fatal(err)
			}
			want := []any{map[string]any{"url": a.Interface.URL, "protocolBinding": tc.binding, "protocolVersion": tc.version}}
			if got, _ := json.Marshal(card["supportedInterfaces"]); string(got) != mustJSON(t, want) {
				t.Errorf("supportedInterfaces = %s, want %s", got, mustJSON(t, want))
			}
			if tc.version == agents.Version03 && card["url"] != a.Interface.URL {
				t.Errorf("v0.3 url = %v, want %s", card["url"], a.Interface.URL)
			}
			if a.Exited() != "" {
				t.Errorf("Exited() = %q while running", a.Exited())
			}

			if !r.Stop(a.ID) {
				t.Fatal("Stop() = false")
			}
			if _, err := fetchCard(t, a.CardURL); err == nil {
				t.Error("the card is still served after Stop")
			}
			if _, err := os.Stat(a.file); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("card file after Stop: %v", err)
			}
			if r.Stop(a.ID) {
				t.Error("second Stop() = true")
			}
		})
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestStartErrors(t *testing.T) {
	t.Run("not installed", func(t *testing.T) {
		r := &Runner{LookPath: func(string) (string, error) { return "", errors.New("not found") }}
		if _, err := r.Start(context.Background(), []byte(v10Card), agents.BindingJSONRPC, agents.Version10, ""); !errors.Is(err, ErrNotInstalled) {
			t.Errorf("Start() error = %v, want ErrNotInstalled", err)
		}
	})
	t.Run("a2a-cli named a2a-cli", func(t *testing.T) {
		r := &Runner{LookPath: func(name string) (string, error) {
			if name == "a2a-cli" {
				return "/go/bin/a2a-cli", nil
			}
			return "", errors.New("not found")
		}}
		if bin, err := r.Binary(); err != nil || bin != "/go/bin/a2a-cli" {
			t.Errorf("Binary() = %q, %v", bin, err)
		}
	})
	t.Run("unsupported interface", func(t *testing.T) {
		r := newRunner(t, servetest.Serve)
		for _, iface := range [][2]string{{"WEBSOCKET", agents.Version10}, {agents.BindingJSONRPC, "2.0"}} {
			if _, err := r.Start(context.Background(), []byte(v10Card), iface[0], iface[1], ""); err == nil {
				t.Errorf("Start(%v) succeeded", iface)
			}
		}
	})
	t.Run("unreadable card", func(t *testing.T) {
		r := newRunner(t, servetest.Serve)
		_, err := r.Start(context.Background(), []byte(`{"skills": "none"}`), agents.BindingJSONRPC, agents.Version10, "")
		if err == nil || !strings.Contains(err.Error(), "can't be served") {
			t.Errorf("Start() error = %v", err)
		}
	})
	t.Run("exits", func(t *testing.T) {
		r := newRunner(t, servetest.Fail)
		_, err := r.Start(context.Background(), []byte(v10Card), agents.BindingJSONRPC, agents.Version10, "")
		if err == nil || !strings.Contains(err.Error(), "exited") || !strings.Contains(err.Error(), "boom") {
			t.Errorf("Start() error = %v, want the exit with its output", err)
		}
		if len(r.List()) != 0 {
			t.Errorf("List() = %v after a failed start", r.List())
		}
	})
	t.Run("never serves the card", func(t *testing.T) {
		defer func(d time.Duration) { startTimeout = d }(startTimeout)
		startTimeout = 300 * time.Millisecond
		r := newRunner(t, servetest.Silent)
		_, err := r.Start(context.Background(), []byte(v10Card), agents.BindingHTTPJSON, agents.Version10, "")
		if err == nil || !strings.Contains(err.Error(), "didn't serve its card") {
			t.Errorf("Start() error = %v", err)
		}
	})
	t.Run("too many", func(t *testing.T) {
		defer func(n int) { maxAgents = n }(maxAgents)
		maxAgents = 1
		r := newRunner(t, servetest.Serve)
		a, err := r.Start(context.Background(), []byte(v10Card), agents.BindingJSONRPC, agents.Version10, "")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := r.Start(context.Background(), []byte(v10Card), agents.BindingJSONRPC, agents.Version10, ""); !errors.Is(err, ErrTooMany) {
			t.Errorf("second Start() error = %v, want ErrTooMany", err)
		}
		r.Stop(a.ID)
		if _, err := r.Start(context.Background(), []byte(v10Card), agents.BindingJSONRPC, agents.Version10, ""); err != nil {
			t.Errorf("Start() after Stop: %v", err)
		}
	})
}

func TestExited(t *testing.T) {
	r := newRunner(t, servetest.Serve)
	a, err := r.Start(context.Background(), []byte(v10Card), agents.BindingJSONRPC, agents.Version10, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-a.done
	list := r.List()
	if len(list) != 1 || !strings.Contains(list[0].Exited(), "exited") {
		t.Fatalf("List() after the process died = %v", list)
	}
	if !r.Stop(a.ID) || len(r.List()) != 0 {
		t.Error("Stop() didn't forget the agent that exited")
	}
}

func TestStartAfterDirectoryRemoved(t *testing.T) {
	r := newRunner(t, servetest.Serve)
	a, err := r.Start(context.Background(), []byte(v10Card), agents.BindingHTTPJSON, agents.Version10, "")
	if err != nil {
		t.Fatal(err)
	}
	r.Stop(a.ID)
	if err := os.RemoveAll(filepath.Dir(a.file)); err != nil {
		t.Fatal(err)
	}
	b, err := r.Start(context.Background(), []byte(v10Card), agents.BindingHTTPJSON, agents.Version10, "")
	if err != nil {
		t.Fatalf("Start() after the card directory was removed: %v", err)
	}
	if filepath.Dir(b.file) == filepath.Dir(a.file) {
		t.Errorf("Start() used the removed directory's name %s again", filepath.Dir(a.file))
	}
}

func TestClose(t *testing.T) {
	r := newRunner(t, servetest.Serve)
	var started []*Agent
	for range 2 {
		a, err := r.Start(context.Background(), []byte(v10Card), agents.BindingHTTPJSON, agents.Version10, "")
		if err != nil {
			t.Fatal(err)
		}
		started = append(started, a)
	}
	dir := filepath.Dir(started[0].file)
	r.Close()
	for _, a := range started {
		if _, err := fetchCard(t, a.CardURL); err == nil {
			t.Errorf("%s still serves its card after Close", a.ID)
		}
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("card directory after Close: %v", err)
	}
	if _, err := r.Start(context.Background(), []byte(v10Card), agents.BindingHTTPJSON, agents.Version10, ""); !errors.Is(err, ErrClosed) {
		t.Errorf("Start() after Close: %v, want ErrClosed", err)
	}
}

func TestCommand(t *testing.T) {
	got := command("a2a", []string{"server", "--card", "/tmp/my cards/it's.json", "--port", "8080"})
	want := `a2a server --card '/tmp/my cards/it'\''s.json' --port 8080`
	if got != want {
		t.Errorf("command() = %s, want %s", got, want)
	}
	if got := Preview(agents.BindingGRPC, agents.Version03); got != "a2a server --card '<card file>' --echo --host 127.0.0.1 --port '<free port>' --serve-transport grpc --protocol 0.3 --card-compat" {
		t.Errorf("Preview() = %s", got)
	}
}

func TestGRPCCardURL(t *testing.T) {
	for out, want := range map[string]string{
		"gRPC listening on 127.0.0.1:5000\nAgent card at http://[::]:41234/.well-known/agent-card.json\n": "http://127.0.0.1:41234/.well-known/agent-card.json",
		"Agent card at http://0.0.0.0:41234/.well-known/agent-card.json":                                  "http://127.0.0.1:41234/.well-known/agent-card.json",
		"Agent card at http://127.0.0.1:41234/.well-known/agent-card.json":                                "http://127.0.0.1:41234/.well-known/agent-card.json",
		"gRPC listening on 127.0.0.1:5000\n":                                                              "",
	} {
		if got := grpcCardURL(out); got != want {
			t.Errorf("grpcCardURL(%q) = %q, want %q", out, got, want)
		}
	}
}

func TestTail(t *testing.T) {
	tl := &tail{limit: 4}
	_, _ = tl.Write([]byte("abc"))
	_, _ = tl.Write([]byte("def"))
	if got := tl.String(); got != "cdef" {
		t.Errorf("tail = %q, want cdef", got)
	}
}
