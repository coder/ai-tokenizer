# Encode, decode and count

A user builds `new Tokenizer(encoding)` and calls `encode`, `decode` and `count` on ordinary text. For o200k_base, cl100k_base and p50k_base the token ids must equal tiktoken's, and decode must give back the input.

## Sub-features

- `encode` returns the same ids as tiktoken for English, Unicode and emoji, code, numbers, whitespace runs, a long repeated string and the empty string.
- `count` equals the tiktoken token count.
- `roundtrip` gives `decode(encode(text)) === text`.
- `decode-oracle-ids` decodes tiktoken's ids back to the input.
- `claude` round trips and counts consistently. There is no external oracle.

## How to get to it (user POV)

- `import { Tokenizer } from "ai-tokenizer"` with `import * as o200k_base from "ai-tokenizer/encoding/o200k_base"` (README "Estimate tokens using an encoding").
- `import * as encoding from "ai-tokenizer/encoding"` and `new Tokenizer(encoding[name])`.

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` exits 0.

- **Run the journey.** Run `verify.sh drive encode-decode`. It prints `PASS encode-decode/journey`.
- **Read the checks.** Open `evidence/encode-decode/journey.stdout`. Each check named `<encoding>/<sample>/<check>` has `pass: true`. A failing `encode` check gives the first differing index in `observed.firstDiff`.
- **Reproduce by hand.** Run `node journeys/encode-decode.mjs` in the consumer folder. The exit code is 0 when all checks pass.

## Gotchas

- The corpus has no special-token text on purpose. Special tokens live in [special-tokens](./special-tokens.md).
- Encodings are 2 to 8 MB each. Loading all four takes a few seconds.
- claude results are self-consistent only. A wrong claude vocabulary still passes here.
