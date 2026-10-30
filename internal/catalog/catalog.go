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

// Package catalog reads AI Catalogs: it lists the A2A agents in a catalog and
// in the catalogs nested in it. A catalog is only a container for agents to
// the inspector, so it isn't validated.
package catalog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"

	aicatalog "github.com/Agent-Card/ai-catalog-go/catalog"
	"github.com/a2aproject/a2a-inspector/internal/agents"
)

// ExtensionKey is the extension of a catalog and its entries that holds the
// inspector's settings.
const ExtensionKey = "com.github.a2aproject.inspector"

// Accept is the Accept header of catalog requests.
const Accept = aicatalog.MediaTypeCatalog + ", application/json"

const (
	// MaxDepth is how deep catalogs nested in catalogs are followed, as the
	// specification recommends.
	MaxDepth = 4
	// maxFetches bounds the nested catalogs fetched for one catalog.
	maxFetches = 50
	// parallelFetches is how many nested catalogs are fetched at once.
	parallelFetches = 8
	maxAgents       = 1000
)

// NormalizeURL turns a catalog reference into the URL to fetch, as
// agents.NormalizeCardURL does for cards: a bare host means its well-known
// catalog.
func NormalizeURL(ref string) (string, error) {
	return agents.NormalizeURL(ref, aicatalog.WellKnownPath, "catalog URL")
}

// Agent is an A2A agent listed in a catalog.
type Agent struct {
	Identifier  string `json:"identifier"`
	DisplayName string `json:"displayName,omitempty"`
	Description string `json:"description,omitempty"`
	// CardURL is where the agent's card is, unless the catalog has the card
	// itself in Card.
	CardURL string          `json:"cardUrl,omitempty"`
	Card    json.RawMessage `json:"card,omitempty"`
	// Inspector is the entry's ExtensionKey extension, as written.
	Inspector json.RawMessage `json:"inspector,omitempty"`
	// Catalog is the URL of the catalog that lists the agent; empty when
	// it's in a catalog given as a document.
	Catalog string `json:"catalog,omitempty"`
}

// Problem is a nested catalog or an agent entry that couldn't be read.
type Problem struct {
	Catalog string `json:"catalog,omitempty"`
	Message string `json:"message"`
}

// Result lists the agents of a catalog and its nested catalogs, in catalog
// order and without duplicates.
type Result struct {
	Agents []Agent `json:"agents"`
	// Skipped counts the entries that are neither A2A agents nor catalogs.
	Skipped  int       `json:"skipped"`
	Problems []Problem `json:"problems,omitempty"`
	// Inspector is the catalog's own ExtensionKey extension, as written.
	Inspector json.RawMessage `json:"inspector,omitempty"`
}

// Resolver reads catalogs and fetches the catalogs nested in them.
type Resolver struct {
	Client *http.Client
	// Headers are sent with requests for nested catalogs on the origin of
	// the catalog being resolved, and never to other origins.
	Headers http.Header
}

