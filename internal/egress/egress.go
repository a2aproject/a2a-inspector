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

// Package egress keeps a shared inspector from reaching the network it runs
// in: loopback, private, link-local (cloud metadata servers) and other
// non-public addresses. The check runs on the addresses actually dialed, so
// DNS rebinding and redirects can't get around it. Through a proxy, the
// destination is checked before the request goes out, but the proxy resolves
// it again, so the proxy has to apply its own rules too.
package egress

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http/httpproxy"
)

// Policy decides which addresses the inspector may connect to: public ones,
// and the ones its allow list names.
type Policy struct {
	allowNets  []netip.Prefix
	allowHosts []string
	// OnBlock, if set, is called with every destination the policy blocks.
	OnBlock func(host string, err error)

	lookup    func(ctx context.Context, host string) ([]netip.Addr, error)
	proxyFunc func(*url.URL) (*url.URL, error)
	dialer    *net.Dialer
	// proxies holds the proxy addresses requests were sent through. The
	// policy dials them without checks: they come from the environment, and
	// the destination behind them was checked already.
	proxies sync.Map
}

// New returns a policy that blocks non-public addresses except the allowed
// ones: CIDR blocks, IP addresses, host names, and "*.example.com" for every
// subdomain of example.com. Proxies come from HTTP_PROXY, HTTPS_PROXY and
// NO_PROXY, as for Go's default HTTP transport.
func New(allow []string) (*Policy, error) {
	p := &Policy{
		lookup: func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		},
		proxyFunc: httpproxy.FromEnvironment().ProxyFunc(),
		dialer:    &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second},
	}
	for _, a := range allow {
		a = strings.TrimSpace(a)
		if prefix, err := netip.ParsePrefix(a); err == nil {
			p.allowNets = append(p.allowNets, prefix.Masked())
			continue
		}
		if ip, err := netip.ParseAddr(a); err == nil {
			p.allowNets = append(p.allowNets, netip.PrefixFrom(ip.Unmap(), ip.Unmap().BitLen()))
			continue
		}
		name := strings.TrimSuffix(strings.ToLower(a), ".")
		if rest, ok := strings.CutPrefix(name, "*."); ok {
			name = "." + rest
		}
		if !validHostName(strings.TrimPrefix(name, ".")) {
			return nil, fmt.Errorf("egress allow list: %q isn't a CIDR block, an IP address or a host name", a)
		}
		p.allowHosts = append(p.allowHosts, name)
	}
	return p, nil
}

func validHostName(name string) bool {
	if name == "" || len(name) > 253 {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '.') {
			return false
		}
	}
	return !strings.Contains(name, "..")
}

// BlockedError is the error for a destination the policy doesn't allow.
type BlockedError struct {
	Host   string
	Addr   netip.Addr
	Reason string
}

func (e *BlockedError) Error() string {
	if e.Host == e.Addr.String() {
		return fmt.Sprintf("blocked by the inspector's egress policy: %s is %s", e.Host, e.Reason)
	}
	return fmt.Sprintf("blocked by the inspector's egress policy: %s resolves to %s, %s", e.Host, e.Addr, e.Reason)
}

func (p *Policy) hostAllowed(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	for _, h := range p.allowHosts {
		if host == h || (strings.HasPrefix(h, ".") && strings.HasSuffix(host, h)) {
			return true
		}
	}
	return false
}

func (p *Policy) addrAllowed(ip netip.Addr) bool {
	ip = ip.Unmap()
	for _, n := range p.allowNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// Resolve returns the addresses of host the policy allows, or a
// *BlockedError when it allows none of them.
func (p *Policy) Resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	var addrs []netip.Addr
	if ip, err := netip.ParseAddr(host); err == nil {
		addrs = []netip.Addr{ip.Unmap()}
	} else {
		if addrs, err = p.lookup(ctx, host); err != nil {
			return nil, err
		}
	}
	if p.hostAllowed(host) {
		return addrs, nil
	}
	var allowed []netip.Addr
	var blocked error
	for _, ip := range addrs {
		if reason := Classify(ip); reason != "" && !p.addrAllowed(ip) {
			blocked = &BlockedError{Host: host, Addr: ip.Unmap(), Reason: reason}
			continue
		}
		allowed = append(allowed, ip)
	}
	if len(allowed) == 0 {
		if blocked == nil {
			blocked = fmt.Errorf("no addresses for %s", host)
		} else if p.OnBlock != nil {
			p.OnBlock(host, blocked)
		}
		return nil, blocked
	}
	return allowed, nil
}

