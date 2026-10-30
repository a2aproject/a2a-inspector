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

package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/go-cmp/cmp"
)

// serve answers each path with its document, and records the Authorization
// header of every request.
func serve(t *testing.T, docs map[string]string) (*httptest.Server, func() map[string]string) {
	t.Helper()
	var mu sync.Mutex
	auth := map[string]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		auth[r.URL.Path] = r.Header.Get("Authorization")
		mu.Unlock()
		doc, ok := docs[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/ai-catalog+json")
		_, _ = fmt.Fprint(w, strings.ReplaceAll(doc, "{{host}}", "http://"+r.Host))
	}))
	t.Cleanup(srv.Close)
	return srv, func() map[string]string {
		mu.Lock()
		defer mu.Unlock()
		return auth
	}
}

func catalogOf(entries ...string) string {
	return `{"specVersion":"1.0","entries":[` + strings.Join(entries, ",") + `]}`
}

func agentEntry(id, rawURL string) string {
	return fmt.Sprintf(`{"identifier":%q,"type":"application/a2a-agent-card+json","url":%q}`, id, rawURL)
}

func nestedEntry(id, rawURL string) string {
	return fmt.Sprintf(`{"identifier":%q,"type":"application/ai-catalog+json","url":%q}`, id, rawURL)
}

