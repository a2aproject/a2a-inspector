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

// Package v03spec reconciles A2A v0.3 proto JSON as the specification and
// v0.3 peers write it with the a2a-go v0.3.15 stubs the inspector uses. The
// v0.3.0 specification names the parts of a2a.v1.Message "content"; the
// stubs name the same field (number 5) "parts". Binary gRPC is unaffected.
package v03spec

import (
	"encoding/json"

	"google.golang.org/protobuf/reflect/protoreflect"
)

const messageParts protoreflect.FullName = "a2a.v1.Message.parts"

// specName is the specification's JSON name for the field the stubs call parts.
const specName = "content"

// JSONName returns a field's JSON name as the v0.3 specification writes it.
func JSONName(fd protoreflect.FieldDescriptor) string {
	if fd.FullName() == messageParts {
		return specName
	}
	return fd.JSONName()
}

// Name returns a field's proto name as the v0.3 specification writes it.
func Name(fd protoreflect.FieldDescriptor) string {
	if fd.FullName() == messageParts {
		return specName
	}
	return string(fd.Name())
}

// ToSpec rewrites proto JSON of a v0.3 message, as protojson writes it from
// the stubs, with the specification's field names.
func ToSpec(md protoreflect.MessageDescriptor, data []byte) []byte {
	return rewrite(md, data, false)
}

// ToStub rewrites proto JSON of a v0.3 message, as the specification writes
// it, with the stubs' field names, so protojson can parse it.
func ToStub(md protoreflect.MessageDescriptor, data []byte) []byte {
	return rewrite(md, data, true)
}

func rewrite(md protoreflect.MessageDescriptor, data []byte, toStub bool) []byte {
	if md.ParentFile().Package() != "a2a.v1" {
		return data
	}
	var doc any
	if err := json.Unmarshal(data, &doc); err != nil {
		return data
	}
	if !rename(md, doc, toStub) {
		return data
	}
	out, err := json.Marshal(doc)
	if err != nil {
		return data
	}
	return out
}

// rename walks doc along md and renames the parts field of every Message.
// It reports whether it renamed anything.
func rename(md protoreflect.MessageDescriptor, doc any, toStub bool) bool {
	obj, ok := doc.(map[string]any)
	if !ok {
		return false
	}
	changed := false
	fields := md.Fields()
	for i := range fields.Len() {
		fd := fields.Get(i)
		key := fd.JSONName()
		if fd.FullName() == messageParts {
			from, to := fd.JSONName(), specName
			if toStub {
				from, to = to, from
			}
			if v, found := obj[from]; found {
				if _, taken := obj[to]; !taken {
					delete(obj, from)
					obj[to] = v
					changed = true
				}
			}
			key = to
		}
		v, found := obj[key]
		if !found {
			v, found = obj[string(fd.Name())]
		}
		if !found || fd.Kind() != protoreflect.MessageKind {
			continue
		}
		switch {
		case fd.IsMap():
			if m, ok := v.(map[string]any); ok && fd.MapValue().Message() != nil {
				for _, item := range m {
					changed = rename(fd.MapValue().Message(), item, toStub) || changed
				}
			}
		case fd.IsList():
			if list, ok := v.([]any); ok {
				for _, item := range list {
					changed = rename(fd.Message(), item, toStub) || changed
				}
			}
		default:
			changed = rename(fd.Message(), v, toStub) || changed
		}
	}
	return changed
}