// DialContext dials addr, a host and port, on one of the host's addresses
// the policy allows. Proxies that requests went through are dialed as they
// are; Transport checks direct requests to a proxy's address beforehand.
func (p *Policy) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if _, ok := p.proxies.Load(addr); ok {
		return p.dialer.DialContext(ctx, network, addr)
	}
	return p.dialChecked(ctx, network, addr)
}

// dialChecked dials addr on one of the host's addresses the policy allows.
func (p *Policy) dialChecked(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	addrs, err := p.Resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	var firstErr error
	for _, ip := range addrs {
		conn, err := p.dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, firstErr
}

// Transport returns an HTTP transport, like http.DefaultTransport, that only
// connects where the policy allows. With a proxy, the destination is checked
// before the request goes to the proxy.
func (p *Policy) Transport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.DialContext = p.DialContext
	t.Proxy = func(req *http.Request) (*url.URL, error) {
		return p.proxy(req.Context(), req.URL)
	}
	return t
}

// proxy returns the proxy for a request to u, after checking u's host.
func (p *Policy) proxy(ctx context.Context, u *url.URL) (*url.URL, error) {
	proxyURL, err := p.proxyFunc(u)
	if err != nil {
		return nil, err
	}
	if proxyURL == nil {
		// DialContext doesn't check a proxy's address, so a direct request
		// to it, which NO_PROXY or a loopback proxy allow, is checked here.
		if _, ok := p.proxies.Load(proxyAddr(u)); ok {
			if _, err := p.Resolve(ctx, u.Hostname()); err != nil {
				return nil, err
			}
		}
		return nil, nil
	}
	if _, err := p.Resolve(ctx, u.Hostname()); err != nil {
		return nil, err
	}
	p.proxies.Store(proxyAddr(proxyURL), true)
	return proxyURL, nil
}

// proxyAddr is the host and port the HTTP transport dials for u, a proxy
// or a request URL.
func proxyAddr(u *url.URL) string {
	if u.Port() != "" {
		return u.Host
	}
	port := map[string]string{"http": "80", "https": "443", "socks5": "1080", "socks5h": "1080"}[u.Scheme]
	return net.JoinHostPort(u.Hostname(), port)
}

// DialGRPC dials a gRPC server at addr, a host and port, where the policy
// allows, through the HTTPS proxy when one applies. gRPC doesn't use proxies
// with a custom dialer, so this does the CONNECT itself. Use it with
// grpc.WithContextDialer and a target from GRPCTarget.
func (p *Policy) DialGRPC(ctx context.Context, addr string) (net.Conn, error) {
	proxyURL, err := p.proxy(ctx, &url.URL{Scheme: "https", Host: addr})
	if err != nil {
		return nil, err
	}
	if proxyURL == nil {
		return p.dialChecked(ctx, "tcp", addr)
	}
	conn, err := p.dialer.DialContext(ctx, "tcp", proxyAddr(proxyURL))
	if err != nil {
		return nil, err
	}
	tunnel, err := connect(ctx, conn, addr, proxyURL)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return tunnel, nil
}