// Resolve lists the agents in doc, a catalog fetched from docURL, and in the
// catalogs nested in it. docURL is "" for a catalog that came as a document;
// its relative URLs can't be followed then, and Headers aren't sent. The error
// says why doc isn't a catalog; nested catalogs that fail are Problems.
func (r *Resolver) Resolve(ctx context.Context, doc []byte, docURL string) (*Result, error) {
	c, err := parse(doc)
	if err != nil {
		return nil, err
	}
	w := &walker{r: r, visited: map[string]bool{}, slots: make(chan struct{}, parallelFetches)}
	if docURL != "" {
		if w.base, err = url.Parse(docURL); err != nil {
			return nil, err
		}
		w.origin = w.base
		w.visited[docURL] = true
	}
	n := w.walk(ctx, c, w.base, docURL, 0)
	res := &Result{Agents: []Agent{}, Skipped: n.skipped, Problems: n.problems, Inspector: c.Extensions[ExtensionKey]}
	seen := map[string]bool{}
	for _, a := range n.agents {
		key := a.CardURL
		if key == "" {
			key = "inline:" + a.Identifier
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		if len(res.Agents) == maxAgents {
			res.Problems = append(res.Problems, Problem{Message: fmt.Sprintf("Only the first %d agents are listed.", maxAgents)})
			break
		}
		res.Agents = append(res.Agents, a)
	}
	return res, nil
}

// parse reads a catalog. Anything with a specVersion and entries is one,
// unless its major version is newer than the inspector knows. Signatures and
// trust manifests are dropped first: the inspector ignores them, and the SDK
// reads an older draft of them, which newer catalogs fail.
func parse(doc []byte) (*aicatalog.AICatalog, error) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(doc, &probe); err != nil {
		return nil, errors.New("it isn't a JSON object")
	}
	var version string
	if err := json.Unmarshal(probe["specVersion"], &version); err != nil || version == "" {
		return nil, errors.New("it has no specVersion")
	}
	var entries []map[string]json.RawMessage
	if list := bytes.TrimSpace(probe["entries"]); !bytes.HasPrefix(list, []byte("[")) {
		return nil, errors.New("it has no entries list")
	} else if err := json.Unmarshal(list, &entries); err != nil {
		return nil, fmt.Errorf("its entries can't be read: %w", err)
	}
	major, _, _ := strings.Cut(version, ".")
	if n, err := strconv.Atoi(major); err == nil && n >= 2 {
		return nil, fmt.Errorf("its version %s is newer than the inspector supports (1.x)", version)
	}
	delete(probe, "signature")
	delete(probe, "additionalSignatures")
	for _, e := range entries {
		delete(e, "signature")
		delete(e, "trustManifest")
		delete(e, "trustManifests")
	}
	probe["entries"], _ = json.Marshal(entries)
	clean, _ := json.Marshal(probe)
	c, err := aicatalog.Parse(clean)
	if err != nil {
		return nil, fmt.Errorf("it can't be read: %w", err)
	}
	return c, nil
}

// walker resolves one catalog and the catalogs nested in it.
type walker struct {
	r *Resolver
	// base is the URL of the catalog resolved; origin is where Headers may go.
	base, origin *url.URL
	slots        chan struct{}

	mu       sync.Mutex
	visited  map[string]bool
	fetches  int
	overflow bool
}

// node is what a catalog, or one of its entries, contributes to the result.
type node struct {
	agents   []Agent
	problems []Problem
	skipped  int
}

func (n *node) add(o node) {
	n.agents = append(n.agents, o.agents...)
	n.problems = append(n.problems, o.problems...)
	n.skipped += o.skipped
}

func problem(catalogURL, format string, args ...any) node {
	return node{problems: []Problem{{Catalog: catalogURL, Message: fmt.Sprintf(format, args...)}}}
}

// walk reads the entries of c, listed in the catalog at catalogURL, which is
// at the given depth below the catalog resolved. Nested catalogs it has to
// fetch are fetched in parallel; the result keeps the entries' order.
func (w *walker) walk(ctx context.Context, c *aicatalog.AICatalog, base *url.URL, catalogURL string, depth int) node {
	nodes := make([]node, len(c.Entries))
	var wg sync.WaitGroup
	for i := range c.Entries {
		e := &c.Entries[i]
		switch e.Type {
		case aicatalog.MediaTypeA2AAgentCard:
			nodes[i] = agentNode(e, base, catalogURL)
		case aicatalog.MediaTypeCatalog:
			if depth == MaxDepth {
				nodes[i] = problem(catalogURL, "%s isn't followed: catalogs nest deeper than %d levels.", name(e), MaxDepth)
				continue
			}
			if hasData(e.Data) {
				nested, err := parse(e.Data)
				if err != nil {
					nodes[i] = problem(catalogURL, "%s isn't an AI Catalog: %v.", name(e), err)
					continue
				}
				nodes[i] = w.walk(ctx, nested, base, catalogURL, depth+1)
				continue
			}
			u, err := resolveURL(base, e.URL)
			if err != nil {
				nodes[i] = problem(catalogURL, "%s: %v", name(e), err)
				continue
			}
			if !w.claim(u) {
				continue
			}
			wg.Go(func() { nodes[i] = w.fetch(ctx, u, depth+1) })
		default:
			nodes[i].skipped = 1
		}
	}
	wg.Wait()
	var out node
	for _, n := range nodes {
		out.add(n)
	}
	if w.overflowOnce() {
		out.problems = append(out.problems, Problem{Message: fmt.Sprintf("Only the first %d nested catalogs were fetched.", maxFetches)})
	}
	return out
}

