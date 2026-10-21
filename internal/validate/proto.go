package validate

import (
	"fmt"
	"slices"
	"strings"

	a2apb "github.com/a2aproject/a2a-go/v2/a2apb/v1"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"google.golang.org/genproto/googleapis/api/annotations"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/descriptorpb"
)

// v03Fields lists, per v1.0 message, the v0.3 fields a card can carry for
// v0.3 clients, as a2a-go's compat card producer writes them.
var v03Fields = map[string][]string{
	"lf.a2a.v1.AgentCard":         {"url", "preferredTransport", "additionalInterfaces", "protocolVersion", "supportsAuthenticatedExtendedCard", "security"},
	"lf.a2a.v1.AgentCapabilities": {"stateTransitionHistory"},
	"lf.a2a.v1.AgentSkill":        {"security"},
	"lf.a2a.v1.SecurityScheme":    {"type", "description", "in", "name", "scheme", "bearerFormat", "flows", "openIdConnectUrl", "oauth2MetadataUrl"},
}

// checkV10Card validates a card as a v1.0 AgentCard. withV03 is set when the
// card also carries v0.3 fields, which are then listed instead of reported
// as unknown.
func checkV10Card(raw []byte, doc any, withV03 bool) []Finding {
	var out []Finding
	var compat []string
	for _, e := range schemaErrors(schemas().v10Card, doc) {
		ap, ok := e.kind.(*kind.AdditionalProperties)
		if !ok {
			out = append(out, e.findings()...)
			continue
		}
		for _, name := range slices.Sorted(slices.Values(ap.Properties)) {
			path := joinPath(e.path, name)
			if withV03 && slices.Contains(v03Fields[e.definition], name) {
				compat = append(compat, path)
				continue
			}
			out = append(out, Finding{
				Severity: SeverityWarning,
				Path:     path,
				Rule:     "unknown-field",
				Message:  fmt.Sprintf("%q isn't a field of %s. Clients ignore unknown fields.", name, shortName(e.definition)),
			})
		}
	}
	if len(compat) > 0 {
		slices.Sort(compat)
		out = append(out, Finding{
			Severity: SeverityInfo,
			Rule:     "v03-fields",
			Message:  "The card also carries v0.3 fields for v0.3 clients: " + strings.Join(compat, ", ") + ".",
		})
	}

	desc := (&a2apb.AgentCard{}).ProtoReflect().Descriptor()
	checkMessage(desc, doc, "", &out)

	// The schema doesn't express everything protojson enforces, such as
	// oneofs with more than one member set. Skip it when the schema already
	// failed, since protojson stops at the first problem and would repeat it.
	if !slices.ContainsFunc(out, func(f Finding) bool { return f.Severity == SeverityError }) {
		if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(raw, &a2apb.AgentCard{}); err != nil {
			out = append(out, Finding{
				Severity: SeverityError,
				Rule:     "proto",
				Message:  fmt.Sprintf("The card doesn't parse as %s: %s.", desc.FullName(), strings.TrimPrefix(err.Error(), "proto: ")),
			})
		}
	}
	return out
}

// checkMessage walks a JSON object along a message descriptor and reports
// missing REQUIRED fields and fields written with their proto (snake_case)
// name instead of their JSON name.
func checkMessage(md protoreflect.MessageDescriptor, v any, path string, out *[]Finding) {
	obj, ok := v.(map[string]any)
	if !ok || md.ParentFile().Package() == "google.protobuf" {
		return
	}
	fields := md.Fields()
	for i := range fields.Len() {
		fd := fields.Get(i)
		key := fd.JSONName()
		val, found := obj[key]
		if protoName := string(fd.Name()); !found && protoName != key {
			if val, found = obj[protoName]; found {
				*out = append(*out, Finding{
					Severity: SeverityWarning,
					Path:     joinPath(path, protoName),
					Rule:     "camel-case",
					Message:  fmt.Sprintf("JSON field names are camelCase: use %q.", key),
				})
				key = protoName
			}
		}
		fieldPath := joinPath(path, key)
		if isRequired(fd) {
			switch {
			case !found || val == nil:
				*out = append(*out, Finding{
					Severity: SeverityError,
					Path:     fieldPath,
					Rule:     "required",
					Message:  fmt.Sprintf("Required field %q is missing.", key),
				})
			case fd.IsList() && isEmptyList(val):
				*out = append(*out, Finding{
					Severity: SeverityError,
					Path:     fieldPath,
					Rule:     "required",
					Message:  fmt.Sprintf("Required list %q must have at least one item.", key),
				})
			case fd.Kind() == protoreflect.StringKind && !fd.IsList() && val == "":
				*out = append(*out, Finding{
					Severity: SeverityWarning,
					Path:     fieldPath,
					Rule:     "required-empty",
					Message:  fmt.Sprintf("Required field %q is empty.", key),
				})
			}
		}
		if !found {
			continue
		}
		switch {
		case fd.IsMap():
			if fd.MapValue().Message() == nil {
				continue
			}
			m, _ := val.(map[string]any)
			for _, k := range sortedKeys(m) {
				checkMessage(fd.MapValue().Message(), m[k], joinPath(fieldPath, k), out)
			}
		case fd.Message() == nil:
		case fd.IsList():
			list, _ := val.([]any)
			for i, item := range list {
				checkMessage(fd.Message(), item, indexPath(fieldPath, i), out)
			}
		default:
			checkMessage(fd.Message(), val, fieldPath, out)
		}
	}
}

func isRequired(fd protoreflect.FieldDescriptor) bool {
	opts, ok := fd.Options().(*descriptorpb.FieldOptions)
	if !ok || opts == nil {
		return false
	}
	behaviors, _ := proto.GetExtension(opts, annotations.E_FieldBehavior).([]annotations.FieldBehavior)
	return slices.Contains(behaviors, annotations.FieldBehavior_REQUIRED)
}

func isEmptyList(v any) bool {
	list, ok := v.([]any)
	return ok && len(list) == 0
}

// shortName turns "lf.a2a.v1.AgentCard" into "AgentCard".
func shortName(fullName string) string {
	if i := strings.LastIndexByte(fullName, '.'); i >= 0 {
		return fullName[i+1:]
	}
	return fullName
}
