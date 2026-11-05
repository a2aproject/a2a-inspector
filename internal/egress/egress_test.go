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

package egress

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
)

func TestClassify(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "::1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "fe80::1",
		"fd00:ec2::254", "100.100.100.200", "0.0.0.0", "::", "224.0.0.1", "ff02::1", "255.255.255.255",
		"192.0.0.170", "198.18.0.1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1",
		"2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "fec0::1", "::10.0.0.1",
	}
	for _, s := range blocked {
		if Classify(netip.MustParseAddr(s)) == "" {
			t.Errorf("Classify(%s) = public, want blocked", s)
		}
	}
	public := []string{"9.9.9.9", "1.1.1.1", "2606:4700:4700::1111", "::ffff:9.9.9.9", "64:ff9b::909:909", "2002:909:909::1"}
	for _, s := range public {
		if r := Classify(netip.MustParseAddr(s)); r != "" {
			t.Errorf("Classify(%s) = %q, want public", s, r)
		}
	}
	if r := Classify(netip.MustParseAddr("169.254.169.254")); !strings.Contains(r, "metadata") {
		t.Errorf("Classify(metadata) = %q", r)
	}
}

func TestNewAllowList(t *testing.T) {
	p, err := New([]string{"10.0.0.0/8", "192.168.1.5", "Agents.Internal.", "*.lab.example"})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"10.9.9.9", "192.168.1.5", "::ffff:10.0.0.1"} {
		if !p.addrAllowed(netip.MustParseAddr(s)) {
			t.Errorf("addrAllowed(%s) = false", s)
		}
	}
	if p.addrAllowed(netip.MustParseAddr("192.168.1.6")) {
		t.Error("addrAllowed(192.168.1.6) = true")
	}
	for host, want := range map[string]bool{
		"agents.internal": true, "AGENTS.internal.": true, "x.agents.internal": false,
		"a.lab.example": true, "a.b.lab.example": true, "lab.example": false, "evillab.example": false,
	} {
		if got := p.hostAllowed(host); got != want {
			t.Errorf("hostAllowed(%q) = %v, want %v", host, got, want)
		}
	}
	for _, bad := range []string{"http://x", "a b", "*.", "a..b", ""} {
		if _, err := New([]string{bad}); err == nil {
			t.Errorf("New(%q) succeeded", bad)
		}
	}
}

// testPolicy returns a policy whose names resolve through hosts.
func testPolicy(t *testing.T, allow []string, hosts map[string][]string) *Policy {
	t.Helper()
	p, err := New(allow)
	if err != nil {
		t.Fatal(err)
	}
	p.lookup = func(_ context.Context, host string) ([]netip.Addr, error) {
		var out []netip.Addr
		for _, s := range hosts[host] {
			out = append(out, netip.MustParseAddr(s))
		}
		if len(out) == 0 {
			return nil, errors.New("no such host")
		}
		return out, nil
	}
	p.proxyFunc = func(*url.URL) (*url.URL, error) { return nil, nil }
	return p
}

func TestResolve(t *testing.T) {
	var reported []string
	p := testPolicy(t, []string{"allowed.test"}, map[string][]string{
		"rebind.test":  {"10.0.0.7"},
		"mixed.test":   {"10.0.0.7", "9.9.9.9"},
		"allowed.test": {"10.0.0.8"},
	})
	p.OnBlock = func(host string, _ error) { reported = append(reported, host) }

	_, err := p.Resolve(context.Background(), "rebind.test")
	var be *BlockedError
	if !errors.As(err, &be) || be.Addr.String() != "10.0.0.7" || !strings.Contains(err.Error(), "rebind.test resolves to 10.0.0.7, a private address") {
		t.Errorf("Resolve(rebind.test) error = %v", err)
	}
	if addrs, err := p.Resolve(context.Background(), "mixed.test"); err != nil || len(addrs) != 1 || addrs[0].String() != "9.9.9.9" {
		t.Errorf("Resolve(mixed.test) = %v, %v; want only the public address", addrs, err)
	}
	if addrs, err := p.Resolve(context.Background(), "allowed.test"); err != nil || len(addrs) != 1 {
		t.Errorf("Resolve(allowed.test) = %v, %v", addrs, err)
	}
	if _, err := p.Resolve(context.Background(), "[::1]"); err == nil || !strings.Contains(err.Error(), "::1 is a loopback address") {
		t.Errorf("Resolve([::1]) error = %v", err)
	}
	if strings.Join(reported, ",") != "rebind.test,::1" {
		t.Errorf("reported %v", reported)
	}
}

func TestTransportBlocksPrivateAddressesAndRedirects(t *testing.T) {
	var hits int
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.URL.Path == "/redirect" {
			// Leaves the allowed name for the address itself.
			http.Redirect(w, r, "http://"+r.Host+"/private", http.StatusFound)
			return
		}
		_, _ = io.WriteString(w, "ok")
	}))
	defer target.Close()
	_, port, _ := net.SplitHostPort(target.Listener.Addr().String())
	p := testPolicy(t, []string{"agent.test"}, map[string][]string{"agent.test": {"127.0.0.1"}, "rebind.test": {"127.0.0.1"}})
	client := &http.Client{Transport: p.Transport()}

	if resp, err := client.Get("http://agent.test:" + port + "/"); err != nil {
		t.Fatalf("allowed host: %v", err)
	} else {
		_ = resp.Body.Close()
	}
	for _, u := range []string{target.URL + "/", "http://rebind.test:" + port + "/", "http://169.254.169.254/"} {
		if _, err := client.Get(u); err == nil || !strings.Contains(err.Error(), "egress policy") {
			t.Errorf("GET %s error = %v, want blocked", u, err)
		}
	}
	before := hits
	redirect, _ := http.NewRequest(http.MethodGet, "http://agent.test:"+port+"/redirect", nil)
	redirect.Host = "127.0.0.1:" + port
	if _, err := client.Do(redirect); err == nil || !strings.Contains(err.Error(), "egress policy") {
		t.Errorf("redirect to a private address: error = %v, want blocked", err)
	}
	if hits != before+1 {
		t.Errorf("the target got %d requests, want only the one that redirected", hits-before)
	}
}

