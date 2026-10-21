package traffic

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"sync"
)

// UserAgent is sent to agents unless a request sets its own.
const UserAgent = "a2a-inspector"

// Transport is an http.RoundTripper that records every exchange in Log.
type Transport struct {
	Log *Log
	// Base sends the requests. It defaults to http.DefaultTransport.
	Base http.RoundTripper
}

// RoundTrip implements http.RoundTripper.
func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	call := CallFrom(req.Context())
	body, err := readAll(req.Body)
	if err != nil {
		return nil, fmt.Errorf("reading the request body: %w", err)
	}
	if req.Method == http.MethodPost && call.MessageOverride != nil {
		if body, err = spliceMessage(body, call.MessageOverride); err != nil {
			return nil, err
		}
	}

	out := req.Clone(req.Context())
	out.Body = io.NopCloser(bytes.NewReader(body))
	out.ContentLength = int64(len(body))
	out.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	if len(body) == 0 {
		out.Body, out.GetBody = http.NoBody, nil
	}
	if out.Header.Get("User-Agent") == "" {
		out.Header.Set("User-Agent", UserAgent)
	}

	secrets := call.Secrets
	reqBody, truncated := clip(body)
	id := t.Log.add(&Entry{
		ConnectionID: call.ConnectionID,
		HTTP: &HTTPExchange{
			Method:         out.Method,
			URL:            out.URL.String(),
			RequestHeaders: maskHeaders(out.Header, secrets),
			RequestBody:    reqBody,
			Truncated:      truncated,
		},
	})
	call.addEntry(id)

	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	resp, err := base.RoundTrip(out)
	if err != nil {
		t.Log.finish(id, err.Error(), nil)
		return nil, err
	}
	headers := maskHeaders(resp.Header, secrets)
	setResponse := func(e *Entry) {
		e.HTTP.Status = resp.StatusCode
		e.HTTP.ResponseHeaders = headers
	}

	if IsEventStream(resp.Header.Get("Content-Type")) {
		t.Log.update(id, setResponse)
		rec := &streamBody{rc: resp.Body, log: t.Log, id: id}
		rec.parser = sseParser{emit: func(f Frame) {
			t.Log.addFrame(id, f)
			call.frame(id, f)
		}}
		resp.Body = rec
		return resp, nil
	}

	// Read the body now, so it's recorded even if the client never reads it,
	// as a2a-go does with error statuses.
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, MaxBodySize+1))
	respBody, truncated := clip(data)
	record := func(e *Entry) {
		setResponse(e)
		e.HTTP.ResponseBody = respBody
		e.HTTP.Truncated = e.HTTP.Truncated || truncated
	}
	switch {
	case readErr != nil:
		_ = resp.Body.Close()
		t.Log.finish(id, "reading the response: "+readErr.Error(), record)
		resp.Body = io.NopCloser(io.MultiReader(bytes.NewReader(data), errReader{readErr}))
	case truncated:
		t.Log.update(id, record)
		resp.Body = &finishingBody{Reader: io.MultiReader(bytes.NewReader(data), resp.Body), rc: resp.Body, finish: func() { t.Log.finish(id, "", nil) }}
	default:
		_ = resp.Body.Close()
		t.Log.finish(id, "", record)
		resp.Body = io.NopCloser(bytes.NewReader(data))
	}
	return resp, nil
}

func readAll(rc io.ReadCloser) ([]byte, error) {
	if rc == nil || rc == http.NoBody {
		return nil, nil
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// clip returns at most MaxBodySize bytes of a body as text.
func clip(body []byte) (string, bool) {
	if len(body) > MaxBodySize {
		return strings.ToValidUTF8(string(body[:MaxBodySize]), ""), true
	}
	return strings.ToValidUTF8(string(body), "\uFFFD"), false
}

// IsEventStream reports whether a Content-Type is text/event-stream.
func IsEventStream(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	return err == nil && mediaType == "text/event-stream"
}

type errReader struct{ err error }

func (r errReader) Read([]byte) (int, error) { return 0, r.err }

// finishingBody finishes an entry when the client closes the response.
type finishingBody struct {
	io.Reader
	rc     io.Closer
	finish func()
}

func (b *finishingBody) Close() error {
	b.finish()
	return b.rc.Close()
}

// streamBody records the events of a text/event-stream response as the
// client reads them.
type streamBody struct {
	rc     io.ReadCloser
	log    *Log
	id     string
	parser sseParser
	mu     sync.Mutex
	done   bool
}

func (b *streamBody) Read(p []byte) (int, error) {
	n, err := b.rc.Read(p)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.done {
		return n, err
	}
	if n > 0 {
		b.parser.feed(p[:n])
	}
	switch {
	case errors.Is(err, io.EOF):
		b.end("")
	case err != nil:
		b.end("the stream broke off: " + err.Error())
	}
	return n, err
}

func (b *streamBody) Close() error {
	b.mu.Lock()
	if !b.done {
		b.end("the inspector closed the stream before it ended")
	}
	b.mu.Unlock()
	return b.rc.Close()
}

// end finishes the entry. Callers hold b.mu.
func (b *streamBody) end(errMsg string) {
	b.done = true
	if errMsg == "" {
		b.parser.end()
	}
	b.log.finish(b.id, errMsg, nil)
}
