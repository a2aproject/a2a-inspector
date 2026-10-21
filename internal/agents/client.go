package agents

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2aclient"
	"github.com/a2aproject/a2a-go/v2/a2acompat/a2av0"
	a2agrpcv0 "github.com/a2aproject/a2a-go/v2/a2agrpc/v0"
	a2agrpcv1 "github.com/a2aproject/a2a-go/v2/a2agrpc/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// Transport adds a protocol binding beyond the core ones, such as an
// internal RPC system.
type Transport struct {
	// Binding is the protocolBinding value cards use for it.
	Binding string
	// Version is "1.0" or "0.3".
	Version string
	Factory a2aclient.TransportFactory
}

// Dialer creates a2a-go clients for agent interfaces. Every client uses
// HTTPClient for JSON-RPC and HTTP+JSON, and GRPCDialOptions for gRPC, so
// the inspector sees the traffic.
type Dialer struct {
	HTTPClient      *http.Client
	GRPCDialOptions []grpc.DialOption
	Transports      []Transport
}

// Supports reports whether the dialer can talk to interfaces with this
// binding and Major.Minor version.
func (d *Dialer) Supports(binding, version string) bool {
	if CoreBinding(binding) != "" {
		return version == Version10 || version == Version03
	}
	return d.extra(binding, version) != nil
}

func (d *Dialer) extra(binding, version string) a2aclient.TransportFactory {
	for _, t := range d.Transports {
		if strings.EqualFold(t.Binding, binding) && t.Version == version {
			return t.Factory
		}
	}
	return nil
}

// Dial returns a client for exactly this interface: a2a-go doesn't pick
// another one or fall back to SendMessage when the card lacks streaming.
func (d *Dialer) Dial(ctx context.Context, iface Interface, interceptors ...a2aclient.CallInterceptor) (*a2aclient.Client, error) {
	version := MajorMinor(iface.ProtocolVersion)
	binding := CoreBinding(iface.ProtocolBinding)
	if binding == "" {
		binding = iface.ProtocolBinding
	}
	factory := d.factory(binding, version)
	if factory == nil {
		return nil, fmt.Errorf("the inspector doesn't support %s %s", binding, version)
	}
	endpoint := &a2a.AgentInterface{
		URL:             iface.URL,
		ProtocolBinding: a2a.TransportProtocol(binding),
		ProtocolVersion: a2a.ProtocolVersion(version),
		Tenant:          iface.Tenant,
	}
	return a2aclient.NewFromEndpoints(ctx, []*a2a.AgentInterface{endpoint},
		a2aclient.WithDefaultsDisabled(),
		a2aclient.WithCompatTransport(endpoint.ProtocolVersion, endpoint.ProtocolBinding, factory),
		a2aclient.WithCallInterceptors(interceptors...),
	)
}

func (d *Dialer) factory(binding, version string) a2aclient.TransportFactory {
	if f := d.extra(binding, version); f != nil {
		return f
	}
	client := d.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	type fn = a2aclient.TransportFactoryFn
	switch [2]string{binding, version} {
	case [2]string{BindingJSONRPC, Version10}:
		return fn(func(_ context.Context, _ *a2a.AgentCard, iface *a2a.AgentInterface) (a2aclient.Transport, error) {
			return a2aclient.NewJSONRPCTransport(iface.URL, client), nil
		})
	case [2]string{BindingHTTPJSON, Version10}:
		return fn(func(_ context.Context, _ *a2a.AgentCard, iface *a2a.AgentInterface) (a2aclient.Transport, error) {
			u, err := url.Parse(iface.URL)
			if err != nil {
				return nil, fmt.Errorf("invalid interface URL: %w", err)
			}
			return a2aclient.NewRESTTransport(u, client), nil
		})
	case [2]string{BindingJSONRPC, Version03}:
		return fn(func(_ context.Context, _ *a2a.AgentCard, iface *a2a.AgentInterface) (a2aclient.Transport, error) {
			return a2av0.NewJSONRPCTransport(a2av0.JSONRPCTransportConfig{URL: iface.URL, Client: client}), nil
		})
	case [2]string{BindingHTTPJSON, Version03}:
		return fn(func(_ context.Context, _ *a2a.AgentCard, iface *a2a.AgentInterface) (a2aclient.Transport, error) {
			return a2av0.NewRESTTransport(a2av0.RESTTransportConfig{URL: iface.URL, Client: client})
		})
	case [2]string{BindingGRPC, Version10}:
		return fn(func(_ context.Context, _ *a2a.AgentCard, iface *a2a.AgentInterface) (a2aclient.Transport, error) {
			conn, err := d.grpcConn(iface.URL)
			if err != nil {
				return nil, err
			}
			return a2agrpcv1.NewGRPCTransport(conn), nil
		})
	case [2]string{BindingGRPC, Version03}:
		return fn(func(_ context.Context, _ *a2a.AgentCard, iface *a2a.AgentInterface) (a2aclient.Transport, error) {
			conn, err := d.grpcConn(iface.URL)
			if err != nil {
				return nil, err
			}
			return a2agrpcv0.NewGRPCTransport(conn), nil
		})
	}
	return nil
}

func (d *Dialer) grpcConn(rawURL string) (*grpc.ClientConn, error) {
	target, secure := GRPCTarget(rawURL)
	creds := insecure.NewCredentials()
	if secure {
		creds = credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12})
	}
	opts := append([]grpc.DialOption{grpc.WithTransportCredentials(creds)}, d.GRPCDialOptions...)
	conn, err := grpc.NewClient(target, opts...)
	if err != nil {
		return nil, fmt.Errorf("invalid gRPC target %q: %w", target, err)
	}
	return conn, nil
}

// GRPCTarget turns a gRPC interface URL into a gRPC target, and tells whether
// to use TLS. Cards write gRPC URLs as host:port or with an http(s) scheme;
// https and hosts other than loopback addresses use TLS.
func GRPCTarget(rawURL string) (target string, secure bool) {
	if u, err := url.Parse(rawURL); err == nil && u.Host != "" {
		switch u.Scheme {
		case "https":
			return u.Host, true
		case "http":
			return u.Host, false
		}
	}
	host := rawURL
	if i := strings.LastIndex(host, "/"); i >= 0 {
		host = host[i+1:]
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return rawURL, !IsLoopbackHost(host)
}
