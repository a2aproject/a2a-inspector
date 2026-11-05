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
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/a2aproject/a2a-inspector/internal/catalog"
	"github.com/a2aproject/a2a-inspector/internal/egress"
)

const catalogToken = "Bearer catalog-token-0123456789"

// catalogServer serves catalogs by path. Paths in protected answer 401
// without catalogToken. It records the Authorization header of each path.
type catalogServer struct {
	*httptest.Server
	mu   sync.Mutex
	auth map[string]string
}

func newCatalogServer(t *testing.T, docs map[string]string, protected ...string) *catalogServer {
	t.Helper()
	cs := &catalogServer{auth: map[string]string{}}
	cs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cs.mu.Lock()
		cs.auth[r.URL.Path] = r.Header.Get("Authorization")
		cs.mu.Unlock()
		for _, p := range protected {
			if p == r.URL.Path && r.Header.Get("Authorization") != catalogToken {
				http.Error(w, "sign in first", http.StatusUnauthorized)
				return
			}
		}
		if to, ok := strings.CutPrefix(docs[r.URL.Path], "redirect:"); ok {
			http.Redirect(w, r, to, http.StatusFound)
			return
		}
		doc, ok := docs[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/ai-catalog+json")
		_, _ = io.WriteString(w, doc)
	}))
	t.Cleanup(cs.Close)
	return cs
}

func (cs *catalogServer) authOf(path string) string {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.auth[path]
}

func catalogDoc(entries ...string) string {
	return `{"specVersion":"1.0","entries":[` + strings.Join(entries, ",") + `]}`
}

func a2aEntry(id, rawURL string) string {
	return fmt.Sprintf(`{"identifier":%q,"type":"application/a2a-agent-card+json","url":%q}`, id, rawURL)
}

func catalogEntry(id, rawURL string) string {
	return fmt.Sprintf(`{"identifier":%q,"type":"application/ai-catalog+json","url":%q}`, id, rawURL)
}

func resolveCatalog(t *testing.T, s *Server, body string) (*httptest.ResponseRecorder, catalogResolveResponse) {
	t.Helper()
	w := s.do(request{method: http.MethodPost, target: "/api/catalog:resolve", body: body, cookie: true})
	if w.Code != http.StatusOK {
		return w, catalogResolveResponse{}
	}
	return w, decodeBody[catalogResolveResponse](t, w)
}

func identifiers(agents []catalog.Agent) string {
	var out []string
	for _, a := range agents {
		out = append(out, a.Identifier)
	}
	return strings.Join(out, ",")
}

func TestCatalogResolve(t *testing.T) {
	other := newCatalogServer(t, map[string]string{"/other.json": catalogDoc(a2aEntry("other", "https://other.example.com"))})
	cs := newCatalogServer(t, map[string]string{
		"/.well-known/ai-catalog.json": catalogDoc(
			a2aEntry("top", "/agents/top.json"),
			catalogEntry("same", "/nested.json"),
			catalogEntry("other", other.URL+"/other.json"),
			`{"identifier":"mcp","type":"application/mcp-server-card+json","url":"https://mcp.example.com"}`,
		),
		"/nested.json": catalogDoc(a2aEntry("nested", "/agents/nested.json")),
		"/card.json":   `{"name":"An agent card"}`,
	}, "/.well-known/ai-catalog.json", "/nested.json")
	s := newServer(t, Options{})
	host := strings.TrimPrefix(cs.URL, "http://")

	// Without credentials the catalog answers 401, which the call reports.
	_, res := resolveCatalog(t, s, `{"url":"`+host+`"}`)
	if res.Call.Error == nil || res.Call.Error.Code != http.StatusUnauthorized || res.Call.Error.Message != "The server answered 401 Unauthorized." || res.Agents == nil {
		t.Errorf("without credentials: %+v", res)
	}

	w, res := resolveCatalog(t, s, `{"url":"`+host+`","auth":{"bearer":{"value":"catalog-token-0123456789"}}}`)
	if res.Call.Error != nil || res.CatalogURL != cs.URL+"/.well-known/ai-catalog.json" || res.Call.TrafficEntryID == "" {
		t.Fatalf("catalog:resolve = %d %s", w.Code, w.Body)
	}
	if identifiers(res.Agents) != "top,nested,other" || res.Agents[0].CardURL != cs.URL+"/agents/top.json" {
		t.Errorf("agents = %+v", res.Agents)
	}
	if res.Skipped != 1 {
		t.Errorf("skipped = %d, want 1", res.Skipped)
	}
	// The credentials go to the catalog's origin only.
	if cs.authOf("/nested.json") != catalogToken || other.authOf("/other.json") != "" {
		t.Errorf("Authorization: same origin %q, other origin %q", cs.authOf("/nested.json"), other.authOf("/other.json"))
	}
	snapshot, _, cancel := s.local.traffic.Subscribe(nil)
	cancel()
	for _, e := range snapshot {
		for _, h := range e.HTTP.RequestHeaders {
			if h.Name == "Authorization" && strings.Contains(h.Value, "catalog-token") {
				t.Errorf("traffic entry %s recorded the token: %q", e.HTTP.URL, h.Value)
			}
		}
	}

	if _, res := resolveCatalog(t, s, `{"url":"`+cs.URL+`/card.json"}`); res.Call.Error == nil || res.Call.Error.Message != "The response isn't an AI Catalog: it has no specVersion." {
		t.Errorf("an agent card: error = %+v", res.Call.Error)
	}

	_, res = resolveCatalog(t, s, `{"catalog":`+catalogDoc(a2aEntry("inline", "https://inline.example.com"))+`}`)
	if res.Call.Error != nil || len(res.Agents) != 1 || res.Agents[0].CardURL != "https://inline.example.com/.well-known/agent-card.json" {
		t.Errorf("inline catalog: %+v", res)
	}
	if _, res := resolveCatalog(t, s, `{"catalog":{"name":"x"}}`); res.Call.Error == nil || !strings.HasPrefix(res.Call.Error.Message, "The file isn't an AI Catalog") {
		t.Errorf("inline non-catalog: error = %+v", res.Call.Error)
	}

	for _, tc := range []struct{ body, want string }{
		{`{}`, `Give \"url\" or \"catalog\".`},
		{`{"url":"./catalog.json"}`, "local file path"},
		{`{"url":"x","catalog":{}}`, "not both"},
		{`{"catalog":{},"auth":{"bearer":{"value":"x"}}}`, "Credentials only go with a catalog URL"},
	} {
		if w, _ := resolveCatalog(t, s, tc.body); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), tc.want) {
			t.Errorf("%s = %d %s, want 400 %q", tc.body, w.Code, w.Body, tc.want)
		}
	}
}

