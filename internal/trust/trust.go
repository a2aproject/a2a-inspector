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

// Package trust builds the set of certificate authorities the inspector
// trusts when it connects to agents, for agents behind a company's own CA or
// a self-signed certificate.
package trust

import (
	"crypto/x509"
	"fmt"
	"os"
)

// Pool returns the system's certificate authorities plus the ones in the PEM
// files. Extra authorities are added to the system's, never replace them, so
// agents with public certificates keep working. It returns nil, meaning the
// system's authorities, when there are no files.
func Pool(files ...string) (*x509.CertPool, error) {
	if len(files) == 0 {
		return nil, nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		// Some platforms have no system pool to copy; start empty.
		pool = x509.NewCertPool()
	}
	for _, name := range files {
		pem, err := os.ReadFile(name)
		if err != nil {
			return nil, err
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("%s has no PEM certificates", name)
		}
	}
	return pool, nil
}
