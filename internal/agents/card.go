// Package agents is the inspector's client layer for A2A agents: it fetches
// agent cards, detects their protocol version and lists their interfaces.
package agents

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// WellKnownCardPath is where agents serve their card when a reference has no path.
const WellKnownCardPath = "/.well-known/agent-card.json"

// MaxCardSize is the largest card body the inspector reads.
const MaxCardSize = 4 << 20

// Protocol versions the inspector supports, as used in AgentInterface.protocolVersion.
const (
	Version10 = "1.0"
	Version03 = "0.3"
)

// Protocol bindings the inspector supports.
const (
	BindingJSONRPC  = "JSONRPC"
	BindingHTTPJSON = "HTTP+JSON"
	BindingGRPC     = "GRPC"
)

// NormalizeCardURL turns an agent card reference into the URL to fetch, with
// the same rules as a2a-cli's --agent-card flag: a bare host gets http:// when
// it's a loopback address and https:// otherwise, and a URL without a path
// (or with "/") gets the well-known card path. Any other path is used as is.
// Local file paths aren't supported.
func NormalizeCardURL(ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", errors.New("agent card URL is empty")
	}
	if !strings.Contains(ref, "://") {
		if looksLikeFilePath(ref) {
			return "", fmt.Errorf("%q looks like a local file path; only http and https agent card URLs are supported", ref)
		}
		host := ref
		if i := strings.IndexAny(host, "/?#"); i >= 0 {
			host = host[:i]
		}
		if IsLoopbackHost(host) {
			ref = "http://" + ref
		} else {
			ref = "https://" + ref
		}
	}
	u, err := url.Parse(ref)
	if err != nil {
		return "", fmt.Errorf("invalid agent card URL %q: %w", ref, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("unsupported scheme %q in agent card URL; use http or https", u.Scheme)
	}
	if u.Host == "" {
		return "", fmt.Errorf("agent card URL %q has no host", ref)
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = WellKnownCardPath
		u.RawPath = ""
	}
	u.Fragment = ""
	return u.String(), nil
}

func looksLikeFilePath(ref string) bool {
	for _, prefix := range []string{"/", "./", "../", "~"} {
		if strings.HasPrefix(ref, prefix) {
			return true
		}
	}
	return false
}

// IsLoopbackHost reports whether host (optionally with a port) is localhost or
// a loopback IP address.
func IsLoopbackHost(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// CardResponse is the HTTP response to a card request.
type CardResponse struct {
	// URL is the final URL, after redirects.
	URL         string
	StatusCode  int
	Status      string
	ContentType string
	// Body holds at most MaxCardSize bytes; TooLarge is set when there was more.
	Body     []byte
	TooLarge bool
	Latency  time.Duration
}

// FetchCard requests cardURL and returns the response whatever its status.
// It only returns an error when no response was received.
func FetchCard(ctx context.Context, client *http.Client, cardURL string) (*CardResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cardURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "a2a-inspector")

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxCardSize+1))
	if err != nil {
		return nil, fmt.Errorf("reading the card response: %w", err)
	}
	out := &CardResponse{
		URL:         resp.Request.URL.String(),
		StatusCode:  resp.StatusCode,
		Status:      resp.Status,
		ContentType: resp.Header.Get("Content-Type"),
		Body:        body,
		Latency:     time.Since(start),
	}
	if len(body) > MaxCardSize {
		out.Body = body[:MaxCardSize]
		out.TooLarge = true
	}
	return out, nil
}

// Interface is one way to reach an agent: a URL, a protocol binding and a
// protocol version.
type Interface struct {
	URL string `json:"url"`
	// ProtocolBinding is JSONRPC, HTTP+JSON or GRPC for the core bindings
	// (normalized to upper case), or the card's value for any other binding.
	ProtocolBinding string `json:"protocolBinding"`
	// ProtocolVersion is Major.Minor, for example "1.0" or "0.3".
	ProtocolVersion string `json:"protocolVersion"`
	Tenant          string `json:"tenant,omitempty"`
	// Supported reports whether the inspector can talk to this interface.
	Supported bool `json:"supported"`
	// Source is where the interface is declared in the card, for example
	// "supportedInterfaces[1]", "url" or "additionalInterfaces[0]".
	Source string `json:"source"`
}

