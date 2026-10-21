package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"strings"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/validate"
)

// maxRequestSize bounds API request bodies; card:validate carries a whole card.
const maxRequestSize = agents.MaxCardSize + 1<<20

// agentPayload is anything an agent sent, exactly as received, with its validation.
type agentPayload struct {
	// ProtocolVersion is "1.0" or "0.3" and tells the UI which shape Raw has.
	ProtocolVersion string          `json:"protocolVersion"`
	Raw             json.RawMessage `json:"raw"`
	Validation      validate.Report `json:"validation"`
}

// call describes the request to the agent behind an API response.
type call struct {
	LatencyMs int64 `json:"latencyMs"`
	// Error is set when the agent or the network failed. The API call itself
	// still succeeds, so the UI can show the failure.
	Error *callError `json:"error"`
}

type callError struct {
	Message string `json:"message"`
	// Code is the HTTP status, when there was a response.
	Code int `json:"code,omitempty"`
	// Raw is the start of the response body, when there was one.
	Raw any `json:"raw,omitempty"`
}

type features struct {
	Serve    bool `json:"serve"`
	Webhooks bool `json:"webhooks"`
}

type configResponse struct {
	Mode string `json:"mode"`
	// AgentCardURL is the agent given with --agent-card, which the UI opens on start.
	AgentCardURL string   `json:"agentCardUrl,omitempty"`
	Features     features `json:"features"`
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, configResponse{Mode: "local", AgentCardURL: s.opts.AgentCardURL})
}

type cardResolveRequest struct {
	URL string `json:"url"`
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

	resp := cardResolveResponse{CardURL: cardURL, Interfaces: []agents.Interface{}}
	res, err := agents.FetchCard(r.Context(), s.client, cardURL)
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
		payload, info := describeCard(res.Body, validate.CardInput{FetchedFrom: res.URL, ContentType: res.ContentType}, "")
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
	payload, info := describeCard(req.Card, validate.CardInput{}, req.ProtocolVersion)
	writeJSON(w, http.StatusOK, cardValidateResponse{
		ProtocolVersion:  payload.ProtocolVersion,
		Versions:         info.Versions,
		Validation:       payload.Validation,
		Interfaces:       nonNil(info.Interfaces),
		DefaultInterface: defaultIndex(info),
	})
}

// describeCard detects the card's format, unless version forces one, and validates it.
func describeCard(raw []byte, in validate.CardInput, version string) (*agentPayload, agents.CardInfo) {
	var card map[string]any
	_ = json.Unmarshal(raw, &card) // A card that isn't an object is reported by validate.Card.
	info := agents.DescribeCard(card)
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
