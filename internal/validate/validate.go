// Package validate checks A2A payloads against the specification. It runs in
// the backend, once per payload, and reports findings the UI shows as badges.
//
// v0.3 payloads are checked against the spec's JSON Schema. v1.0 payloads are
// checked against the JSON Schema generated from a2a.proto, against the
// proto's REQUIRED field annotations, and by parsing them with protojson into
// the generated lf.a2a.v1 types. Agent cards also get semantic checks.
package validate

import (
	"bytes"
	"cmp"
	"fmt"
	"mime"
	"slices"
	"strconv"
	"strings"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

// Severity of a finding.
type Severity string

const (
	// SeverityError marks a violation of a MUST in the specification.
	SeverityError Severity = "ERROR"
	// SeverityWarning marks a likely problem: a SHOULD, or something clients may trip over.
	SeverityWarning Severity = "WARNING"
	// SeverityInfo marks something worth knowing that isn't wrong.
	SeverityInfo Severity = "INFO"
)

// Finding is one validation result.
type Finding struct {
	Severity Severity `json:"severity"`
	// Path locates the value in the payload, for example "skills[0].tags".
	// It's empty for the payload as a whole.
	Path    string `json:"path"`
	Rule    string `json:"rule"`
	Message string `json:"message"`
	// Hint suggests a fix, with an example where one helps.
	Hint string `json:"hint,omitempty"`
	// ProtocolVersion is set when a card is checked as both v1.0 and v0.3,
	// and tells which of the two checks reported the finding.
	ProtocolVersion string `json:"protocolVersion,omitempty"`
}

// Report is the result of validating one payload.
type Report struct {
	// Findings are ordered by severity, errors first, and then by path.
	Findings []Finding `json:"findings"`
}

// CardInput tells Card how to read an agent card.
type CardInput struct {
	// Info is the card's format and interfaces, from agents.DescribeCard.
	Info agents.CardInfo
	// FetchedFrom is the URL the card was fetched from. It's empty for a card
	// written in the editor.
	FetchedFrom string
	// ContentType is the Content-Type the card was served with. It's only
	// checked when FetchedFrom is set.
	ContentType string
}

// Card validates an agent card in every format it carries.
func Card(raw []byte, in CardInput) Report {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return newReport([]Finding{{Severity: SeverityError, Rule: "json", Message: "The card isn't valid JSON: " + err.Error()}})
	}
	card, ok := doc.(map[string]any)
	if !ok {
		return newReport([]Finding{{Severity: SeverityError, Rule: "card-object", Message: "An agent card must be a JSON object."}})
	}

	var findings []Finding
	if in.FetchedFrom != "" {
		findings = append(findings, contentTypeFindings(in.ContentType)...)
	}
	if !in.Info.VersionDetected {
		findings = append(findings, Finding{
			Severity: SeverityInfo,
			Rule:     "protocol-version",
			Message:  "The card has neither supportedInterfaces (v1.0) nor url (v0.3), so it's checked as a v1.0 card.",
		})
	}
	both := len(in.Info.Versions) > 1
	for _, version := range in.Info.Versions {
		var vf []Finding
		switch version {
		case agents.Version10:
			vf = checkV10Card(raw, doc, both)
		case agents.Version03:
			vf = checkV03Card(doc)
		}
		for i := range vf {
			if both {
				vf[i].ProtocolVersion = version
			}
			addHint(&vf[i], cmp.Or(vf[i].ProtocolVersion, in.Info.ProtocolVersion))
		}
		findings = append(findings, vf...)
	}
	findings = append(findings, cardSemantics(card, in)...)
	return newReport(findings)
}

func newReport(findings []Finding) Report {
	rank := map[Severity]int{SeverityError: 0, SeverityWarning: 1, SeverityInfo: 2}
	slices.SortStableFunc(findings, func(a, b Finding) int {
		return cmp.Or(rank[a.Severity]-rank[b.Severity], strings.Compare(a.Path, b.Path))
	})
	if findings == nil {
		findings = []Finding{}
	}
	return Report{Findings: findings}
}

func contentTypeFindings(contentType string) []Finding {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err == nil && (mediaType == "application/json" || strings.HasSuffix(mediaType, "+json")) {
		return nil
	}
	msg := "The card was served without a Content-Type."
	if contentType != "" {
		msg = fmt.Sprintf("The card was served as %q.", contentType)
	}
	return []Finding{{
		Severity: SeverityWarning,
		Rule:     "content-type",
		Message:  msg + " Serve it as application/json.",
	}}
}

// joinPath appends an object key to a path.
func joinPath(path, key string) string {
	if isIdentifier(key) {
		if path == "" {
			return key
		}
		return path + "." + key
	}
	return path + "[" + strconv.Quote(key) + "]"
}

func indexPath(path string, i int) string {
	return path + "[" + strconv.Itoa(i) + "]"
}

func isIdentifier(s string) bool {
	if s == "" || (s[0] >= '0' && s[0] <= '9') {
		return false
	}
	for _, r := range s {
		if !(r == '_' || r == '-' || r == '$' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// formatPath turns a JSON Pointer's tokens into a path, using the document to
// tell array indexes from object keys.
func formatPath(doc any, tokens []string) string {
	path := ""
	cur := doc
	for _, tok := range tokens {
		switch c := cur.(type) {
		case []any:
			i, err := strconv.Atoi(tok)
			if err != nil || i < 0 || i >= len(c) {
				path, cur = joinPath(path, tok), nil
				continue
			}
			path, cur = indexPath(path, i), c[i]
		case map[string]any:
			path, cur = joinPath(path, tok), c[tok]
		default:
			path, cur = joinPath(path, tok), nil
		}
	}
	return path
}

func str(v any) string {
	s, _ := v.(string)
	return s
}
