package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
	"github.com/a2aproject/a2a-inspector/internal/validate"
)

// maxRequestSize bounds API request bodies, which can carry a card or a
// message with attachments.
const maxRequestSize = 32 << 20

// cardTimeout bounds fetching a card.
const cardTimeout = 30 * time.Second

// agentPayload is anything an agent sent, exactly as received, with its validation.
type agentPayload struct {
	// ProtocolVersion is "1.0" or "0.3" and tells the UI which shape Raw has.
	ProtocolVersion string          `json:"protocolVersion"`
	Raw             json.RawMessage `json:"raw"`
	Validation      validate.Report `json:"validation"`
}

// call describes the request to the agent behind an API response.
type call struct {
	// TrafficEntryID is the exchange on the wire, in the traffic log.
	TrafficEntryID string `json:"trafficEntryId,omitempty"`
	LatencyMs      int64  `json:"latencyMs"`
	// Error is set when the agent or the network failed. The API call itself
	// still succeeds, so the UI can show the failure.
	Error *callError `json:"error"`
	// Findings are about the call rather than the payload, such as an
	// operation the card doesn't declare.
	Findings []validate.Finding `json:"findings,omitempty"`
}

type callError struct {
	// A2AError is the error's name in the specification, when it's an A2A error.
	A2AError string `json:"a2aError,omitempty"`
	Message  string `json:"message"`
	// Code is the JSON-RPC error code, the HTTP status or the gRPC status
	// code, depending on the binding.
	Code int `json:"code,omitempty"`
	// Raw is the error as the agent sent it, or the start of the response body.
	Raw any `json:"raw,omitempty"`
}

type features struct {
	Serve    bool `json:"serve"`
	Webhooks bool `json:"webhooks"`
}

type configResponse struct {
	Mode string `json:"mode"`
	// AgentCardURL is the agent given with --agent-card, which the UI opens on start.
	AgentCardURL string `json:"agentCardUrl,omitempty"`
	// Startup is how to connect to the agent opened on start.
	Startup  *startupConfig `json:"startup,omitempty"`
	Features features       `json:"features"`
	// Bindings lists the protocol bindings the inspector supports.
	Bindings []string `json:"bindings"`
}

// startupConfig is the agent given on the command line.
type startupConfig struct {
	AgentCardURL string `json:"agentCardUrl,omitempty"`
	// Endpoint is the interface given with --endpoint, --transport and --a2a-version.
	Endpoint *agents.Interface `json:"endpoint,omitempty"`
	// Preferences pick the card interface to use, from --transport and --a2a-version.
	Preferences *Preferences `json:"preferences,omitempty"`
	// Headers come from --auth and --svc-param. Secret values are stored in
	// the backend and referred to by ref.
	Headers []headerView `json:"headers"`
}

func (s *Server) newStartupConfig() (*startupConfig, error) {
	o := s.opts
	if o.AgentCardURL == "" && o.Endpoint == nil && len(o.StartupHeaders) == 0 {
		return nil, nil
	}
	cfg := &startupConfig{AgentCardURL: o.AgentCardURL, Endpoint: o.Endpoint, Headers: []headerView{}}
	if len(o.Preferences.Bindings) > 0 || o.Preferences.Version != "" {
		cfg.Preferences = &o.Preferences
	}
	for _, h := range o.StartupHeaders {
		if !h.Secret {
			cfg.Headers = append(cfg.Headers, headerView{Name: h.Name, Value: h.Value})
			continue
		}
		value := h.Value
		sv, err := s.secrets.store(secretInput{Value: &value})
		if err != nil {
			return nil, err
		}
		cfg.Headers = append(cfg.Headers, headerView{Name: h.Name, Secret: &sv})
	}
	return cfg, nil
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	bindings := []string{agents.BindingJSONRPC, agents.BindingHTTPJSON, agents.BindingGRPC}
	for _, t := range s.opts.Transports {
		if !slices.Contains(bindings, t.Binding) {
			bindings = append(bindings, t.Binding)
		}
	}
	writeJSON(w, http.StatusOK, configResponse{Mode: "local", AgentCardURL: s.opts.AgentCardURL, Startup: s.startup, Bindings: bindings})
}

type cardResolveRequest struct {
	URL string `json:"url"`
	// Auth and Headers are sent with the card request, for agents that
	// protect their card.
	Auth    *authInput    `json:"auth,omitempty"`
	Headers []headerInput `json:"headers,omitempty"`
}

type cardResolveResponse struct {
	// CardURL is the URL the card was fetched from, after redirects.
	CardURL string        `json:"cardUrl"`
	Payload *agentPayload `json:"payload,omitempty"`
	// Versions lists the card formats present; see agents.CardInfo.
	Versions   []string           `json:"versions,omitempty"`
	Interfaces []agents.Interface `json:"interfaces"`
	// DefaultInterface is the index of the interface used unless the user
	// picks another, or null when the inspector supports none of them.
	DefaultInterface *int `json:"defaultInterface"`
	Call             call `json:"call"`
}

