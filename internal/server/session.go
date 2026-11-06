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
	"net/netip"
	"strings"
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
	// New sessions of one client, with per-client limits: ten at once, then
	// one every ten seconds.
	clientSessionRate  = rate.Limit(0.1)
	clientSessionBurst = 10
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
	// SessionEgressRate is how many requests to agents a session can make
	// per second.
	SessionEgressRate float64
	// EgressRate is how many requests to agents the inspector makes per
	// second, over all sessions.
	EgressRate float64
	// StreamDuration ends streams from agents after that long.
	StreamDuration time.Duration

	// ClientHeader names the request header that identifies a client, set
	// by the proxy in front of the inspector: X-Forwarded-For, or a header
	// with the signed-in user. It turns on the limits per client below.
	ClientHeader string
	// TrustedProxies is how many proxies add an entry to ClientHeader; the
	// client is the entry that many from the end.
	TrustedProxies int
	// ClientSessions is how many sessions a client can have. At the limit,
	// a new one replaces the client's session idle the longest.
	ClientSessions int
	// ClientEgressRate is how many requests to agents a client can make per
	// second, over its sessions.
	ClientEgressRate float64
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
	host    *hostConversations
	// limiter bounds the session's API requests; nil means no limit.
	limiter *rate.Limiter
	// quota is the share of the client that started the session; nil
	// without limits per client.
	quota *clientQuota
	// ctx ends with the session, and ends its calls and streams.
	ctx     context.Context
	cancel  context.CancelFunc
	created time.Time

	mu      sync.Mutex
	streams int
}

// newSession returns a session in the client's quota q, which is nil
// without limits per client.
func (s *Server) newSession(id string, q *clientQuota) *session {
	log := traffic.NewLog(0, s.opts.Limits.TrafficBytes)
	// A request to an agent counts against the session, its client and the
	// inspector.
	egressLimits := limits{{newLimiter(s.opts.Limits.SessionEgressRate, 4), errSessionEgressRate}}
	if q != nil {
		egressLimits = append(egressLimits, limit{q.egress, errClientEgressRate})
	}
	egressLimits = append(egressLimits, limit{s.egress, errEgressRate})
	transport, grpcOptions := egressLimits.apply(s.transport)
	client := &http.Client{Transport: &traffic.Transport{Log: log, Base: transport}, CheckRedirect: checkRedirect}
	sess := &session{
		id:      id,
		traffic: log,
		client:  client,
		dialer: &agents.Dialer{
			HTTPClient:      client,
			GRPCDialOptions: append(log.DialOptions(), grpcOptions...),
			Transports:      s.opts.Transports,
			Egress:          s.opts.Egress,
		},
		secrets: newSecretStore(!s.opts.Hosted),
		conns:   newConnections(s.opts.Limits.Connections),
		hooks:   newHooks(),
		host:    &hostConversations{byID: map[string]*hostConversation{}},
		limiter: newLimiter(s.opts.Limits.RequestRate, 4),
		quota:   q,
		created: time.Now(),
	}
	sess.ctx, sess.cancel = context.WithCancel(s.ctx)
	return sess
}

// stop ends the session's calls and streams.
func (sess *session) stop() { sess.cancel() }

// destroy closes the session's connections.
func (sess *session) destroy() {
	sess.cancel()
	sess.conns.close()
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

type sessionKey struct{}

// sessionOf returns the session of an API request.
func sessionOf(r *http.Request) *session {
	return r.Context().Value(sessionKey{}).(*session)
}

// sessions are the sessions of a hosted inspector. Requests acquire their
// session for as long as they run.
type sessions struct {
	limits Limits
	create *rate.Limiter
	logf   func(format string, args ...any)
	pool   *pool[*session]

	// mu serializes starting and sweeping sessions, and guards renewed and
	// clients.
	mu sync.Mutex
	// renewed maps the IDs of sessions that ended to the sessions that
	// replaced them, for renewalGrace.
	renewed map[string]renewal
	// clients are the quotas of clients, with limits per client. A quota
	// stays while the client has sessions or its limiters haven't refilled.
	clients map[string]*clientQuota
}

type renewal struct {
	id string
	at time.Time
}

// clientQuota is the share of the inspector a client can use.
type clientQuota struct {
	// start bounds the client's new sessions, and egress its requests to
	// agents; nil means no limit.
	start  *rate.Limiter
	egress *rate.Limiter
}

var (
	errTooManySessions   = errors.New("too many new sessions; try again in a minute")
	errClientSessionRate = errors.New("too many new sessions from your address or account; try again in a minute")
	errClientFull        = errors.New("too many sessions are open from your address or account; try again later")
	errFull              = errors.New("the inspector is at capacity; try again later")
)

func newSessions(limits Limits, logf func(string, ...any)) *sessions {
	return &sessions{
		limits:  limits,
		create:  rate.NewLimiter(sessionRate, sessionBurst),
		logf:    logf,
		pool:    newPool[*session](),
		renewed: map[string]renewal{},
		clients: map[string]*clientQuota{},
	}
}

// acquire returns the session with the ID, held until release is called.
func (ss *sessions) acquire(id string) (sess *session, release func(), ok bool) {
	return ss.pool.acquire(id)
}

// renew returns the session that replaced the one with the given ID, if
// it was replaced moments ago, or starts a new session for it. The session
// is held until release is called.
func (ss *sessions) renew(old, client string, start func(*clientQuota) *session) (sess *session, release func(), err error) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if r, ok := ss.renewed[old]; ok && time.Since(r.at) < renewalGrace {
		if sess, release, ok := ss.pool.acquire(r.id); ok {
			return sess, release, nil
		}
	}
	sess, release, err = ss.startLocked(client, start)
	if err == nil && old != "" {
		ss.renewed[old] = renewal{id: sess.id, at: time.Now()}
	}
	return sess, release, err
}

