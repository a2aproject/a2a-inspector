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

package agents

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http/httptest"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"
)

func TestGRPCConnRootCAs(t *testing.T) {
	// httptest's certificate is for 127.0.0.1 and signed by no system authority.
	srvCert := httptest.NewTLSServer(nil)
	defer srvCert.Close()
	tlsCert := srvCert.TLS.Certificates[0]

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	// The address is "https://" so the dialer uses TLS even on loopback.
	s := grpc.NewServer(grpc.Creds(credentials.NewTLS(&tls.Config{Certificates: []tls.Certificate{tlsCert}})))
	go func() { _ = s.Serve(lis) }()
	defer s.Stop()
	url := "https://" + lis.Addr().String()

	pool := x509.NewCertPool()
	pool.AddCert(srvCert.Certificate())

	// An unknown method answers Unimplemented after a good handshake, and the
	// connection fails with Unavailable before it.
	code := func(d *Dialer) codes.Code {
		conn, err := d.GRPCConn(url)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = conn.Close() }()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return status.Code(conn.Invoke(ctx, "/x.Y/Z", &struct{}{}, &struct{}{}))
	}
	if got := code(&Dialer{}); got != codes.Unavailable {
		t.Errorf("without the CA: %v, want Unavailable", got)
	}
	if got := code(&Dialer{RootCAs: pool}); got == codes.Unavailable {
		t.Errorf("with the CA: %v, want the handshake to succeed", got)
	}
}
