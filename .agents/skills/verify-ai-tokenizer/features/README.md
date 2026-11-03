# ai-tokenizer verification map

This folder is the maintained source for verifying what ai-tokenizer users see. Read this index before you drive, then use the matching feature file as the recipe.

## Baseline preconditions

- `verify.sh launch` printed `READY run=<id>` and `verify.sh doctor` exits 0.
- The consumer at `${TMPDIR:-/tmp}/verify-ai-tokenizer/<run-id>/work/consumer` has the packed `ai-tokenizer` tarball plus `tiktoken`, `ai` and `zod`.
- For the demo site: `verify.sh site-up` printed `SITE READY` and `doctor` reports the port as ours.
- Never drive a site or browser session that this run did not start.

## Driving conventions

- Run journeys through `verify.sh drive <feature>`. It runs node from the consumer, so imports resolve to the installed tarball.
- tiktoken 1.0.22 is the oracle for o200k_base, cl100k_base and p50k_base. claude has no oracle here.
- Drive the site with agent-browser through ids and data attributes, not coordinates.
- Wait for the console line `Encoded in` or `Tokenization error` after a site input. The count shows the old value until the debounce fires.

## Proof and skip reporting

- Node proof is the JSON report in `evidence/<feature>/<step>.stdout` with the command and exit code beside it.
- Site proof is a full-page screenshot, an interactive snapshot, the console and the stats line after each action.
- Record the expected value with its source: tiktoken, the README, or a stated user expectation.
- Report a journey that cannot run with the command and the unmet precondition. Do not report it as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph about the user-visible behavior. It then has exactly four H2 sections in this order:

1. `Sub-features`: short IDs, one line each.
2. `How to get to it (user POV)`: every user entry point.
3. `Driving it with verify.sh`: starts with `Preconditions:`, then labeled bullets that pair a user action with a command and an observable result.
4. `Gotchas`: traps that waste or invalidate a run.

## Features

- [Encode, decode and count](./encode-decode.md): `Tokenizer` on plain text for every encoding, against tiktoken.
- [Special tokens](./special-tokens.md): `allowedSpecial` and `disallowedSpecial` on `encode`, against tiktoken.
- [AI SDK count](./sdk-count.md): `count()` from `ai-tokenizer/sdk` over messages, parts, tools and every model.
- [Package entry points](./entry-points.md): ESM, CJS and TypeScript consumers of every export subpath.
- [Demo site](./demo-site.md): the tokenizer page in `site/`, from model choice to token count.