// CardInfo describes how the inspector reads an agent card.
type CardInfo struct {
	// ProtocolVersion is the card format: "1.0" when the card has
	// supportedInterfaces, "0.3" otherwise.
	ProtocolVersion string
	// Versions lists every card format present. A v1.0 card can also carry
	// the v0.3 fields (url, protocolVersion, ...) for v0.3 clients, in which
	// case Versions is ["1.0", "0.3"].
	Versions []string
	// VersionDetected is false when the card has neither v1.0 nor v0.3
	// fields; it's then read as v1.0.
	VersionDetected bool
	// Interfaces in card order. When the card has supportedInterfaces, only
	// those are listed: the v0.3 fields mirror its 0.3 entries.
	Interfaces []Interface
	// DefaultInterface is the index of the first supported interface, or -1.
	DefaultInterface int
}

// DescribeCard detects the format of a decoded agent card and lists its interfaces.
func DescribeCard(card map[string]any) CardInfo {
	_, hasV10 := card["supportedInterfaces"]
	hasV03 := has(card, "url") || has(card, "preferredTransport") || has(card, "additionalInterfaces") ||
		strings.HasPrefix(str(card["protocolVersion"]), "0.")

	info := CardInfo{DefaultInterface: -1, VersionDetected: hasV10 || hasV03}
	switch {
	case hasV10:
		info.ProtocolVersion = Version10
		info.Versions = []string{Version10}
		if hasV03 {
			info.Versions = append(info.Versions, Version03)
		}
		info.Interfaces = v10Interfaces(card)
	case hasV03:
		info.ProtocolVersion = Version03
		info.Versions = []string{Version03}
		info.Interfaces = v03Interfaces(card)
	default:
		info.ProtocolVersion = Version10
		info.Versions = []string{Version10}
	}
	for i := range info.Interfaces {
		if info.Interfaces[i].Supported {
			info.DefaultInterface = i
			break
		}
	}
	return info
}

func v10Interfaces(card map[string]any) []Interface {
	list, _ := card["supportedInterfaces"].([]any)
	var out []Interface
	for i, item := range list {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, newInterface(
			str(entry["url"]), str(entry["protocolBinding"]), str(entry["protocolVersion"]), str(entry["tenant"]),
			fmt.Sprintf("supportedInterfaces[%d]", i),
		))
	}
	return out
}

func v03Interfaces(card map[string]any) []Interface {
	version := MajorMinor(str(card["protocolVersion"]))
	if version == "" {
		version = Version03
	}
	var out []Interface
	seen := map[[2]string]bool{}
	add := func(rawURL, transport, source string) {
		key := [2]string{rawURL, strings.ToUpper(strings.TrimSpace(transport))}
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, newInterface(rawURL, transport, version, "", source))
	}
	if mainURL := str(card["url"]); mainURL != "" {
		transport := str(card["preferredTransport"])
		if transport == "" {
			// v0.3 default when preferredTransport is absent.
			transport = BindingJSONRPC
		}
		add(mainURL, transport, "url")
	}
	list, _ := card["additionalInterfaces"].([]any)
	for i, item := range list {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		add(str(entry["url"]), str(entry["transport"]), fmt.Sprintf("additionalInterfaces[%d]", i))
	}
	return out
}

func newInterface(rawURL, binding, version, tenant, source string) Interface {
	iface := Interface{
		URL:             rawURL,
		ProtocolBinding: binding,
		ProtocolVersion: MajorMinor(version),
		Tenant:          tenant,
		Source:          source,
	}
	if core := CoreBinding(binding); core != "" {
		iface.ProtocolBinding = core
	}
	iface.Supported = CoreBinding(binding) != "" &&
		(iface.ProtocolVersion == Version10 || iface.ProtocolVersion == Version03)
	return iface
}

// CoreBinding returns the canonical name of a core protocol binding, matched
// case-insensitively, or "" for any other binding.
func CoreBinding(binding string) string {
	switch strings.ToUpper(strings.TrimSpace(binding)) {
	case BindingJSONRPC:
		return BindingJSONRPC
	case BindingHTTPJSON:
		return BindingHTTPJSON
	case BindingGRPC:
		return BindingGRPC
	}
	return ""
}

// MajorMinor drops the patch part of a version: "0.3.0" becomes "0.3".
func MajorMinor(version string) string {
	version = strings.TrimSpace(version)
	parts := strings.SplitN(version, ".", 3)
	if len(parts) == 3 {
		return parts[0] + "." + parts[1]
	}
	return version
}

func has(m map[string]any, key string) bool {
	_, ok := m[key]
	return ok
}

func str(v any) string {
	s, _ := v.(string)
	return s
}
