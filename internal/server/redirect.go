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
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/a2aproject/a2a-inspector/internal/traffic"
)

// checkRedirect follows redirects as Go's client does by default, except
// that the headers the user configured, which Go would copy to any host,
// don't go to another origin, and a call with credentials isn't sent on
// from https to plain http.
func checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	// Go copies the headers of the first request to every redirect.
	first := via[0].URL
	if sameOriginURL(req.URL, first) {
		return nil
	}
	call := traffic.CallFrom(req.Context())
	if first.Scheme == "https" && req.URL.Scheme == "http" && len(call.Secrets) > 0 {
		return fmt.Errorf("refused to follow a redirect from https to %s with credentials", req.URL.Redacted())
	}
	for _, name := range call.Headers {
		req.Header.Del(name)
	}
	return nil
}

func sameOriginURL(a, b *url.URL) bool {
	return strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(hostPort(a), hostPort(b))
}

// hostPort returns the host and port of an http(s) URL, with the scheme's
// default port when it has none.
func hostPort(u *url.URL) string {
	if u.Port() != "" {
		return u.Host
	}
	if strings.EqualFold(u.Scheme, "https") {
		return u.Hostname() + ":443"
	}
	return u.Hostname() + ":80"
}
