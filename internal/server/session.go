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
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/a2aproject/a2a-inspector/internal/agents"
	"github.com/a2aproject/a2a-inspector/internal/traffic"
	"golang.org/x/time/rate"
)

const (
	// hostedCookie holds the session ID in hosted mode. The __Host- prefix
	// makes browsers require Secure and Path=/ and refuse a Domain.
	hostedCookie = "__Host-a2a_inspector_session"
	// New sessions in hosted mode: 120 a minute, with room for a room full of
	// people opening the link at once.
	sessionRate  = rate.Limit(2)
	sessionBurst = 600
	// renewalGrace is how long requests with an expired session's cookie
	// get the same new session, so parallel requests don't create several.
	renewalGrace = time.Minute
	// hostedRequestSize bounds API request bodies in hosted mode.
	hostedRequestSize = 8 << 20
)

// Limits bound what users of a hosted inspector can do. Zero means no limit.
type Limits struct {
	// MaxSessions is how many sessions the inspector keeps. At the limit, a
	// new one replaces the session idle the longest.
	MaxSessions int
	// IdleTimeout ends a session that had no request or open stream for
	// that long, and MaxAge ends any session that old.
	IdleTimeout time.Duration
	MaxAge      time.Duration
	// Connections is how many connections a session keeps. At the limit, a
	// new one replaces the connection used the longest ago.
	Connections int
	// Streams is how many streams a session can have open at once, the UI's
	// traffic feed included.
	Streams int
	// TrafficBytes bounds a session's traffic log.
	TrafficBytes int
	// RequestRate is how many API requests a session can make per second.
	RequestRate float64
	// EgressRate is how many requests to agents the inspector makes per
	// second, over all sessions.
	EgressRate float64
	// StreamDuration ends streams from agents after that long.
	StreamDuration time.Duration
}

// session is one user's state: connections, secrets and traffic. Local mode
// has a single session, tied to the per-run token; hosted mode has one per
// browser, kept in memory until it's idle for too long.
type session struct {
	id      string
	traffic *traffic.Log
	client  *http.Client
	dialer  *agents.Dialer
	secrets *secretStore
	conns   *connections
	hooks   *hooks
	// limiter bounds the session's API requests; nil means no limit.
	limiter *rate.Limiter
	// ctx ends with the session, and ends its calls and streams.
	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	created  time.Time
	lastSeen time.Time
	// requests counts the API requests in flight, streams included.
	requests int
	streams  int
}

func (s *Server) newSession(id string) *session {
	log := traffic.NewLog(0, s.opts.Limits.TrafficBytes)
	client := &http.Client{Transport: &traffic.Transport{Log: log, Base: s.transport}, CheckRedirect: checkRedirect}
	now := time.Now()
	sess := &session{
		id:      id,
		traffic: log,
		client:  client,
		dialer: &agents.Dialer{
			HTTPClient:      client,
			GRPCDialOptions: append(log.DialOptions(), s.grpcOptions...),
			Transports:      s.opts.Transports,
			Egress:          s.opts.Egress,
		},
		secrets:  newSecretStore(!s.opts.Hosted),
		conns:    &connections{items: map[string]*connection{}, max: s.opts.Limits.Connections},
		hooks:    newHooks(),
		created:  now,
		lastSeen: now,
	}
	if r := s.opts.Limits.RequestRate; r > 0 {
		sess.limiter = rate.NewLimiter(rate.Limit(r), max(1, int(4*r)))
	}
	sess.ctx, sess.cancel = context.WithCancel(s.ctx)
	return sess
}

// close ends the session's streams and closes its connections.
func (sess *session) close() {
	sess.cancel()
	for _, c := range sess.conns.removeAll() {
		_ = c.client.Destroy()
	}
}

func (sess *session) begin() {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	sess.requests++
	sess.lastSeen = time.Now()
}

func (sess *session) end() {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	sess.requests--
	sess.lastSeen = time.Now()
}

