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
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/textproto"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2aclient"
	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
	"github.com/a2aproject/a2a-inspector/internal/validate"
)

// headerInput is a service parameter, sent as an HTTP header or gRPC
// metadata, with a plain value or a secret.
type headerInput struct {
	Name   string       `json:"name"`
	Value  string       `json:"value,omitempty"`
	Secret *secretInput `json:"secret,omitempty"`
}

type headerView struct {
	Name   string      `json:"name"`
	Value  string      `json:"value,omitempty"`
	Secret *secretView `json:"secret,omitempty"`
}

// authInput is one of the auth presets.
type authInput struct {
	Bearer *secretInput `json:"bearer,omitempty"`
	Basic  *struct {
		Username string      `json:"username"`
		Password secretInput `json:"password"`
	} `json:"basic,omitempty"`
	APIKey *struct {
		Header string      `json:"header"`
		Key    secretInput `json:"key"`
	} `json:"apiKey,omitempty"`
}

type authView struct {
	// Type is "bearer", "basic" or "apiKey".
	Type     string     `json:"type"`
	Username string     `json:"username,omitempty"`
	Header   string     `json:"header,omitempty"`
	Secret   secretView `json:"secret"`
}

type connectionRequest struct {
	// CardURL is where the card came from. Card, if set, is the card itself,
	// so the backend doesn't fetch it again; without either, Interface is
	// required.
	CardURL   string          `json:"cardUrl,omitempty"`
	Card      json.RawMessage `json:"card,omitempty"`
	Interface *struct {
		URL             string `json:"url"`
		ProtocolBinding string `json:"protocolBinding"`
		ProtocolVersion string `json:"protocolVersion"`
		Tenant          string `json:"tenant,omitempty"`
	} `json:"interface,omitempty"`
	Auth          *authInput        `json:"auth,omitempty"`
	Headers       []headerInput     `json:"headers,omitempty"`
	Extensions    []string          `json:"extensions,omitempty"`
	ServiceParams map[string]string `json:"serviceParams,omitempty"`
	Tenant        string            `json:"tenant,omitempty"`
	// ContextID and OpenTask continue a conversation, for example one an
	// earlier connection to the agent had.
	ContextID string     `json:"contextId,omitempty"`
	OpenTask  *taskState `json:"openTask,omitempty"`
	// Replaces is the connection this one takes over from, for example
	// after a settings change. Its webhooks move to the new connection.
	Replaces string `json:"replaces,omitempty"`
}

type connectionResponse struct {
	ID      string        `json:"id"`
	CardURL string        `json:"cardUrl,omitempty"`
	Card    *agentPayload `json:"card,omitempty"`
	// Interface is the one the connection uses. Custom is set when the card
	// doesn't list it.
	Interface           agents.Interface   `json:"interface"`
	Custom              bool               `json:"custom"`
	AvailableInterfaces []agents.Interface `json:"availableInterfaces"`
	Auth                *authView          `json:"auth,omitempty"`
	Headers             []headerView       `json:"headers"`
	Extensions          []string           `json:"extensions"`
	Tenant              string             `json:"tenant,omitempty"`
	// ContextID is the conversation the next message continues, and
	// OpenTask the task it continues.
	ContextID string     `json:"contextId,omitempty"`
	OpenTask  *taskState `json:"openTask,omitempty"`
}

// taskState is a task waiting for the user, which the next message continues.
type taskState struct {
	ID string `json:"id"`
	// State is "input-required" or "auth-required".
	State string `json:"state"`
}

// connection is an a2a-go client for one interface of an agent, with the
// auth and headers it sends.
type connection struct {
	view    connectionResponse
	cardDoc map[string]any
	client  *a2aclient.Client
	// params resolves the service parameters and the secret values among them.
	params func() (a2aclient.ServiceParams, []string, error)

	mu        sync.Mutex
	contextID string
	openTask  *taskState
	lastUsed  time.Time
	// calls counts the calls in progress, streams included.
	calls int
}

func (c *connection) response() connectionResponse {
	v := c.view
	v.ContextID, v.OpenTask = c.conversation()
	return v
}

// conversation returns the context and the open task the next message continues.
func (c *connection) conversation() (string, *taskState) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.contextID, c.openTask
}

// reset forgets the open task, and with newContext the context too.
func (c *connection) reset(newContext bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.openTask = nil
	if newContext {
		c.contextID = ""
	}
}

