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
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/catalog"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
)

// catalogTimeout bounds resolving a catalog, nested catalogs included.
const catalogTimeout = 30 * time.Second

type catalogResolveRequest struct {
	// URL is a catalog to fetch; Catalog is one given as a document, such as
	// an imported file.
	URL     string          `json:"url,omitempty"`
	Catalog json.RawMessage `json:"catalog,omitempty"`
	// Auth and Headers are sent with the request for URL, and for nested
	// catalogs on its origin.
	Auth    *authInput    `json:"auth,omitempty"`
	Headers []headerInput `json:"headers,omitempty"`
}

type catalogResolveResponse struct {
	// CatalogURL is the URL the catalog was fetched from, after redirects.
	CatalogURL string `json:"catalogUrl,omitempty"`
	catalog.Result
	Call call `json:"call"`
}

func (s *Server) handleCatalogResolve(w http.ResponseWriter, r *http.Request) {
	sess := sessionOf(r)
	var req catalogResolveRequest
	if !decodeRequest(w, r, &req) {
		return
	}
	inline := len(req.Catalog) > 0 && string(req.Catalog) != "null"
	switch {
	case inline && req.URL != "":
		writeError(w, http.StatusBadRequest, `Give "url" or "catalog", not both.`)
		return
	case inline && (req.Auth != nil || len(req.Headers) > 0):
		writeError(w, http.StatusBadRequest, "Credentials only go with a catalog URL.")
		return
	case !inline && strings.TrimSpace(req.URL) == "":
		writeError(w, http.StatusBadRequest, `Give "url" or "catalog".`)
		return
	}

	resp := catalogResolveResponse{Result: catalog.Result{Agents: []catalog.Agent{}}}
	ctx, cancel := context.WithTimeout(r.Context(), catalogTimeout)
	defer cancel()
	if inline {
		tc := &traffic.Call{}
		res, err := (&catalog.Resolver{Client: sess.client}).Resolve(traffic.WithCall(ctx, tc), req.Catalog, "")
		resp.Call.TrafficEntryID = tc.LastEntryID()
		if err != nil {
			resp.Call.Error = &callError{Message: "The file isn't an AI Catalog: " + err.Error() + "."}
		} else {
			resp.Result = *res
		}
		writeJSON(w, http.StatusOK, resp)
		return
	}

	catalogURL, err := catalog.NormalizeURL(req.URL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	headers, secrets, err := headerParams(sess, req.Auth, req.Headers)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	resp.CatalogURL = catalogURL
	tc := &traffic.Call{Secrets: secrets, Headers: slices.Collect(maps.Keys(headers))}
	ctx = traffic.WithCall(ctx, tc)
	res, err := agents.Fetch(ctx, sess.client, catalogURL, catalog.Accept, headers)
	resp.Call.TrafficEntryID = tc.LastEntryID()
	if err != nil {
		resp.Call.Error = &callError{Message: err.Error()}
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.CatalogURL = res.URL
	resp.Call.LatencyMs = res.Latency.Milliseconds()
	if msg := documentError(res, "catalog"); msg != "" {
		resp.Call.Error = &callError{Message: msg, Code: res.StatusCode, Raw: excerpt(res.Body)}
		writeJSON(w, http.StatusOK, resp)
		return
	}
	result, err := (&catalog.Resolver{Client: sess.client, Headers: headers}).Resolve(ctx, res.Body, res.URL)
	if err != nil {
		resp.Call.Error = &callError{Message: "The response isn't an AI Catalog: " + err.Error() + ".", Raw: excerpt(res.Body)}
	} else {
		resp.Result = *result
	}
	writeJSON(w, http.StatusOK, resp)
}

// documentError says why a response isn't a document to read, or returns "".
func documentError(res *agents.Response, what string) string {
	switch {
	case res.StatusCode != http.StatusOK:
		return "The server answered " + res.Status + "."
	case res.TooLarge:
		return fmt.Sprintf("The %s is larger than %d MiB.", what, agents.MaxCardSize>>20)
	}
	return ""
}

// loadCatalog reads the shared catalog, a file or a URL, with the
// inspector's own transport: the egress policy applies, credentials don't.
func (s *Server) loadCatalog(ref string) (*catalog.Result, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*catalogTimeout)
	defer cancel()
	r := &catalog.Resolver{Client: &http.Client{Transport: s.transport, CheckRedirect: checkRedirect}}
	if !strings.Contains(ref, "://") {
		doc, err := os.ReadFile(ref)
		if err != nil {
			return nil, err
		}
		return r.Resolve(ctx, doc, "")
	}
	u, err := catalog.NormalizeURL(ref)
	if err != nil {
		return nil, err
	}
	res, err := agents.Fetch(ctx, r.Client, u, catalog.Accept, nil)
	if err != nil {
		return nil, err
	}
	if msg := documentError(res, "catalog"); msg != "" {
		return nil, errors.New(msg)
	}
	return r.Resolve(ctx, res.Body, res.URL)
}

func (s *Server) handleSharedCatalog(w http.ResponseWriter, r *http.Request) {
	if s.shared == nil {
		writeError(w, http.StatusNotFound, "The inspector has no shared catalog.")
		return
	}
	writeJSON(w, http.StatusOK, s.shared)
}
