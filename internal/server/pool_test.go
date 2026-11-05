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
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// peek returns the object with the ID without holding it, for tests to
// look at.
func (p *pool[T]) peek(id string) (v T, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, found := p.items[id]; found {
		return e.v, true
	}
	return v, false
}

// object counts what a pool does to it. users counts the holders that are
// using it, which destroy must never see.
type object struct {
	stopped, destroyed, users atomic.Int32
	destroyedInUse            atomic.Bool
}

func (o *object) stop() { o.stopped.Add(1) }

func (o *object) destroy() {
	if o.users.Load() > 0 {
		o.destroyedInUse.Store(true)
	}
	o.destroyed.Add(1)
}

func mustAdd(t *testing.T, p *pool[*object], id string, limits ...poolLimit[*object]) *object {
	t.Helper()
	o := &object{}
	release, _, err := p.add(id, o, limits...)
	if err != nil {
		t.Fatalf("add(%s) = %v", id, err)
	}
	release()
	return o
}

func TestPoolRemoveWhileHeld(t *testing.T) {
	p := newPool[*object]()
	o := mustAdd(t, p, "a")
	_, release, ok := p.acquire("a")
	if !ok {
		t.Fatal("acquire(a) failed")
	}
	if !p.remove("a") {
		t.Fatal("remove(a) = false")
	}
	if _, _, ok := p.acquire("a"); ok {
		t.Error("acquired a removed object")
	}
	if o.stopped.Load() != 1 || o.destroyed.Load() != 0 {
		t.Errorf("held and removed: stopped %d, destroyed %d; want stopped, not destroyed", o.stopped.Load(), o.destroyed.Load())
	}
	release()
	release()
	if o.destroyed.Load() != 1 {
		t.Errorf("destroyed %d times after the last release, want once", o.destroyed.Load())
	}
	if p.remove("a") {
		t.Error("removed a twice")
	}
}

func TestPoolLimits(t *testing.T) {
	errFullPool := errors.New("full")
	limit := poolLimit[*object]{max: 2, err: errFullPool}
	p := newPool[*object]()
	a := mustAdd(t, p, "a", limit)
	time.Sleep(time.Millisecond)
	b := mustAdd(t, p, "b", limit)

	// a was released the longest ago, but it's held, so b goes.
	_, releaseA, _ := p.acquire("a")
	_, replaced, err := p.add("c", &object{}, limit)
	if err != nil || len(replaced) != 1 || replaced[0] != b || b.destroyed.Load() != 1 || a.stopped.Load() != 0 {
		t.Fatalf("add(c) = replaced %v, %v; want b", replaced, err)
	}

	// With every object held, add fails and changes nothing.
	_, releaseC, _ := p.acquire("c")
	if _, _, err := p.add("d", &object{}, limit); !errors.Is(err, errFullPool) || p.len() != 2 {
		t.Errorf("add(d) with every object held = %v, %d objects", err, p.len())
	}
	releaseA()
	releaseC()

	// Limits apply together: when the second can't make room, the first
	// doesn't either.
	onlyA := poolLimit[*object]{max: 1, match: func(o *object) bool { return o == a }, err: errors.New("a")}
	_, releaseC, _ = p.acquire("c")
	defer releaseC()
	if _, _, err := p.add("e", &object{}, onlyA, poolLimit[*object]{max: 1, err: errFullPool}); !errors.Is(err, errFullPool) {
		t.Errorf("add(e) = %v, want the second limit's error", err)
	}
	if _, ok := p.peek("a"); !ok || a.destroyed.Load() != 0 {
		t.Error("a failed add replaced a")
	}
}

func TestPoolClose(t *testing.T) {
	p := newPool[*object]()
	idle, held := mustAdd(t, p, "idle"), mustAdd(t, p, "held")
	_, release, _ := p.acquire("held")
	p.close()
	if idle.destroyed.Load() != 1 || held.stopped.Load() != 1 || held.destroyed.Load() != 0 {
		t.Errorf("after close: idle destroyed %d, held stopped %d and destroyed %d", idle.destroyed.Load(), held.stopped.Load(), held.destroyed.Load())
	}
	release()
	if held.destroyed.Load() != 1 {
		t.Error("the held object wasn't destroyed on release")
	}
	if _, _, err := p.add("new", &object{}); !errors.Is(err, errPoolClosed) {
		t.Errorf("add after close = %v", err)
	}
}

func TestPoolRemoveIf(t *testing.T) {
	p := newPool[*object]()
	old := mustAdd(t, p, "old")
	time.Sleep(10 * time.Millisecond)
	cutoff := time.Now()
	mustAdd(t, p, "new")
	busy := mustAdd(t, p, "busy")
	_, release, _ := p.acquire("busy")
	defer release()

	reasons := p.removeIf(func(_ *object, held bool, lastUse time.Time) string {
		if !held && lastUse.Before(cutoff) {
			return "idle"
		}
		return ""
	})
	if len(reasons) != 1 || reasons[0] != "idle" || old.destroyed.Load() != 1 || busy.stopped.Load() != 0 || p.len() != 2 {
		t.Errorf("removeIf = %v, %d left", reasons, p.len())
	}
}

// TestPoolConcurrent races handlers that use objects against adds at a limit,
// removals and a sweep, and checks that nothing is destroyed while in use
// or more than once.
func TestPoolConcurrent(t *testing.T) {
	p := newPool[*object]()
	limit := poolLimit[*object]{max: 4, err: errors.New("full")}
	var mu sync.Mutex
	var all []*object
	var next atomic.Int64
	add := func() {
		o := &object{}
		if release, _, err := p.add(strconv.FormatInt(next.Add(1), 10), o, limit); err == nil {
			mu.Lock()
			all = append(all, o)
			mu.Unlock()
			release()
		}
	}
	for range 4 {
		add()
	}

	var wg sync.WaitGroup
	for w := range 8 {
		wg.Go(func() {
			for i := range 2000 {
				id := strconv.FormatInt(next.Load()-int64(i%6), 10)
				switch {
				case w == 0 && i%10 == 0:
					add()
				case w == 1 && i%50 == 0:
					p.remove(id)
				case w == 2 && i%100 == 0:
					p.removeIf(func(_ *object, held bool, _ time.Time) string {
						if !held && i%200 == 0 {
							return "sweep"
						}
						return ""
					})
				default:
					if o, release, ok := p.acquire(id); ok {
						o.users.Add(1)
						runtime.Gosched()
						o.users.Add(-1)
						release()
					}
				}
			}
		})
	}
	wg.Wait()
	p.close()

	mu.Lock()
	defer mu.Unlock()
	for i, o := range all {
		if o.destroyedInUse.Load() {
			t.Errorf("object %d was destroyed while in use", i)
		}
		if n := o.destroyed.Load(); n != 1 {
			t.Errorf("object %d destroyed %d times, want once", i, n)
		}
	}
}
