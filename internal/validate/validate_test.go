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

package validate

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2acompat/a2av0"
	"github.com/a2aproject/a2a-go/v2/a2asrv"
	"github.com/a2aproject/a2a-inspector/internal/agents"
)

const cardURL = "https://agent.example.com/.well-known/agent-card.json"

func testCard() *a2a.AgentCard {
	return &a2a.AgentCard{
		Name:        "Test agent",
		Description: "An agent for tests",
		Version:     "1.0.0",
		SupportedInterfaces: []*a2a.AgentInterface{
			a2a.NewAgentInterface("https://agent.example.com/a2a", a2a.TransportProtocolJSONRPC),
			{URL: "https://agent.example.com/v03", ProtocolBinding: a2a.TransportProtocolJSONRPC, ProtocolVersion: a2av0.Version},
		},
		Capabilities:       a2a.AgentCapabilities{Streaming: true},
		DefaultInputModes:  []string{"text/plain"},
		DefaultOutputModes: []string{"text/plain", "application/json"},
		Skills:             []a2a.AgentSkill{{ID: "echo", Name: "Echo", Description: "Echoes back", Tags: []string{"echo"}}},
	}
}

const v03Card = `{
	"protocolVersion": "0.3.0",
	"name": "Test agent",
	"description": "An agent for tests",
	"url": "https://agent.example.com/a2a",
	"preferredTransport": "JSONRPC",
	"additionalInterfaces": [{"url": "https://agent.example.com/a2a", "transport": "JSONRPC"}],
	"version": "1.0.0",
	"capabilities": {"streaming": true},
	"defaultInputModes": ["text/plain"],
	"defaultOutputModes": ["text/plain"],
	"securitySchemes": {"key": {"type": "apiKey", "in": "header", "name": "X-API-Key"}},
	"security": [{"key": []}],
	"skills": [{"id": "echo", "name": "Echo", "description": "Echoes back", "tags": ["echo"]}]
}`

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// cardFindings validates a card as if it were fetched from cardURL as application/json.
func cardFindings(t *testing.T, raw string) []Finding {
	t.Helper()
	return validateCard(t, raw, CardInput{FetchedFrom: cardURL, ContentType: "application/json"})
}

func validateCard(t *testing.T, raw string, in CardInput) []Finding {
	t.Helper()
	var card map[string]any
	if err := json.Unmarshal([]byte(raw), &card); err == nil {
		in.Info = agents.DescribeCard(card, (&agents.Dialer{}).Supports)
	}
	return Card([]byte(raw), in).Findings
}

// edit decodes a card, applies fn and encodes it again.
func edit(t *testing.T, raw string, fn func(card map[string]any)) string {
	t.Helper()
	var card map[string]any
	if err := json.Unmarshal([]byte(raw), &card); err != nil {
		t.Fatal(err)
	}
	fn(card)
	return mustJSON(t, card)
}

type want struct {
	severity Severity
	path     string
	rule     string
}

func (w want) String() string { return fmt.Sprintf("%s %s %q", w.severity, w.rule, w.path) }

