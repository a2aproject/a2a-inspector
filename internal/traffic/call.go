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

package traffic

import (
	"context"
	"sync"
)

// Call ties the exchanges of one inspector operation, such as sending a
// message, to that operation. Attach it to the context of the a2a-go call
// with WithCall; the recording transport and interceptors pick it up.
type Call struct {
	ConnectionID string
	// Secrets are values masked wherever they appear in headers or metadata.
	Secrets []string
	// MessageOverride, if set, replaces the message of the call's request:
	// byte for byte for HTTP bindings, parsed as proto3 JSON for gRPC. A call
	// makes one A2A request, so every POST of it is that request, also when
	// a redirect makes the client send it again.
	MessageOverride []byte
	// OnFrame is called with every server-sent event of the call's responses,
	// as it arrives, on the goroutine reading the response.
	OnFrame func(entryID string, f Frame)
	// OnMessage is called with every gRPC message the server sends.
	OnMessage func(entryID string, m GRPCMessage)

	mu       sync.Mutex
	entryIDs []string
}

type callKey struct{}

// WithCall returns a context that records its exchanges as part of c.
func WithCall(ctx context.Context, c *Call) context.Context {
	return context.WithValue(ctx, callKey{}, c)
}

// CallFrom returns the call attached to ctx, or an empty one.
func CallFrom(ctx context.Context) *Call {
	if c, ok := ctx.Value(callKey{}).(*Call); ok {
		return c
	}
	return &Call{}
}

// LastEntryID returns the ID of the call's latest traffic entry, or "".
func (c *Call) LastEntryID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entryIDs) == 0 {
		return ""
	}
	return c.entryIDs[len(c.entryIDs)-1]
}

func (c *Call) addEntry(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entryIDs = append(c.entryIDs, id)
}

func (c *Call) frame(entryID string, f Frame) {
	if c.OnFrame != nil {
		c.OnFrame(entryID, f)
	}
}

func (c *Call) message(entryID string, m GRPCMessage) {
	if c.OnMessage != nil {
		c.OnMessage(entryID, m)
	}
}
