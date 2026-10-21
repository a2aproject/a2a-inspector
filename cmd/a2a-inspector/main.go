// Command a2a-inspector serves a web UI for inspecting, debugging and testing
// A2A agents. Run it and it opens the browser on the inspector.
package main

import (
	"os"

	"github.com/a2aproject/a2a-inspector/inspector"
)

func main() {
	os.Exit(inspector.Main(inspector.Options{}))
}
