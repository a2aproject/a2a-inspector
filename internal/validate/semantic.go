package validate

import (
	"fmt"
	"maps"
	"mime"
	"net"
	"net/url"
	"slices"
	"strings"

	"github.com/a2aproject/a2a-inspector/internal/agents"
)

// cardSemantics reports problems the schemas can't express.
func cardSemantics(card map[string]any, in CardInput) []Finding {
	var out []Finding
	out = append(out, bindingFindings(card)...)
	out = append(out, interfaceFindings(in.Info, in.FetchedFrom)...)
	out = append(out, v03MirrorFindings(card, in.Info)...)
	out = append(out, skillFindings(card)...)
	out = append(out, mediaTypeFindings(card)...)
	out = append(out, securityFindings(card)...)
	return out
}

// bindingFindings checks how protocol bindings and versions are written.
func bindingFindings(card map[string]any) []Finding {
	var out []Finding
	checkBinding := func(path, binding string) {
		switch core := agents.CoreBinding(binding); {
		case binding == "":
		case core != "" && core != binding:
			out = append(out, Finding{
				Severity: SeverityWarning,
				Path:     path,
				Rule:     "protocol-binding",
				Message:  fmt.Sprintf("Core binding names are upper case: use %q.", core),
			})
		case core == "":
			out = append(out, Finding{
				Severity: SeverityInfo,
				Path:     path,
				Rule:     "protocol-binding",
				Message:  fmt.Sprintf("%q is a custom binding. The inspector supports JSONRPC, HTTP+JSON and GRPC.", binding),
			})
		}
	}

	list, _ := card["supportedInterfaces"].([]any)
	for i, item := range list {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		base := indexPath("supportedInterfaces", i)
		checkBinding(joinPath(base, "protocolBinding"), str(entry["protocolBinding"]))
		version := str(entry["protocolVersion"])
		switch mm := agents.MajorMinor(version); {
		case version == "":
		case mm != version:
			out = append(out, Finding{
				Severity: SeverityWarning,
				Path:     joinPath(base, "protocolVersion"),
				Rule:     "protocol-version",
				Message:  fmt.Sprintf("Agent cards should give only Major.Minor: use %q.", mm),
			})
		case mm != agents.Version10 && mm != agents.Version03:
			out = append(out, Finding{
				Severity: SeverityInfo,
				Path:     joinPath(base, "protocolVersion"),
				Rule:     "protocol-version",
				Message:  fmt.Sprintf("Protocol version %q isn't one the inspector supports (1.0 and 0.3).", version),
			})
		}
	}
	checkBinding("preferredTransport", str(card["preferredTransport"]))
	additional, _ := card["additionalInterfaces"].([]any)
	for i, item := range additional {
		if entry, ok := item.(map[string]any); ok {
			checkBinding(joinPath(indexPath("additionalInterfaces", i), "transport"), str(entry["transport"]))
		}
	}
	return out
}

// interfaceFindings checks interface URLs and whether the inspector can use any interface.
func interfaceFindings(info agents.CardInfo, fetchedFrom string) []Finding {
	var out []Finding
	fetchedHost := ""
	if u, err := url.Parse(fetchedFrom); err == nil {
		fetchedHost = u.Hostname()
	}
	seen := map[string]string{}
	supported := false
	for _, iface := range info.Interfaces {
		supported = supported || iface.Supported
		urlPath := iface.Source
		if urlPath != "url" {
			urlPath = joinPath(urlPath, "url")
		}

		key := iface.URL + " " + iface.ProtocolBinding + " " + iface.ProtocolVersion
		if first, dup := seen[key]; dup {
			out = append(out, Finding{
				Severity: SeverityWarning,
				Path:     iface.Source,
				Rule:     "duplicate-interface",
				Message:  fmt.Sprintf("Same URL, binding and version as %s.", first),
			})
		} else {
			seen[key] = iface.Source
		}

		if iface.URL == "" {
			continue
		}
		scheme, host, ok := interfaceHost(iface)
		if !ok {
			out = append(out, Finding{
				Severity: SeverityError,
				Path:     urlPath,
				Rule:     "interface-url",
				Message:  fmt.Sprintf("%q isn't an absolute URL.", iface.URL),
			})
			continue
		}
		ip := net.ParseIP(host)
		switch {
		case ip != nil && ip.IsUnspecified():
			out = append(out, Finding{
				Severity: SeverityWarning,
				Path:     urlPath,
				Rule:     "interface-url",
				Message:  fmt.Sprintf("%s means all addresses on the server; clients can't connect to it. Advertise the agent's real address.", host),
			})
		case agents.IsLoopbackHost(host) && fetchedHost != "" && !agents.IsLoopbackHost(fetchedHost):
			out = append(out, Finding{
				Severity: SeverityWarning,
				Path:     urlPath,
				Rule:     "interface-url",
				Message:  fmt.Sprintf("The card was fetched from %s but points to a loopback address, which clients on other machines can't reach.", fetchedHost),
			})
		case scheme == "http" && !agents.IsLoopbackHost(host):
			out = append(out, Finding{
				Severity: SeverityInfo,
				Path:     urlPath,
				Rule:     "interface-url",
				Message:  "Plain http. Agents should use https outside local development.",
			})
		}
	}
	if len(info.Interfaces) > 0 && !supported {
		out = append(out, Finding{
			Severity: SeverityWarning,
			Rule:     "no-supported-interface",
			Message:  "The inspector can't use any of the card's interfaces: it supports JSONRPC, HTTP+JSON and GRPC in versions 1.0 and 0.3.",
		})
	}
	return out
}

