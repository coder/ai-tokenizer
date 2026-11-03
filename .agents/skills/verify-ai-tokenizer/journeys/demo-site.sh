#!/usr/bin/env bash
# demo-site journey. Usage: demo-site.sh <site-url> <agent-browser-session> <evidence-dir> <consumer-dir>
# verify.sh drive demo-site calls this with the values from the current run.
set -uo pipefail
URL="$1" SESSION="$2" OUT="$3" CONSUMER="$4"
mkdir -p "$OUT"
CHECKS="$OUT/checks.jsonl"
: > "$CHECKS"
FAILED=0
N=0

ab() { agent-browser --session "$SESSION" "$@"; }

# oracle <encoding> <text>: tiktoken count for o200k/cl100k/p50k, ai-tokenizer count for claude.
oracle() {
  (cd "$CONSUMER" && ENC="$1" TEXT="$2" node --input-type=module -e '
    const { ENC, TEXT } = process.env;
    if (ENC === "claude") {
      const { Tokenizer } = await import("ai-tokenizer");
      const claude = await import("ai-tokenizer/encoding/claude");
      console.log(new Tokenizer(claude).count(TEXT));
    } else {
      const { get_encoding } = await import("tiktoken");
      console.log(get_encoding(ENC).encode_ordinary(TEXT).length);
    }')
}

record() { # id action expected observed pass(0|1)
  local pass=false; [[ "$5" == 1 ]] && pass=true || FAILED=1
  node -e 'const [id,action,expected,observed,pass]=process.argv.slice(1);console.log(JSON.stringify({id,pass:pass==="true",action,expected,observed}))' \
    "$1" "$2" "$3" "$4" "$pass" >> "$CHECKS"
  echo "$([[ $pass == true ]] && echo PASS || echo FAIL) demo-site/$1: expected [$3] observed [$4]"
}

# evidence <id>: screenshot, interactive snapshot and console for the state after an action.
evidence() {
  N=$((N + 1))
  local p; p="$OUT/$(printf '%02d' "$N")-$1"
  ab screenshot --full "$p.png" >/dev/null
  ab snapshot -i -c > "$p.aria.txt"
  ab console > "$p.console.txt"
  printf 'tokens=%s chars=%s encoding=%s\n' "$(stat_text token-count)" "$(stat_text char-count)" "$(stat_text encoding-name)" > "$p.stats.txt"
}

stat_text() { ab get text "#$1" 2>/dev/null | tr -d '\r'; }
digits() { tr -d ','; }

# wait_tokenized: main.js logs "Encoded in" or "Tokenization error" once per finished tokenization.
wait_tokenized() {
  for _ in $(seq 1 50); do
    if ab console 2>/dev/null | grep -qE 'Encoded in|Tokenization error'; then return 0; fi
    sleep 0.2
  done
  return 1
}

act() { ab console --clear >/dev/null; "$@"; }

# 1. Load: default model GPT-5, default example text, count shown.
ab open "$URL" >/dev/null
ab wait --fn "document.getElementById('encoding-name').textContent === 'o200k_base' && /^[0-9,]+$/.test(document.getElementById('token-count').textContent)" >/dev/null
default_text="$(ab get value '#input-text')"
want="$(oracle o200k_base "$default_text")"
got="$(stat_text token-count | digits)"
evidence load
record load "open $URL (default GPT-5 and example text)" "tokens=$want (tiktoken o200k_base)" "tokens=$got encoding=$(stat_text encoding-name)" "$([[ "$got" == "$want" ]] && echo 1 || echo 0)"

# 2. Type text.
text="Hello, world! Tokenizers split text into tokens."
act ab fill '#input-text' "$text" >/dev/null; wait_tokenized
want="$(oracle o200k_base "$text")"; got="$(stat_text token-count | digits)"; chars="$(stat_text char-count | digits)"
evidence type-text
record type-text "fill #input-text \"$text\"" "tokens=$want chars=${#text}" "tokens=$got chars=$chars" "$([[ "$got" == "$want" && "$chars" == "${#text}" ]] && echo 1 || echo 0)"

# 3. Popular model chip switches encoding.
act ab click 'button.model-chip[data-model="anthropic/claude-opus-4.5"]' >/dev/null
ab wait --fn "document.getElementById('encoding-name').textContent === 'claude'" >/dev/null; wait_tokenized
want="$(oracle claude "$text")"; got="$(stat_text token-count | digits)"
evidence chip-claude
record chip-claude "click chip \"Claude Opus 4.5\"" "encoding=claude tokens=$want (ai-tokenizer claude, no external oracle)" "encoding=$(stat_text encoding-name) tokens=$got" "$([[ "$got" == "$want" && "$(stat_text encoding-name)" == claude ]] && echo 1 || echo 0)"

# 4. All-models dropdown loads another encoding.
act ab select '#model-select' 'openai/gpt-4-turbo' >/dev/null
ab wait --fn "document.getElementById('encoding-name').textContent === 'cl100k_base'" >/dev/null; wait_tokenized
want="$(oracle cl100k_base "$text")"; got="$(stat_text token-count | digits)"
evidence select-gpt4-turbo
record select-gpt4-turbo "select #model-select openai/gpt-4-turbo" "encoding=cl100k_base tokens=$want (tiktoken)" "encoding=$(stat_text encoding-name) tokens=$got" "$([[ "$got" == "$want" && "$(stat_text encoding-name)" == cl100k_base ]] && echo 1 || echo 0)"

# 5. Text that mentions a special token. A user expects a plain-text count, as tiktoken encode_ordinary gives.
act ab click 'button.model-chip[data-model="openai/gpt-5"]' >/dev/null
ab wait --fn "document.getElementById('encoding-name').textContent === 'o200k_base'" >/dev/null; wait_tokenized
stext="hello <|endoftext|> world"
act ab fill '#input-text' "$stext" >/dev/null; wait_tokenized
want="$(oracle o200k_base "$stext")"; got="$(stat_text token-count | digits)"
alerts="$(ab console | grep -c 'Tokenization error')"
evidence special-token
record special-token "fill #input-text \"$stext\" (GPT-5)" "tokens=$want, no error alert" "tokens=$got, error alerts=$alerts" "$([[ "$got" == "$want" && "$alerts" == 0 ]] && echo 1 || echo 0)"

# 6. Keep typing after the special token: every edit tokenizes again.
act ab type '#input-text' " again" >/dev/null; wait_tokenized
got="$(stat_text token-count | digits)"; alerts="$(ab console | grep -c 'Tokenization error')"
evidence special-token-keep-typing
record special-token-keep-typing "type \" again\" after the special token" "tokens=$(oracle o200k_base "$stext again"), no new alert" "tokens=$got, new error alerts=$alerts" "$([[ "$alerts" == 0 ]] && echo 1 || echo 0)"

# 7. Remove the special token: the page recovers.
act ab fill '#input-text' "hello world" >/dev/null; wait_tokenized
want="$(oracle o200k_base "hello world")"; got="$(stat_text token-count | digits)"
evidence recover
record recover "fill #input-text \"hello world\"" "tokens=$want" "tokens=$got" "$([[ "$got" == "$want" ]] && echo 1 || echo 0)"

# 8. Clear.
ab click '#clear-btn' >/dev/null
ab wait --fn "document.getElementById('token-count').textContent === '0'" >/dev/null
value="$(ab get value '#input-text')"
evidence clear
record clear "click Clear" "tokens=0 chars=0 textarea empty" "tokens=$(stat_text token-count) chars=$(stat_text char-count) textarea='${value}'" "$([[ "$(stat_text token-count)" == 0 && "$(stat_text char-count)" == 0 && -z "$value" ]] && echo 1 || echo 0)"

ab close >/dev/null 2>&1 || true
exit "$FAILED"