func assertHas(t *testing.T, findings []Finding, wants ...want) {
	t.Helper()
	for _, w := range wants {
		found := false
		for _, f := range findings {
			if f.Severity == w.severity && f.Path == w.path && f.Rule == w.rule {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("missing finding %v in:\n%s", w, dump(findings))
		}
	}
}

// assertClean fails on any error or warning.
func assertClean(t *testing.T, findings []Finding) {
	t.Helper()
	for _, f := range findings {
		if f.Severity != SeverityInfo {
			t.Errorf("unexpected findings:\n%s", dump(findings))
			return
		}
	}
}

func dump(findings []Finding) string {
	var b strings.Builder
	for _, f := range findings {
		fmt.Fprintf(&b, "  %s %s %q %s (version %q, hint %q)\n", f.Severity, f.Rule, f.Path, f.Message, f.ProtocolVersion, f.Hint)
	}
	return b.String()
}

func TestCardValid(t *testing.T) {
	union, err := a2av0.NewStaticAgentCardProducer(testCard()).(a2asrv.AgentCardJSONProducer).CardJSON(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	t.Run("v1.0 card from a2a-go", func(t *testing.T) {
		assertClean(t, cardFindings(t, mustJSON(t, testCard())))
	})
	t.Run("v0.3 card", func(t *testing.T) {
		assertClean(t, cardFindings(t, v03Card))
	})
	t.Run("v1.0 card with v0.3 fields from a2a-go's compat producer", func(t *testing.T) {
		findings := cardFindings(t, string(union))
		assertClean(t, findings)
		assertHas(t, findings, want{SeverityInfo, "", "v03-fields"})
		for _, f := range findings {
			if f.Rule == "v03-fields" && !strings.Contains(f.Message, "preferredTransport, protocolVersion, url") {
				t.Errorf("v03-fields message = %q, want it to list the v0.3 fields", f.Message)
			}
		}
	})
}

func TestCardV10Structure(t *testing.T) {
	valid := mustJSON(t, testCard())
	tests := []struct {
		name  string
		card  string
		wants []want
	}{
		{
			name: "missing and empty required fields",
			card: edit(t, valid, func(c map[string]any) {
				delete(c, "name")
				c["version"] = ""
				c["defaultInputModes"] = []any{}
				c["skills"] = []any{map[string]any{"id": "echo", "name": "Echo", "description": "Echoes back"}}
			}),
			wants: []want{
				{SeverityError, "name", "required"},
				{SeverityWarning, "version", "required-empty"},
				{SeverityError, "defaultInputModes", "required"},
				{SeverityError, "skills[0].tags", "required"},
			},
		},
		{
			name: "missing interface fields",
			card: edit(t, valid, func(c map[string]any) {
				c["supportedInterfaces"] = []any{map[string]any{"url": "https://agent.example.com/a2a"}}
			}),
			wants: []want{
				{SeverityError, "supportedInterfaces[0].protocolBinding", "required"},
				{SeverityError, "supportedInterfaces[0].protocolVersion", "required"},
			},
		},
		{
			name:  "wrong type",
			card:  edit(t, valid, func(c map[string]any) { c["name"] = 5 }),
			wants: []want{{SeverityError, "name", "schema"}},
		},
		{
			name:  "unknown field",
			card:  edit(t, valid, func(c map[string]any) { c["owner"] = "me" }),
			wants: []want{{SeverityWarning, "owner", "unknown-field"}},
		},
		{
			name: "v0.3 field without the rest of the v0.3 format",
			card: edit(t, valid, func(c map[string]any) {
				c["capabilities"].(map[string]any)["stateTransitionHistory"] = true
			}),
			wants: []want{{SeverityWarning, "capabilities.stateTransitionHistory", "unknown-field"}},
		},
		{
			name: "snake_case field name",
			card: edit(t, valid, func(c map[string]any) {
				c["default_output_modes"] = c["defaultOutputModes"]
				delete(c, "defaultOutputModes")
			}),
			wants: []want{{SeverityWarning, "default_output_modes", "camel-case"}},
		},
		{
			name: "security scheme with two members",
			card: edit(t, valid, func(c map[string]any) {
				c["securitySchemes"] = map[string]any{"both": map[string]any{
					"apiKeySecurityScheme":   map[string]any{"location": "header", "name": "X-Key"},
					"httpAuthSecurityScheme": map[string]any{"scheme": "Bearer"},
				}}
			}),
			wants: []want{{SeverityError, "", "proto"}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assertHas(t, cardFindings(t, tc.card), tc.wants...)
		})
	}
}

func TestCardV03Structure(t *testing.T) {
	card := edit(t, v03Card, func(c map[string]any) {
		delete(c, "name")
		c["capabilities"] = "none"
	})
	findings := cardFindings(t, card)
	assertHas(t, findings,
		want{SeverityError, "name", "required"},
		want{SeverityError, "capabilities", "schema"},
	)
	for _, f := range findings {
		if f.Path == "name" && f.Hint == "" {
			t.Errorf("finding for name has no hint")
		}
	}
}

func TestCardBothFormats(t *testing.T) {
	union, err := a2av0.NewStaticAgentCardProducer(testCard()).(a2asrv.AgentCardJSONProducer).CardJSON(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Run("each format is checked", func(t *testing.T) {
		card := edit(t, string(union), func(c map[string]any) { delete(c, "name") })
		findings := cardFindings(t, card)
		versions := map[string]bool{}
		for _, f := range findings {
			if f.Path == "name" && f.Rule == "required" {
				versions[f.ProtocolVersion] = true
			}
		}
		if !versions["1.0"] || !versions["0.3"] {
			t.Errorf("missing name reported for versions %v, want both:\n%s", versions, dump(findings))
		}
	})
	t.Run("url must mirror a 0.3 interface", func(t *testing.T) {
		card := edit(t, string(union), func(c map[string]any) { c["url"] = "https://agent.example.com/a2a" })
		assertHas(t, cardFindings(t, card), want{SeverityWarning, "url", "v03-fields"})
	})
}

func TestCardSemantics(t *testing.T) {
	valid := mustJSON(t, testCard())
	interfaces := func(entries ...map[string]any) string {
		return edit(t, valid, func(c map[string]any) {
			list := make([]any, len(entries))
			for i, e := range entries {
				list[i] = e
			}
			c["supportedInterfaces"] = list
		})
	}
	iface := func(url, binding, version string) map[string]any {
		return map[string]any{"url": url, "protocolBinding": binding, "protocolVersion": version}
	}

	tests := []struct {
		name  string
		card  string
		in    CardInput
		wants []want
	}{
		{
			name: "interface URLs",
			card: interfaces(
				iface("http://0.0.0.0:8000/a2a", "JSONRPC", "1.0"),
				iface("http://localhost:8000/a2a", "HTTP+JSON", "1.0"),
				iface("http://agent.example.com/a2a", "GRPC", "1.0"),
				iface("not a url", "JSONRPC", "0.3"),
				iface("agent.example.com:443", "GRPC", "0.3"),
			),
			wants: []want{
				{SeverityWarning, "supportedInterfaces[0].url", "interface-url"},
				{SeverityWarning, "supportedInterfaces[1].url", "interface-url"},
				{SeverityInfo, "supportedInterfaces[2].url", "interface-url"},
				{SeverityError, "supportedInterfaces[3].url", "interface-url"},
			},
		},
		{
			name: "binding and version spelling",
			card: interfaces(
				iface("https://agent.example.com/a2a", "jsonrpc", "1.0.0"),
				iface("wss://agent.example.com/a2a", "https://example.com/bindings/websocket/v1", "1.0"),
				iface("https://agent.example.com/a2a", "JSONRPC", "2.0"),
			),
			wants: []want{
				{SeverityWarning, "supportedInterfaces[0].protocolBinding", "protocol-binding"},
				{SeverityWarning, "supportedInterfaces[0].protocolVersion", "protocol-version"},
				{SeverityInfo, "supportedInterfaces[1].protocolBinding", "protocol-binding"},
				{SeverityInfo, "supportedInterfaces[2].protocolVersion", "protocol-version"},
			},
		},
		{
			name: "duplicate interfaces and nothing supported",
			card: interfaces(
				iface("wss://agent.example.com/a2a", "WEBSOCKET", "1.0"),
				iface("wss://agent.example.com/a2a", "WEBSOCKET", "1.0"),
			),
			wants: []want{
				{SeverityWarning, "supportedInterfaces[1]", "duplicate-interface"},
				{SeverityWarning, "", "no-supported-interface"},
			},
		},
		{
			name: "skills, media types and security",
			card: edit(t, valid, func(c map[string]any) {
				skill := map[string]any{"id": "echo", "name": "Echo 2", "description": "Echoes", "tags": []any{"echo"}, "inputModes": []any{"text"}}
				c["skills"] = append(c["skills"].([]any), skill)
				c["defaultOutputModes"] = []any{"json"}
				c["securityRequirements"] = []any{map[string]any{"schemes": map[string]any{"oauth": map[string]any{"list": []any{}}}}}
			}),
			wants: []want{
				{SeverityWarning, "skills[1].id", "duplicate-skill"},
				{SeverityWarning, "skills[1].inputModes[0]", "media-type"},
				{SeverityWarning, "defaultOutputModes[0]", "media-type"},
				{SeverityWarning, "securityRequirements[0].schemes.oauth", "security-scheme"},
			},
		},
		{
			name:  "v0.3 security",
			card:  edit(t, v03Card, func(c map[string]any) { c["security"] = []any{map[string]any{"bearer": []any{}}} }),
			wants: []want{{SeverityWarning, "security[0].bearer", "security-scheme"}},
		},
		{
			name:  "content type",
			card:  valid,
			in:    CardInput{FetchedFrom: cardURL, ContentType: "text/html; charset=utf-8"},
			wants: []want{{SeverityWarning, "", "content-type"}},
		},
		{
			name:  "no version fields",
			card:  `{"name": "x"}`,
			wants: []want{{SeverityInfo, "", "protocol-version"}, {SeverityError, "supportedInterfaces", "required"}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			in := tc.in
			if in.FetchedFrom == "" {
				in = CardInput{FetchedFrom: cardURL, ContentType: "application/json"}
			}
			assertHas(t, validateCard(t, tc.card, in), tc.wants...)
		})
	}

	t.Run("editor cards skip the fetch checks", func(t *testing.T) {
		card := interfaces(iface("http://localhost:8000/a2a", "JSONRPC", "1.0"))
		assertClean(t, validateCard(t, card, CardInput{}))
	})
}

func TestCardNotAnObject(t *testing.T) {
	for raw, rule := range map[string]string{`[1, 2]`: "card-object", `{"name": `: "json"} {
		findings := Card([]byte(raw), CardInput{}).Findings
		if len(findings) != 1 || findings[0].Rule != rule || findings[0].Severity != SeverityError {
			t.Errorf("Card(%q) = %v, want one %s error", raw, findings, rule)
		}
	}
}

func TestFindingsAreSortedBySeverity(t *testing.T) {
	findings := cardFindings(t, edit(t, mustJSON(t, testCard()), func(c map[string]any) {
		c["owner"] = "me"
		delete(c, "name")
		c["supportedInterfaces"] = []any{map[string]any{"url": "http://agent.example.com/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}}
	}))
	rank := map[Severity]int{SeverityError: 0, SeverityWarning: 1, SeverityInfo: 2}
	for i := 1; i < len(findings); i++ {
		if rank[findings[i-1].Severity] > rank[findings[i].Severity] {
			t.Fatalf("findings aren't sorted by severity:\n%s", dump(findings))
		}
	}
}

func TestOperationFindings(t *testing.T) {
	card := map[string]any{"capabilities": map[string]any{"streaming": true, "pushNotifications": false}}
	tests := []struct {
		op      Operation
		version string
		want    string
	}{
		{SendStreamingMessage, "1.0", ""},
		{SubscribeToTask, "1.0", ""},
		{CreateTaskPushNotificationConfig, "1.0", "capabilities.pushNotifications"},
		{GetExtendedAgentCard, "1.0", "capabilities.extendedAgentCard"},
		{GetExtendedAgentCard, "0.3", "supportsAuthenticatedExtendedCard"},
		{ListTasks, "1.0", ""},
		{ListTasks, "0.3", "operation-version"},
	}
	for _, tc := range tests {
		got := OperationFindings(card, tc.version, tc.op)
		switch {
		case tc.want == "" && len(got) > 0:
			t.Errorf("OperationFindings(%s, %s) = %v, want none", tc.op, tc.version, got)
		case tc.want != "" && (len(got) != 1 || (got[0].Path != tc.want && got[0].Rule != tc.want)):
			t.Errorf("OperationFindings(%s, %s) = %v, want one finding for %s", tc.op, tc.version, got, tc.want)
		}
	}
}

func TestFormatPath(t *testing.T) {
	doc := map[string]any{
		"skills":          []any{map[string]any{"tags": []any{"x"}}},
		"securitySchemes": map[string]any{"my key": map[string]any{}, "0": map[string]any{}},
	}
	tests := []struct {
		tokens []string
		want   string
	}{
		{nil, ""},
		{[]string{"skills", "0", "tags", "0"}, "skills[0].tags[0]"},
		{[]string{"securitySchemes", "my key"}, `securitySchemes["my key"]`},
		{[]string{"securitySchemes", "0"}, `securitySchemes["0"]`},
	}
	for _, tc := range tests {
		if got := formatPath(doc, tc.tokens); got != tc.want {
			t.Errorf("formatPath(%v) = %q, want %q", tc.tokens, got, tc.want)
		}
	}
}

func TestDefinitionName(t *testing.T) {
	for url, want := range map[string]string{
		v10SchemaURL + "#/$defs/lf.a2a.v1.AgentCard/properties/name": "lf.a2a.v1.AgentCard",
		v10SchemaURL + "#/%24defs/lf.a2a.v1.SecurityScheme":          "lf.a2a.v1.SecurityScheme",
		v03SchemaURL + "#/definitions/AgentSkill":                    "AgentSkill",
		v03SchemaURL: "",
	} {
		if got := definitionName(url); got != want {
			t.Errorf("definitionName(%q) = %q, want %q", url, got, want)
		}
	}
}