// observe follows the conversation through a payload the agent sent. Replies
// to the conversation's own messages (own) set its context. A task waiting
// for the user becomes the open task, if it's in the conversation's context;
// the open task closes when it moves on.
func (c *connection) observe(raw json.RawMessage, own bool) {
	ref := taskRefOf(raw)
	c.mu.Lock()
	defer c.mu.Unlock()
	if own && ref.ContextID != "" {
		c.contextID = ref.ContextID
	}
	switch {
	case ref.ID == "" || ref.State == "":
	case (ref.State == "input-required" || ref.State == "auth-required") && (own || ref.ContextID == c.contextID):
		c.openTask = &taskState{ID: ref.ID, State: ref.State}
	case c.openTask != nil && c.openTask.ID == ref.ID:
		c.openTask = nil
	}
}

// settle follows the conversation through a result, and records in the
// result what the next message continues.
func (c *connection) settle(res *agentResult, own bool) {
	if res.Payload != nil {
		c.observe(res.Payload.Raw, own)
	}
	res.ContextID, res.OpenTask = c.conversation()
}

// binding returns the canonical binding and version of the connection.
func (c *connection) binding() (string, string) {
	return c.view.Interface.ProtocolBinding, c.view.Interface.ProtocolVersion
}

// call returns the traffic.Call for a call on the connection, with the
// secrets to mask and the headers that don't follow redirects to another origin.
func (c *connection) call() (*traffic.Call, error) {
	params, secrets, err := c.params()
	if err != nil {
		return nil, err
	}
	return &traffic.Call{ConnectionID: c.view.ID, Secrets: secrets, Headers: slices.Collect(maps.Keys(params))}, nil
}

// use counts a call in progress on the connection; the returned func ends it.
func (c *connection) use() func() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	return func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.calls--
		c.lastUsed = time.Now()
	}
}

// usage reports whether the connection has a call in progress, and when it was last used.
func (c *connection) usage() (bool, time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls > 0, c.lastUsed
}

type connections struct {
	mu   sync.Mutex
	next int
	// max is how many connections to keep; 0 means no limit.
	max   int
	items map[string]*connection
}

var errTooManyConnections = errors.New("too many connections busy with calls in this session; stop a stream or remove an agent first")

// add keeps a connection and gives it an ID. At the limit, it drops the
// connection used the longest ago that has no call in progress, and returns
// it to be closed. It fails when every connection is busy.
func (cs *connections) add(c *connection) (dropped *connection, err error) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if cs.max > 0 && len(cs.items) >= cs.max {
		var oldest time.Time
		for _, other := range cs.items {
			if busy, used := other.usage(); !busy && (dropped == nil || used.Before(oldest)) {
				dropped, oldest = other, used
			}
		}
		if dropped == nil {
			return nil, errTooManyConnections
		}
		delete(cs.items, dropped.view.ID)
	}
	cs.next++
	id := "conn-" + strconv.Itoa(cs.next)
	c.view.ID = id
	c.lastUsed = time.Now()
	cs.items[id] = c
	return dropped, nil
}

func (cs *connections) get(id string) (*connection, bool) {
	cs.mu.Lock()
	c, ok := cs.items[id]
	cs.mu.Unlock()
	if ok {
		c.mu.Lock()
		c.lastUsed = time.Now()
		c.mu.Unlock()
	}
	return c, ok
}

func (cs *connections) all() []*connection {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return slices.Collect(maps.Values(cs.items))
}

func (cs *connections) remove(id string) (*connection, bool) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	c, ok := cs.items[id]
	delete(cs.items, id)
	return c, ok
}

func (cs *connections) removeAll() []*connection {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	all := slices.Collect(maps.Values(cs.items))
	clear(cs.items)
	return all
}

// paramSource is one resolved header: a fixed value, or a secret formatted
// into the value.
type paramSource struct {
	name   string
	value  string
	ref    string
	format func(secret string) string
}