// interfaceHost returns the scheme and host of an interface URL. gRPC
// interfaces may also be given as a plain host:port target.
func interfaceHost(iface agents.Interface) (scheme, host string, ok bool) {
	if !strings.Contains(iface.URL, "://") {
		if iface.ProtocolBinding != agents.BindingGRPC {
			return "", "", false
		}
		host = iface.URL
		if h, _, err := net.SplitHostPort(iface.URL); err == nil {
			host = h
		}
		return "", strings.Trim(host, "[]"), host != ""
	}
	u, err := url.Parse(iface.URL)
	if err != nil || u.Host == "" {
		return "", "", false
	}
	return u.Scheme, u.Hostname(), true
}

// v03MirrorFindings checks that the v0.3 fields of a card that has both
// formats point to one of its 0.3 interfaces.
func v03MirrorFindings(card map[string]any, info agents.CardInfo) []Finding {
	mainURL := str(card["url"])
	if len(info.Versions) < 2 || mainURL == "" {
		return nil
	}
	var v03 []agents.Interface
	for _, iface := range info.Interfaces {
		if iface.ProtocolVersion == agents.Version03 {
			v03 = append(v03, iface)
		}
	}
	msg := ""
	switch {
	case len(v03) == 0:
		msg = "url is for v0.3 clients, but supportedInterfaces has no entry with protocolVersion \"0.3\"."
	case !slices.ContainsFunc(v03, func(i agents.Interface) bool { return i.URL == mainURL }):
		msg = "url is for v0.3 clients, but it doesn't match any supportedInterfaces entry with protocolVersion \"0.3\"."
	default:
		return nil
	}
	return []Finding{{Severity: SeverityWarning, Path: "url", Rule: "v03-fields", Message: msg}}
}

func skillFindings(card map[string]any) []Finding {
	var out []Finding
	skills, _ := card["skills"].([]any)
	seen := map[string]int{}
	for i, item := range skills {
		skill, _ := item.(map[string]any)
		id := str(skill["id"])
		if id == "" {
			continue
		}
		if first, dup := seen[id]; dup {
			out = append(out, Finding{
				Severity: SeverityWarning,
				Path:     joinPath(indexPath("skills", i), "id"),
				Rule:     "duplicate-skill",
				Message:  fmt.Sprintf("Skill id %q is also used by skills[%d].", id, first),
			})
			continue
		}
		seen[id] = i
	}
	return out
}

func mediaTypeFindings(card map[string]any) []Finding {
	var out []Finding
	check := func(path string, v any) {
		list, _ := v.([]any)
		for i, item := range list {
			s, ok := item.(string)
			if !ok {
				continue
			}
			if _, _, err := mime.ParseMediaType(s); err != nil || !strings.Contains(s, "/") {
				out = append(out, Finding{
					Severity: SeverityWarning,
					Path:     indexPath(path, i),
					Rule:     "media-type",
					Message:  fmt.Sprintf("%q isn't a media type, such as \"text/plain\" or \"application/json\".", s),
				})
			}
		}
	}
	check("defaultInputModes", card["defaultInputModes"])
	check("defaultOutputModes", card["defaultOutputModes"])
	skills, _ := card["skills"].([]any)
	for i, item := range skills {
		skill, _ := item.(map[string]any)
		check(joinPath(indexPath("skills", i), "inputModes"), skill["inputModes"])
		check(joinPath(indexPath("skills", i), "outputModes"), skill["outputModes"])
	}
	return out
}

