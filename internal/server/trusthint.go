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
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
)

// trustHint adds to the error of a connection whose certificate no trusted
// authority signed how to trust it, for agents with a company CA or a
// self-signed certificate. It applies to HTTP; gRPC errors are left as they are.
type trustHint struct{ base http.RoundTripper }

func (t trustHint) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	var unknown x509.UnknownAuthorityError
	if errors.As(err, &unknown) {
		err = fmt.Errorf("%w (the inspector doesn't trust this certificate's authority; to trust a company CA or a self-signed certificate, start the inspector with --ca-file or the A2A_INSPECTOR_CA_FILE environment variable)", err)
	}
	return resp, err
}
