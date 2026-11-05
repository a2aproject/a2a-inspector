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
	"errors"
	"sync"
	"time"
)

// pooled is what a pool needs from the objects it holds.
type pooled interface {
	// stop ends the calls in progress on the object, when the pool removes
	// it.
	stop()
	// destroy frees what the object holds, once it's removed and nobody
	// holds it.
	destroy()
}

// pool holds objects of one kind by ID: the sessions of a hosted inspector,
// or the connections of a session. A handler acquires an object for as long
// as it uses it. Adding, replacing and removing objects are each decided
// under the pool's lock, so an object someone holds is never replaced, and
// a removed object is destroyed only when its last holder releases it. Each
// object's own lock guards only its own data.
type pool[T pooled] struct {
	mu     sync.Mutex
	closed bool
	items  map[string]*poolEntry[T]
}

type poolEntry[T pooled] struct {
	id      string
	v       T
	refs    int
	removed bool
	// lastUse is when the object was last released, or added.
	lastUse time.Time
}

// poolLimit is a limit add makes room under: at most max objects that
// match, or no limit when max is 0.
type poolLimit[T pooled] struct {
	max int
	// match picks the objects the limit counts; nil counts all of them.
	match func(T) bool
	// err is what add fails with when every matching object is held.
	err error
}

var errPoolClosed = errors.New("pool closed")

func newPool[T pooled]() *pool[T] {
	return &pool[T]{items: map[string]*poolEntry[T]{}}
}

// acquire returns the object with the ID, held until release is called.
func (p *pool[T]) acquire(id string) (v T, release func(), ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.items[id]
	if !ok {
		return v, nil, false
	}
	return e.v, p.holdLocked(e), true
}

// holdLocked counts a holder of e and returns the func that releases it,
// which destroys e if it was removed and this was its last holder. Callers
// hold p.mu.
func (p *pool[T]) holdLocked(e *poolEntry[T]) func() {
	e.refs++
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			e.refs--
			e.lastUse = time.Now()
			last := e.removed && e.refs == 0
			p.mu.Unlock()
			if last {
				e.v.destroy()
			}
		})
	}
}

// add adds v under the ID, held until release is called. To stay within
// the limits, it replaces the matching objects released the longest ago
// that nobody holds, and returns them. When a limit counts only held
// objects, add changes nothing and fails with the limit's error.
func (p *pool[T]) add(id string, v T, limits ...poolLimit[T]) (release func(), replaced []T, err error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, nil, errPoolClosed
	}
	victims := map[*poolEntry[T]]bool{}
	for _, l := range limits {
		if l.max <= 0 {
			continue
		}
		n := 0
		var oldest *poolEntry[T]
		for _, e := range p.items {
			if victims[e] || (l.match != nil && !l.match(e.v)) {
				continue
			}
			n++
			if e.refs == 0 && (oldest == nil || e.lastUse.Before(oldest.lastUse)) {
				oldest = e
			}
		}
		if n < l.max {
			continue
		}
		if oldest == nil {
			p.mu.Unlock()
			return nil, nil, l.err
		}
		victims[oldest] = true
	}
	var finish []func()
	for e := range victims {
		finish = append(finish, p.removeLocked(e))
		replaced = append(replaced, e.v)
	}
	e := &poolEntry[T]{id: id, v: v, lastUse: time.Now()}
	p.items[id] = e
	release = p.holdLocked(e)
	p.mu.Unlock()
	for _, f := range finish {
		f()
	}
	return release, replaced, nil
}

// removeLocked takes e out of the pool and returns the func that stops it,
// and destroys it if nobody holds it, for the caller to run once it has
// unlocked p.mu.
func (p *pool[T]) removeLocked(e *poolEntry[T]) func() {
	delete(p.items, e.id)
	e.removed = true
	unheld := e.refs == 0
	return func() {
		e.v.stop()
		if unheld {
			e.v.destroy()
		}
	}
}

// remove removes the object with the ID: it stops it now, and destroys it
// once nobody holds it.
func (p *pool[T]) remove(id string) bool {
	p.mu.Lock()
	e, ok := p.items[id]
	if !ok {
		p.mu.Unlock()
		return false
	}
	finish := p.removeLocked(e)
	p.mu.Unlock()
	finish()
	return true
}

// removeIf removes the objects why gives a reason for, given whether anyone
// holds them and when they were last used, and returns the reasons.
func (p *pool[T]) removeIf(why func(v T, held bool, lastUse time.Time) string) []string {
	p.mu.Lock()
	var reasons []string
	var finish []func()
	for _, e := range p.items {
		if reason := why(e.v, e.refs > 0, e.lastUse); reason != "" {
			reasons = append(reasons, reason)
			finish = append(finish, p.removeLocked(e))
		}
	}
	p.mu.Unlock()
	for _, f := range finish {
		f()
	}
	return reasons
}

// close removes every object, and makes add fail from then on.
func (p *pool[T]) close() {
	p.mu.Lock()
	p.closed = true
	var finish []func()
	for _, e := range p.items {
		finish = append(finish, p.removeLocked(e))
	}
	p.mu.Unlock()
	for _, f := range finish {
		f()
	}
}

// values returns the objects in the pool, without holding them.
func (p *pool[T]) values() []T {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]T, 0, len(p.items))
	for _, e := range p.items {
		out = append(out, e.v)
	}
	return out
}

func (p *pool[T]) len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.items)
}