// resolveParams turns the auth preset, headers, extensions and service
// parameters of a request into the connection's params function and the
// views the UI gets back.
func resolveParams(sess *session, auth *authInput, headers []headerInput, extensions []string, svcParams map[string]string) (func() (a2aclient.ServiceParams, []string, error), *authView, []headerView, error) {
	var sources []paramSource
	var av *authView
	if auth != nil {
		var err error
		var src paramSource
		src, av, err = resolveAuth(sess, auth)
		if err != nil {
			return nil, nil, nil, err
		}
		if av != nil {
			sources = append(sources, src)
		}
	}
	views := []headerView{}
	for _, h := range headers {
		name := strings.TrimSpace(h.Name)
		if !validHeaderName(name) {
			return nil, nil, nil, fmt.Errorf("%q isn't a valid header name", h.Name)
		}
		if h.Secret == nil {
			sources = append(sources, paramSource{name: name, value: h.Value})
			views = append(views, headerView{Name: name, Value: h.Value})
			continue
		}
		sv, err := sess.secrets.store(*h.Secret)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("header %s: %w", name, err)
		}
		sources = append(sources, paramSource{name: name, ref: sv.Ref})
		views = append(views, headerView{Name: name, Secret: &sv})
	}
	for _, k := range slices.Sorted(maps.Keys(svcParams)) {
		if !validHeaderName(k) {
			return nil, nil, nil, fmt.Errorf("%q isn't a valid service parameter name", k)
		}
		sources = append(sources, paramSource{name: k, value: svcParams[k]})
		views = append(views, headerView{Name: k, Value: svcParams[k]})
	}
	if exts := slices.DeleteFunc(slices.Clone(extensions), func(e string) bool { return strings.TrimSpace(e) == "" }); len(exts) > 0 {
		sources = append(sources, paramSource{name: a2a.SvcParamExtensions, value: strings.Join(exts, ", ")})
	}

	params := func() (a2aclient.ServiceParams, []string, error) {
		out := a2aclient.ServiceParams{}
		var secrets []string
		for _, src := range sources {
			value := src.value
			if src.ref != "" {
				v, err := sess.secrets.resolve(src.ref)
				if err != nil {
					return nil, nil, err
				}
				secrets = append(secrets, v)
				value = v
				if src.format != nil {
					value = src.format(v)
					secrets = append(secrets, value)
				}
			}
			out.Append(src.name, value)
		}
		return out, secrets, nil
	}
	return params, av, views, nil
}

func resolveAuth(sess *session, auth *authInput) (paramSource, *authView, error) {
	set := 0
	for _, ok := range []bool{auth.Bearer != nil, auth.Basic != nil, auth.APIKey != nil} {
		if ok {
			set++
		}
	}
	switch {
	case set == 0:
		return paramSource{}, nil, nil
	case set > 1:
		return paramSource{}, nil, errors.New(`"auth" takes one of "bearer", "basic" and "apiKey"`)
	case auth.Bearer != nil:
		sv, err := sess.secrets.store(*auth.Bearer)
		if err != nil {
			return paramSource{}, nil, fmt.Errorf("bearer token: %w", err)
		}
		return paramSource{name: "Authorization", ref: sv.Ref, format: func(v string) string { return "Bearer " + v }},
			&authView{Type: "bearer", Secret: sv}, nil
	case auth.Basic != nil:
		user := auth.Basic.Username
		if strings.Contains(user, ":") {
			return paramSource{}, nil, errors.New("a basic auth username can't contain a colon")
		}
		sv, err := sess.secrets.store(auth.Basic.Password)
		if err != nil {
			return paramSource{}, nil, fmt.Errorf("basic auth password: %w", err)
		}
		return paramSource{name: "Authorization", ref: sv.Ref, format: func(v string) string {
				return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+v))
			}},
			&authView{Type: "basic", Username: user, Secret: sv}, nil
	default:
		header := strings.TrimSpace(auth.APIKey.Header)
		if !validHeaderName(header) {
			return paramSource{}, nil, fmt.Errorf("%q isn't a valid header name for the API key", auth.APIKey.Header)
		}
		sv, err := sess.secrets.store(auth.APIKey.Key)
		if err != nil {
			return paramSource{}, nil, fmt.Errorf("API key: %w", err)
		}
		return paramSource{name: header, ref: sv.Ref}, &authView{Type: "apiKey", Header: header, Secret: sv}, nil
	}
}

// validHeaderName accepts HTTP header names that are also valid gRPC
// metadata keys once lowercased.
func validHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}

// headerParams resolves the auth preset and headers for requests the
// inspector makes outside of a connection, such as fetching a card.
func headerParams(sess *session, auth *authInput, headers []headerInput) (http.Header, []string, error) {
	params, _, _, err := resolveParams(sess, auth, headers, nil, nil)
	if err != nil {
		return nil, nil, err
	}
	resolved, secrets, err := params()
	if err != nil {
		return nil, nil, err
	}
	out := http.Header{}
	for k, vals := range resolved {
		for _, v := range vals {
			out.Add(textproto.CanonicalMIMEHeaderKey(k), v)
		}
	}
	return out, secrets, nil
}

