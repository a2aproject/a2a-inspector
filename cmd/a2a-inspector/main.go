// Command a2a-inspector serves a web UI for inspecting, debugging and testing
// A2A agents. Run it and it opens the browser on the inspector.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := newRootCmd(os.Stdout, os.Stderr, openBrowser).ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}
