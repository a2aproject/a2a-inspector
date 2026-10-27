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
	"encoding/base64"
	"maps"
	"net/http"
	"slices"
	"strings"

	"google.golang.org/grpc/metadata"
)

// Masked replaces secret values in recorded headers.
const Masked = "••••"

// secretHeaders are always masked, whatever their value.
var secretHeaders = map[string]bool{
	"authorization":       true,
	"proxy-authorization": true,
	"cookie":              true,
	"set-cookie":          true,
	"x-api-key":           true,
	"api-key":             true,
}

// IsSecretHeader reports whether a header is always masked.
func IsSecretHeader(name string) bool {
	return secretHeaders[strings.ToLower(name)]
}

// MaskValue masks a header value. Secret headers keep only an auth scheme
// such as "Bearer"; other values have every occurrence of a secret replaced.
func MaskValue(name, value string, secrets []string) string {
	if IsSecretHeader(name) {
		if scheme, _, ok := strings.Cut(value, " "); ok && isAuthScheme(scheme) {
			return scheme + " " + Masked
		}
		return Masked
	}
	for _, s := range secrets {
		switch {
		case s == "":
		case value == s:
			return Masked
		case len(s) >= 4:
			value = strings.ReplaceAll(value, s, Masked)
		}
	}
	return value
}

func isAuthScheme(s string) bool {
	if s == "" || len(s) > 20 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '-') {
			return false
		}
	}
	return true
}

func maskHeaders(h http.Header, secrets []string) []Header {
	out := make([]Header, 0, len(h))
	for _, name := range slices.Sorted(maps.Keys(h)) {
		for _, v := range h[name] {
			out = append(out, Header{Name: name, Value: MaskValue(name, v, secrets)})
		}
	}
	return out
}

func maskMetadata(md metadata.MD, secrets []string) []Header {
	out := make([]Header, 0, len(md))
	for _, name := range slices.Sorted(maps.Keys(md)) {
		for _, v := range md[name] {
			if strings.HasSuffix(name, "-bin") {
				v = base64.StdEncoding.EncodeToString([]byte(v))
			}
			out = append(out, Header{Name: name, Value: MaskValue(name, v, secrets)})
		}
	}
	return out
}
