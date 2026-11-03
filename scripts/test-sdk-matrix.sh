#!/usr/bin/env bash
# Tests `ai-tokenizer/sdk` against one AI SDK + zod pairing, or against all of
# them. CI runs one cell per job. Every cell does four things:
#   1. installs the pairing in place of the dev dependencies,
#   2. type-checks src and runs the sdk tests,
#   3. builds dist,
#   4. loads the CJS and ESM builds with the installed `ai` and `zod`.
#
#   scripts/test-sdk-matrix.sh <ai-version> <zod-version>
#       Runs one cell in this checkout. It rewrites package.json, bun.lock and
#       node_modules, so use it in a throwaway checkout such as a CI job.
#   scripts/test-sdk-matrix.sh --all
#       Runs every cell, each in a throwaway copy of the repo, on the Node
#       that is installed here (the Node column only applies in CI).
#   scripts/test-sdk-matrix.sh --list-json
#       Prints the cells as a GitHub Actions matrix. CI reads this list.
#
# Every cell prints one line starting with "CELL".
set -euo pipefail

# ai version, zod version, Node major used in CI. Node 20 covers a v5/v6 user
# who loads the CJS build: v7 needs Node 22.
CELLS=(
  "5 3.25.76 22"
  "5 4 22"
  "5 4 20"
  "6 3.25.76 22"
  "6 4 22"
  "6 4 20"
  "7 3.25.76 22"
  "7 4 22"
)

installed() { node -p "require('$1/package.json').version"; }

run_cell() {
  local ai="$1" zod="$2" log
  # Bun resolves `ai` once for the dev dependency and the peer dependency and
  # picks the peer range (^5 || ^6 || ^7), so drop the peer range here.
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    pkg.devDependencies.ai = process.argv[1];
    pkg.devDependencies.zod = process.argv[2];
    delete pkg.peerDependencies;
    delete pkg.peerDependenciesMeta;
    fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  ' "$ai" "$zod"
  bun install >/dev/null

  # Only the sdk files are type-checked: scripts/ and bench/ use the newest AI SDK.
  log="$(mktemp)"
  local typecheck=ok tests
  printf '{"extends":"./tsconfig.json","include":["src/sdk*.ts"]}' >tsconfig.sdk-cell.json
  bunx tsc --noEmit -p tsconfig.sdk-cell.json >"$log" 2>&1 || { cat "$log"; typecheck=FAILED; }
  rm -f tsconfig.sdk-cell.json

  bun test src/sdk.test.ts src/sdk.compat.test.ts >"$log" 2>&1 || { cat "$log"; exit 1; }
  tests="$(grep -E '^ *[0-9]+ (pass|skip|fail)$' "$log" | tr -s ' ' | tr '\n' ' ' || true)"
  [ -n "$tests" ] || { cat "$log"; echo "no test summary found" >&2; exit 1; }

  bun run build --dts=false >/dev/null
  local smoke
  smoke="$(node scripts/smoke-sdk-dist.mjs)"

  echo "CELL ai@$(installed ai) zod@$(installed zod) typecheck=$typecheck tests:$tests| $smoke"
  [ "$typecheck" = ok ]
}

case "${1:-}" in
  --list-json)
    printf '{"include":['
    sep=""
    for cell in "${CELLS[@]}"; do
      read -r ai zod node <<<"$cell"
      printf '%s{"ai":"%s","zod":"%s","node":"%s"}' "$sep" "$ai" "$zod" "$node"
      sep=","
    done
    printf ']}\n'
    ;;
  --all)
    root="$(cd "$(dirname "$0")/.." && pwd)"
    failed=0
    for cell in "${CELLS[@]}"; do
      read -r ai zod _node <<<"$cell"
      tmp="$(mktemp -d)"
      (cd "$root" && cp -r package.json bun.lock tsconfig.json tsdown.config.ts src scripts "$tmp")
      (cd "$tmp" && bash scripts/test-sdk-matrix.sh "$ai" "$zod") || failed=1
      rm -rf "$tmp"
    done
    exit "$failed"
    ;;
  "")
    echo "usage: $0 <ai-version> <zod-version> | --all | --list-json" >&2
    exit 2
    ;;
  *)
    run_cell "$1" "${2:?zod version required}"
    ;;
esac
