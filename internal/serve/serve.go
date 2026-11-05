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

// Package serve runs echo agents for cards written in the inspector, with
// a2a-cli's `a2a server --echo`. The inspector has no serving code of its own,
// and never runs a command a user supplied.
package serve

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2acompat/a2av0"
	"github.com/a2aproject/a2a-inspector/internal/agents"
)

const (
	// stopTimeout bounds how long Stop waits for a killed echo agent to exit.
	stopTimeout = 5 * time.Second
	// outputLimit is how much of an echo agent's output is kept, for errors.
	outputLimit = 16 << 10
)

var (
	// maxAgents is how many echo agents run at once.
	maxAgents = 10
	// startTimeout bounds how long an echo agent takes to serve its card.
	startTimeout = 15 * time.Second
)

// InstallHint tells how to install a2a-cli.
const InstallHint = "Install a2a-cli with `brew install a2a`, `winget install a2aproject.a2acli` or " +
	"`go install github.com/a2aproject/a2a-cli@latest`, then restart the inspector from a shell where a2a or a2a-cli is on the PATH."

var (
	// ErrNotInstalled means a2a-cli's binary isn't on the PATH.
	ErrNotInstalled = errors.New("a2a-cli isn't installed: neither a2a nor a2a-cli is on the PATH")
	// ErrTooMany means as many echo agents run as may.
	ErrTooMany = errors.New("too many echo agents are running; stop one first")
	// ErrClosed means the runner was closed, as the inspector shuts down.
	ErrClosed = errors.New("the inspector is shutting down")
)

// binaries are the names of a2a-cli's binary: a2a from a release, and
// a2a-cli from go install.
var binaries = []string{"a2a", "a2a-cli"}

// Values of a2a server's --serve-transport and --protocol flags.
var (
	transportFlags = map[string]string{agents.BindingJSONRPC: "jsonrpc", agents.BindingHTTPJSON: "rest", agents.BindingGRPC: "grpc"}
	protocolFlags  = map[string]string{agents.Version10: "latest", agents.Version03: "0.3"}
)

// grpcCardLine is where a2a server says it serves the card of a gRPC agent,
// which is on a port of its own.
var grpcCardLine = regexp.MustCompile(`Agent card at (https?://\S+)`)

// Runner starts and stops echo agents. The zero value is ready to use.
type Runner struct {
	// LookPath finds a2a-cli's binary; nil means exec.LookPath.
	LookPath func(file string) (string, error)

	mu     sync.Mutex
	dir    string
	agents []*Agent
	next   int
	closed bool
}

// Agent is a running echo agent, or one that stopped by itself.
type Agent struct {
	ID string
	// Source is what the agent was started for, as the caller named it.
	Source string
	// Name is the card's name.
	Name string
	// Interface is the one interface the agent serves, on 127.0.0.1.
	Interface agents.Interface
	// CardURL is where the agent serves its card.
	CardURL string
	// Command is how a2a-cli was started.
	Command string
	Started time.Time

	cmd  *exec.Cmd
	file string
	out  *tail
	// done closes when the process exits; err is then why.
	done chan struct{}
	err  error
}

// Exited returns why the agent stopped by itself, with the end of its
// output, or "" while it runs.
func (a *Agent) Exited() string {
	select {
	case <-a.done:
		return describeExit(a.err, a.out.String())
	default:
		return ""
	}
}

// Binary returns the path of a2a-cli's binary, or ErrNotInstalled.
func (r *Runner) Binary() (string, error) {
	lookPath := r.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	for _, name := range binaries {
		if path, err := lookPath(name); err == nil {
			return path, nil
		}
	}
	return "", ErrNotInstalled
}

// Preview is the command an echo agent would be started with, with
// placeholders for the card file and port.
func Preview(binding, version string) string {
	return command("a2a", args("<card file>", "<free port>", binding, version))
}

// CheckInterface reports whether a2a-cli can serve the binding and version.
func CheckInterface(binding, version string) error {
	if transportFlags[binding] == "" {
		return fmt.Errorf("a2a-cli can't serve the %s binding; use JSONRPC, HTTP+JSON or GRPC", binding)
	}
	if protocolFlags[version] == "" {
		return fmt.Errorf("a2a-cli can't serve protocol version %s; use %s or %s", version, agents.Version10, agents.Version03)
	}
	return nil
}

