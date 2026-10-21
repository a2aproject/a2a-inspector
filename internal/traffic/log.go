// Package traffic records the inspector's wire traffic with agents: every
// HTTP exchange through an http.RoundTripper, and every gRPC call through
// client interceptors. Entries go to an in-memory ring buffer that the UI
// follows live. Secret header values are masked before they're stored.
package traffic

import (
	"encoding/json"
	"slices"
	"strconv"
	"sync"
	"time"
)

// Limits on what one entry keeps. Frames and messages beyond them still reach
// the call that made the request; only the log drops them.
const (
	MaxBodySize     = 1 << 20
	MaxFrames       = 2000
	defaultCapacity = 500
	subscriberQueue = 256
)

// Header is one header or metadata value.
type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Frame is one server-sent event.
type Frame struct {
	Time  time.Time `json:"time"`
	Event string    `json:"event"`
	ID    string    `json:"id,omitempty"`
	Data  string    `json:"data"`
}

// HTTPExchange is a JSON-RPC or HTTP+JSON request and its response.
type HTTPExchange struct {
	Method         string   `json:"method"`
	URL            string   `json:"url"`
	RequestHeaders []Header `json:"requestHeaders"`
	RequestBody    string   `json:"requestBody"`
	// Status is 0 until the response headers arrive.
	Status          int      `json:"status,omitempty"`
	ResponseHeaders []Header `json:"responseHeaders,omitempty"`
	// ResponseBody is empty for event streams, which are kept as SSEFrames.
	ResponseBody string  `json:"responseBody"`
	SSEFrames    []Frame `json:"sseFrames,omitempty"`
	// Truncated is set when a body or the frame list hit the size limits.
	Truncated bool `json:"truncated,omitempty"`
}

// GRPCMessage is one message of a gRPC call, as proto3 JSON.
type GRPCMessage struct {
	FromClient bool            `json:"fromClient"`
	Time       time.Time       `json:"time"`
	JSON       json.RawMessage `json:"json"`
}

// GRPCExchange is a gRPC call.
type GRPCExchange struct {
	Target     string `json:"target"`
	FullMethod string `json:"fullMethod"`
	// Metadata is what the client sent; Headers and Trailers are what the server sent.
	Metadata      []Header      `json:"metadata"`
	Messages      []GRPCMessage `json:"messages"`
	Headers       []Header      `json:"headers,omitempty"`
	StatusCode    string        `json:"statusCode,omitempty"`
	StatusMessage string        `json:"statusMessage,omitempty"`
	Trailers      []Header      `json:"trailers,omitempty"`
	Truncated     bool          `json:"truncated,omitempty"`
}

// Entry is one exchange with an agent.
type Entry struct {
	ID           string    `json:"id"`
	ConnectionID string    `json:"connectionId,omitempty"`
	StartTime    time.Time `json:"startTime"`
	// DurationMs is set once the exchange is over.
	DurationMs *int64 `json:"durationMs"`
	// Error is set when no response arrived or the response broke off.
	Error string        `json:"error,omitempty"`
	HTTP  *HTTPExchange `json:"http,omitempty"`
	GRPC  *GRPCExchange `json:"grpc,omitempty"`
}

// Done reports whether the exchange is over.
func (e *Entry) Done() bool { return e.DurationMs != nil }

func (e *Entry) clone() *Entry {
	c := *e
	if e.HTTP != nil {
		h := *e.HTTP
		h.RequestHeaders = slices.Clone(h.RequestHeaders)
		h.ResponseHeaders = slices.Clone(h.ResponseHeaders)
		h.SSEFrames = slices.Clone(h.SSEFrames)
		c.HTTP = &h
	}
	if e.GRPC != nil {
		g := *e.GRPC
		g.Metadata = slices.Clone(g.Metadata)
		g.Messages = slices.Clone(g.Messages)
		g.Headers = slices.Clone(g.Headers)
		g.Trailers = slices.Clone(g.Trailers)
		c.GRPC = &g
	}
	return &c
}

// Update is a change to the log, as the UI receives it.
type Update struct {
	// Entry replaces the whole entry with this ID.
	Entry *Entry
	// Frame or Message is appended to the entry EntryID.
	EntryID string
	Frame   *Frame
	Message *GRPCMessage
}

// Log is a ring buffer of entries that can be followed live.
type Log struct {
	mu       sync.Mutex
	capacity int
	entries  []*Entry
	nextID   int
	subs     map[*subscriber]struct{}
}

