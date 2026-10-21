// Package ui embeds the built inspector UI. The build output in dist is
// committed, so the Go module builds without Node.js; rebuild it with
// `npm run build` in this directory after changing the UI.
package ui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// FS returns the built UI, with index.html at its root.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
