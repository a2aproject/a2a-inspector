package validate

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"

	// The v0.3 (a2a.v1) and v1.0 (lf.a2a.v1) messages, looked up by name.
	_ "github.com/a2aproject/a2a-go/a2apb"
	_ "github.com/a2aproject/a2a-go/v2/a2apb/v1"
	"github.com/a2aproject/a2a-inspector/internal/v03spec"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"google.golang.org/genproto/googleapis/api/annotations"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
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
	return checkV10(raw, doc, "lf.a2a.v1.AgentCard", withV03)
}

// checkV10 validates a payload as the v1.0 message with the given full name:
// against its JSON Schema, its REQUIRED fields and oneofs, and by parsing it
// with protojson.
func checkV10(raw []byte, doc any, message string, withV03 bool) []Finding {
	mt, err := protoregistry.GlobalTypes.FindMessageByName(protoreflect.FullName(message))
	if err != nil {
		panic(fmt.Sprintf("unknown message %s: %v", message, err))
	}
	var out []Finding
	var compat []string
	for _, e := range schemaErrors(v10Schema(message), doc) {
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

	checkMessage(mt.Descriptor(), doc, "", false, &out)
	return append(out, parseFindings(raw, mt, out)...)
}

// checkV03Proto validates a payload as the v0.3 proto message (package
// a2a.v1) with the given full name, as v0.3 HTTP+JSON and gRPC send them.
// v0.3 has no JSON Schema for this form.
func checkV03Proto(raw []byte, doc any, message string) []Finding {
	mt, err := protoregistry.GlobalTypes.FindMessageByName(protoreflect.FullName(message))
	if err != nil {
		panic(fmt.Sprintf("unknown message %s: %v", message, err))
	}
	var out []Finding
	checkMessage(mt.Descriptor(), doc, "", true, &out)
	return append(out, parseFindings(v03spec.ToStub(mt.Descriptor(), raw), mt, out)...)
}

// parseFindings parses raw with protojson. The schema doesn't express
// everything protojson enforces, such as oneofs with more than one member
// set. It's skipped when earlier checks found errors, since protojson stops
// at the first problem and would repeat one of them.
func parseFindings(raw []byte, mt protoreflect.MessageType, earlier []Finding) []Finding {
	if slices.ContainsFunc(earlier, func(f Finding) bool { return f.Severity == SeverityError }) {
		return nil
	}
	// Unknown fields are reported already. Dropping them, rather than
	// passing DiscardUnknown, keeps the check on enum names, which
	// DiscardUnknown also skips.
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	pruneUnknown(mt.Descriptor(), doc)
	pruned, err := json.Marshal(doc)
	if err != nil {
		return nil
	}
	if err := protojson.Unmarshal(pruned, mt.New().Interface()); err != nil {
		return []Finding{{
			Severity: SeverityError,
			Rule:     "proto",
			Message:  fmt.Sprintf("It doesn't parse as %s: %s.", mt.Descriptor().FullName(), strings.TrimPrefix(err.Error(), "proto: ")),
		}}
	}
	return nil
}

// pruneUnknown deletes the keys of a JSON document that aren't fields of the
// message, at every level.
func pruneUnknown(md protoreflect.MessageDescriptor, v any) {
	obj, ok := v.(map[string]any)
	if !ok || md.ParentFile().Package() == "google.protobuf" {
		return
	}
	for key, val := range obj {
		fd := md.Fields().ByJSONName(key)
		if fd == nil {
			fd = md.Fields().ByName(protoreflect.Name(key))
		}
		switch {
		case fd == nil:
			delete(obj, key)
		case fd.IsMap():
			if m, ok := val.(map[string]any); ok && fd.MapValue().Message() != nil {
				for _, item := range m {
					pruneUnknown(fd.MapValue().Message(), item)
				}
			}
		case fd.Message() == nil:
		case fd.IsList():
			if list, ok := val.([]any); ok {
				for _, item := range list {
					pruneUnknown(fd.Message(), item)
				}
			}
		default:
			pruneUnknown(fd.Message(), val)
		}
	}
}

// checkMessage walks a JSON object along a message descriptor and reports
// missing REQUIRED fields, oneofs with no member set, and fields written
// with their proto (snake_case) name instead of their JSON name. With v03
// set, the object is v0.3 proto JSON: field names follow the v0.3
// specification, and keys that aren't fields of the message are reported,
// since v0.3 has no JSON Schema for this form that would.
func checkMessage(md protoreflect.MessageDescriptor, v any, path string, v03 bool, out *[]Finding) {
	obj, ok := v.(map[string]any)
	if !ok || md.ParentFile().Package() == "google.protobuf" {
		return
	}
	jsonName := protoreflect.FieldDescriptor.JSONName
	protoName := func(fd protoreflect.FieldDescriptor) string { return string(fd.Name()) }
	if v03 {
		jsonName, protoName = v03spec.JSONName, v03spec.Name
	}
	checkOneofs(md, obj, path, out)
	if v03 {
		known := map[string]bool{}
		for i := range md.Fields().Len() {
			fd := md.Fields().Get(i)
			known[jsonName(fd)], known[protoName(fd)] = true, true
		}
		for _, key := range slices.Sorted(maps.Keys(obj)) {
			if !known[key] {
				*out = append(*out, Finding{
					Severity: SeverityWarning,
					Path:     joinPath(path, key),
					Rule:     "unknown-field",
					Message:  fmt.Sprintf("%q isn't a field of %s. Clients ignore unknown fields.", key, md.Name()),
				})
			}
		}
	}
	fields := md.Fields()
	for i := range fields.Len() {
		fd := fields.Get(i)
		key := jsonName(fd)
		val, found := obj[key]
		if protoName := protoName(fd); !found && protoName != key {
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
			for _, k := range slices.Sorted(maps.Keys(m)) {
				checkMessage(fd.MapValue().Message(), m[k], joinPath(fieldPath, k), v03, out)
			}
		case fd.Message() == nil:
		case fd.IsList():
			list, _ := val.([]any)
			for i, item := range list {
				checkMessage(fd.Message(), item, indexPath(fieldPath, i), v03, out)
			}
		default:
			checkMessage(fd.Message(), val, fieldPath, v03, out)
		}
	}
}

// checkOneofs reports oneofs with none of their members set. Every oneof in
// the A2A protos holds the content of its message, such as a part's text,
// file or data, so one member is always needed. More than one is reported by
// protojson.
func checkOneofs(md protoreflect.MessageDescriptor, obj map[string]any, path string, out *[]Finding) {
	oneofs := md.Oneofs()
	for i := range oneofs.Len() {
		od := oneofs.Get(i)
		if od.IsSynthetic() {
			continue
		}
		var names []string
		set := false
		fields := od.Fields()
		for j := range fields.Len() {
			fd := fields.Get(j)
			names = append(names, fd.JSONName())
			if v, ok := obj[fd.JSONName()]; ok && v != nil {
				set = true
			} else if v, ok := obj[string(fd.Name())]; ok && v != nil {
				set = true
			}
		}
		if !set {
			*out = append(*out, Finding{
				Severity: SeverityError,
				Path:     path,
				Rule:     "oneof",
				Message:  fmt.Sprintf("%s needs one of %s.", md.Name(), quoteList(names)),
			})
		}
	}
}

func quoteList(names []string) string {
	quoted := make([]string, len(names))
	for i, n := range names {
		quoted[i] = strconv.Quote(n)
	}
	if len(quoted) <= 2 {
		return strings.Join(quoted, " or ")
	}
	return strings.Join(quoted[:len(quoted)-1], ", ") + " or " + quoted[len(quoted)-1]
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
