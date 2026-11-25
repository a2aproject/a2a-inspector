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

package trust

import (
	"crypto/tls"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// serverCA starts a TLS server whose certificate no system authority signed,
// and returns it with a PEM file that trusts it.
func serverCA(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(srv.Close)
	file := filepath.Join(t.TempDir(), "ca.pem")
	data := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	if err := os.WriteFile(file, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return srv, file
}

func get(url string, cfg *tls.Config) error {
	c := &http.Client{Transport: &http.Transport{TLSClientConfig: cfg}}
	resp, err := c.Get(url)
	if err == nil {
		_ = resp.Body.Close()
	}
	return err
}

func TestPool(t *testing.T) {
	srv, file := serverCA(t)

	if err := get(srv.URL, nil); err == nil {
		t.Fatal("a self-signed server is trusted without its CA")
	}
	pool, err := Pool(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := get(srv.URL, &tls.Config{RootCAs: pool}); err != nil {
		t.Fatalf("with the CA: %v", err)
	}
}

func TestPoolNoFiles(t *testing.T) {
	if pool, err := Pool(); pool != nil || err != nil {
		t.Fatalf("Pool() = %v, %v; want the system's authorities (nil)", pool, err)
	}
}

func TestPoolErrors(t *testing.T) {
	notPEM := filepath.Join(t.TempDir(), "x.pem")
	if err := os.WriteFile(notPEM, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{filepath.Join(t.TempDir(), "missing.pem"), notPEM} {
		if _, err := Pool(name); err == nil {
			t.Errorf("Pool(%q) succeeded", name)
		}
	}
}
