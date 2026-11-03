# AI SDK count

`count({ tokenizer, model, messages, tools })` from `ai-tokenizer/sdk` estimates the input tokens of an AI SDK call. It returns a total, one entry per message with a typed breakdown per content part, and a per-tool breakdown. It makes no network calls.

## Sub-features

- `string-content`: a string message gives a `text` part equal to `round(tokenizer.count(text) * contentMultiplier)`, and `total` equals `baseOverhead` plus the message and tool totals.
- `message-parts`: system, user text parts, assistant `tool-call` and `tool` `tool-result` messages give the parts in order, with `input` and `output` above 0.
- `tools`: tools built with `tool()` from `ai` and a `zod` schema give `name`, `description` and `inputSchema` counts above 0.
- `every-model`: the README pattern `new Tokenizer(encoding[model.encoding])` works for every entry in `models`.
- `special-text`: user text or a tool result that mentions `<|endoftext|>` or `<META>` still gives a numeric total. For openai/gpt-5 the text part equals tiktoken's `encode_ordinary` length times `contentMultiplier`.

## How to get to it (user POV)

- README "Estimate tokens with the AI SDK": `import Tokenizer, { models } from "ai-tokenizer"`, `import { count } from "ai-tokenizer/sdk"`, `import * as encoding from "ai-tokenizer/encoding"`.
- The same from CommonJS with `require("ai-tokenizer/sdk")` (covered in [entry-points](./entry-points.md)).

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` exits 0. The consumer has `ai` and `zod` from the repo's lockfile versions.

- **Run the journey.** Run `verify.sh drive sdk-count`. It prints one line per check in `evidence/sdk-count/journey.stderr`.
- **Check the breakdown.** Open `evidence/sdk-count/journey.stdout`. `message-parts` shows `contentTypes` `["text","text","tool-call","tool-result"]`. `tools` shows counts for `weather` and `time`.
- **Check every model.** The `every-model` check has `observed: []` when all models count.
- **Check text with special tokens.** The `special-text/*` checks pass when `observed.value.total` is a number.

## Gotchas

- `count()` has no tiktoken oracle. Provider APIs are the real oracle and need keys, so this journey checks structure, sums and the documented multiplier only.
- At commit 107814b, all three `special-text` checks fail. `count()` throws `Text contains disallowed special token: ...` because it calls `encode()` with the default arguments. Real chat text that mentions a special token, or claude's `<META>`, crashes the estimate.
- Images count as a fixed 85 and files as 100. Do not treat those numbers as measured.
- The `ai` package is an optional peer. It is required for the types of `ai-tokenizer/sdk`, not for running `count()`.
