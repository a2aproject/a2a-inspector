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

package server

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"unicode/utf8"

	"github.com/a2aproject/a2a-inspector/internal/traffic"
)

// secretInput is a credential as the UI sends it: exactly one of a value
// kept in backend memory for the session, an environment variable read on
// every call, or a reference to a secret stored earlier.
type secretInput struct {
	Value  *string `json:"value,omitempty"`
	EnvVar string  `json:"envVar,omitempty"`
	Ref    string  `json:"ref,omitempty"`
}

// secretView is how the UI sees a stored secret: never its value.
type secretView struct {
	Ref    string `json:"ref"`
	Masked string `json:"masked"`
	EnvVar string `json:"envVar,omitempty"`
}

type secret struct {
	value  string
	envVar string
}

// secretStore keeps the secrets of the session in memory.
type secretStore struct {
	// allowEnv lets secrets refer to the inspector's environment variables.
	// A shared inspector's environment holds the operator's secrets.
	allowEnv bool
	mu       sync.Mutex
	next     int
	items    map[string]secret
}

func newSecretStore(allowEnv bool) *secretStore {
	return &secretStore{allowEnv: allowEnv, items: map[string]secret{}}
}

// store keeps a secret and returns how to show it. A reference returns the
// secret it refers to.
func (s *secretStore) store(in secretInput) (secretView, error) {
	set := 0
	for _, ok := range []bool{in.Value != nil, in.EnvVar != "", in.Ref != ""} {
		if ok {
			set++
		}
	}
	if set != 1 {
		return secretView{}, errors.New(`a secret needs exactly one of "value", "envVar" and "ref"`)
	}
	if in.Ref != "" {
		return s.view(in.Ref)
	}
	if in.EnvVar != "" && !s.allowEnv {
		return secretView{}, errors.New("a shared inspector can't read its environment variables; enter the value instead")
	}
	sec := secret{envVar: in.EnvVar}
	if in.Value != nil {
		sec.value = *in.Value
	} else if _, ok := os.LookupEnv(in.EnvVar); !ok {
		return secretView{}, fmt.Errorf("the environment variable %s isn't set in the inspector's environment", in.EnvVar)
	}
	s.mu.Lock()
	s.next++
	ref := "sec-" + strconv.Itoa(s.next)
	s.items[ref] = sec
	s.mu.Unlock()
	return s.view(ref)
}

func (s *secretStore) view(ref string) (secretView, error) {
	value, err := s.resolve(ref)
	if err != nil {
		return secretView{}, err
	}
	s.mu.Lock()
	envVar := s.items[ref].envVar
	s.mu.Unlock()
	return secretView{Ref: ref, Masked: mask(value), EnvVar: envVar}, nil
}

// resolve returns a secret's value, reading environment variables now.
func (s *secretStore) resolve(ref string) (string, error) {
	s.mu.Lock()
	sec, ok := s.items[ref]
	s.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("unknown secret %q", ref)
	}
	if sec.envVar == "" {
		return sec.value, nil
	}
	v, ok := os.LookupEnv(sec.envVar)
	if !ok {
		return "", fmt.Errorf("the environment variable %s isn't set in the inspector's environment", sec.envVar)
	}
	return v, nil
}

// mask shows the last four characters of long secrets, so users can tell
// them apart, and nothing of short ones.
func mask(value string) string {
	if utf8.RuneCountInString(value) < 16 {
		return traffic.Masked
	}
	runes := []rune(value)
	return traffic.Masked + string(runes[len(runes)-4:])
}
