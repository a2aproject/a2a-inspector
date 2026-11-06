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

package inspector

import (
	"fmt"
	"runtime"
	"runtime/debug"
)

// Build metadata, which release builds set with -ldflags "-X". Other builds
// read the module version and VCS stamp of the binary.
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

// modulePath is the inspector's module. In a program that embeds the
// inspector, the binary's module version and VCS stamp are the program's.
const modulePath = "github.com/a2aproject/a2a-inspector"

// versionText is what --version prints after the command name.
func versionText() string {
	v, c, d := version, commit, date
	if bi, ok := debug.ReadBuildInfo(); ok && bi.Main.Path == modulePath {
		if v == "dev" && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
			v = bi.Main.Version
		}
		vcs := map[string]string{}
		for _, s := range bi.Settings {
			vcs[s.Key] = s.Value
		}
		if c == "none" && vcs["vcs.revision"] != "" {
			c = vcs["vcs.revision"]
			if vcs["vcs.modified"] == "true" {
				c += "-dirty"
			}
		}
		if d == "unknown" && vcs["vcs.time"] != "" {
			d = vcs["vcs.time"]
		}
	}
	return fmt.Sprintf("%s\ncommit:  %s\nbuilt:   %s\ngo:      %s\nos/arch: %s/%s\n", v, c, d, runtime.Version(), runtime.GOOS, runtime.GOARCH)
}
