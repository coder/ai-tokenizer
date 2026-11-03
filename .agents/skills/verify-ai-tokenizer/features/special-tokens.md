# Special tokens

`Tokenizer.encode(text, allowedSpecial, disallowedSpecial)` follows tiktoken's contract. By default special-token text throws. An allowed token encodes to its special id. `"all"` allows every special token. An empty disallowed list encodes the text as ordinary tokens.

## Sub-features

- `default-disallows`: `encode("hello <|endoftext|> world")` throws, as tiktoken does.
- `allowed-list`: `encode(text, ["<|endoftext|>"])` equals tiktoken and contains the special id.
- `allowed-all`: `encode(text, "all")` equals tiktoken `encode(text, "all")`.
- `disallowed-none`: `encode(text, [], [])` equals tiktoken.
- `decode-special`: `decode([<special id>])` gives the special token text.
- `count-ordinary`: `count(text)` counts special-token text as ordinary text and equals tiktoken `encode_ordinary(text).length`. It never throws. This is the behavior that [PR #9](https://github.com/coder/ai-tokenizer/pull/9) introduces.
- `claude/*`: the same checks for claude's `<EOT>`, without an oracle.

## How to get to it (user POV)

- `new Tokenizer(o200k_base).encode(text, allowedSpecial, disallowedSpecial)` from the published package.
- `tokenizer.count(text)`. With PR #9 it encodes with `[]`, `[]`. Without PR #9 it calls `encode(text)` with the defaults and throws on special-token text.
- Indirectly through `count()` in `ai-tokenizer/sdk` and the demo site. Those paths are in [sdk-count](./sdk-count.md) and [demo-site](./demo-site.md).

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` exits 0.

- **Run the journey.** Run `verify.sh drive special-tokens`. Each check prints in `evidence/special-tokens/journey.stderr`.
- **Compare with tiktoken.** Open `evidence/special-tokens/journey.stdout`. For the oracle checks, `expected` holds tiktoken's result and `observed` holds ai-tokenizer's, as `{ "value": [...] }` or `{ "threw": "..." }`. `default-disallows` nests them under `tiktoken` and `ours`. The claude checks and `decode-special` hold a stated expectation in `expected`.
- **Reproduce one case.** In the consumer, run `node --input-type=module -e 'import {Tokenizer} from "ai-tokenizer"; import * as e from "ai-tokenizer/encoding/o200k_base"; console.log(new Tokenizer(e).encode("hello <|endoftext|> world", "all"))'`. tiktoken gives `[24912, 220, 199999, 2375]`.

## Gotchas

- At commit 107814b, `allowed-all` and `count-ordinary` fail for every encoding. `encode(text, "all")` returns ordinary tokens, not the special id, and tiktoken returns the special id. `count(text)` throws `Text contains disallowed special token`, because the fix in PR #9 is not on main.
- claude's special tokens (`<EOT>`, `<META>`, `<META_START>`, `<META_END>`, `<SOS>`) look like normal markup. Users hit them in ordinary text.
- tiktoken objects hold WASM memory. Call `free()` in new checks.