func (s *Server) handleCreateConnection(w http.ResponseWriter, r *http.Request) {
	sess := sessionOf(r)
	var req connectionRequest
	if !decodeRequest(w, r, &req) {
		return
	}
	conn := &connection{view: connectionResponse{
		CardURL:             req.CardURL,
		AvailableInterfaces: []agents.Interface{},
		Extensions:          nonNilStrings(req.Extensions),
		Tenant:              req.Tenant,
	}}

	var defaultIface *agents.Interface
	var fetched validate.CardInput
	if len(req.Card) == 0 && req.CardURL != "" {
		headers, secrets, err := headerParams(sess, req.Auth, req.Headers)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		res, msg := fetchCard(r, sess, req.CardURL, headers, secrets)
		if msg != "" {
			writeError(w, http.StatusBadGateway, msg)
			return
		}
		req.Card = res.Body
		conn.view.CardURL = res.URL
		fetched = validate.CardInput{FetchedFrom: res.URL, ContentType: res.ContentType}
	}
	if len(req.Card) > 0 {
		payload, info := s.describeCard(req.Card, fetched, "")
		conn.view.Card = payload
		_ = json.Unmarshal(req.Card, &conn.cardDoc)
		conn.view.AvailableInterfaces = nonNil(info.Interfaces)
		if info.DefaultInterface >= 0 {
			defaultIface = &info.Interfaces[info.DefaultInterface]
		}
	}

	var iface agents.Interface
	switch {
	case req.Interface != nil:
		iface = agents.Interface{
			URL:             strings.TrimSpace(req.Interface.URL),
			ProtocolBinding: req.Interface.ProtocolBinding,
			ProtocolVersion: agents.MajorMinor(req.Interface.ProtocolVersion),
			Tenant:          req.Interface.Tenant,
		}
		if core := agents.CoreBinding(iface.ProtocolBinding); core != "" {
			iface.ProtocolBinding = core
		}
		if iface.URL == "" {
			writeError(w, http.StatusBadRequest, "The interface needs a URL.")
			return
		}
		iface.Supported = sess.dialer.Supports(iface.ProtocolBinding, iface.ProtocolVersion)
		if !iface.Supported {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("The inspector doesn't support %s %s.", iface.ProtocolBinding, iface.ProtocolVersion))
			return
		}
		iface.Source = "custom"
		for _, known := range conn.view.AvailableInterfaces {
			if known.URL == iface.URL && known.ProtocolBinding == iface.ProtocolBinding && known.ProtocolVersion == iface.ProtocolVersion {
				iface.Source = known.Source
				if iface.Tenant == "" {
					iface.Tenant = known.Tenant
				}
			}
		}
	case defaultIface != nil:
		iface = *defaultIface
	case len(req.Card) > 0:
		writeError(w, http.StatusBadRequest, "The card has no interface the inspector supports. Add a custom interface.")
		return
	default:
		writeError(w, http.StatusBadRequest, `Give "cardUrl", "card" or "interface".`)
		return
	}
	conn.view.Interface = iface
	conn.view.Custom = iface.Source == "custom"

	params, av, hv, err := resolveParams(sess, req.Auth, req.Headers, req.Extensions, req.ServiceParams)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	conn.params, conn.view.Auth, conn.view.Headers = params, av, hv

	interceptor := &agents.ParamsInterceptor{
		Params: func() (a2aclient.ServiceParams, error) {
			p, _, err := params()
			return p, err
		},
		Tenant: req.Tenant,
	}
	client, err := sess.dialer.Dial(r.Context(), iface, interceptor)
	if err != nil {
		writeError(w, http.StatusBadGateway, "Couldn't create a client for the interface: "+err.Error())
		return
	}
	conn.client = client
	conn.contextID = req.ContextID
	if req.OpenTask != nil && req.OpenTask.ID != "" {
		conn.openTask = req.OpenTask
	}
	dropped, err := sess.conns.add(conn)
	if err != nil {
		_ = client.Destroy()
		writeError(w, http.StatusTooManyRequests, capitalize(err.Error())+".")
		return
	}
	if dropped != nil {
		_ = dropped.client.Destroy()
	}
	if req.Replaces != "" {
		sess.hooks.move(req.Replaces, conn.view.ID)
	}
	writeJSON(w, http.StatusCreated, conn.response())
}

func (s *Server) connection(w http.ResponseWriter, r *http.Request) (*connection, bool) {
	c, ok := sessionOf(r).conns.get(r.PathValue("id"))
	if !ok {
		writeErrorCode(w, http.StatusNotFound, "unknownConnection", "Unknown connection. Connect to the agent again.")
	}
	return c, ok
}

func (s *Server) handleGetConnection(w http.ResponseWriter, r *http.Request) {
	if c, ok := s.connection(w, r); ok {
		writeJSON(w, http.StatusOK, c.response())
	}
}

func (s *Server) handleDeleteConnection(w http.ResponseWriter, r *http.Request) {
	c, ok := sessionOf(r).conns.remove(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "Unknown connection.")
		return
	}
	_ = c.client.Destroy()
	w.WriteHeader(http.StatusNoContent)
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
