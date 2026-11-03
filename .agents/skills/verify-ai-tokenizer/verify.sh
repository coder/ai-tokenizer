#!/usr/bin/env bash
# Verification harness for ai-tokenizer. Usage: verify.sh <launch|doctor|drive|site-up|site-down|cleanup> [args]
# See SKILL.md in this folder for the full recipe.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$SKILL_DIR" rev-parse --show-toplevel)"
VAT_ROOT="${VAT_ROOT:-${TMPDIR:-/tmp}/verify-ai-tokenizer}"
BUN="${BUN:-$(command -v bun || true)}"
FEATURES="encode-decode special-tokens sdk-count entry-points demo-site"

die() { echo "FAIL: $*" >&2; exit 1; }

# VAT_ROOT is shared by every checkout on the host, so the lock and the latest pointer are keyed by checkout path.
CHECKOUT_KEY="$(printf '%s' "$REPO" | sha256sum | cut -c1-12)"
LATEST="$VAT_ROOT/latest-$CHECKOUT_KEY"

run_dir() {
  local id="${VAT_RUN:-}"
  if [[ -z "$id" && -f "$LATEST" ]]; then id="$(cat "$LATEST")"; fi
  [[ -n "$id" && -d "$VAT_ROOT/$id" ]] || die "no run found for this checkout. Run 'verify.sh launch' first or prefix VAT_RUN=<id>."
  echo "$VAT_ROOT/$id"
}

load_meta() {
  RUN="$(run_dir)"
  local here="$REPO"
  # shellcheck disable=SC1091
  source "$RUN/meta.env"
  [[ "$REPO" == "$here" ]] || die "run $RUN_ID belongs to checkout $REPO, not $here. Use a run launched from this checkout."
}

set_meta() { # key value
  local f="$RUN/meta.env"
  grep -v "^$1=" "$f" > "$f.tmp" || true
  printf '%s=%q\n' "$1" "$2" >> "$f.tmp"
  mv "$f.tmp" "$f"
}

# Serializes writes to the checkout's dist/ and site/node_modules between concurrent runs.
with_checkout_lock() {
  local lock
  lock="$VAT_ROOT/checkout-$CHECKOUT_KEY.lock"
  flock "$lock" "$@"
}

# Peer and oracle packages, packed from the repo's installed devDependencies so the
# consumer install needs no network.
ORACLE_PKGS="tiktoken zod ai @ai-sdk/gateway @ai-sdk/provider @ai-sdk/provider-utils @opentelemetry/api @vercel/oidc @standard-schema/spec eventsource-parser json-schema"

build_and_pack() {
  local work="$1"
  cd "$REPO"
  "$BUN" install --frozen-lockfile
  "$BUN" run build
  npm pack --pack-destination "$work/pkgs" --silent
  for p in $ORACLE_PKGS; do
    (cd "$REPO/node_modules/$p" && npm pack --pack-destination "$work/pkgs" --silent >/dev/null)
  done
}