// securityFindings checks that security requirements name declared schemes,
// in both the v1.0 (securityRequirements) and v0.3 (security) forms.
func securityFindings(card map[string]any) []Finding {
	schemes, _ := card["securitySchemes"].(map[string]any)
	var out []Finding
	check := func(path string, v any, v10 bool) {
		list, _ := v.([]any)
		for i, item := range list {
			req, _ := item.(map[string]any)
			reqPath := indexPath(path, i)
			if v10 {
				req, _ = req["schemes"].(map[string]any)
				reqPath = joinPath(reqPath, "schemes")
			}
			for _, name := range slices.Sorted(maps.Keys(req)) {
				if _, ok := schemes[name]; !ok {
					out = append(out, Finding{
						Severity: SeverityWarning,
						Path:     joinPath(reqPath, name),
						Rule:     "security-scheme",
						Message:  fmt.Sprintf("Requires security scheme %q, which isn't in securitySchemes.", name),
					})
				}
			}
		}
	}
	check("securityRequirements", card["securityRequirements"], true)
	check("security", card["security"], false)
	skills, _ := card["skills"].([]any)
	for i, item := range skills {
		skill, _ := item.(map[string]any)
		check(joinPath(indexPath("skills", i), "securityRequirements"), skill["securityRequirements"], true)
		check(joinPath(indexPath("skills", i), "security"), skill["security"], false)
	}
	return out
}

// Operation is an A2A operation, named as in the specification.
type Operation string

// Operations that depend on a card capability or a protocol version.
const (
	SendStreamingMessage             Operation = "SendStreamingMessage"
	SubscribeToTask                  Operation = "SubscribeToTask"
	ListTasks                        Operation = "ListTasks"
	CreateTaskPushNotificationConfig Operation = "CreateTaskPushNotificationConfig"
	GetTaskPushNotificationConfig    Operation = "GetTaskPushNotificationConfig"
	ListTaskPushNotificationConfigs  Operation = "ListTaskPushNotificationConfigs"
	DeleteTaskPushNotificationConfig Operation = "DeleteTaskPushNotificationConfig"
	GetExtendedAgentCard             Operation = "GetExtendedAgentCard"
)

// OperationFindings reports when a card doesn't declare the capability an
// operation needs, in which case the agent must reject the call, or when
// the operation doesn't exist in the protocol version used.
func OperationFindings(card map[string]any, protocolVersion string, op Operation) []Finding {
	caps, _ := card["capabilities"].(map[string]any)
	needs := func(path string, declared any) []Finding {
		if b, _ := declared.(bool); b {
			return nil
		}
		return []Finding{{
			Severity: SeverityWarning,
			Path:     path,
			Rule:     "capability",
			Message:  fmt.Sprintf("%s needs %s, which the card doesn't declare, so the agent must reject the call.", op, path),
		}}
	}
	switch op {
	case SendStreamingMessage, SubscribeToTask:
		return needs("capabilities.streaming", caps["streaming"])
	case CreateTaskPushNotificationConfig, GetTaskPushNotificationConfig, ListTaskPushNotificationConfigs, DeleteTaskPushNotificationConfig:
		return needs("capabilities.pushNotifications", caps["pushNotifications"])
	case GetExtendedAgentCard:
		if protocolVersion == agents.Version03 {
			return needs("supportsAuthenticatedExtendedCard", card["supportsAuthenticatedExtendedCard"])
		}
		return needs("capabilities.extendedAgentCard", caps["extendedAgentCard"])
	case ListTasks:
		if protocolVersion == agents.Version03 {
			return []Finding{{
				Severity: SeverityError,
				Rule:     "operation-version",
				Message:  "ListTasks doesn't exist in protocol version 0.3.",
			}}
		}
	}
	return nil
}
