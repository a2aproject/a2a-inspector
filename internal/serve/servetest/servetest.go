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

// Package servetest fakes a2a-cli's `a2a server --echo` for tests. A test
// binary whose TestMain calls RunIfFake acts as a2a-cli when it's started
// with Env set, so a serve.Runner whose LookPath is LookPath starts it.
package servetest

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"iter"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2acompat/a2av0"
	a2agrpcv0 "github.com/a2aproject/a2a-go/v2/a2agrpc/v0"
	a2agrpcv1 "github.com/a2aproject/a2a-go/v2/a2agrpc/v1"
	"github.com/a2aproject/a2a-go/v2/a2asrv"
	"google.golang.org/grpc"
)

// Env holds the mode the fake runs in.
const Env = "A2A_INSPECTOR_FAKE_A2A"

// Modes of the fake.
const (
	// Serve serves the card as an echo agent, as a2a-cli does.
	Serve = "serve"
	// Fail prints an error and exits.
	Fail = "fail"
	// Silent runs without ever serving the card.
	Silent = "silent"
)

// LookPath returns the test binary for every name.
func LookPath(string) (string, error) { return os.Executable() }

// RunIfFake acts as a2a-cli and exits when Env is set, and returns otherwise.
func RunIfFake() {
	mode := os.Getenv(Env)
	if mode == "" {
		return
	}
	var err error
	switch mode {
	case Serve:
		err = serve(os.Args[1:])
	case Fail:
		err = errors.New("boom")
	case Silent:
		time.Sleep(time.Hour)
	default:
		err = fmt.Errorf("unknown mode %q", mode)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
	os.Exit(0)
}

// serve runs `a2a server --echo` with the flags the inspector passes.
func serve(args []string) error {
	if len(args) == 0 || args[0] != "server" {
		return fmt.Errorf("unknown command %q", args)
	}
	fs := flag.NewFlagSet("server", flag.ContinueOnError)
	cardFile := fs.String("card", "", "")
	echo := fs.Bool("echo", false, "")
	host := fs.String("host", "127.0.0.1", "")
	port := fs.Int("port", 8080, "")
	transport := fs.String("serve-transport", "rest", "")
	protocol := fs.String("protocol", "latest", "")
	compat := fs.Bool("card-compat", false, "")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if !*echo {
		return errors.New("only --echo is faked")
	}
	data, err := os.ReadFile(*cardFile)
	if err != nil {
		return fmt.Errorf("reading card file: %w", err)
	}
	card := new(a2a.AgentCard)
	if err := json.Unmarshal(data, card); err != nil {
		return fmt.Errorf("parsing card file: %w", err)
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(*host, strconv.Itoa(*port)))
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	cardHandler := a2asrv.NewStaticAgentCardHandler(card)
	if *compat {
		cardHandler = a2asrv.NewAgentCardHandler(a2av0.NewStaticAgentCardProducer(card))
	}
	handler := a2asrv.NewHandler(a2asrv.AgentExecutorFunc(execute))
	v03 := *protocol == "0.3"
	if *transport == "grpc" {
		s := grpc.NewServer()
		if v03 {
			a2agrpcv0.NewHandler(handler).RegisterWith(s)
		} else {
			a2agrpcv1.NewHandler(handler).RegisterWith(s)
		}
		cardListener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
		mux := http.NewServeMux()
		mux.Handle(a2asrv.WellKnownAgentCardPath, cardHandler)
		go func() { _ = http.Serve(cardListener, mux) }()
		// a2a-cli listens on all addresses for the card and says so.
		fmt.Fprintf(os.Stderr, "Agent card at http://[::]:%d%s\n", cardListener.Addr().(*net.TCPAddr).Port, a2asrv.WellKnownAgentCardPath)
		return s.Serve(ln)
	}
	mux := http.NewServeMux()
	mux.Handle(a2asrv.WellKnownAgentCardPath, cardHandler)
	switch {
	case *transport == "jsonrpc" && v03:
		mux.Handle("/", a2av0.NewJSONRPCHandler(handler))
	case *transport == "jsonrpc":
		mux.Handle("/", a2asrv.NewJSONRPCHandler(handler))
	case v03:
		mux.Handle("/", a2av0.NewRESTHandler(handler))
	default:
		mux.Handle("/", a2asrv.NewRESTHandler(handler))
	}
	return http.Serve(ln, mux)
}

// execute echoes the message's text back as an artifact of a task.
func execute(_ context.Context, ec *a2asrv.ExecutorContext) iter.Seq2[a2a.Event, error] {
	return func(yield func(a2a.Event, error) bool) {
		if ec.StoredTask == nil && !yield(a2a.NewSubmittedTask(ec, ec.Message), nil) {
			return
		}
		var text strings.Builder
		for _, p := range ec.Message.Parts {
			if t, ok := p.Content.(a2a.Text); ok {
				text.WriteString(string(t))
			}
		}
		if !yield(a2a.NewArtifactEvent(ec, a2a.NewTextPart(text.String())), nil) {
			return
		}
		yield(a2a.NewStatusUpdateEvent(ec, a2a.TaskStateCompleted, nil), nil)
	}
}