// claim reports whether u is a catalog to fetch: one not seen yet, within
// the fetch limit.
func (w *walker) claim(u *url.URL) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	key := u.String()
	if w.visited[key] {
		return false
	}
	w.visited[key] = true
	if w.fetches == maxFetches {
		w.overflow = true
		return false
	}
	w.fetches++
	return true
}

// overflowOnce reports, once, that nested catalogs were left out.
func (w *walker) overflowOnce() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.overflow {
		return false
	}
	w.overflow = false
	return true
}

// fetch fetches a nested catalog and walks it.
func (w *walker) fetch(ctx context.Context, u *url.URL, depth int) node {
	var headers http.Header
	if w.origin != nil && agents.SameOrigin(u, w.origin) {
		headers = w.r.Headers
	}
	w.slots <- struct{}{}
	res, err := agents.Fetch(ctx, w.r.Client, u.String(), Accept, headers)
	<-w.slots
	catalogURL := u.String()
	switch {
	case err != nil:
		return problem(catalogURL, "Couldn't fetch the catalog: %v", err)
	case res.StatusCode != http.StatusOK:
		return problem(catalogURL, "The server answered %s.", res.Status)
	case res.TooLarge:
		return problem(catalogURL, "The catalog is larger than %d MiB.", agents.MaxCardSize>>20)
	}
	c, err := parse(res.Body)
	if err != nil {
		return problem(catalogURL, "The response isn't an AI Catalog: %v.", err)
	}
	final, err := url.Parse(res.URL)
	if err != nil {
		final = u
	}
	return w.walk(ctx, c, final, catalogURL, depth)
}

// agentNode reads an A2A agent entry; a card in the entry wins over its URL.
func agentNode(e *aicatalog.CatalogEntry, base *url.URL, catalogURL string) node {
	a := Agent{
		Identifier:  e.Identifier,
		DisplayName: e.DisplayName,
		Description: e.Description,
		Inspector:   e.Extensions[ExtensionKey],
		Catalog:     catalogURL,
	}
	switch {
	case hasData(e.Data):
		if !bytes.HasPrefix(bytes.TrimSpace(e.Data), []byte("{")) {
			return problem(catalogURL, "%s: the card in the entry isn't a JSON object.", name(e))
		}
		if e.Identifier == "" {
			return problem(catalogURL, "An agent with its card in the entry has no identifier.")
		}
		a.Card = e.Data
	case e.URL != "":
		u, err := resolveURL(base, e.URL)
		if err == nil {
			a.CardURL, err = agents.NormalizeCardURL(u.String())
		}
		if err != nil {
			return problem(catalogURL, "%s: %v", name(e), err)
		}
	default:
		return problem(catalogURL, "%s has neither a URL nor a card.", name(e))
	}
	return node{agents: []Agent{a}}
}

func hasData(data json.RawMessage) bool {
	d := bytes.TrimSpace(data)
	return len(d) > 0 && !bytes.Equal(d, []byte("null"))
}

// resolveURL resolves an entry's URL against the catalog's.
func resolveURL(base *url.URL, ref string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(ref))
	if err != nil {
		return nil, fmt.Errorf("invalid URL %q", ref)
	}
	if !u.IsAbs() {
		if base == nil {
			return nil, fmt.Errorf("the relative URL %q has no catalog URL to resolve against", ref)
		}
		u = base.ResolveReference(u)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported URL %q; use http or https", ref)
	}
	return u, nil
}

// name names an entry in problems.
func name(e *aicatalog.CatalogEntry) string {
	if n := e.ResolveDisplayName(); n != "" {
		return strconv.Quote(n)
	}
	return "An entry without an identifier"
}
