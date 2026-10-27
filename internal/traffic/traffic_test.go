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
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
)

func parse(chunks ...string) []Frame {
	var frames []Frame
	p := sseParser{emit: func(f Frame) { frames = append(frames, f) }}
	for _, c := range chunks {
		p.feed([]byte(c))
	}
	p.end()
	return frames
}

func TestSSEParser(t *testing.T) {
	t.Parallel()
	ignoreTime := cmpopts.IgnoreFields(Frame{}, "Time")
	tests := []struct {
		name   string
		chunks []string
		want   []Frame
	}{
		{"LF", []string{"data: a\n\ndata: b\n\n"}, []Frame{{Data: "a"}, {Data: "b"}}},
		{"CRLF split across chunks", []string{"data: a\r", "\n\r", "\ndata: b\r\n\r\n"}, []Frame{{Data: "a"}, {Data: "b"}}},
		{"CR only", []string{"data: a\r\rdata: b\r\r"}, []Frame{{Data: "a"}, {Data: "b"}}},
		{"multi-line data, event and id", []string{"event: update\nid: 7\ndata: {\ndata: }\n\n"}, []Frame{{Event: "update", ID: "7", Data: "{\n}"}}},
		{"comments and empty events are skipped", []string{": keep-alive\n\nevent: x\n\ndata: a\n\n"}, []Frame{{Data: "a"}}},
		{"byte order mark", []string{"\xEF\xBB\xBFdata: a\n\n"}, []Frame{{Data: "a"}}},
		{"last event without a blank line", []string{"data: a\n\ndata: b"}, []Frame{{Data: "a"}, {Data: "b"}}},
		{"id persists", []string{"id: 1\ndata: a\n\ndata: b\n\n"}, []Frame{{ID: "1", Data: "a"}, {ID: "1", Data: "b"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if diff := cmp.Diff(tt.want, parse(tt.chunks...), ignoreTime); diff != "" {
				t.Errorf("parse() wrong result (-want +got) diff = %s", diff)
			}
		})
	}
}

func TestSpliceMessage(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, body, raw, want string
	}{
		{
			"JSON-RPC",
			`{"jsonrpc":"2.0","method":"SendMessage","params":{"message":{"messageId":"a"},"configuration":{}},"id":"1"}`,
			"{ \"messageId\" : \"raw\" }",
			`{"jsonrpc":"2.0","method":"SendMessage","params":{"message":{ "messageId" : "raw" },"configuration":{}},"id":"1"}`,
		},
		{
			"HTTP+JSON with spaces",
			`{"message" : {"parts":[{"text":"x"}]}, "metadata":{"message":1}}`,
			`not json at all`,
			`{"message" : not json at all, "metadata":{"message":1}}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := spliceMessage([]byte(tt.body), []byte(tt.raw))
			if err != nil {
				t.Fatalf("spliceMessage() error = %v", err)
			}
			if string(got) != tt.want {
				t.Errorf("spliceMessage() = %s, want %s", got, tt.want)
			}
		})
	}
	if _, err := spliceMessage([]byte(`{"params":{"id":"t-1"}}`), []byte(`{}`)); err == nil {
		t.Error("spliceMessage() without a message: error = nil, want an error")
	}
}

func TestMaskValue(t *testing.T) {
	t.Parallel()
	secrets := []string{"key-12345", "ab"}
	tests := []struct{ name, value, want string }{
		{"Authorization", "Bearer abc.def", "Bearer " + Masked},
		{"authorization", "opaque-token", Masked},
		{"Cookie", "session=1", Masked},
		{"X-Api-Key", "anything", Masked},
		{"X-Custom", "prefix key-12345 suffix", "prefix " + Masked + " suffix"},
		{"X-Short", "ab", Masked},
		{"X-Short", "abc", "abc"},
		{"Content-Type", "application/json", "application/json"},
	}
	for _, tt := range tests {
		if got := MaskValue(tt.name, tt.value, secrets); got != tt.want {
			t.Errorf("MaskValue(%q, %q) = %q, want %q", tt.name, tt.value, got, tt.want)
		}
	}
}

func TestLogSubscribe(t *testing.T) {
	t.Parallel()
	l := NewLog(2)
	first := l.add(&Entry{ConnectionID: "a", HTTP: &HTTPExchange{}})
	snapshot, updates, cancel := l.Subscribe(func(e *Entry) bool { return e.ConnectionID == "a" })
	defer cancel()
	if len(snapshot) != 1 || snapshot[0].ID != first {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	l.add(&Entry{ConnectionID: "b", HTTP: &HTTPExchange{}})
	l.addFrame(first, Frame{Data: "x"})
	l.finish(first, "", nil)

	u := <-updates
	if u.Frame == nil || u.EntryID != first || u.Frame.Data != "x" {
		t.Fatalf("first update = %+v, want the frame (entries of other connections are filtered out)", u)
	}
	u = <-updates
	if u.Entry == nil || !u.Entry.Done() || len(u.Entry.HTTP.SSEFrames) != 1 {
		t.Fatalf("second update = %+v, want the finished entry", u)
	}

	// The buffer keeps two entries.
	l.add(&Entry{HTTP: &HTTPExchange{}})
	if _, ok := l.Get(first); ok {
		t.Error("the oldest entry is still in the log")
	}
}

func TestLogDropsSlowSubscribers(t *testing.T) {
	t.Parallel()
	l := NewLog(0)
	id := l.add(&Entry{HTTP: &HTTPExchange{}})
	_, updates, cancel := l.Subscribe(nil)
	defer cancel()
	for range subscriberQueue + 1 {
		l.addFrame(id, Frame{Data: "x"})
	}
	n := 0
	for range updates {
		n++
	}
	if n != subscriberQueue {
		t.Errorf("got %d updates before the channel closed, want %d", n, subscriberQueue)
	}
}

func TestTransportOverrideAfterRedirect(t *testing.T) {
	t.Parallel()
	var got string
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/a2a" {
			http.Redirect(w, r, "/a2a/", http.StatusTemporaryRedirect)
			return
		}
		b, _ := io.ReadAll(r.Body)
		got = string(b)
	}))
	defer agent.Close()
	client := &http.Client{Transport: &Transport{Log: NewLog(0)}}
	ctx := WithCall(context.Background(), &Call{MessageOverride: []byte(`{"raw":1}`)})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, agent.URL+"/a2a", strings.NewReader(`{"message":{"placeholder":1}}`))
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if got != `{"message":{"raw":1}}` {
		t.Errorf("the agent got %s after the redirect, want the raw message", got)
	}
}

func TestTransport(t *testing.T) {
	t.Parallel()
	agent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/stream":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: one\n\n")
			w.(http.Flusher).Flush()
			_, _ = io.WriteString(w, "data: two\n\n")
		case "/error":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTeapot)
			_, _ = io.WriteString(w, `{"error":{"message":"no"}}`)
		}
	}))
	defer agent.Close()
	l := NewLog(0)
	client := &http.Client{Transport: &Transport{Log: l}}

	var frames []string
	call := &Call{ConnectionID: "c", Secrets: []string{"s3cret"}, OnFrame: func(_ string, f Frame) { frames = append(frames, f.Data) }}
	ctx := WithCall(context.Background(), call)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, agent.URL+"/stream", strings.NewReader(`{"a":1}`))
	req.Header.Set("X-Token", "s3cret")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if body, _ := io.ReadAll(resp.Body); !strings.Contains(string(body), "data: two") {
		t.Errorf("the client got %q, want the whole stream", body)
	}
	_ = resp.Body.Close()
	if diff := cmp.Diff([]string{"one", "two"}, frames); diff != "" {
		t.Errorf("frames (-want +got) diff = %s", diff)
	}
	e, _ := l.Get(call.LastEntryID())
	if !e.Done() || e.ConnectionID != "c" || len(e.HTTP.SSEFrames) != 2 || e.HTTP.RequestBody != `{"a":1}` || e.Error != "" {
		t.Errorf("entry = %+v %+v", e, e.HTTP)
	}
	for _, h := range e.HTTP.RequestHeaders {
		if h.Name == "X-Token" && h.Value != Masked {
			t.Errorf("X-Token recorded as %q", h.Value)
		}
	}

	// The body of an error response is recorded even though nobody reads it.
	call = &Call{}
	req, _ = http.NewRequestWithContext(WithCall(context.Background(), call), http.MethodGet, agent.URL+"/error", nil)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	e, _ = l.Get(call.LastEntryID())
	if !e.Done() || e.HTTP.Status != http.StatusTeapot || e.HTTP.ResponseBody != `{"error":{"message":"no"}}` {
		t.Errorf("entry = %+v", e.HTTP)
	}

	// Without a response, the entry has the error.
	call = &Call{}
	req, _ = http.NewRequestWithContext(WithCall(context.Background(), call), http.MethodGet, "http://127.0.0.1:1", nil)
	if _, err := client.Do(req); err == nil {
		t.Fatal("Do() error = nil, want a connection error")
	}
	e, _ = l.Get(call.LastEntryID())
	if !e.Done() || e.Error == "" || time.Since(e.StartTime) > time.Minute {
		t.Errorf("entry = %+v", e)
	}
}