// openStream counts a stream against the session's limit, or reports false
// when the session has as many open as it may.
func (sess *session) openStream(limit int) bool {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if limit > 0 && sess.streams >= limit {
		return false
	}
	sess.streams++
	return true
}

func (sess *session) closeStream() {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	sess.streams--
}

// idle reports whether the session has no request in flight, and since when.
func (sess *session) idle() (bool, time.Time) {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return sess.requests == 0, sess.lastSeen
}

type sessionKey struct{}

// sessionOf returns the session of an API request.
func sessionOf(r *http.Request) *session {
	return r.Context().Value(sessionKey{}).(*session)
}

// sessions are the sessions of a hosted inspector.
type sessions struct {
	limits Limits
	create *rate.Limiter
	logf   func(format string, args ...any)

	mu    sync.Mutex
	items map[string]*session
	// renewed maps the IDs of sessions that ended to the sessions that
	// replaced them, for renewalGrace.
	renewed map[string]renewal
}

type renewal struct {
	id string
	at time.Time
}

var (
	errTooManySessions = errors.New("too many new sessions; try again in a minute")
	errFull            = errors.New("the inspector is at capacity; try again later")
)

func newSessions(limits Limits, logf func(string, ...any)) *sessions {
	return &sessions{
		limits:  limits,
		create:  rate.NewLimiter(sessionRate, sessionBurst),
		logf:    logf,
		items:   map[string]*session{},
		renewed: map[string]renewal{},
	}
}

func (ss *sessions) get(id string) *session {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	return ss.items[id]
}

// renew returns the session that replaced the one with the given ID, if
// it was replaced moments ago, or starts a new session for it.
func (ss *sessions) renew(old string, start func() *session) (*session, error) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if r, ok := ss.renewed[old]; ok && time.Since(r.at) < renewalGrace {
		if sess, ok := ss.items[r.id]; ok {
			return sess, nil
		}
	}
	sess, err := ss.startLocked(start)
	if err == nil && old != "" {
		ss.renewed[old] = renewal{id: sess.id, at: time.Now()}
	}
	return sess, err
}

// startLocked starts a session, making room for it if the inspector is
// at its limit. Callers hold ss.mu.
func (ss *sessions) startLocked(start func() *session) (*session, error) {
	if !ss.create.Allow() {
		return nil, errTooManySessions
	}
	ss.sweepLocked(time.Now())
	if ss.limits.MaxSessions > 0 && len(ss.items) >= ss.limits.MaxSessions {
		var oldest *session
		var oldestSeen time.Time
		for _, sess := range ss.items {
			if idle, seen := sess.idle(); idle && (oldest == nil || seen.Before(oldestSeen)) {
				oldest, oldestSeen = sess, seen
			}
		}
		if oldest == nil {
			return nil, errFull
		}
		ss.endLocked(oldest, "replaced by a new session")
	}
	sess := start()
	ss.items[sess.id] = sess
	ss.logf("session started (%d active)", len(ss.items))
	return sess, nil
}

// sweep ends the sessions that are idle for too long or too old.
func (ss *sessions) sweep(now time.Time) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	ss.sweepLocked(now)
}

func (ss *sessions) sweepLocked(now time.Time) {
	for _, sess := range ss.items {
		idle, seen := sess.idle()
		switch {
		case ss.limits.MaxAge > 0 && now.Sub(sess.created) > ss.limits.MaxAge:
			ss.endLocked(sess, "reached its maximum age")
		case ss.limits.IdleTimeout > 0 && idle && now.Sub(seen) > ss.limits.IdleTimeout:
			ss.endLocked(sess, "idle")
		}
	}
	for old, r := range ss.renewed {
		if now.Sub(r.at) >= renewalGrace {
			delete(ss.renewed, old)
		}
	}
}

func (ss *sessions) endLocked(sess *session, why string) {
	delete(ss.items, sess.id)
	sess.close()
	ss.logf("session ended, %s (%d active)", why, len(ss.items))
}

func (ss *sessions) closeAll() {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	for _, sess := range ss.items {
		delete(ss.items, sess.id)
		sess.close()
	}
}
