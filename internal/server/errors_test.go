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
	"testing"
)

const unauthenticatedInfo = `{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"UNAUTHENTICATED","domain":"a2a-protocol.org"}`

func TestErrorNames(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{
		// The specification's codes name the error, whatever the details say.
		{`{"code":-32001,"message":"m","data":[` + unauthenticatedInfo + `]}`, "TaskNotFoundError"},
		// Other codes, such as those for authentication, are named after the ErrorInfo reason.
		{`{"code":-31401,"message":"m","data":[{"@type":"type.googleapis.com/google.rpc.BadRequest"},` + unauthenticatedInfo + `]}`, "UnauthenticatedError"},
		// Some v0.3 agents send a single object.
		{`{"code":-31403,"message":"m","data":{"reason":"UNAUTHORIZED"}}`, "UnauthorizedError"},
		{`{"code":-31401,"message":"m"}`, ""},
		{`{"code":-31401,"message":"m","data":"not details"}`, ""},
	} {
		if got := jsonrpcError(json.RawMessage(tc.raw)).A2AError; got != tc.want {
			t.Errorf("%s: name = %q, want %q", tc.raw, got, tc.want)
		}
	}
	body := `{"error":{"code":401,"status":"UNAUTHENTICATED","message":"m","details":[` + unauthenticatedInfo + `]}}`
	if got := httpError(401, []byte(body), nil).A2AError; got != "UnauthenticatedError" {
		t.Errorf("HTTP+JSON: name = %q", got)
	}
}
