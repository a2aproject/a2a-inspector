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
	"regexp"

	"github.com/a2aproject/a2a-inspector/internal/agents"
)

// Field hints for schema and required-field findings.
var (
	commonHints = map[string]string{
		"name":                  `A string, for example "name": "My Agent".`,
		"version":               `A string, for example "version": "1.0.0".`,
		"description":           "A string describing what the agent does.",
		"capabilities":          `An object, for example "capabilities": {"streaming": false}.`,
		"skills":                `An array, for example "skills": [{"id": "echo", "name": "Echo", "description": "Echoes back", "tags": ["echo"]}].`,
		"skills[*].id":          "Each skill needs a string id.",
		"skills[*].name":        "Each skill needs a string name.",
		"skills[*].description": "Each skill needs a string description.",
		"skills[*].tags":        `Each skill needs a tags array, for example "tags": ["echo"].`,
		"defaultInputModes":     `An array of media types, for example "defaultInputModes": ["text/plain"].`,
		"defaultOutputModes":    `An array of media types, for example "defaultOutputModes": ["text/plain"].`,
		"provider.organization": "The provider's organization name, as a string.",
		"provider.url":          "The provider's website, as a URL string.",
	}
	v03Hints = map[string]string{
		"url":             `The agent's main interface URL, for example "url": "https://agent.example.com/a2a".`,
		"protocolVersion": `A string, for example "protocolVersion": "0.3.0".`,
	}
	v10Hints = map[string]string{
		"supportedInterfaces":                    `An array, for example "supportedInterfaces": [{"url": "https://agent.example.com/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}].`,
		"supportedInterfaces[*].url":             "Each interface needs a URL string.",
		"supportedInterfaces[*].protocolBinding": `Each interface needs a protocolBinding: "JSONRPC", "HTTP+JSON" or "GRPC".`,
		"supportedInterfaces[*].protocolVersion": `Each interface needs a protocolVersion, for example "1.0".`,
	}
)

var indexRE = regexp.MustCompile(`\[\d+\]`)

func addHint(f *Finding, version string) {
	if f.Rule != "schema" && f.Rule != "required" {
		return
	}
	key := indexRE.ReplaceAllString(f.Path, "[*]")
	versionHints := v10Hints
	if version == agents.Version03 {
		versionHints = v03Hints
	}
	if hint, ok := versionHints[key]; ok {
		f.Hint = hint
	} else if hint, ok := commonHints[key]; ok {
		f.Hint = hint
	}
}
