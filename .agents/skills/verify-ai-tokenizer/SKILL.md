---
name: verify-ai-tokenizer
description: "Drive the ai-tokenizer npm package the way a consumer does (packed tarball installed into a scratch project, ESM, CJS and TypeScript imports, tiktoken as oracle) and the demo site in site/ through agent-browser, then keep evidence. Use to prove or reproduce encode/decode/count, special-token, AI SDK count(), package entry point or demo-site behavior before or after a change."
---

# Verify ai-tokenizer

ai-tokenizer has two user surfaces:

1. Primary: the npm package. A user installs it and imports `ai-tokenizer`, `ai-tokenizer/sdk`, `ai-tokenizer/encoding` and `ai-tokenizer/encoding/<name>` from ESM, CJS or TypeScript.
2. Secondary: the demo site in `site/` (vite), deployed to GitHub Pages by `.github/workflows/deploy-site.yml`.

Every command below goes through one helper, `verify.sh`, in this folder. Run it from anywhere in the checkout:

```bash
V=.agents/skills/verify-ai-tokenizer/verify.sh
```

The feature map in [`features/README.md`](features/README.md) lists every journey. Read it before you drive.

## Launch

```bash
export BUN=/path/to/bun   # optional; defaults to bun on PATH
$V launch                 # prints READY run=<id> ... and export VAT_RUN=<id>
$V site-up                # only for demo-site; prints SITE READY url=... pgid=...
```

`launch` does this, in order:

1. Creates `${TMPDIR:-/tmp}/verify-ai-tokenizer/<run-id>/` with `work/` (scratch) and `evidence/` (kept). It writes `meta.env` with HEAD, tool versions and the agent-browser session name.
2. In the checkout, under a per-checkout `flock`: `bun install --frozen-lockfile`, `bun run build` (full build with `.d.ts`, as a published package has), `npm pack` of the package, and `npm pack` of the oracle and peer packages from the repo's `node_modules` (tiktoken, ai and its deps, zod).
3. Installs all tarballs into `work/consumer` with `npm install --offline`. No network is used.
4. Copies `journeys/` into the consumer. Node resolves `ai-tokenizer` from the importing file, so journeys must run from the consumer, never from the repo.

Ready means the last line reads `READY run=<id> consumer=<path> ai-tokenizer@<version>`. The build takes about 45 seconds.

`site-up` removes bun's copy at `site/node_modules/ai-tokenizer` (bun copies `file:..` at install time), runs `bun install --frozen-lockfile` and `bun run build --outDir <run>/work/site-dist` in `site/`, then starts `bun run preview` on a free port in its own process group. Ready means `SITE READY url=http://127.0.0.1:<port>/ai-tokenizer/`. Set `VAT_PORT` to pick the port.

Other commands use the run in `VAT_RUN`, or the latest launch when `VAT_RUN` is unset.

Isolation: each run has its own consumer, site build, port and browser session. Two runs share only the checkout's `dist/` and `site/node_modules`, and the lock serializes writes to them. A rebuild by another run makes `doctor` fail on this run. Relaunch then.

## Doctor

```bash
$V doctor
```

Read-only. Exit code 0 means the run is worth driving. It checks:

- checkout HEAD equals the HEAD at launch,
- `bun.lock` and `site/bun.lock` are unchanged,
- the consumer has `ai-tokenizer@<package.json version>` and its `dist/index.js` equals the checkout `dist/index.js`,
- the tiktoken oracle is installed,
- when the site is up: the port belongs to our process group, the site was built against the checkout `dist/`, the page answers, and agent-browser is on PATH.

Run it first whenever a result looks wrong.

## Drive

```bash
$V drive encode-decode     # Tokenizer encode/decode/count vs tiktoken
$V drive special-tokens    # allowedSpecial / disallowedSpecial vs tiktoken
$V drive sdk-count         # count() from ai-tokenizer/sdk with real ai + zod objects
$V drive entry-points      # ESM, CJS and tsc (nodenext, bundler) consumers
$V drive demo-site         # agent-browser on the preview site (needs site-up)
$V drive all
```

Each drive prints one `PASS` or `FAIL` line per step and exits non-zero on any failure. A failing step is a finding. Do not edit a journey to make it pass.

The node journeys print a JSON report: one entry per check with `id`, `pass`, `action`, `expected` and `observed`. `observed` holds `{ "value": ... }` or `{ "threw": "<message>" }`.

The demo-site journey drives the page through stable ids and data attributes: `#input-text`, `#model-select`, `#token-count`, `#char-count`, `#encoding-name`, `#clear-btn` and `button.model-chip[data-model="<model key>"]`. To drive the page by hand, use the run's session:

```bash
source "${TMPDIR:-/tmp}/verify-ai-tokenizer/$VAT_RUN/meta.env"   # sets SITE_URL and SESSION
agent-browser --session "$SESSION" open "$SITE_URL"
agent-browser --session "$SESSION" snapshot -i -c
agent-browser --session "$SESSION" fill '#input-text' 'some text'
agent-browser --session "$SESSION" get text '#token-count'
agent-browser --session "$SESSION" console
```

## Evidence

Everything goes to `${TMPDIR:-/tmp}/verify-ai-tokenizer/<run-id>/evidence/`:

- `meta.env`: run id, HEAD, dirty file count, bun and node versions, package version, site URL.
- `steps.log`: one line per step with time, feature, step and exit code.
- `<feature>/<step>.cmd`, `.stdout`, `.stderr`, `.exit`: the exact command, its output and exit code. For node journeys `.stdout` is the JSON report.
- `demo-site/NN-<check>.png` (full page), `.aria.txt` (interactive snapshot), `.console.txt` (browser console) and `.stats.txt` (token, character and encoding values) after each action, plus `checks.jsonl`.

Proof standards:

- Exercise the published shape: the packed tarball in a separate project, not `src/` and not `bun test`.
- Compare with tiktoken where an oracle exists (o200k_base, cl100k_base, p50k_base). claude has no oracle here, so its checks prove round trips and consistency only.
- Capture the action and the resulting state. For the site, keep the console with the screenshot: the error path only shows up there and as an `alert`.
- A green `bun test` is not proof of user behavior.

## Cleanup

```bash
$V site-down   # closes the browser session and kills the preview process group
$V cleanup     # site-down, then removes <run>/work; keeps <run>/evidence and lists it
```

Cleanup kills only the process group recorded in `meta.env` and the browser session named there. It leaves the checkout's `dist/` and `site/node_modules` in place, because they are normal build output that other work can use. Remove an old run with `rm -rf "${TMPDIR:-/tmp}/verify-ai-tokenizer/<run-id>"` once you no longer need its evidence.

## Helpers

- `verify.sh <launch|doctor|site-up|drive <feature>|site-down|cleanup>`: the harness. Environment: `BUN` (bun binary), `VAT_RUN` (run id), `VAT_ROOT` (default `${TMPDIR:-/tmp}/verify-ai-tokenizer`), `VAT_PORT` (site port).
- `journeys/*.mjs`, `journeys/entry-points.cjs`: node journeys. `verify.sh drive` runs them from the consumer. To rerun one by hand: `cd "$VAT_ROOT/$VAT_RUN/work/consumer" && node journeys/special-tokens.mjs`.
- `journeys/types-esm.mts`, `journeys/types-cjs.cts`: the README snippets, typechecked by `drive entry-points` with the repo's `node_modules/typescript`.
- `journeys/demo-site.sh <site-url> <session> <evidence-dir> <consumer-dir>`: the site journey. `verify.sh drive demo-site` fills in the arguments.

Keep the map honest as the app changes with `/maintain-verification-skill`.