type subscriber struct {
	ch     chan Update
	filter func(*Entry) bool
}

// NewLog returns a log that keeps the last capacity entries, or 500 if capacity is 0.
func NewLog(capacity int) *Log {
	if capacity <= 0 {
		capacity = defaultCapacity
	}
	return &Log{capacity: capacity, subs: map[*subscriber]struct{}{}}
}

// Get returns a copy of the entry with the given ID.
func (l *Log) Get(id string) (*Entry, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e := l.find(id); e != nil {
		return e.clone(), true
	}
	return nil, false
}

// Subscribe returns copies of the entries that pass filter (all of them if
// filter is nil) and a channel with every later update to such entries. The
// channel is closed when cancel is called, or when the subscriber falls too
// far behind; it should then subscribe again.
func (l *Log) Subscribe(filter func(*Entry) bool) (snapshot []*Entry, updates <-chan Update, cancel func()) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, e := range l.entries {
		if filter == nil || filter(e) {
			snapshot = append(snapshot, e.clone())
		}
	}
	s := &subscriber{ch: make(chan Update, subscriberQueue), filter: filter}
	l.subs[s] = struct{}{}
	return snapshot, s.ch, func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.unsubscribe(s)
	}
}

func (l *Log) unsubscribe(s *subscriber) {
	if _, ok := l.subs[s]; ok {
		delete(l.subs, s)
		close(s.ch)
	}
}

// publish sends u to the subscribers interested in e. Callers hold l.mu.
func (l *Log) publish(e *Entry, u Update) {
	for s := range l.subs {
		if s.filter != nil && !s.filter(e) {
			continue
		}
		select {
		case s.ch <- u:
		default:
			l.unsubscribe(s)
		}
	}
}

func (l *Log) find(id string) *Entry {
	for i := len(l.entries) - 1; i >= 0; i-- {
		if l.entries[i].ID == id {
			return l.entries[i]
		}
	}
	return nil
}

// add stores a new entry, assigns its ID and start time, and returns the ID.
func (l *Log) add(e *Entry) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.nextID++
	e.ID = "tr-" + strconv.Itoa(l.nextID)
	if e.StartTime.IsZero() {
		e.StartTime = time.Now()
	}
	l.entries = append(l.entries, e)
	if len(l.entries) > l.capacity {
		l.entries = slices.Delete(l.entries, 0, len(l.entries)-l.capacity)
	}
	l.publish(e, Update{Entry: e.clone()})
	return e.ID
}

// update changes an entry and sends it to the subscribers. Entries already
// dropped from the buffer are ignored.
func (l *Log) update(id string, change func(e *Entry)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.find(id)
	if e == nil {
		return
	}
	change(e)
	l.publish(e, Update{Entry: e.clone()})
}

// finish marks an entry as over.
func (l *Log) finish(id string, errMsg string, change func(e *Entry)) {
	l.update(id, func(e *Entry) {
		if e.Done() {
			return
		}
		if change != nil {
			change(e)
		}
		ms := time.Since(e.StartTime).Milliseconds()
		e.DurationMs = &ms
		if errMsg != "" && e.Error == "" {
			e.Error = errMsg
		}
	})
}

// addFrame appends a server-sent event to an HTTP entry.
func (l *Log) addFrame(id string, f Frame) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.find(id)
	if e == nil || e.HTTP == nil {
		return
	}
	if len(e.HTTP.SSEFrames) >= MaxFrames {
		if !e.HTTP.Truncated {
			e.HTTP.Truncated = true
			l.publish(e, Update{Entry: e.clone()})
		}
		return
	}
	e.HTTP.SSEFrames = append(e.HTTP.SSEFrames, f)
	l.publish(e, Update{EntryID: id, Frame: &f})
}

// addMessage appends a gRPC message to a gRPC entry.
func (l *Log) addMessage(id string, m GRPCMessage) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.find(id)
	if e == nil || e.GRPC == nil {
		return
	}
	if len(e.GRPC.Messages) >= MaxFrames {
		if !e.GRPC.Truncated {
			e.GRPC.Truncated = true
			l.publish(e, Update{Entry: e.clone()})
		}
		return
	}
	e.GRPC.Messages = append(e.GRPC.Messages, m)
	l.publish(e, Update{EntryID: id, Message: &m})
}