func (s *Server) handleCardResolve(w http.ResponseWriter, r *http.Request) {
	var req cardResolveRequest
	if !decodeRequest(w, r, &req) {
		return
	}
	cardURL, err := agents.NormalizeCardURL(req.URL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	headers, secrets, err := s.headerParams(req.Auth, req.Headers)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	resp := cardResolveResponse{CardURL: cardURL, Interfaces: []agents.Interface{}}
	tc := &traffic.Call{Secrets: secrets}
	ctx, cancel := context.WithTimeout(r.Context(), cardTimeout)
	defer cancel()
	res, err := agents.FetchCard(traffic.WithCall(ctx, tc), s.client, cardURL, headers)
	resp.Call.TrafficEntryID = tc.LastEntryID()
	if err != nil {
		resp.Call.Error = &callError{Message: err.Error()}
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.CardURL = res.URL
	resp.Call.LatencyMs = res.Latency.Milliseconds()
	switch {
	case res.StatusCode != http.StatusOK:
		resp.Call.Error = &callError{Message: "The agent answered " + res.Status + ".", Code: res.StatusCode, Raw: excerpt(res.Body)}
	case res.TooLarge:
		resp.Call.Error = &callError{Message: fmt.Sprintf("The card is larger than %d MiB.", agents.MaxCardSize>>20)}
	case !json.Valid(res.Body):
		resp.Call.Error = &callError{Message: "The response isn't valid JSON.", Raw: excerpt(res.Body)}
	default:
		payload, info := s.describeCard(res.Body, validate.CardInput{FetchedFrom: res.URL, ContentType: res.ContentType}, "")
		resp.Payload = payload
		resp.Versions = info.Versions
		resp.Interfaces = nonNil(info.Interfaces)
		resp.DefaultInterface = defaultIndex(info)
	}
	writeJSON(w, http.StatusOK, resp)
}

type cardValidateRequest struct {
	Card json.RawMessage `json:"card"`
	// ProtocolVersion, if set, overrides the detected card format.
	ProtocolVersion string `json:"protocolVersion,omitempty"`
}

type cardValidateResponse struct {
	ProtocolVersion  string             `json:"protocolVersion"`
	Versions         []string           `json:"versions"`
	Validation       validate.Report    `json:"validation"`
	Interfaces       []agents.Interface `json:"interfaces"`
	DefaultInterface *int               `json:"defaultInterface"`
}

func (s *Server) handleCardValidate(w http.ResponseWriter, r *http.Request) {
	var req cardValidateRequest
	if !decodeRequest(w, r, &req) {
		return
	}
	if len(req.Card) == 0 || string(req.Card) == "null" {
		writeError(w, http.StatusBadRequest, `"card" is required.`)
		return
	}
	switch req.ProtocolVersion {
	case "", agents.Version10, agents.Version03:
	default:
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Unsupported protocolVersion %q; use %q or %q.", req.ProtocolVersion, agents.Version10, agents.Version03))
		return
	}
	payload, info := s.describeCard(req.Card, validate.CardInput{}, req.ProtocolVersion)
	writeJSON(w, http.StatusOK, cardValidateResponse{
		ProtocolVersion:  payload.ProtocolVersion,
		Versions:         info.Versions,
		Validation:       payload.Validation,
		Interfaces:       nonNil(info.Interfaces),
		DefaultInterface: defaultIndex(info),
	})
}

// fetchCard fetches a card for a connection, or returns why it couldn't.
func (s *Server) fetchCard(r *http.Request, cardURL string, headers http.Header, secrets []string) (*agents.CardResponse, string) {
	ctx, cancel := context.WithTimeout(r.Context(), cardTimeout)
	defer cancel()
	res, err := agents.FetchCard(traffic.WithCall(ctx, &traffic.Call{Secrets: secrets}), s.client, cardURL, headers)
	switch {
	case err != nil:
		return nil, "Couldn't fetch the card: " + err.Error()
	case res.StatusCode != http.StatusOK:
		return nil, "Couldn't fetch the card: the agent answered " + res.Status + "."
	case res.TooLarge || !json.Valid(res.Body):
		return nil, "Couldn't fetch the card: the response isn't a JSON card."
	}
	return res, ""
}

// describeCard detects the card's format, unless version forces one, and validates it.
func (s *Server) describeCard(raw []byte, in validate.CardInput, version string) (*agentPayload, agents.CardInfo) {
	var card map[string]any
	_ = json.Unmarshal(raw, &card) // A card that isn't an object is reported by validate.Card.
	info := agents.DescribeCard(card, s.dialer.Supports)
	if version != "" {
		info.ProtocolVersion, info.Versions, info.VersionDetected = version, []string{version}, true
	}
	in.Info = info
	return &agentPayload{ProtocolVersion: info.ProtocolVersion, Raw: raw, Validation: validate.Card(raw, in)}, info
}

func defaultIndex(info agents.CardInfo) *int {
	if info.DefaultInterface < 0 {
		return nil
	}
	i := info.DefaultInterface
	return &i
}

func nonNil(list []agents.Interface) []agents.Interface {
	if list == nil {
		return []agents.Interface{}
	}
	return list
}

// excerpt returns the start of a response body for error details.
func excerpt(body []byte) string {
	const limit = 2048
	if len(body) > limit {
		body = body[:limit]
	}
	return strings.ToValidUTF8(string(body), "")
}

// decodeRequest reads a JSON request body into v, or writes an error response.
func decodeRequest(w http.ResponseWriter, r *http.Request, v any) bool {
	// Requiring a JSON content type also keeps plain HTML forms out.
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "The request body must be application/json.")
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestSize))
	if err := dec.Decode(v); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "The request body is too large.")
		} else {
			writeError(w, http.StatusBadRequest, "Invalid request body: "+err.Error())
		}
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type errorResponse struct {
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

func writeError(w http.ResponseWriter, status int, message string) {
	var resp errorResponse
	resp.Error.Message = message
	writeJSON(w, status, resp)
}
