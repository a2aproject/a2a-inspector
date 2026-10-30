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

// Package inspector runs the A2A Inspector. The a2a-inspector command calls
// Main with no options; a program that embeds the inspector can pass extra
// transports and an HTTP hook.
package inspector

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2aclient"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// Options configures the inspector. The zero value uses only the built-in
// transports.
type Options struct {
	// Transports adds protocol bindings beyond JSON-RPC, HTTP+JSON and gRPC.
	// The egress policy (--egress=public, the default with --hosted) can't
	// see their connections, so a transport has to limit them itself.
	Transports []Transport
	// WrapHTTPTransport, if set, wraps the transport that sends the
	// inspector's HTTP requests to agents, which applies the egress policy.
	// The traffic log shows requests as they are before it.
	WrapHTTPTransport func(http.RoundTripper) http.RoundTripper
}

// Transport adds a protocol binding beyond JSON-RPC, HTTP+JSON and gRPC.
// The inspector can't record its traffic, so it shows responses as a2a-go
// decoded them.
type Transport struct {
	// Protocol is the protocolBinding value cards use for the binding, and
	// the value of --transport that selects it.
	Protocol a2a.TransportProtocol
	// Factory creates v1.0 connections. CompatFactory, if set, creates v0.3 ones.
	Factory       a2aclient.TransportFactory
	CompatFactory a2aclient.TransportFactory
	// AddFlags, if set, adds the transport's own flags to the command.
	AddFlags func(*pflag.FlagSet)
}

// Main runs the inspector with the command-line arguments and returns the
// exit code.
func Main(opts Options) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := NewCommand(opts).ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		return 1
	}
	return 0
}

// NewCommand returns the a2a-inspector command.
func NewCommand(opts Options) *cobra.Command {
	return newCommand(opts, os.Stdout, os.Stderr, openBrowser)
}
