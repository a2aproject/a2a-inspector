package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/a2aproject/a2a-go/v2/a2a"
)

// a2aErrors names the errors a2a-go reports, as the specification names them.
var a2aErrors = []struct {
	err  error
	name string
}{
	{a2a.ErrTaskNotFound, "TaskNotFoundError"},
	{a2a.ErrTaskNotCancelable, "TaskNotCancelableError"},
	{a2a.ErrPushNotificationNotSupported, "PushNotificationNotSupportedError"},
	{a2a.ErrUnsupportedOperation, "UnsupportedOperationError"},
	{a2a.ErrUnsupportedContentType, "ContentTypeNotSupportedError"},
	{a2a.ErrInvalidAgentResponse, "InvalidAgentResponseError"},
	{a2a.ErrExtendedCardNotConfigured, "ExtendedAgentCardNotConfiguredError"},
	{a2a.ErrExtensionSupportRequired, "ExtensionSupportRequiredError"},
	{a2a.ErrVersionNotSupported, "VersionNotSupportedError"},
	{a2a.ErrParseError, "JSONParseError"},
	{a2a.ErrInvalidRequest, "InvalidRequestError"},
	{a2a.ErrMethodNotFound, "MethodNotFoundError"},
	{a2a.ErrInvalidParams, "InvalidParamsError"},
	{a2a.ErrInternalError, "InternalError"},
	{a2a.ErrUnauthenticated, "UnauthenticatedError"},
	{a2a.ErrUnauthorized, "PermissionDeniedError"},
}

// jsonrpcErrorNames are the JSON-RPC error codes of the specification.
var jsonrpcErrorNames = map[int]string{
	-32700: "JSONParseError",
	-32600: "InvalidRequestError",
	-32601: "MethodNotFoundError",
	-32602: "InvalidParamsError",
	-32603: "InternalError",
	-32001: "TaskNotFoundError",
	-32002: "TaskNotCancelableError",
	-32003: "PushNotificationNotSupportedError",
	-32004: "UnsupportedOperationError",
	-32005: "ContentTypeNotSupportedError",
	-32006: "InvalidAgentResponseError",
	-32007: "ExtendedAgentCardNotConfiguredError",
	-32008: "ExtensionSupportRequiredError",
	-32009: "VersionNotSupportedError",
}

func a2aErrorName(err error) string {
	if err == nil {
		return ""
	}
	for _, e := range a2aErrors {
		if errors.Is(err, e.err) {
			return e.name
		}
	}
	return ""
}

// errorFrom describes an error a2a-go returned when there's no recorded
// response to describe instead.
func errorFrom(err error) *callError {
	return &callError{A2AError: a2aErrorName(err), Message: err.Error()}
}

// jsonrpcError describes the error object of a JSON-RPC response.
func jsonrpcError(raw json.RawMessage) *callError {
	var e struct {
		Code    *int            `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	var decoded any
	_ = json.Unmarshal(raw, &decoded)
	ce := &callError{Raw: decoded, rejected: true}
	if err := json.Unmarshal(raw, &e); err != nil || e.Code == nil {
		ce.Message = "The agent sent a malformed JSON-RPC error."
		return ce
	}
	ce.Code = *e.Code
	ce.A2AError = jsonrpcErrorNames[*e.Code]
	if ce.A2AError == "" {
		// Errors without a code of their own, such as authentication
		// errors, can still name themselves with an ErrorInfo reason.
		ce.A2AError = detailsReason(e.Data)
	}
	ce.Message = e.Message
	if ce.Message == "" {
		ce.Message = fmt.Sprintf("JSON-RPC error %d.", *e.Code)
	}
	return ce
}

// httpError describes an HTTP error response, or an error event of an
// HTTP+JSON stream when status is 0. A2A's HTTP+JSON binding sends errors as
// {"error": {"code", "status", "message", "details"}}.
func httpError(status int, body []byte, err error) *callError {
	ce := &callError{Code: status, A2AError: a2aErrorName(err), rejected: true}
	var decoded any
	if json.Unmarshal(body, &decoded) == nil {
		ce.Raw = decoded
	} else if len(body) > 0 {
		ce.Raw = excerpt(body)
	}
	var e struct {
		Error struct {
			Message string          `json:"message"`
			Details json.RawMessage `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil {
		ce.Message = e.Error.Message
		if ce.A2AError == "" {
			ce.A2AError = detailsReason(e.Error.Details)
		}
	}
	if ce.Message == "" && status != 0 {
		ce.Message = fmt.Sprintf("The agent answered %d %s.", status, http.StatusText(status))
	}
	return ce
}

type errorDetail struct {
	Reason string `json:"reason"`
}

// detailsReason names an error after the first ErrorInfo reason in its
// details: a list, or a single object as some v0.3 agents send.
func detailsReason(raw json.RawMessage) string {
	var details []errorDetail
	if json.Unmarshal(raw, &details) != nil {
		var one errorDetail
		if json.Unmarshal(raw, &one) != nil {
			return ""
		}
		details = []errorDetail{one}
	}
	for _, d := range details {
		if d.Reason != "" {
			return reasonName(d.Reason)
		}
	}
	return ""
}

// reasonName turns an ErrorInfo reason such as "TASK_NOT_FOUND" into
// "TaskNotFoundError".
func reasonName(reason string) string {
	var b strings.Builder
	for _, word := range strings.Split(strings.ToLower(reason), "_") {
		if word != "" {
			b.WriteString(strings.ToUpper(word[:1]) + word[1:])
		}
	}
	name := b.String()
	if !strings.HasSuffix(name, "Error") {
		name += "Error"
	}
	return name
}
