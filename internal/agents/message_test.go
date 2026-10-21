package agents

import (
	"strings"
	"testing"
)

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
