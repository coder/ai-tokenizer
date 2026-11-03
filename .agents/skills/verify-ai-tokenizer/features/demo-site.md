# Demo site

The demo page lets a user pick a model, type or paste text, and see the token count, character count, encoding and colored tokens. The page loads with GPT-5 (o200k_base) and an example text. Tokenization runs in a web worker.

## Sub-features

- `load`: the default page shows encoding `o200k_base` and the tiktoken count of the example text.
- `type-text`: typing updates tokens and characters to the tiktoken values.
- `chip-claude`: the `Claude Opus 4.5` chip switches the encoding to `claude`.
- `select-gpt4-turbo`: choosing `openai/gpt-4-turbo` in the all-models list loads `cl100k_base`.
- `special-token`: text that contains `<|endoftext|>` gives a plain-text count and no error.
- `special-token-keep-typing`: further typing after such text gives the tiktoken plain-text count and no new error alert.
- `recover`: removing the special token restores a numeric count.
- `clear`: the `Clear` button empties the text and resets both counts to 0.

## How to get to it (user POV)

- Open `https://coder.github.io/ai-tokenizer/` (deployed) or the local preview URL from `verify.sh site-up`.
- Choose a popular-model chip, or a model in the `All models` list.
- Type or paste into the `Input Text` box.

## Driving it with verify.sh

Preconditions:

- `verify.sh site-up` printed `SITE READY` and `verify.sh doctor` exits 0.
- agent-browser is on PATH. The journey uses the session named in `meta.env`.

- **Run the journey.** Run `verify.sh drive demo-site`. `evidence/demo-site/journey.stdout` has one `PASS` or `FAIL` line per check with expected and observed values.
- **Load.** `agent-browser open <url>`, then wait until `#encoding-name` reads `o200k_base` and `#token-count` is a number. The count equals tiktoken's count of the `#input-text` value.
- **Type.** `agent-browser fill '#input-text' '<text>'`, then wait for an `Encoded in` console line. `#token-count` and `#char-count` show the new values.
- **Switch model.** `agent-browser click 'button.model-chip[data-model="anthropic/claude-opus-4.5"]'` or `agent-browser select '#model-select' 'openai/gpt-4-turbo'`. `#encoding-name` changes to `claude` or `cl100k_base`.
- **Special token.** Choose GPT-5 and fill `hello <|endoftext|> world`. Expected: 9 tokens (tiktoken `encode_ordinary`) and no alert. Proof: `05-special-token.png` and `05-special-token.console.txt`.
- **Clear.** `agent-browser click '#clear-btn'`. `#token-count` and `#char-count` read `0` and `#input-text` is empty.
- **Proof.** Each step leaves `NN-<check>.png`, `.aria.txt`, `.console.txt` and `.stats.txt` in `evidence/demo-site/`.

## Gotchas

- agent-browser accepts `alert` dialogs on its own. The site reports errors with `alert('Tokenization error: ...')`, so look for `[error] Tokenization error` in the console file. A real user sees a blocking alert.
- At commit 107814b, `special-token` and `special-token-keep-typing` fail. `#token-count` reads `Error`, an alert opens on each edit, and the Tokens panel keeps showing the tokens of the previous text.
- The count keeps its old value for 150 ms or more after an input (debounce). Wait for the console line, not for a fixed time.
- Tokens are drawn on an OffscreenCanvas. Snapshots cannot read them. Use the screenshot.
- `bun install` copies `file:..` into `site/node_modules/ai-tokenizer`. `site-up` deletes that copy first so the site uses the fresh `dist/`.
- The preview serves under `/ai-tokenizer/` (vite `base`). The root path only redirects. Open the URL that `site-up` prints.
- The claude count has no external oracle. The journey compares it with the installed library.
