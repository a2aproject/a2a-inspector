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
	"bytes"
	"strings"
	"time"
)

// sseParser splits a text/event-stream into events as bytes arrive. Lines
// may end with "\n", "\r\n" or "\r", and chunks may split them anywhere.
type sseParser struct {
	emit      func(Frame)
	buf       []byte
	started   bool
	pendingCR bool
	data      []string
	event     string
	lastID    string
}

func (p *sseParser) feed(chunk []byte) {
	if !p.started && len(chunk) > 0 {
		p.started = true
		chunk = bytes.TrimPrefix(chunk, []byte("\xEF\xBB\xBF"))
	}
	if p.pendingCR {
		// The previous chunk ended with "\r"; a "\n" here is part of the same line ending.
		p.pendingCR = false
		chunk = bytes.TrimPrefix(chunk, []byte("\n"))
	}
	p.buf = append(p.buf, chunk...)
	start := 0
	for i := 0; i < len(p.buf); i++ {
		c := p.buf[i]
		if c != '\r' && c != '\n' {
			continue
		}
		p.line(string(p.buf[start:i]))
		if c == '\r' {
			if i+1 == len(p.buf) {
				p.pendingCR = true
			} else if p.buf[i+1] == '\n' {
				i++
			}
		}
		start = i + 1
	}
	p.buf = append(p.buf[:0], p.buf[start:]...)
}

// end processes what's left when the stream ends. Unlike the HTML spec, it
// also dispatches an event that lacks its closing blank line, as a2a-go does.
func (p *sseParser) end() {
	if len(p.buf) > 0 {
		p.line(string(p.buf))
		p.buf = nil
	}
	p.dispatch()
}

func (p *sseParser) line(line string) {
	if line == "" {
		p.dispatch()
		return
	}
	if strings.HasPrefix(line, ":") {
		return
	}
	field, value, _ := strings.Cut(line, ":")
	value = strings.TrimPrefix(value, " ")
	switch field {
	case "data":
		p.data = append(p.data, value)
	case "event":
		p.event = value
	case "id":
		if !strings.Contains(value, "\x00") {
			p.lastID = value
		}
	}
}

func (p *sseParser) dispatch() {
	if len(p.data) > 0 {
		p.emit(Frame{Time: time.Now(), Event: p.event, ID: p.lastID, Data: strings.Join(p.data, "\n")})
	}
	p.data = nil
	p.event = ""
}
