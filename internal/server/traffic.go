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
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/traffic"
)

const keepAliveInterval = 20 * time.Second

// handleTraffic streams the traffic log as server-sent events: a "snapshot"
// of the entries so far, then "entry" events that replace an entry, and
// "frame" and "message" events that append an SSE frame or a gRPC message to
// one. The stream ends when the UI falls behind; it then reconnects.
func (s *Server) handleTraffic(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming isn't supported by this server.")
		return
	}
	var filter func(*traffic.Entry) bool
	if id := r.URL.Query().Get("connectionId"); id != "" {
		filter = func(e *traffic.Entry) bool { return e.ConnectionID == id }
	}
	snapshot, updates, cancel := s.traffic.Subscribe(filter)
	defer cancel()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if snapshot == nil {
		snapshot = []*traffic.Entry{}
	}
	if !writeEvent(w, "snapshot", map[string]any{"entries": snapshot}) {
		return
	}
	flusher.Flush()

	keepAlive := time.NewTicker(keepAliveInterval)
	defer keepAlive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case <-keepAlive.C:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
		case u, ok := <-updates:
			if !ok {
				return
			}
			var written bool
			switch {
			case u.Entry != nil:
				written = writeEvent(w, "entry", u.Entry)
			case u.Frame != nil:
				written = writeEvent(w, "frame", map[string]any{"entryId": u.EntryID, "frame": u.Frame})
			case u.Message != nil:
				written = writeEvent(w, "message", map[string]any{"entryId": u.EntryID, "message": u.Message})
			}
			if !written {
				return
			}
		}
		flusher.Flush()
	}
}

func writeEvent(w http.ResponseWriter, event string, v any) bool {
	data, err := json.Marshal(v)
	if err != nil {
		return false
	}
	_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
	return err == nil
}