// connect opens a tunnel to addr through an HTTP proxy.
func connect(ctx context.Context, conn net.Conn, addr string, proxyURL *url.URL) (net.Conn, error) {
	req := &http.Request{Method: http.MethodConnect, URL: &url.URL{Host: addr}, Host: addr, Header: http.Header{}}
	if u := proxyURL.User; u != nil {
		password, _ := u.Password()
		req.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(u.Username()+":"+password)))
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
		defer func() { _ = conn.SetDeadline(time.Time{}) }()
	}
	if err := req.Write(conn); err != nil {
		return nil, fmt.Errorf("proxy CONNECT to %s: %w", addr, err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		return nil, fmt.Errorf("proxy CONNECT to %s: %w", addr, err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the proxy refused the connection to %s: %s", addr, resp.Status)
	}
	if br.Buffered() > 0 {
		return &bufferedConn{Conn: conn, r: br}, nil
	}
	return conn, nil
}

// bufferedConn reads what the proxy sent after its answer before the rest.
type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.r.Read(b) }

// GRPCTarget checks a gRPC target and returns it for DialGRPC. Only a host
// and port are accepted, so a card can't name a Unix socket or another gRPC
// resolver. A target without a port gets 443, gRPC's default.
func GRPCTarget(target string) (string, error) {
	host, port, err := net.SplitHostPort(target)
	if err != nil && strings.Count(target, ":") == 0 {
		host, port, err = target, "443", nil
	}
	if n, perr := strconv.Atoi(port); err != nil || perr != nil || n <= 0 || n > 65535 || host == "" || strings.ContainsAny(host, "/@?#") {
		return "", fmt.Errorf("the egress policy only accepts gRPC targets of the form host:port, not %q", target)
	}
	// passthrough hands the target to the dialer, which resolves and checks it.
	return "passthrough:///" + net.JoinHostPort(host, port), nil
}

// reserved are non-public networks that netip's predicates don't cover.
var reserved = []struct {
	prefix netip.Prefix
	reason string
}{
	{netip.MustParsePrefix("0.0.0.0/8"), "a reserved address"},
	{netip.MustParsePrefix("100.64.0.0/10"), "a shared (carrier-grade NAT) address"},
	{netip.MustParsePrefix("192.0.0.0/24"), "a reserved address"},
	{netip.MustParsePrefix("192.0.2.0/24"), "a documentation address"},
	{netip.MustParsePrefix("198.18.0.0/15"), "a benchmarking address"},
	{netip.MustParsePrefix("198.51.100.0/24"), "a documentation address"},
	{netip.MustParsePrefix("203.0.113.0/24"), "a documentation address"},
	{netip.MustParsePrefix("240.0.0.0/4"), "a reserved address"},
	{netip.MustParsePrefix("::/96"), "a reserved address"},
	{netip.MustParsePrefix("64:ff9b:1::/48"), "a local NAT64 address"},
	{netip.MustParsePrefix("100::/64"), "a discard address"},
	{netip.MustParsePrefix("2001::/32"), "a Teredo tunnel address"},
	{netip.MustParsePrefix("2001:db8::/32"), "a documentation address"},
	{netip.MustParsePrefix("fec0::/10"), "a site-local address"},
}

var (
	nat64     = netip.MustParsePrefix("64:ff9b::/96")
	sixToFour = netip.MustParsePrefix("2002::/16")
)

// Classify returns why ip isn't a public address, such as "a private
// address", or "" when it is one. IPv4 addresses embedded in IPv6 ones
// (mapped, NAT64, 6to4) are classified as the IPv4 address.
func Classify(ip netip.Addr) string {
	ip = ip.Unmap()
	switch {
	case !ip.IsValid():
		return "not an IP address"
	case ip.IsLoopback():
		return "a loopback address"
	case ip.IsPrivate():
		return "a private address"
	case ip.IsLinkLocalUnicast():
		return "a link-local address, such as a cloud metadata server's"
	case ip.IsUnspecified():
		return "an unspecified address"
	case ip.IsMulticast():
		return "a multicast address"
	}
	for _, r := range reserved {
		if r.prefix.Contains(ip) {
			return r.reason
		}
	}
	b := ip.As16()
	switch {
	case nat64.Contains(ip):
		return Classify(netip.AddrFrom4([4]byte(b[12:16])))
	case sixToFour.Contains(ip):
		return Classify(netip.AddrFrom4([4]byte(b[2:6])))
	case !ip.IsGlobalUnicast():
		return "not a public address"
	}
	return ""
}
