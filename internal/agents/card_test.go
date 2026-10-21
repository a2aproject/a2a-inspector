package agents

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2acompat/a2av0"
	"github.com/a2aproject/a2a-go/v2/a2asrv"
	"github.com/google/go-cmp/cmp"
)

func TestNormalizeCardURL(t *testing.T) {
	tests := []struct {
		ref     string
		want    string
		wantErr string
	}{
		{ref: "https://agent.example.com", want: "https://agent.example.com/.well-known/agent-card.json"},
		{ref: "https://agent.example.com/", want: "https://agent.example.com/.well-known/agent-card.json"},
		{ref: "  https://agent.example.com  ", want: "https://agent.example.com/.well-known/agent-card.json"},
		{ref: "https://agent.example.com/a2a/card.json", want: "https://agent.example.com/a2a/card.json"},
		{ref: "http://localhost:10102/jsonrpc/.well-known/agent-card.json", want: "http://localhost:10102/jsonrpc/.well-known/agent-card.json"},
		{ref: "https://agent.example.com/card?v=1#frag", want: "https://agent.example.com/card?v=1"},
		{ref: "agent.example.com", want: "https://agent.example.com/.well-known/agent-card.json"},
		{ref: "localhost:9999", want: "http://localhost:9999/.well-known/agent-card.json"},
		{ref: "127.0.0.1:9999/custom/card.json", want: "http://127.0.0.1:9999/custom/card.json"},
		{ref: "[::1]:9999", want: "http://[::1]:9999/.well-known/agent-card.json"},
		{ref: "", wantErr: "empty"},
		{ref: "./card.json", wantErr: "local file path"},
		{ref: "/tmp/card.json", wantErr: "local file path"},
		{ref: "file:///tmp/card.json", wantErr: "unsupported scheme"},
		{ref: "ftp://agent.example.com", wantErr: "unsupported scheme"},
		{ref: "https://", wantErr: "no host"},
	}
	for _, tc := range tests {
		t.Run(tc.ref, func(t *testing.T) {
			got, err := NormalizeCardURL(tc.ref)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("NormalizeCardURL(%q) error = %v, want it to contain %q", tc.ref, err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizeCardURL(%q) error = %v", tc.ref, err)
			}
			if got != tc.want {
				t.Errorf("NormalizeCardURL(%q) = %q, want %q", tc.ref, got, tc.want)
			}
		})
	}
}

func TestIsLoopbackHost(t *testing.T) {
	for host, want := range map[string]bool{
		"localhost":      true,
		"LOCALHOST:80":   true,
		"127.0.0.1":      true,
		"127.1.2.3:8080": true,
		"[::1]:8080":     true,
		"::1":            true,
		"0.0.0.0":        false,
		"10.0.0.1":       false,
		"example.com":    false,
	} {
		if got := IsLoopbackHost(host); got != want {
			t.Errorf("IsLoopbackHost(%q) = %v, want %v", host, got, want)
		}
	}
}

func testCard() *a2a.AgentCard {
	return &a2a.AgentCard{
		Name:        "Test agent",
		Description: "An agent for tests",
		Version:     "1.0.0",
		SupportedInterfaces: []*a2a.AgentInterface{
			a2a.NewAgentInterface("https://agent.example.com/a2a", a2a.TransportProtocolJSONRPC),
			{URL: "https://agent.example.com/v03", ProtocolBinding: a2a.TransportProtocolJSONRPC, ProtocolVersion: a2av0.Version},
			a2a.NewAgentInterface("agent.example.com:443", a2a.TransportProtocolGRPC),
		},
		Capabilities:       a2a.AgentCapabilities{Streaming: true},
		DefaultInputModes:  []string{"text/plain"},
		DefaultOutputModes: []string{"text/plain"},
		Skills:             []a2a.AgentSkill{{ID: "echo", Name: "Echo", Description: "Echoes back", Tags: []string{"echo"}}},
	}
}