// startLocked starts a session for the client, replacing the client's or
// the inspector's session idle the longest at their limits. Callers hold
// ss.mu.
func (ss *sessions) startLocked(client string, start func(*clientQuota) *session) (*session, func(), error) {
	now := time.Now()
	q := ss.quotaLocked(client)
	creates := limits{{ss.create, errTooManySessions}}
	var caps []poolLimit[*session]
	if q != nil {
		creates = limits{{q.start, errClientSessionRate}, {ss.create, errTooManySessions}}
		caps = append(caps, poolLimit[*session]{max: ss.limits.ClientSessions, match: func(sess *session) bool { return sess.quota == q }, err: errClientFull})
	}
	caps = append(caps, poolLimit[*session]{max: ss.limits.MaxSessions, err: errFull})
	if err := creates.allow(now); err != nil {
		return nil, nil, err
	}
	ss.sweepLocked(now)
	active := ss.pool.len()
	sess := start(q)
	release, replaced, err := ss.pool.add(sess.id, sess, caps...)
	if err != nil {
		sess.destroy()
		return nil, nil, err
	}
	for range replaced {
		active--
		ss.logf("session ended, replaced by a new session (%d active)", active)
	}
	ss.logf("session started (%d active)", active+1)
	return sess, release, nil
}

// quotaLocked returns the client's quota, or nil without limits per client.
// Callers hold ss.mu.
func (ss *sessions) quotaLocked(client string) *clientQuota {
	if ss.limits.ClientHeader == "" {
		return nil
	}
	q := ss.clients[client]
	if q == nil {
		q = &clientQuota{
			start:  rate.NewLimiter(clientSessionRate, clientSessionBurst),
			egress: newLimiter(ss.limits.ClientEgressRate, 2),
		}
		ss.clients[client] = q
	}
	return q
}

// sweep ends the sessions that are idle for too long or too old.
func (ss *sessions) sweep(now time.Time) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	ss.sweepLocked(now)
}

func (ss *sessions) sweepLocked(now time.Time) {
	// A session ends at its maximum age even with requests in progress; the
	// pool stops them.
	ended := ss.pool.removeIf(func(sess *session, held bool, lastUse time.Time) string {
		switch {
		case ss.limits.MaxAge > 0 && now.Sub(sess.created) > ss.limits.MaxAge:
			return "reached its maximum age"
		case ss.limits.IdleTimeout > 0 && !held && now.Sub(lastUse) > ss.limits.IdleTimeout:
			return "idle"
		}
		return ""
	})
	active := ss.pool.len() + len(ended)
	for _, why := range ended {
		active--
		ss.logf("session ended, %s (%d active)", why, active)
	}
	for old, r := range ss.renewed {
		if now.Sub(r.at) >= renewalGrace {
			delete(ss.renewed, old)
		}
	}
	// A quota without sessions and with full limiters is the same as a new
	// one.
	inUse := map[*clientQuota]bool{}
	for _, sess := range ss.pool.values() {
		inUse[sess.quota] = true
	}
	for client, q := range ss.clients {
		if !inUse[q] && refilled(q.start, now) && refilled(q.egress, now) {
			delete(ss.clients, client)
		}
	}
}

func refilled(l *rate.Limiter, now time.Time) bool {
	return l == nil || l.TokensAt(now) >= float64(l.Burst())
}

// clientOf returns the client a request comes from, for limits per client:
// the entry of the client header that the trusted proxies added, or the
// address the request came from without one. IPv6 addresses count per /64,
// the block a single host usually gets.
func (s *Server) clientOf(r *http.Request) string {
	l := s.opts.Limits
	if l.ClientHeader == "" {
		return ""
	}
	var entries []string
	for _, v := range r.Header.Values(l.ClientHeader) {
		entries = append(entries, strings.Split(v, ",")...)
	}
	client := r.RemoteAddr
	if n := max(l.TrustedProxies, 1); len(entries) >= n {
		if e := strings.TrimSpace(entries[len(entries)-n]); e != "" {
			client = e
		}
	}
	addr, err := netip.ParseAddr(client)
	if err != nil {
		addrPort, err := netip.ParseAddrPort(client)
		if err != nil {
			return client
		}
		addr = addrPort.Addr()
	}
	addr = addr.Unmap().WithZone("")
	if addr.Is6() {
		block, _ := addr.Prefix(64)
		return block.String()
	}
	return addr.String()
}

// closeAll ends every session, and makes starting new ones fail.
func (ss *sessions) closeAll() { ss.pool.close() }