func TestCatalogRedirects(t *testing.T) {
	other := newCatalogServer(t, map[string]string{"/other.json": catalogDoc()})
	cs := newCatalogServer(t, map[string]string{"/moved.json": "redirect:" + other.URL + "/other.json"})
	s := newServer(t, Options{})
	auth := `"auth":{"bearer":{"value":"catalog-token-0123456789"}}`
	if _, res := resolveCatalog(t, s, `{"url":"`+cs.URL+`/moved.json",`+auth+`}`); res.Call.Error != nil || other.authOf("/other.json") != "" {
		t.Errorf("cross-origin redirect: error %+v, Authorization %q; want the credentials dropped", res.Call.Error, other.authOf("/other.json"))
	}

	tlsCatalog := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/other.json", http.StatusFound)
	}))
	defer tlsCatalog.Close()
	s = newServer(t, Options{HTTPTransport: tlsCatalog.Client().Transport})
	if _, res := resolveCatalog(t, s, `{"url":"`+tlsCatalog.URL+`/catalog.json",`+auth+`}`); res.Call.Error == nil || !strings.Contains(res.Call.Error.Message, "redirect from https") {
		t.Errorf("https to http redirect with credentials: error = %+v", res.Call.Error)
	}
}

func TestHostedCatalogResolve(t *testing.T) {
	policy, err := egress.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	s := newServer(t, Options{Hosted: true, Egress: policy})
	t.Cleanup(s.Close)
	b := &browser{s: s}
	w := b.do(request{method: http.MethodPost, target: "/api/catalog:resolve", body: `{"url":"http://127.0.0.1:1/catalog.json"}`})
	if res := decodeBody[catalogResolveResponse](t, w); res.Call.Error == nil || !strings.Contains(res.Call.Error.Message, "egress policy") {
		t.Errorf("loopback catalog: error = %+v, want blocked", res.Call.Error)
	}
	t.Setenv("A2A_INSPECTOR_TEST_SECRET", "operator-secret")
	w = b.do(request{method: http.MethodPost, target: "/api/catalog:resolve", body: `{"url":"https://catalog.example.com","auth":{"bearer":{"envVar":"A2A_INSPECTOR_TEST_SECRET"}}}`})
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "environment variables") {
		t.Errorf("envVar credentials = %d %s", w.Code, w.Body)
	}
}

func TestSharedCatalog(t *testing.T) {
	cs := newCatalogServer(t, map[string]string{
		"/catalog.json": catalogDoc(a2aEntry("remote", "/agents/remote.json")),
		"/nested.json":  catalogDoc(a2aEntry("nested", "/agents/nested.json")),
	})
	path := filepath.Join(t.TempDir(), "ai-catalog.json")
	if err := os.WriteFile(path, []byte(catalogDoc(a2aEntry("local", "https://local.example.com"), catalogEntry("nested", cs.URL+"/nested.json"))), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, ref := range []string{path, cs.URL + "/catalog.json"} {
		s := newServer(t, Options{Catalog: ref})
		w := s.do(request{target: "/api/catalog", cookie: true})
		if w.Code != http.StatusOK {
			t.Fatalf("GET /api/catalog = %d %s", w.Code, w.Body)
		}
		got := decodeBody[catalog.Result](t, w)
		if len(got.Agents) == 0 || !decodeBody[configResponse](t, s.do(request{target: "/api/config", cookie: true})).Features.SharedCatalog {
			t.Errorf("--catalog %s: agents %+v", ref, got.Agents)
		}
		if ref == path && identifiers(got.Agents) != "local,nested" {
			t.Errorf("file catalog agents = %+v", got.Agents)
		}
	}

	s := newServer(t, Options{})
	if w := s.do(request{target: "/api/catalog", cookie: true}); w.Code != http.StatusNotFound {
		t.Errorf("GET /api/catalog without a catalog = %d", w.Code)
	}
	if decodeBody[configResponse](t, s.do(request{target: "/api/config", cookie: true})).Features.SharedCatalog {
		t.Error("sharedCatalog is set without a catalog")
	}

	if _, err := New(Options{Token: testToken, UI: testUI, Catalog: filepath.Join(t.TempDir(), "missing.json")}); err == nil {
		t.Error("New() accepted a missing catalog file")
	}
	policy, err := egress.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(Options{Hosted: true, UI: testUI, Egress: policy, Catalog: cs.URL + "/catalog.json"}); err == nil || !strings.Contains(err.Error(), "egress policy") {
		t.Errorf("New() with a loopback catalog under the egress policy: error = %v", err)
	}
}