func decode(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestDescribeCard(t *testing.T) {
	v10, err := json.Marshal(testCard())
	if err != nil {
		t.Fatal(err)
	}
	union, err := a2av0.NewStaticAgentCardProducer(testCard()).(a2asrv.AgentCardJSONProducer).CardJSON(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	v10Interfaces := []Interface{
		{URL: "https://agent.example.com/a2a", ProtocolBinding: "JSONRPC", ProtocolVersion: "1.0", Supported: true, Source: "supportedInterfaces[0]"},
		{URL: "https://agent.example.com/v03", ProtocolBinding: "JSONRPC", ProtocolVersion: "0.3", Supported: true, Source: "supportedInterfaces[1]"},
		{URL: "agent.example.com:443", ProtocolBinding: "GRPC", ProtocolVersion: "1.0", Supported: true, Source: "supportedInterfaces[2]"},
	}

	tests := []struct {
		name string
		card string
		want CardInfo
	}{
		{
			name: "v1.0 card from a2a-go",
			card: string(v10),
			want: CardInfo{ProtocolVersion: "1.0", Versions: []string{"1.0"}, VersionDetected: true, Interfaces: v10Interfaces, DefaultInterface: 0},
		},
		{
			name: "v1.0 card with v0.3 fields from a2a-go's compat producer",
			card: string(union),
			want: CardInfo{ProtocolVersion: "1.0", Versions: []string{"1.0", "0.3"}, VersionDetected: true, Interfaces: v10Interfaces, DefaultInterface: 0},
		},
		{
			name: "v0.3 card",
			card: `{"protocolVersion": "0.3.0", "url": "https://agent.example.com/a2a", "preferredTransport": "GRPC",
				"additionalInterfaces": [
					{"url": "https://agent.example.com/a2a", "transport": "GRPC"},
					{"url": "https://agent.example.com/a2a", "transport": "jsonrpc"},
					{"url": "https://agent.example.com/rest", "transport": "HTTP+JSON"}
				]}`,
			want: CardInfo{ProtocolVersion: "0.3", Versions: []string{"0.3"}, VersionDetected: true, DefaultInterface: 0, Interfaces: []Interface{
				{URL: "https://agent.example.com/a2a", ProtocolBinding: "GRPC", ProtocolVersion: "0.3", Supported: true, Source: "url"},
				{URL: "https://agent.example.com/a2a", ProtocolBinding: "JSONRPC", ProtocolVersion: "0.3", Supported: true, Source: "additionalInterfaces[1]"},
				{URL: "https://agent.example.com/rest", ProtocolBinding: "HTTP+JSON", ProtocolVersion: "0.3", Supported: true, Source: "additionalInterfaces[2]"},
			}},
		},
		{
			name: "v0.3 card without preferredTransport defaults to JSONRPC",
			card: `{"url": "https://agent.example.com/a2a"}`,
			want: CardInfo{ProtocolVersion: "0.3", Versions: []string{"0.3"}, VersionDetected: true, DefaultInterface: 0, Interfaces: []Interface{
				{URL: "https://agent.example.com/a2a", ProtocolBinding: "JSONRPC", ProtocolVersion: "0.3", Supported: true, Source: "url"},
			}},
		},
		{
			name: "default skips unsupported interfaces",
			card: `{"supportedInterfaces": [
				{"url": "wss://agent.example.com", "protocolBinding": "https://example.com/bindings/websocket/v1", "protocolVersion": "1.0"},
				{"url": "https://agent.example.com", "protocolBinding": "JSONRPC", "protocolVersion": "2.0"},
				{"url": "https://agent.example.com", "protocolBinding": "http+json", "protocolVersion": "1.0.0", "tenant": "t1"}
			]}`,
			want: CardInfo{ProtocolVersion: "1.0", Versions: []string{"1.0"}, VersionDetected: true, DefaultInterface: 2, Interfaces: []Interface{
				{URL: "wss://agent.example.com", ProtocolBinding: "https://example.com/bindings/websocket/v1", ProtocolVersion: "1.0", Source: "supportedInterfaces[0]"},
				{URL: "https://agent.example.com", ProtocolBinding: "JSONRPC", ProtocolVersion: "2.0", Source: "supportedInterfaces[1]"},
				{URL: "https://agent.example.com", ProtocolBinding: "HTTP+JSON", ProtocolVersion: "1.0", Tenant: "t1", Supported: true, Source: "supportedInterfaces[2]"},
			}},
		},
		{
			name: "no version fields",
			card: `{"name": "x"}`,
			want: CardInfo{ProtocolVersion: "1.0", Versions: []string{"1.0"}, DefaultInterface: -1},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := DescribeCard(decode(t, []byte(tc.card)), (&Dialer{}).Supports)
			if diff := cmp.Diff(tc.want, got); diff != "" {
				t.Errorf("DescribeCard() mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestMajorMinor(t *testing.T) {
	for in, want := range map[string]string{"0.3.0": "0.3", "1.0": "1.0", "1.0.1": "1.0", " 1.0 ": "1.0", "1": "1", "": ""} {
		if got := MajorMinor(in); got != want {
			t.Errorf("MajorMinor(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFetchCard(t *testing.T) {
	mux := http.NewServeMux()
	mux.Handle(WellKnownCardPath, a2asrv.NewStaticAgentCardHandler(testCard()))
	mux.Handle("/old", http.RedirectHandler(WellKnownCardPath, http.StatusFound))
	mux.HandleFunc("/missing", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no card here", http.StatusNotFound)
	})
	mux.HandleFunc("/huge", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat(" ", MaxCardSize+10)))
	})
	mux.HandleFunc("/headers", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"accept": r.Header.Get("Accept"), "userAgent": r.Header.Get("User-Agent"), "token": r.Header.Get("X-Token")})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	ctx := context.Background()

	t.Run("card", func(t *testing.T) {
		resp, err := FetchCard(ctx, srv.Client(), srv.URL+WellKnownCardPath, nil)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.ContentType, "application/json") || resp.TooLarge {
			t.Errorf("FetchCard() = status %d, content type %q, too large %v", resp.StatusCode, resp.ContentType, resp.TooLarge)
		}
		if name := decode(t, resp.Body)["name"]; name != "Test agent" {
			t.Errorf("card name = %v, want %q", name, "Test agent")
		}
	})
	t.Run("redirect reports the final URL", func(t *testing.T) {
		resp, err := FetchCard(ctx, srv.Client(), srv.URL+"/old", nil)
		if err != nil {
			t.Fatal(err)
		}
		if want := srv.URL + WellKnownCardPath; resp.URL != want {
			t.Errorf("URL = %q, want %q", resp.URL, want)
		}
	})
	t.Run("error status is returned, not an error", func(t *testing.T) {
		resp, err := FetchCard(ctx, srv.Client(), srv.URL+"/missing", nil)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusNotFound || !strings.Contains(string(resp.Body), "no card here") {
			t.Errorf("FetchCard() = %d %q", resp.StatusCode, resp.Body)
		}
	})
	t.Run("body is capped", func(t *testing.T) {
		resp, err := FetchCard(ctx, srv.Client(), srv.URL+"/huge", nil)
		if err != nil {
			t.Fatal(err)
		}
		if !resp.TooLarge || len(resp.Body) != MaxCardSize {
			t.Errorf("TooLarge = %v, len(Body) = %d", resp.TooLarge, len(resp.Body))
		}
	})
	t.Run("request headers", func(t *testing.T) {
		resp, err := FetchCard(ctx, srv.Client(), srv.URL+"/headers", http.Header{"X-Token": {"t0ken"}, "Accept": {"text/html"}})
		if err != nil {
			t.Fatal(err)
		}
		got := decode(t, resp.Body)
		if got["accept"] != "application/json" || got["userAgent"] != "a2a-inspector" || got["token"] != "t0ken" {
			t.Errorf("request headers = %v", got)
		}
	})
	t.Run("connection error", func(t *testing.T) {
		if _, err := FetchCard(ctx, srv.Client(), "http://127.0.0.1:1/card.json", nil); err == nil {
			t.Error("FetchCard() error = nil, want a connection error")
		}
	})
}