cmd_launch() {
  command -v node >/dev/null || die "node not on PATH"
  command -v npm >/dev/null || die "npm not on PATH"
  [[ -x "$BUN" ]] || die "bun not found. Set BUN=/path/to/bun"
  local id="${VAT_RUN:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
  RUN="$VAT_ROOT/$id"
  [[ ! -e "$RUN" ]] || die "run $id already exists. Drop the VAT_RUN prefix to launch a new run."
  mkdir -p "$RUN/work/pkgs" "$RUN/work/consumer" "$RUN/evidence"
  echo "== run $id at $RUN"
  : > "$RUN/meta.env"
  set_meta RUN_ID "$id"
  set_meta REPO "$REPO"
  set_meta HEAD "$(git -C "$REPO" rev-parse HEAD)"
  set_meta DIRTY "$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ')"
  set_meta BUN "$BUN"
  set_meta BUN_VERSION "$("$BUN" --version)"
  set_meta NODE_VERSION "$(node --version)"
  set_meta PKG_VERSION "$(node -p "require('$REPO/package.json').version")"
  set_meta SESSION "verify-ai-tokenizer-$id"
  git -C "$REPO" diff HEAD > "$RUN/evidence/checkout.diff"
  git -C "$REPO" status --porcelain > "$RUN/evidence/checkout.status"

  echo "== build and pack (logs: $RUN/work/build.log)"
  export -f build_and_pack
  export REPO BUN ORACLE_PKGS
  with_checkout_lock bash -c 'build_and_pack "$0"' "$RUN/work" > "$RUN/work/build.log" 2>&1 \
    || { tail -20 "$RUN/work/build.log"; die "build failed"; }

  echo "== install tarballs into scratch consumer"
  cd "$RUN/work/consumer"
  echo '{ "name": "vat-consumer", "private": true, "version": "0.0.0" }' > package.json
  npm install --offline --no-audit --no-fund "$RUN"/work/pkgs/*.tgz > "$RUN/work/install.log" 2>&1 \
    || { tail -20 "$RUN/work/install.log"; die "consumer install failed"; }
  cp -R "$SKILL_DIR/journeys" "$RUN/work/consumer/journeys"
  cp "$RUN/meta.env" "$RUN/evidence/meta.env"
  echo "$id" > "$LATEST"
  echo "READY run=$id consumer=$RUN/work/consumer ai-tokenizer@$(node -p "require('./node_modules/ai-tokenizer/package.json').version")"
}

site_build() {
  local out="$1"
  cd "$REPO/site"
  # bun copies the file:.. dependency at install time. Drop the copy so it picks up the fresh dist/.
  rm -rf node_modules/ai-tokenizer
  "$BUN" install --frozen-lockfile
  "$BUN" run build --outDir "$out" --emptyOutDir
}

free_port() { node -e 's=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

cmd_site_up() {
  load_meta
  [[ -z "${SITE_PGID:-}" ]] || ! kill -0 -- "-$SITE_PGID" 2>/dev/null || die "site already up (pgid $SITE_PGID). Run site-down first."
  echo "== build site (logs: $RUN/work/site-build.log)"
  export -f site_build
  export REPO BUN
  with_checkout_lock bash -c 'site_build "$0"' "$RUN/work/site-dist" > "$RUN/work/site-build.log" 2>&1 \
    || { tail -20 "$RUN/work/site-build.log"; die "site build failed"; }
  local port="${VAT_PORT:-$(free_port)}"
  cd "$REPO/site"
  # setsid gives the preview server its own process group, so site-down kills exactly what we started.
  setsid nohup "$BUN" run preview --outDir "$RUN/work/site-dist" --port "$port" --strictPort --host 127.0.0.1 \
    > "$RUN/work/site.log" 2>&1 < /dev/null &
  local pgid=$!
  set_meta SITE_PGID "$pgid"
  set_meta SITE_URL "http://127.0.0.1:$port/ai-tokenizer/"
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$port/ai-tokenizer/" 2>/dev/null | grep -q 'id="model-select"'; then
      echo "SITE READY url=http://127.0.0.1:$port/ai-tokenizer/ pgid=$pgid"
      return 0
    fi
    kill -0 -- "-$pgid" 2>/dev/null || { cat "$RUN/work/site.log"; die "preview server exited"; }
    sleep 0.5
  done
  die "site did not answer on port $port within 30s"
}

cmd_site_down() {
  load_meta
  if command -v agent-browser >/dev/null; then agent-browser --session "$SESSION" close >/dev/null 2>&1 || true; fi
  if [[ -n "${SITE_PGID:-}" ]] && kill -0 -- "-$SITE_PGID" 2>/dev/null; then
    kill -- "-$SITE_PGID"
    echo "stopped site pgid $SITE_PGID"
  fi
  set_meta SITE_PGID ""
}

cmd_doctor() {
  load_meta
  local bad=0
  ok() { echo "OK   $*"; }
  no() { echo "FAIL $*"; bad=1; }
  echo "run=$RUN_ID repo=$REPO"
  [[ "$(git -C "$REPO" rev-parse HEAD)" == "$HEAD" ]] && ok "checkout HEAD matches launch ($HEAD)" \
    || no "checkout HEAD moved since launch. Relaunch."
  git -C "$REPO" diff --quiet -- bun.lock site/bun.lock && ok "bun.lock and site/bun.lock untouched" \
    || no "bun.lock changed. Restore it with git checkout -- bun.lock site/bun.lock"
  ok "bun $("$BUN" --version) node $(node --version)"
  local c="$RUN/work/consumer"
  if [[ -f "$c/node_modules/ai-tokenizer/package.json" ]]; then
    local v; v="$(node -p "require('$c/node_modules/ai-tokenizer/package.json').version")"
    [[ "$v" == "$PKG_VERSION" ]] && ok "consumer has ai-tokenizer@$v from the packed tarball" || no "consumer ai-tokenizer@$v, repo is $PKG_VERSION"
    if cmp -s "$c/node_modules/ai-tokenizer/dist/index.js" "$REPO/dist/index.js"; then ok "consumer dist matches checkout dist/"
    else no "consumer dist differs from checkout dist/ (someone rebuilt). Relaunch."; fi
  else
    no "consumer install missing at $c"
  fi
  [[ -f "$c/node_modules/tiktoken/package.json" ]] && ok "tiktoken oracle installed" || no "tiktoken oracle missing"
  if [[ -n "${SITE_PGID:-}" ]]; then
    local port="${SITE_URL#http://127.0.0.1:}"; port="${port%%/*}"
    local lpid; lpid="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)" || true
    if [[ -n "$lpid" && "$(ps -o pgid= -p "$lpid" | tr -d ' ')" == "$SITE_PGID" ]]; then ok "port $port owned by our preview (pgid $SITE_PGID)"
    else no "port $port is not owned by pgid $SITE_PGID"; fi
    if cmp -s "$REPO/site/node_modules/ai-tokenizer/dist/index.js" "$REPO/dist/index.js"; then ok "site was built against checkout dist/"
    else no "site/node_modules/ai-tokenizer is stale against dist/. Run site-down, then site-up."; fi
    curl -fsS "$SITE_URL" 2>/dev/null | grep -q 'id="model-select"' && ok "site answers at $SITE_URL" || no "site does not answer at $SITE_URL"
    command -v agent-browser >/dev/null && ok "agent-browser $(agent-browser --version | awk '{print $2}')" || no "agent-browser not on PATH"
  else
    echo "INFO site not up (run 'verify.sh site-up' for demo-site)"
  fi
  return $bad
}

# step <feature> <name> <cmd...>: run one user action and keep cmd, stdout, stderr and exit code.
step() {
  local f="$1" n="$2"; shift 2
  local d="$RUN/evidence/$f"; mkdir -p "$d"
  printf '%q ' "$@" > "$d/$n.cmd"; echo >> "$d/$n.cmd"
  local rc=0
  "$@" > "$d/$n.stdout" 2> "$d/$n.stderr" || rc=$?
  echo "$rc" > "$d/$n.exit"
  echo "$(date -u +%FT%TZ) $f $n exit=$rc" >> "$RUN/evidence/steps.log"
  [[ "$rc" == 0 ]] && echo "PASS $f/$n" || echo "FAIL $f/$n (exit $rc, see $d/$n.stdout)"
  return "$rc"
}

write_tsconfig() { # name module moduleResolution
  printf '{"compilerOptions":{"strict":true,"noEmit":true,"skipLibCheck":true,"module":"%s","moduleResolution":"%s","target":"es2022","lib":["es2022","dom"],"types":[]},"files":["journeys/types-esm.mts","journeys/types-cjs.cts"]}\n' "$2" "$3" > "$1"
}

cmd_drive() {
  load_meta
  local feature="${1:-}"
  [[ -n "$feature" ]] || die "usage: verify.sh drive <$(echo $FEATURES | tr ' ' '|')|all>"
  if [[ "$feature" == all ]]; then
    local rc=0
    for f in $FEATURES; do cmd_drive "$f" || rc=1; done
    return $rc
  fi
  local c="$RUN/work/consumer" rc=0
  cd "$c"
  case "$feature" in
    encode-decode|special-tokens|sdk-count)
      step "$feature" journey node "journeys/$feature.mjs" || rc=1 ;;
    entry-points)
      step "$feature" esm node journeys/entry-points.mjs || rc=1
      step "$feature" cjs node journeys/entry-points.cjs || rc=1
      write_tsconfig tsconfig.nodenext.json nodenext nodenext
      write_tsconfig tsconfig.bundler.json preserve bundler
      step "$feature" types-nodenext node "$REPO/node_modules/typescript/bin/tsc" -p tsconfig.nodenext.json || rc=1
      step "$feature" types-bundler node "$REPO/node_modules/typescript/bin/tsc" -p tsconfig.bundler.json || rc=1 ;;
    demo-site)
      [[ -n "${SITE_PGID:-}" ]] || die "site not up. Run 'verify.sh site-up' first."
      step "$feature" journey bash "$SKILL_DIR/journeys/demo-site.sh" "$SITE_URL" "$SESSION" "$RUN/evidence/demo-site" "$c" || rc=1 ;;
    *) die "unknown feature '$feature'. Known: $FEATURES" ;;
  esac
  return $rc
}

cmd_cleanup() {
  load_meta
  cmd_site_down >/dev/null
  mkdir -p "$RUN/evidence/logs"
  for log in build install site-build site; do
    if [[ -f "$RUN/work/$log.log" ]]; then cp "$RUN/work/$log.log" "$RUN/evidence/logs/"; fi
  done
  rm -rf "$RUN/work"
  # Re-read meta so the evidence copy records the final site state.
  cp "$RUN/meta.env" "$RUN/evidence/meta.env"
  echo "cleaned $RUN/work. Evidence kept at $RUN/evidence:"
  (cd "$RUN/evidence" && find . -type f | sort)
}

case "${1:-}" in
  launch) cmd_launch ;;
  doctor) cmd_doctor ;;
  site-up) cmd_site_up ;;
  site-down) cmd_site_down ;;
  drive) shift; cmd_drive "$@" ;;
  cleanup) cmd_cleanup ;;
  *) echo "usage: verify.sh <launch|doctor|site-up|drive <feature>|site-down|cleanup>"; exit 2 ;;
esac