func resolve(t *testing.T, r *Resolver, docURL string) *Result {
	t.Helper()
	res, err := r.Client.Get(docURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var doc json.RawMessage
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	out, err := r.Resolve(context.Background(), doc, docURL)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	return out
}

func TestResolve(t *testing.T) {
	srv, _ := serve(t, map[string]string{
		"/top.json": catalogOf(
			agentEntry("urn:air:example.com:a2a:relative", "agents/relative.json"),
			agentEntry("urn:air:example.com:a2a:host", "https://agent.example.com"),
			`{"identifier":"urn:air:example.com:a2a:inline","displayName":"Inline","description":"An inline card","type":"application/a2a-agent-card+json",
				"data":{"name":"Inline agent"},"extensions":{"com.github.a2aproject.inspector":{"name":"Saved"},"com.example.other":1}}`,
			`{"identifier":"urn:air:example.com:mcp:weather","type":"application/mcp-server-card+json","url":"https://mcp.example.com/card"}`,
			nestedEntry("urn:air:example.com:catalog:nested", "/nested.json"),
			agentEntry("urn:air:example.com:a2a:duplicate", "{{host}}/agents/relative.json"),
			nestedEntry("urn:air:example.com:catalog:missing", "/missing.json"),
			nestedEntry("urn:air:example.com:catalog:card", "/not-a-catalog.json"),
			`{"identifier":"urn:air:example.com:a2a:empty","type":"application/a2a-agent-card+json"}`,
		),
		"/nested.json": catalogOf(
			agentEntry("urn:air:example.com:a2a:nested", "/agents/nested.json"),
			// A loop back to the top catalog is ignored.
			nestedEntry("urn:air:example.com:catalog:top", "/top.json"),
			`{"identifier":"urn:air:example.com:catalog:inline","type":"application/ai-catalog+json","data":`+
				catalogOf(agentEntry("urn:air:example.com:a2a:deep", "deep.json"), `{"identifier":"x","type":"text/plain","url":"https://example.com/x"}`)+`}`,
		),
		"/not-a-catalog.json": `{"name":"An agent card"}`,
	})
	got := resolve(t, &Resolver{Client: srv.Client()}, srv.URL+"/top.json")

	top, nested := srv.URL+"/top.json", srv.URL+"/nested.json"
	wantAgents := []Agent{
		{Identifier: "urn:air:example.com:a2a:relative", CardURL: srv.URL + "/agents/relative.json", Catalog: top},
		{Identifier: "urn:air:example.com:a2a:host", CardURL: "https://agent.example.com/.well-known/agent-card.json", Catalog: top},
		{Identifier: "urn:air:example.com:a2a:inline", DisplayName: "Inline", Description: "An inline card", Card: json.RawMessage(`{"name":"Inline agent"}`),
			Inspector: json.RawMessage(`{"name":"Saved"}`), Catalog: top},
		{Identifier: "urn:air:example.com:a2a:nested", CardURL: srv.URL + "/agents/nested.json", Catalog: nested},
		{Identifier: "urn:air:example.com:a2a:deep", CardURL: srv.URL + "/deep.json", Catalog: nested},
	}
	if diff := cmp.Diff(wantAgents, got.Agents); diff != "" {
		t.Errorf("agents (-want +got):\n%s", diff)
	}
	if got.Skipped != 2 {
		t.Errorf("skipped = %d, want 2", got.Skipped)
	}
	wantProblems := []Problem{
		{Catalog: srv.URL + "/missing.json", Message: "The server answered 404 Not Found."},
		{Catalog: srv.URL + "/not-a-catalog.json", Message: "The response isn't an AI Catalog: it has no specVersion."},
		{Catalog: top, Message: `"empty" has neither a URL nor a card.`},
	}
	if diff := cmp.Diff(wantProblems, got.Problems); diff != "" {
		t.Errorf("problems (-want +got):\n%s", diff)
	}
}

func TestResolveDocument(t *testing.T) {
	srv, auth := serve(t, map[string]string{"/nested.json": catalogOf(agentEntry("b", "/b.json"))})
	doc := `{"specVersion":"1.0","extensions":{"com.github.a2aproject.inspector":{"endpoints":[]}},"entries":[` +
		agentEntry("a", "https://a.example.com") + "," + agentEntry("relative", "/relative.json") + "," + nestedEntry("nested", srv.URL+"/nested.json") + `]}`
	r := &Resolver{Client: srv.Client(), Headers: http.Header{"Authorization": {"Bearer t0ken"}}}
	got, err := r.Resolve(context.Background(), []byte(doc), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Agents) != 2 || got.Agents[0].CardURL != "https://a.example.com/.well-known/agent-card.json" || got.Agents[1].CardURL != srv.URL+"/b.json" {
		t.Errorf("agents = %+v", got.Agents)
	}
	if len(got.Problems) != 1 || !strings.Contains(got.Problems[0].Message, "has no catalog URL") {
		t.Errorf("problems = %+v, want the relative URL", got.Problems)
	}
	if string(got.Inspector) != `{"endpoints":[]}` {
		t.Errorf("inspector = %s", got.Inspector)
	}
	// A document has no origin, so the credentials go nowhere.
	if a := auth()["/nested.json"]; a != "" {
		t.Errorf("nested catalog got Authorization %q", a)
	}
}

func TestResolveDepth(t *testing.T) {
	docs := map[string]string{}
	for i := range 6 {
		docs[fmt.Sprintf("/c%d.json", i)] = catalogOf(agentEntry(fmt.Sprintf("agent-%d", i), fmt.Sprintf("/a%d.json", i)), nestedEntry(fmt.Sprintf("c%d", i+1), fmt.Sprintf("/c%d.json", i+1)))
	}
	srv, _ := serve(t, docs)
	got := resolve(t, &Resolver{Client: srv.Client()}, srv.URL+"/c0.json")
	if len(got.Agents) != MaxDepth+1 || got.Agents[MaxDepth].Identifier != fmt.Sprintf("agent-%d", MaxDepth) {
		t.Errorf("agents = %+v, want agents 0 to %d", got.Agents, MaxDepth)
	}
	if len(got.Problems) != 1 || !strings.Contains(got.Problems[0].Message, `"c5" isn't followed`) {
		t.Errorf("problems = %+v", got.Problems)
	}
}

func TestResolveFetchLimit(t *testing.T) {
	docs := map[string]string{}
	var entries []string
	for i := range maxFetches + 10 {
		docs[fmt.Sprintf("/c%d.json", i)] = catalogOf(agentEntry(fmt.Sprintf("agent-%d", i), fmt.Sprintf("/a%d.json", i)))
		entries = append(entries, nestedEntry(fmt.Sprintf("c%d", i), fmt.Sprintf("/c%d.json", i)))
	}
	docs["/top.json"] = catalogOf(entries...)
	srv, _ := serve(t, docs)
	got := resolve(t, &Resolver{Client: srv.Client()}, srv.URL+"/top.json")
	if len(got.Agents) != maxFetches {
		t.Errorf("got %d agents, want %d", len(got.Agents), maxFetches)
	}
	for i, a := range got.Agents {
		if a.Identifier != fmt.Sprintf("agent-%d", i) {
			t.Fatalf("agent %d = %q, want catalog order", i, a.Identifier)
		}
	}
	if len(got.Problems) != 1 || got.Problems[0].Message != fmt.Sprintf("Only the first %d nested catalogs were fetched.", maxFetches) {
		t.Errorf("problems = %+v", got.Problems)
	}
}

func TestResolveHeaders(t *testing.T) {
	other, otherAuth := serve(t, map[string]string{"/other.json": catalogOf()})
	srv, auth := serve(t, map[string]string{
		"/top.json":  catalogOf(nestedEntry("same", "/same.json"), nestedEntry("other", other.URL+"/other.json")),
		"/same.json": catalogOf(),
	})
	r := &Resolver{Client: srv.Client(), Headers: http.Header{"Authorization": {"Bearer t0ken"}}}
	resolve(t, r, srv.URL+"/top.json")
	if a := auth()["/same.json"]; a != "Bearer t0ken" {
		t.Errorf("same-origin catalog got Authorization %q, want the credentials", a)
	}
	if a := otherAuth()["/other.json"]; a != "" {
		t.Errorf("catalog on another origin got Authorization %q", a)
	}
}

func TestParse(t *testing.T) {
	tests := []struct {
		doc, wantErr string
	}{
		{doc: `{"specVersion":"1.0","entries":[]}`},
		{doc: `{"specVersion":"1.3","entries":[],"host":{"displayName":"x"},"unknown":true}`},
		// Trust metadata in the current draft's shapes is ignored.
		{doc: `{"specVersion":"1.0","signature":{"protected":"x","signature":"y"},"entries":[
			{"identifier":"x","type":"application/a2a-agent-card+json","url":"https://a.example.com","trustManifests":[{"identity":"did:web:a.example.com"}],"trustManifest":[]}]}`},
		{doc: `{"specVersion":"1.0","entries":["not an entry"]}`, wantErr: "entries can't be read"},
		{doc: `[]`, wantErr: "isn't a JSON object"},
		{doc: `{"name":"An agent card","url":"https://a.example.com"}`, wantErr: "no specVersion"},
		{doc: `{"specVersion":"1.0"}`, wantErr: "no entries list"},
		{doc: `{"specVersion":"1.0","entries":{}}`, wantErr: "no entries list"},
		{doc: `{"specVersion":"2.0","entries":[]}`, wantErr: "newer than the inspector supports"},
		{doc: `{"specVersion":"1.0","entries":[{"identifier":"x","tags":"not a list"}]}`, wantErr: "can't be read"},
	}
	for _, tc := range tests {
		_, err := parse([]byte(tc.doc))
		if tc.wantErr == "" && err != nil || tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
			t.Errorf("parse(%s) error = %v, want %q", tc.doc, err, tc.wantErr)
		}
	}
}

func TestNormalizeURL(t *testing.T) {
	tests := []struct {
		ref, want, wantErr string
	}{
		{ref: "example.com", want: "https://example.com/.well-known/ai-catalog.json"},
		{ref: "localhost:8000", want: "http://localhost:8000/.well-known/ai-catalog.json"},
		{ref: "https://example.com/catalogs/finance.json", want: "https://example.com/catalogs/finance.json"},
		{ref: "./catalog.json", wantErr: "only http and https catalog URLs are supported"},
		{ref: "ftp://example.com", wantErr: "unsupported scheme"},
	}
	for _, tc := range tests {
		got, err := NormalizeURL(tc.ref)
		if got != tc.want || tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
			t.Errorf("NormalizeURL(%q) = %q, %v; want %q, %q", tc.ref, got, err, tc.want, tc.wantErr)
		}
	}
}
