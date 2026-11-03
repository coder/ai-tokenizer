---
name: formal-verify-tokenizer
description: Checks that ai-tokenizer's Tokenizer (src/tokenizer.ts) gives the same tokens as tiktoken for every input in a stated scope, and that decode undoes encode. Use when a change touches src/tokenizer.ts, src/encoding/, scripts/generate-encodings.ts or the tiktoken version, or before you claim tiktoken parity.
---

# Formal verification of the tokenizer

## The property

For every input in scope, `Tokenizer.encode` returns the same token ids as tiktoken, under every special-token mode, and `decode(encode(text))` returns `text`.

When this breaks, users get wrong token counts and wrong cost estimates without any error. Tests rarely reach the inputs that break it: a byte-order mark, U+0085, a word like `constructor`, or a special token with `allowedSpecial = "all"`.

## The tool, and why

No verifier runs on TypeScript code, so this check runs the real `src/tokenizer.ts` on generated inputs. It covers every input up to a bound, plus seeded random inputs, and compares each result with two oracles:

- tiktoken (the `tiktoken` devDependency, Rust core compiled to WASM) for `o200k_base`, `cl100k_base` and `p50k_base`.
- `reference.ts`, a second, naive implementation that shares no code with `src/tokenizer.ts`. It is the only oracle for `claude`, which tiktoken does not ship. On the other three encodings, the check also compares it with tiktoken, so a wrong reference fails too.

Random inputs come from fast-check, which shrinks a failure to a short counterexample.

## Run it

```sh
bun install
bun .agents/skills/formal-verify-tokenizer/check.ts            # full, about 90 s
bun .agents/skills/formal-verify-tokenizer/check.ts --quick    # about 5 s, smaller bounds
bun .agents/skills/formal-verify-tokenizer/mutants.ts          # about 1 min, proves the check can fail
bunx tsc --noEmit -p .agents/skills/formal-verify-tokenizer    # typecheck the scripts
```

`check.ts` also takes `--seed N` (default `20261103`), `--fail-fast`, and `--tokenizer PATH` to check another copy of `tokenizer.ts`. It prints one `PASS` or `FAIL` line per property and ends with `SUMMARY pass=N fail=M`. It exits 1 on any failure. A run without the `SUMMARY` line did not finish.

`mutants.ts` breaks `src/tokenizer.ts` in one place at a time, in a temp copy, and runs the quick check on each copy. It ends with `SUMMARY killed=11/11 problems=0`. A `SURVIVED` line means the check no longer catches that break. A `STALE` line means the code changed and that mutant's text no longer matches. Update the mutant to the new code.

## What it checks

| Property                | Inputs                                                                                                                                                                                                                                                                                                          | Bound                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `codepoints/<encoding>` | Every Unicode scalar value as a one-character string, ordinary mode, plus round trip.                                                                                                                                                                                                                           | All 1,112,064 (`--quick`: every 61st).                    |
| `chunks/<encoding>`     | Every concatenation of 1 to 3 chunks from `CHUNKS` in `check.ts`: whitespace, U+FEFF, U+0085, contractions, digits, accents, emoji, special tokens and fragments of them, `Object.prototype` names. 5 special-token modes each. Shortest first.                                                                 | 33,824 strings (`--quick`: 1 to 2 chunks, 1,056 strings). |
| `random/<encoding>`     | Joined arrays of chunks, grapheme, ASCII and binary strings, and lowercase words. 5 modes, on a default tokenizer and on one with a 2-entry merge cache.                                                                                                                                                        | 3,000 runs (`--quick`: 300).                              |
| `cache/<encoding>`      | Every sequence of 6 encodes over 4 pieces that miss the vocabulary, with cache sizes 0, 1, 2, 3 and Infinity. After each step the merge cache must hold exactly what a FIFO queue of that size holds, in order, and the ring of keys must hold the same keys. Runs on `o200k_base` and `p50k_base-no-specials`. | 20,480 sequences each (`--quick`: 4 encodes).             |

The encodings are `o200k_base`, `cl100k_base`, `p50k_base`, `claude`, and `p50k_base-no-specials`: p50k with its special tokens removed. `encode` reaches `encodeOrdinary` only for an encoding without special tokens, so this one covers that path. It runs only the ordinary mode, because tiktoken still knows p50k's special token.

The 5 modes are ordinary (`[]`, `[]`), `"all"`, the default (throws on any special token), one allowed special token with the rest disallowed, and one allowed with the rest ordinary. Where the oracle throws, ours must throw too, with an error that names a disallowed special token. Ours must not throw anywhere else.

## Read a failure

A failure prints the input as JSON, the mode, our tokens and the oracle's tokens. Tell the story in the code's words. Example: "`encode(\"<|endoftext|>\", \"all\")` returns 7 ordinary tokens. tiktoken returns `[199999]`."

Then decide which side is wrong:

1. Our output differs from tiktoken: a bug in `src/tokenizer.ts`, or in the generated data under `src/encoding/`. Fix the code. Do not weaken the property, the bounds or `CHUNKS`.
2. Only `reference` disagrees, and tiktoken agrees with ours: a bug in `reference.ts`. Fix the reference.
3. A `codepoints` or `random` failure on a character that a recent Unicode version added: Bun's regex and tiktoken's Rust regex can use different Unicode tables. Confirm with `bun -e` on that character before you call it a bug.
4. A `decode(encode(input))` failure on text that is not well formed: the check skips such text, so this means the check is broken.

## When a change is intended

- A new encoding: add it to `ENCODINGS` in `check.ts`, and add its special tokens to `CHUNKS`.
- A new code path in `src/tokenizer.ts`: add a mutant for it to `mutants.ts` and confirm that the check kills it.
- A deliberate difference from tiktoken: there is none today. Do not add one without an explicit decision in the PR.

## Not covered

- Strings longer than the bounds, other than the random runs. A pass covers the bounds, not every string.
- Lone UTF-16 surrogates. UTF-8 cannot encode them, so the round trip skips them.
- `extendedSpecialTokens` (the second constructor argument), `decode` of token sequences that `encode` did not produce, and `count` in `src/sdk.ts`.
- The `claude` vocabulary itself. Its only oracle reads the same `src/encoding/claude.ts` data, so wrong data there passes.
- Speed. Use `bench/` for that.

## Coverage record

The check covers `src/tokenizer.ts` (`Tokenizer` constructor, `encode`, `encodeOrdinary`, `encodeOrdinaryInto`, `bytePairEncode`, `addToMergeCache`, `decode`, and the module functions `bytePairMerge`, `binarySearchBytes`, `tryBytesToString`, `isValidUTF8`) and the data in `src/encoding/*.ts`. Its oracle is `tiktoken` as pinned in `bun.lock`.

Sync commit: `1849542abadf`. With the covered files as of that commit, the full check printed `SUMMARY pass=17 fail=0` and `mutants.ts` printed `SUMMARY killed=11/11 problems=0`.

To see whether the check needs another look:

```sh
git diff --stat 1849542abadf..HEAD -- src/tokenizer.ts src/encoding scripts/generate-encodings.ts
git diff 1849542abadf..HEAD -- bun.lock | grep '"tiktoken"'
```

No output from either command means the covered code and the oracle did not change.

Move the sync commit forward only after both scripts pass at the new commit and you have confirmed that the tables above still describe the code. For drift that a change did not recheck, use `/maintain-formal-verification-skill` from the pstack plugin. Without pstack, rerun both scripts, compare the coverage record with the code, and fix the check before you move the sync commit.