// Start serves card, in either version's format, as an echo agent on a free
// 127.0.0.1 port, with one interface of the given binding and version in
// place of the card's. It returns once the agent serves its card.
func (r *Runner) Start(ctx context.Context, card []byte, binding, version, source string) (*Agent, error) {
	if err := CheckInterface(binding, version); err != nil {
		return nil, err
	}
	parsed, err := a2av0.NewAgentCardParser()(card)
	if err != nil {
		return nil, fmt.Errorf("the card can't be served: %w", err)
	}
	bin, err := r.Binary()
	if err != nil {
		return nil, err
	}
	id, dir, err := r.reserve()
	if err != nil {
		return nil, err
	}
	a, err := r.start(ctx, bin, dir, id, parsed, binding, version)
	if a != nil {
		a.Source = source
	}
	r.mu.Lock()
	i := slices.IndexFunc(r.agents, func(p *Agent) bool { return p.ID == id })
	switch {
	case err != nil && i >= 0:
		r.agents = slices.Delete(r.agents, i, i+1)
	case err == nil && i >= 0:
		r.agents[i] = a
	case err == nil:
		// Close dropped the placeholder.
		err = ErrClosed
		defer a.kill()
	}
	r.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return a, nil
}

// start runs a2a-cli, trying another port once if the one it got was taken
// before a2a-cli could listen on it.
func (r *Runner) start(ctx context.Context, bin, dir, id string, card *a2a.AgentCard, binding, version string) (*Agent, error) {
	for attempt := 0; ; attempt++ {
		a, err := launch(ctx, bin, dir, id, card, binding, version)
		if err == nil || attempt > 0 || !errors.Is(err, errPortTaken) {
			return a, err
		}
	}
}

var errPortTaken = errors.New("the port was taken")

func launch(ctx context.Context, bin, dir, id string, card *a2a.AgentCard, binding, version string) (*Agent, error) {
	port, err := freePort()
	if err != nil {
		return nil, err
	}
	host := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	iface := agents.Interface{URL: "http://" + host, ProtocolBinding: binding, ProtocolVersion: version, Supported: true, Source: "supportedInterfaces[0]"}
	if binding == agents.BindingGRPC {
		iface.URL = host
	}
	served := *card
	served.SupportedInterfaces = []*a2a.AgentInterface{{
		URL:             iface.URL,
		ProtocolBinding: a2a.TransportProtocol(binding),
		ProtocolVersion: a2a.ProtocolVersion(version),
	}}
	data, err := json.MarshalIndent(&served, "", "  ")
	if err != nil {
		return nil, err
	}
	file := filepath.Join(dir, id+".json")
	if err := os.WriteFile(file, data, 0o600); err != nil {
		return nil, fmt.Errorf("writing the card file: %w", err)
	}
	argv := args(file, strconv.Itoa(port), binding, version)
	a := &Agent{
		ID:        id,
		Name:      card.Name,
		Interface: iface,
		Command:   command(filepath.Base(bin), argv),
		Started:   time.Now(),
		cmd:       exec.Command(bin, argv...),
		file:      file,
		out:       &tail{limit: outputLimit},
		done:      make(chan struct{}),
	}
	if binding != agents.BindingGRPC {
		a.CardURL = iface.URL + agents.WellKnownCardPath
	}
	a.cmd.Stdout, a.cmd.Stderr = a.out, a.out
	if err := a.cmd.Start(); err != nil {
		_ = os.Remove(file)
		return nil, fmt.Errorf("starting %s: %w", a.Command, err)
	}
	go func() {
		a.err = a.cmd.Wait()
		close(a.done)
	}()
	if err := a.awaitCard(ctx); err != nil {
		a.kill()
		return nil, err
	}
	return a, nil
}

// awaitCard waits until the agent serves its card, it exits, or it takes
// too long.
func (a *Agent) awaitCard(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, startTimeout)
	defer cancel()
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		if a.CardURL == "" {
			a.CardURL = grpcCardURL(a.out.String())
		}
		if a.CardURL != "" && cardServed(ctx, client, a.CardURL) {
			return nil
		}
		select {
		case <-a.done:
			out := a.out.String()
			if strings.Contains(out, "address already in use") || strings.Contains(out, "Only one usage of each socket address") {
				return errPortTaken
			}
			return errors.New(describeExit(a.err, out))
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return fmt.Errorf("the echo agent didn't serve its card within %s; its output:\n%s", startTimeout, a.out.String())
			}
			return ctx.Err()
		case <-tick.C:
		}
	}
}

