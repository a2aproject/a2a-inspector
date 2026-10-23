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

package agents

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2aclient"
)

func TestParamsInterceptorTenant(t *testing.T) {
	t.Parallel()
	p := &ParamsInterceptor{Tenant: "acme"}
	requests := []any{
		&a2a.SendMessageRequest{}, &a2a.GetTaskRequest{}, &a2a.ListTasksRequest{}, &a2a.CancelTaskRequest{},
		&a2a.SubscribeToTaskRequest{}, &a2a.PushConfig{}, &a2a.GetTaskPushConfigRequest{},
		&a2a.ListTaskPushConfigRequest{}, &a2a.DeleteTaskPushConfigRequest{}, &a2a.GetExtendedAgentCardRequest{},
	}
	for _, payload := range requests {
		if _, _, err := p.Before(context.Background(), &a2aclient.Request{Payload: payload, ServiceParams: a2aclient.ServiceParams{}}); err != nil {
			t.Fatal(err)
		}
		if got := reflectTenant(payload); got != "acme" {
			t.Errorf("%T tenant = %q, want acme", payload, got)
		}
	}
}

// reflectTenant reads the Tenant field every A2A request type has.
func reflectTenant(payload any) string {
	return reflect.ValueOf(payload).Elem().FieldByName("Tenant").String()
}

func TestComposeMessage(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		compose Compose
		parts   int
		wantErr string
	}{
		{name: "text, file and data", compose: Compose{Text: "hi", Attachments: []Attachment{{Name: "a.txt", Bytes: []byte("a")}, {URL: "https://x/b"}}, Data: []byte(`{"k":1}`)}, parts: 4},
		{name: "empty", compose: Compose{}, wantErr: "empty"},
		{name: "empty attachment", compose: Compose{Attachments: []Attachment{{Name: "a.txt"}}}, wantErr: "attachment 1 is empty"},
		{name: "attachment with bytes and URL", compose: Compose{Attachments: []Attachment{{Bytes: []byte("a"), URL: "https://x"}}}, wantErr: "both bytes and a URL"},
		{name: "invalid data", compose: Compose{Data: []byte(`{`)}, wantErr: "isn't valid JSON"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			msg, err := tt.compose.Message()
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("Message() error = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Message() error = %v", err)
			}
			if len(msg.Parts) != tt.parts {
				t.Errorf("Message() has %d parts, want %d", len(msg.Parts), tt.parts)
			}
		})
	}
}