// connectProxy is an HTTP proxy that only tunnels with CONNECT, and records the targets.
func connectProxy(t *testing.T) (addr string, targets chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	targets = make(chan string, 10)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				br := bufio.NewReader(conn)
				req, err := http.ReadRequest(br)
				if err != nil || req.Method != http.MethodConnect {
					return
				}
				targets <- req.Host + " " + req.Header.Get("Proxy-Authorization")
				// Names ending in .test stand for the loopback address.
				host, port, _ := net.SplitHostPort(req.Host)
				if strings.HasSuffix(host, ".test") {
					host = "127.0.0.1"
				}
				upstream, err := net.Dial("tcp", net.JoinHostPort(host, port))
				if err != nil {
					_, _ = io.WriteString(conn, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
					return
				}
				defer func() { _ = upstream.Close() }()
				_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\n")
				go func() { _, _ = io.Copy(upstream, br) }()
				_, _ = io.Copy(conn, upstream)
			}()
		}
	}()
	return ln.Addr().String(), targets
}

func TestDialGRPCThroughProxy(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = echo.Close() }()
	go func() {
		conn, err := echo.Accept()
		if err == nil {
			_, _ = io.WriteString(conn, "hello")
			_ = conn.Close()
		}
	}()
	_, port, _ := net.SplitHostPort(echo.Addr().String())
	proxy, targets := connectProxy(t)
	p := testPolicy(t, []string{"agent.test"}, map[string][]string{"agent.test": {"127.0.0.1"}})
	p.proxyFunc = func(*url.URL) (*url.URL, error) {
		return &url.URL{Scheme: "http", Host: proxy, User: url.UserPassword("u", "p")}, nil
	}

	conn, err := p.DialGRPC(context.Background(), "127.0.0.1:"+port)
	if err == nil {
		_ = conn.Close()
		t.Fatal("DialGRPC to a loopback address through the proxy succeeded")
	}
	conn, err = p.DialGRPC(context.Background(), net.JoinHostPort("agent.test", port))
	if err != nil {
		t.Fatalf("DialGRPC(agent.test): %v", err)
	}
	defer func() { _ = conn.Close() }()
	if got := <-targets; got != "agent.test:"+port+" Basic dTpw" {
		t.Errorf("CONNECT = %q", got)
	}
	if b, err := io.ReadAll(conn); err != nil || string(b) != "hello" {
		t.Errorf("read through the tunnel: %q, %v", b, err)
	}
}

func TestDialGRPCDirect(t *testing.T) {
	p := testPolicy(t, nil, map[string][]string{"meta.test": {"169.254.169.254"}})
	for _, addr := range []string{"10.0.0.1:443", "meta.test:443", "[::1]:50051"} {
		if _, err := p.DialGRPC(context.Background(), addr); err == nil || !strings.Contains(err.Error(), "egress policy") {
			t.Errorf("DialGRPC(%s) error = %v, want blocked", addr, err)
		}
	}
}

func TestGRPCTarget(t *testing.T) {
	good := map[string]string{
		"agent.example.com:443": "passthrough:///agent.example.com:443",
		"agent.example.com":     "passthrough:///agent.example.com:443",
		"[2001:db8::1]:50051":   "passthrough:///[2001:db8::1]:50051",
	}
	for in, want := range good {
		if got, err := GRPCTarget(in); err != nil || got != want {
			t.Errorf("GRPCTarget(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"unix:///var/run/agent.sock", "unix:agent.sock", "unix-abstract:x", "dns:///agent:443", "passthrough:///10.0.0.1:443", "xds:///agent", "agent:0", "agent:http", ":443"} {
		if got, err := GRPCTarget(bad); err == nil {
			t.Errorf("GRPCTarget(%q) = %q, want an error", bad, got)
		}
	}
}

func TestDirectRequestToProxyIsChecked(t *testing.T) {
	p := testPolicy(t, []string{"agent.test"}, map[string][]string{"agent.test": {"127.0.0.1"}})
	proxy := &url.URL{Scheme: "http", Host: "127.0.0.1:3128"}
	p.proxyFunc = func(u *url.URL) (*url.URL, error) {
		if u.Hostname() == "agent.test" {
			return proxy, nil
		}
		return nil, nil // as NO_PROXY does for loopback addresses
	}
	ctx := context.Background()
	if got, err := p.proxy(ctx, &url.URL{Scheme: "http", Host: "agent.test"}); err != nil || got != proxy {
		t.Fatalf("proxy(agent.test) = %v, %v", got, err)
	}
	if _, err := p.proxy(ctx, &url.URL{Scheme: "http", Host: "127.0.0.1:3128"}); err == nil || !strings.Contains(err.Error(), "egress policy") {
		t.Errorf("direct request to the proxy's address: error = %v, want blocked", err)
	}
	if _, err := p.DialGRPC(ctx, "127.0.0.1:3128"); err == nil || !strings.Contains(err.Error(), "egress policy") {
		t.Errorf("direct gRPC dial to the proxy's address: error = %v, want blocked", err)
	}
}
