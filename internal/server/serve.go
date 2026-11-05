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
	"fmt"
	"net/http"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/serve"
)

// maxSourceLength bounds the source a caller names an echo agent's card by.
const maxSourceLength = 512

type serveRequest struct {
	Card json.RawMessage `json:"card"`
	// Interface picks the binding and version to serve; it defaults to the
	// card's first one the inspector supports.
	Interface *struct {
		ProtocolBinding string `json:"protocolBinding"`
		ProtocolVersion string `json:"protocolVersion"`
	} `json:"interface,omitempty"`
	// Source names the card the agent serves, such as its catalog
	// identifier, and comes back as it is.
	Source string `json:"source,omitempty"`
}

type echoAgentView struct {
	ID     string `json:"id"`
	Source string `json:"source,omitempty"`
	Name   string `json:"name"`
	// Interface is the one interface the agent serves; its card lists only
	// that one.
	Interface agents.Interface `json:"interface"`
	CardURL   string           `json:"cardUrl"`
	// Command is how the agent was started.
	Command   string `json:"command"`
	StartTime string `json:"startTime"`
	// Exited is set when the agent stopped by itself: why, with the end of
	// its output.
	Exited string `json:"exited,omitempty"`
}

func viewEchoAgent(a *serve.Agent) echoAgentView {
	return echoAgentView{
		ID:        a.ID,
		Source:    a.Source,
		Name:      a.Name,
		Interface: a.Interface,
		CardURL:   a.CardURL,
		Command:   a.Command,
		StartTime: a.Started.UTC().Format(time.RFC3339),
		Exited:    a.Exited(),
	}
}

type serveErrorResponse struct {
	Error struct {
		Message string `json:"message"`
		Code    string `json:"code"`
		// InstallHint tells how to install a2a-cli, and Command is what the
		// inspector would run.
		InstallHint string `json:"installHint"`
		Command     string `json:"command"`
	} `json:"error"`
}

func (s *Server) handleServe(w http.ResponseWriter, r *http.Request) {
	var req serveRequest
	if !decodeRequest(w, r, &req) {
		return
	}
	if len(req.Card) == 0 || string(req.Card) == "null" {
		writeError(w, http.StatusBadRequest, `"card" is required.`)
		return
	}
	if len(req.Card) > agents.MaxCardSize {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("The card is larger than %d MiB.", agents.MaxCardSize>>20))
		return
	}
	if len(req.Source) > maxSourceLength {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(`"source" is longer than %d bytes.`, maxSourceLength))
		return
	}
	binding, version := s.servedInterface(req)
	if err := serve.CheckInterface(binding, version); err != nil {
		writeError(w, http.StatusBadRequest, capitalize(err.Error())+".")
		return
	}
	a, err := s.echo.Start(r.Context(), req.Card, binding, version, req.Source)
	switch {
	case errors.Is(err, serve.ErrNotInstalled):
		var resp serveErrorResponse
		resp.Error.Message = capitalize(err.Error()) + "."
		resp.Error.Code = "serveNotInstalled"
		resp.Error.InstallHint = serve.InstallHint
		resp.Error.Command = serve.Preview(binding, version)
		writeJSON(w, http.StatusConflict, resp)
	case errors.Is(err, serve.ErrTooMany):
		writeError(w, http.StatusTooManyRequests, capitalize(err.Error())+".")
	case errors.Is(err, serve.ErrClosed):
		writeError(w, http.StatusServiceUnavailable, capitalize(err.Error())+".")
	case err != nil:
		// The card couldn't be read, or a2a-cli failed: either way it's about
		// what was asked to be served.
		writeError(w, http.StatusUnprocessableEntity, capitalize(err.Error()))
	default:
		writeJSON(w, http.StatusCreated, viewEchoAgent(a))
	}
}

// servedInterface is the binding and version the request asks for, or the
// card's first supported core interface, or HTTP+JSON in the card's version.
func (s *Server) servedInterface(req serveRequest) (binding, version string) {
	if req.Interface != nil {
		binding = req.Interface.ProtocolBinding
		if core := agents.CoreBinding(binding); core != "" {
			binding = core
		}
		return binding, agents.MajorMinor(req.Interface.ProtocolVersion)
	}
	var card map[string]any
	_ = json.Unmarshal(req.Card, &card)
	info := agents.DescribeCard(card, s.supports)
	for _, iface := range info.Interfaces {
		if iface.Supported && serve.CheckInterface(iface.ProtocolBinding, iface.ProtocolVersion) == nil {
			return iface.ProtocolBinding, iface.ProtocolVersion
		}
	}
	return agents.BindingHTTPJSON, info.ProtocolVersion
}

func (s *Server) handleListServe(w http.ResponseWriter, _ *http.Request) {
	list := []echoAgentView{}
	for _, a := range s.echo.List() {
		list = append(list, viewEchoAgent(a))
	}
	writeJSON(w, http.StatusOK, struct {
		Agents []echoAgentView `json:"agents"`
	}{list})
}

func (s *Server) handleStopServe(w http.ResponseWriter, r *http.Request) {
	if !s.echo.Stop(r.PathValue("id")) {
		writeError(w, http.StatusNotFound, "Unknown echo agent.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
