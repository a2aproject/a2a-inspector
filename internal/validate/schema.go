package validate

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// The schemas are regenerated with scripts/gen-schemas.sh.
var (
	//go:embed schemas/a2a-v0.3.json
	v03SchemaJSON []byte
	//go:embed schemas/a2a-v1.0.json
	v10SchemaJSON []byte
)

// Schema locations. They only identify the embedded documents and are never fetched.
const (
	v03SchemaURL = "https://a2a-inspector.invalid/schemas/a2a-v0.3.json"
	v10SchemaURL = "https://a2a-inspector.invalid/schemas/a2a-v1.0.json"
)

// schemaSet compiles definitions of the embedded schemas on first use.
type schemaSet struct {
	mu       sync.Mutex
	compiler *jsonschema.Compiler
	compiled map[string]*jsonschema.Schema
}

var schemas = sync.OnceValue(func() *schemaSet {
	c := jsonschema.NewCompiler()
	for url, data := range map[string][]byte{v03SchemaURL: v03SchemaJSON, v10SchemaURL: v10SchemaJSON} {
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
		if err != nil {
			panic(fmt.Sprintf("embedded schema %s: %v", url, err))
		}
		if err := c.AddResource(url, doc); err != nil {
			panic(fmt.Sprintf("embedded schema %s: %v", url, err))
		}
	}
	return &schemaSet{compiler: c, compiled: map[string]*jsonschema.Schema{}}
})

// v10Schema returns the v1.0 schema of a message, for example "lf.a2a.v1.Task".
func v10Schema(message string) *jsonschema.Schema {
	return schemas().get(v10SchemaURL + "#/$defs/" + message)
}

// v03Schema returns a definition of the v0.3 schema, for example "Task", or a
// part of one, such as "GetTaskSuccessResponse/properties/result".
func v03Schema(definition string) *jsonschema.Schema {
	return schemas().get(v03SchemaURL + "#/definitions/" + definition)
}

func (s *schemaSet) get(loc string) *jsonschema.Schema {
	s.mu.Lock()
	defer s.mu.Unlock()
	if schema, ok := s.compiled[loc]; ok {
		return schema
	}
	schema, err := s.compiler.Compile(loc)
	if err != nil {
		panic(fmt.Sprintf("compiling %s: %v", loc, err))
	}
	s.compiled[loc] = schema
	return schema
}

var printer = message.NewPrinter(language.English)

// schemaError is one failing keyword.
type schemaError struct {
	tokens []string
	path   string
	// definition is the schema definition the keyword belongs to, for
	// example "lf.a2a.v1.AgentCard" or "AgentSkill".
	definition string
	kind       jsonschema.ErrorKind
}

// schemaErrors validates doc and returns the failing keywords. A failed
// anyOf or oneOf is reported once rather than with every branch's errors.
func schemaErrors(s *jsonschema.Schema, doc any) []schemaError {
	err := s.Validate(doc)
	if err == nil {
		return nil
	}
	var ve *jsonschema.ValidationError
	if !errors.As(err, &ve) {
		return []schemaError{{kind: &kind.Schema{Location: err.Error()}}}
	}
	var out []schemaError
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		switch e.ErrorKind.(type) {
		case *kind.AnyOf, *kind.OneOf:
		default:
			if len(e.Causes) > 0 {
				for _, c := range e.Causes {
					walk(c)
				}
				return
			}
		}
		out = append(out, schemaError{
			tokens:     e.InstanceLocation,
			path:       formatPath(doc, e.InstanceLocation),
			definition: definitionName(e.SchemaURL),
			kind:       e.ErrorKind,
		})
	}
	walk(ve)
	return out
}

// definitionName extracts the definition name from a schema location such as
// ".../a2a-v1.0.json#/$defs/lf.a2a.v1.AgentCard/properties/name".
func definitionName(schemaURL string) string {
	_, frag, _ := strings.Cut(schemaURL, "#")
	for _, prefix := range []string{"/$defs/", "/%24defs/", "/definitions/"} {
		if rest, ok := strings.CutPrefix(frag, prefix); ok {
			name, _, _ := strings.Cut(rest, "/")
			return name
		}
	}
	return ""
}

// findings turns a schema error into findings. A missing-properties error
// becomes one finding per property, at the property's path.
func (e schemaError) findings() []Finding {
	if req, ok := e.kind.(*kind.Required); ok {
		out := make([]Finding, 0, len(req.Missing))
		for _, name := range req.Missing {
			out = append(out, Finding{
				Severity: SeverityError,
				Path:     joinPath(e.path, name),
				Rule:     "required",
				Message:  fmt.Sprintf("Required field %q is missing.", name),
			})
		}
		return out
	}
	return []Finding{{Severity: SeverityError, Path: e.path, Rule: "schema", Message: e.message()}}
}

func (e schemaError) message() string {
	switch k := e.kind.(type) {
	case *kind.Type:
		return fmt.Sprintf("Expected %s, got %s.", strings.Join(k.Want, " or "), k.Got)
	case *kind.Enum:
		return fmt.Sprintf("%v isn't one of the allowed values.", k.Got)
	case *kind.AnyOf, *kind.OneOf:
		if strings.HasSuffix(e.definition, "SecurityScheme") {
			return "Doesn't match any security scheme type."
		}
		return "Doesn't match any of the allowed forms."
	case *kind.MinItems:
		return fmt.Sprintf("Needs at least %d item(s), has %d.", k.Want, k.Got)
	case *kind.AdditionalProperties:
		return fmt.Sprintf("Unknown field(s): %s.", strings.Join(k.Properties, ", "))
	}
	msg := e.kind.LocalizedString(printer)
	if msg == "" {
		return "Doesn't match the schema."
	}
	return strings.ToUpper(msg[:1]) + msg[1:] + "."
}

// schemaFindings validates doc against a schema and returns the findings.
func schemaFindings(s *jsonschema.Schema, doc any) []Finding {
	var out []Finding
	for _, e := range schemaErrors(s, doc) {
		out = append(out, e.findings()...)
	}
	return out
}

// checkV03Card validates a card against the v0.3 JSON Schema.
func checkV03Card(doc any) []Finding {
	return schemaFindings(v03Schema("AgentCard"), doc)
}
