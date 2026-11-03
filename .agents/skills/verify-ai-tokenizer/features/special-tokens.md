# Special tokens

`Tokenizer.encode(text, allowedSpecial, disallowedSpecial)` follows tiktoken's contract. By default special-token text throws. An allowed token encodes to its special id. `"all"` allows every special token. An empty disallowed list encodes the text as ordinary tokens.

## Sub-features

- `default-disallows`: `encode("hello <|endoftext|> world")` throws, as tiktoken does.
- `allowed-list`: `encode(text, ["<|endoftext|>"])` equals tiktoken and contains the special id.
- `allowed-all`: `encode(text, "all")` equals tiktoken `encode(text, "all")`.
- `disallowed-none`: `encode(text, [], [])` equals tiktoken.
- `decode-special`: `decode([<special id>])` gives the special token text.
- `count-ordinary`: `count(text)` counts special-token text as ordinary text and equals tiktoken `encode_ordinary(text).length`. It never throws.
- `claude/*`: the same checks for claude's `<EOT>`, without an oracle.

## How to get to it (user POV)

- `new Tokenizer(o200k_base).encode(text, allowedSpecial, disallowedSpecial)` from the published package.
- `tokenizer.count(text)`, which encodes with `[]`, `[]`.
- Indirectly through `count()` in `ai-tokenizer/sdk` and the demo site. Those paths are in [sdk-count](./sdk-count.md) and [demo-site](./demo-site.md).

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` exits 0.

- **Run the journey.** Run `verify.sh drive special-tokens`. Each check prints in `evidence/special-tokens/journey.stderr`.
- **Compare with tiktoken.** Open `evidence/special-tokens/journey.stdout`. For every check, `expected` holds tiktoken's result and `observed` holds ai-tokenizer's, as `{ "value": [...] }` or `{ "threw": "..." }`.
- **Reproduce one case.** In the consumer, run `node --input-type=module -e 'import {Tokenizer} from "ai-tokenizer"; import * as e from "ai-tokenizer/encoding/o200k_base"; console.log(new Tokenizer(e).encode("hello <|endoftext|> world", "all"))'`. tiktoken gives `[24912, 220, 199999, 2375]`.

## Gotchas

- At commit 107814b, `allowed-all` fails for every encoding. `encode(text, "all")` returns ordinary tokens, not the special id. tiktoken returns the special id.
- claude's special tokens (`<EOT>`, `<META>`, `<META_START>`, `<META_END>`, `<SOS>`) look like normal markup. Users hit them in ordinary text.
- tiktoken objects hold WASM memory. Call `free()` in new checks.
