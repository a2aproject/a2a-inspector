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

package traffic

import (
	"bytes"
	"encoding/json"
	"errors"
)

// spliceMessage replaces the message in a SendMessage request body with raw,
// leaving every other byte as it was. JSON-RPC requests carry the message in
// params.message, HTTP+JSON requests (v1.0 and v0.3) in message.
func spliceMessage(body, raw []byte) ([]byte, error) {
	start, end, ok := valueSpan(body, "params", "message")
	if !ok {
		start, end, ok = valueSpan(body, "message")
	}
	if !ok {
		return nil, errors.New("the request has no message to replace")
	}
	out := make([]byte, 0, len(body)-(end-start)+len(raw))
	out = append(out, body[:start]...)
	out = append(out, raw...)
	return append(out, body[end:]...), nil
}

// valueSpan returns the byte range of the value at path, a list of object
// keys, in the JSON document data.
func valueSpan(data []byte, path ...string) (start, end int, ok bool) {
	dec := json.NewDecoder(bytes.NewReader(data))
	for depth, key := range path {
		if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
			return 0, 0, false
		}
		found := false
		for dec.More() {
			tok, err := dec.Token()
			if err != nil {
				return 0, 0, false
			}
			if name, _ := tok.(string); name == key {
				if depth < len(path)-1 {
					found = true
					break
				}
				// The offset is right after the key; the value follows the colon.
				start = int(dec.InputOffset())
				for start < len(data) && (data[start] == ':' || isSpace(data[start])) {
					start++
				}
				var v json.RawMessage
				if err := dec.Decode(&v); err != nil {
					return 0, 0, false
				}
				return start, int(dec.InputOffset()), true
			}
			var skip json.RawMessage
			if err := dec.Decode(&skip); err != nil {
				return 0, 0, false
			}
		}
		if !found {
			return 0, 0, false
		}
	}
	return 0, 0, false
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}