func cardServed(ctx context.Context, client *http.Client, cardURL string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cardURL, nil)
	if err != nil {
		return false
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// grpcCardURL finds the card URL a2a server prints for a gRPC agent, on
// 127.0.0.1 in place of the all-addresses host it listens on.
func grpcCardURL(output string) string {
	m := grpcCardLine.FindStringSubmatch(output)
	if m == nil {
		return ""
	}
	u, err := url.Parse(m[1])
	if err != nil || u.Port() == "" {
		return ""
	}
	if ip := net.ParseIP(u.Hostname()); u.Hostname() == "" || ip != nil && ip.IsUnspecified() {
		u.Host = net.JoinHostPort("127.0.0.1", u.Port())
	}
	return u.String()
}

func describeExit(err error, output string) string {
	msg := "the echo agent exited"
	if err != nil {
		msg += ": " + err.Error()
	}
	if output = strings.TrimSpace(output); output != "" {
		msg += "; its output:\n" + output
	}
	return msg
}

// kill stops the process and removes its card file.
func (a *Agent) kill() {
	_ = a.cmd.Process.Kill()
	select {
	case <-a.done:
	case <-time.After(stopTimeout):
	}
	_ = os.Remove(a.file)
}

// reserve counts a new agent against maxAgents and returns its ID and the
// directory for its card, which it creates on first use, and again if it's
// gone.
func (r *Runner) reserve() (id, dir string, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return "", "", ErrClosed
	}
	running := 0
	for _, a := range r.agents {
		if a.Exited() == "" {
			running++
		}
	}
	if running >= maxAgents {
		return "", "", ErrTooMany
	}
	// Something else can remove the directory, such as a cleaner of the
	// temporary directory. A new one with a new random name is safer than
	// creating the old name again, which another user could have taken.
	if _, err := os.Stat(r.dir); r.dir != "" && errors.Is(err, fs.ErrNotExist) {
		r.dir = ""
	}
	if r.dir == "" {
		if r.dir, err = os.MkdirTemp("", "a2a-inspector-serve-"); err != nil {
			return "", "", fmt.Errorf("creating a directory for card files: %w", err)
		}
	}
	r.next++
	// A placeholder keeps the slot until the agent starts or fails.
	id = "echo-" + strconv.Itoa(r.next)
	r.agents = append(r.agents, &Agent{ID: id, done: make(chan struct{}), out: &tail{}})
	return id, r.dir, nil
}

// List returns the agents, running or stopped by themselves, oldest first.
func (r *Runner) List() []*Agent {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []*Agent
	for _, a := range r.agents {
		if a.cmd != nil {
			out = append(out, a)
		}
	}
	return out
}

// Stop stops the agent and forgets it. It reports false for an unknown ID.
func (r *Runner) Stop(id string) bool {
	r.mu.Lock()
	i := slices.IndexFunc(r.agents, func(a *Agent) bool { return a.ID == id && a.cmd != nil })
	if i < 0 {
		r.mu.Unlock()
		return false
	}
	a := r.agents[i]
	r.agents = slices.Delete(r.agents, i, i+1)
	r.mu.Unlock()
	a.kill()
	return true
}

// Close stops every agent, removes the card files, and makes Start fail.
func (r *Runner) Close() {
	r.mu.Lock()
	r.closed = true
	running := r.agents
	r.agents = nil
	dir := r.dir
	r.mu.Unlock()
	for _, a := range running {
		if a.cmd != nil {
			a.kill()
		}
	}
	if dir != "" {
		_ = os.RemoveAll(dir)
	}
}

func args(file, port, binding, version string) []string {
	argv := []string{"server", "--card", file, "--echo", "--host", "127.0.0.1", "--port", port,
		"--serve-transport", transportFlags[binding], "--protocol", protocolFlags[version]}
	if version == agents.Version03 {
		// Adds the v0.3 fields to the card, for v0.3 clients.
		argv = append(argv, "--card-compat")
	}
	return argv
}

// command formats a command line for display, quoting arguments a shell
// would split.
func command(bin string, argv []string) string {
	parts := []string{bin}
	for _, a := range argv {
		if a == "" || strings.ContainsFunc(a, func(r rune) bool { return !safeArg(r) }) {
			a = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		}
		parts = append(parts, a)
	}
	return strings.Join(parts, " ")
}

func safeArg(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-_./:=@%+,", r)
}

// freePort returns a 127.0.0.1 port nobody listens on. Another process can
// take it before a2a-cli does; Start then tries another.
func freePort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("finding a free port: %w", err)
	}
	defer func() { _ = ln.Close() }()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

// tail keeps the end of what's written to it.
type tail struct {
	limit int
	mu    sync.Mutex
	buf   []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.limit; t.limit > 0 && over > 0 {
		t.buf = append(t.buf[:0], t.buf[over:]...)
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.ToValidUTF8(string(t.buf), "")
}
