#!/usr/bin/env bash
# Regenerates the A2A JSON Schemas embedded in internal/validate/schemas.
#
#   a2a-v0.3.json  specification/json/a2a.json from the A2A repository at A2A_V03_REF, unchanged.
#   a2a-v1.0.json  generated from specification/a2a.proto at A2A_V1_REF with bufbuild's
#                  protoc-gen-jsonschema, using the same plugin and options as the A2A
#                  repository's scripts/proto_to_json_schema.sh. Unlike that script's bundle,
#                  each message is kept under $defs with its $ref rewritten to point there, so
#                  validators can resolve the references.
#
# Requires git, protoc, jq, buf and go. Set A2A_REPO to a local clone of
# github.com/a2aproject/A2A to skip cloning, and BUF to the buf binary if it isn't on PATH.
set -euo pipefail

A2A_V03_REF=v0.3.0
A2A_V1_REF=v1.0.1
PLUGIN_VERSION=v0.6.0

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT_DIR=$ROOT_DIR/internal/validate/schemas
BUF=${BUF:-buf}

for cmd in git protoc jq go "$BUF"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd not found on PATH" >&2
    exit 1
  fi
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

REPO=${A2A_REPO:-}
if [[ -z $REPO ]]; then
  REPO=$TMP/A2A
  git clone --quiet --filter=blob:none --no-checkout https://github.com/a2aproject/A2A.git "$REPO"
fi

mkdir -p "$OUT_DIR"
git -C "$REPO" show "$A2A_V03_REF:specification/json/a2a.json" >"$OUT_DIR/a2a-v0.3.json"

mkdir -p "$TMP/spec" "$TMP/clean" "$TMP/out" "$TMP/bin"
git -C "$REPO" archive "$A2A_V1_REF" specification | tar -x -C "$TMP/spec"
(cd "$TMP/spec/specification" && "$BUF" export . --output "$TMP/protos")
# Same comment cleanup as the A2A repository's script.
grep -v -e "// --8<--" -e "// protolint:" "$TMP/protos/a2a.proto" >"$TMP/clean/a2a.proto"

GOBIN=$TMP/bin go install "github.com/bufbuild/protoschema-plugins/cmd/protoc-gen-jsonschema@$PLUGIN_VERSION"
PATH=$TMP/bin:$PATH protoc -I"$TMP/clean" -I"$TMP/protos" \
  --jsonschema_out="$TMP/out" --jsonschema_opt=target=json "$TMP/clean/a2a.proto"

jq -s --arg ref "$A2A_V1_REF" '
  def name: sub("\\.jsonschema\\.json$"; "");
  def fixrefs: walk(
    if type == "object" and (."$ref" | type) == "string"
    then ."$ref" |= ("#/$defs/" + name)
    else . end);
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    title: "A2A Protocol Schemas",
    description: ("Generated from specification/a2a.proto at A2A " + $ref + " by scripts/gen-schemas.sh. Do not edit."),
    "$defs": (map({key: (."$id" | name), value: (del(."$id", ."$schema") | fixrefs)}) | sort_by(.key) | from_entries)
  }' "$TMP"/out/*.json >"$OUT_DIR/a2a-v1.0.json"

echo "wrote $OUT_DIR/a2a-v0.3.json ($A2A_V03_REF) and $OUT_DIR/a2a-v1.0.json ($A2A_V1_REF)" >&2
