/**
 * Generate the llama4 and gemma4 encodings from Hugging Face tokenizer.json
 * files pinned to a repository revision and a SHA-256.
 *
 * Usage:
 *   bun scripts/generate-hf-encodings.ts [llama4] [gemma4]
 *
 * Downloads go to .cache/hf-tokenizers/ (git-ignored). The script refuses a
 * file whose hash differs from the pin, and it asserts every property of the
 * tokenizer that the runtime relies on. A new revision must pass those
 * assertions before its pin changes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as prettier from "prettier";
import { downloadTokenizerJson, SOURCES, type Source } from "./hf-sources";

const ENCODING_DIR = path.join(import.meta.dirname, "../src/encoding");

// tokenizer.json holds the regex in Rust syntax. `(?i:...)` and `\s` differ
// in JavaScript, so the JavaScript pattern is written out and the source
// pattern is asserted instead of translated.
const LLAMA4_SOURCE_PATTERN =
  "[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?|[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";
// `\s` is Unicode White_Space in Rust and Oniguruma. In JavaScript it also
// matches U+FEFF and misses U+0085. `(?i:'s)` also folds U+017F (long s) to s,
// and no other letter of the contraction group has a non-ASCII fold.
const LLAMA4_PATTERN =
  "[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+(?:'[sS\\u017f]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])?|[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*(?:'[sS\\u017f]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])?|\\p{N}{1,3}| ?[^\\p{White_Space}\\p{L}\\p{N}]+[\\r\\n/]*|\\p{White_Space}*[\\r\\n]+|\\p{White_Space}+(?!\\P{White_Space})|\\p{White_Space}+";

const textEncoder = new TextEncoder();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertAddedTokens(added: any[]): Record<string, number> {
  const special: Record<string, number> = {};
  for (const token of added) {
    assert(
      token.special === true &&
        token.normalized === false &&
        token.lstrip === false &&
        token.rstrip === false &&
        token.single_word === false,
      `added token ${token.content} must be plain and special`
    );
    assert(!(token.content in special), `duplicate ${token.content}`);
    special[token.content] = token.id;
  }
  return special;
}

function assertContiguous(vocab: Record<string, number>): string[] {
  const entries = Object.entries(vocab);
  const byId = new Array<string>(entries.length);
  for (const [piece, id] of entries) {
    assert(Number.isInteger(id) && id >= 0 && id < entries.length, `id ${id}`);
    assert(byId[id] === undefined, `duplicate id ${id}`);
    byId[id] = piece;
  }
  return byId;
}

/** The GPT-2 table from byte value to the printable character in vocab keys. */
function byteLevelDecoder(): Map<string, number> {
  const printable: number[] = [];
  for (let b = 33; b <= 126; b++) printable.push(b);
  for (let b = 161; b <= 172; b++) printable.push(b);
  for (let b = 174; b <= 255; b++) printable.push(b);
  const decoder = new Map<string, number>();
  for (const b of printable) decoder.set(String.fromCharCode(b), b);
  let extra = 0;
  for (let b = 0; b < 256; b++) {
    if (!printable.includes(b)) {
      decoder.set(String.fromCharCode(256 + extra), b);
      extra++;
    }
  }
  assert(decoder.size === 256, "byte-level table has 256 entries");
  return decoder;
}

/** Bytes to a string when they are valid UTF-8 and survive a round trip. */
function bytesToString(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const again = textEncoder.encode(text);
  if (again.length !== bytes.length) return undefined;
  for (let i = 0; i < bytes.length; i++) {
    if (again[i] !== bytes[i]) return undefined;
  }
  return text;
}

function describeSource(source: Source): string {
  return ` * Source: https://huggingface.co/${source.repo} at ${source.revision}\n * tokenizer.json sha256: ${source.sha256}`;
}

function generateLlama4(tokenizer: any, source: Source): string {
  assert(tokenizer.normalizer === null, "llama4 has no normalizer");
  const pre = tokenizer.pre_tokenizer;
  assert(
    pre.type === "Sequence" && pre.pretokenizers.length === 2,
    "llama4 pre-tokenizer is split + byte-level"
  );
  const [split, byteLevel] = pre.pretokenizers;
  assert(
    split.type === "Split" &&
      split.behavior === "Isolated" &&
      split.invert === false &&
      split.pattern.Regex === LLAMA4_SOURCE_PATTERN,
    "llama4 split pattern changed"
  );
  assert(
    byteLevel.type === "ByteLevel" &&
      byteLevel.add_prefix_space === false &&
      byteLevel.use_regex === false,
    "llama4 byte-level settings changed"
  );
  const model = tokenizer.model;
  assert(
    model.type === "BPE" &&
      model.ignore_merges === true &&
      model.byte_fallback === false &&
      model.dropout === null &&
      model.continuing_subword_prefix === null &&
      model.end_of_word_suffix === null,
    "llama4 model settings changed"
  );

  const special = assertAddedTokens(tokenizer.added_tokens);
  const byId = assertContiguous(model.vocab);
  assert(!byId.includes("__proto__"), "__proto__ would set a prototype");
  for (const id of Object.values(special)) {
    assert(id >= byId.length, `special id ${id} overlaps the vocabulary`);
  }

  // Rank equals id. The existing engine merges the adjacent pair with the
  // lowest merged rank. Hugging Face merges the pair with the lowest merge
  // index. They agree when the merge list is every splittable pair of every
  // token, in token order.
  const merges: Array<[string, string]> = model.merges;
  const seen = new Set<string>();
  let previousId = -1;
  for (const [left, right] of merges) {
    const id = model.vocab[left + right];
    assert(
      id !== undefined &&
        model.vocab[left] !== undefined &&
        model.vocab[right] !== undefined,
      `merge ${left} ${right} is not in the vocabulary`
    );
    assert(id >= previousId, "merge list is not in token order");
    previousId = id;
    seen.add(`${left} ${right}`);
  }
  assert(seen.size === merges.length, "duplicate merge");
  let splittable = 0;
  for (const piece of byId) {
    for (let i = 1; i < piece.length; i++) {
      if (
        model.vocab[piece.slice(0, i)] !== undefined &&
        model.vocab[piece.slice(i)] !== undefined
      ) {
        splittable++;
      }
    }
  }
  assert(splittable === merges.length, "merge list is not the splittable set");

  const decoderTable = byteLevelDecoder();
  const stringEntries: string[] = [];
  const binaryPairs: Array<{ bytes: number[]; rank: number }> = [];
  const decoderEntries: string[] = [];
  for (let id = 0; id < byId.length; id++) {
    const bytes = Uint8Array.from(
      Array.from(byId[id]!, (ch) => {
        const value = decoderTable.get(ch);
        assert(value !== undefined, `byte-level char U+${ch.codePointAt(0)}`);
        return value;
      })
    );
    const text = bytesToString(bytes);
    if (text !== undefined) {
      stringEntries.push(`  ${JSON.stringify(text)}: ${id}`);
      decoderEntries.push(`  ${id}: ${JSON.stringify(text)}`);
    } else {
      binaryPairs.push({ bytes: Array.from(bytes), rank: id });
      decoderEntries.push(`  ${id}: new Uint8Array([${bytes.join(",")}])`);
    }
  }
  binaryPairs.sort((a, b) => {
    const minLen = Math.min(a.bytes.length, b.bytes.length);
    for (let i = 0; i < minLen; i++) {
      const diff = a.bytes[i]! - b.bytes[i]!;
      if (diff !== 0) return diff;
    }
    return a.bytes.length - b.bytes.length;
  });
  const binaryEntries = binaryPairs.map(
    ({ bytes, rank }) => `  [new Uint8Array([${bytes.join(",")}]), ${rank}]`
  );

  return `/**
 * LLAMA4 encoding
 * Auto-generated by scripts/generate-hf-encodings.ts - DO NOT EDIT
 *
${describeSource(source)}
 *
 * Optimized dual-storage format:
 * - String tokens: ${stringEntries.length.toLocaleString("en-US")} (fast Map lookup)
 * - Binary tokens: ${binaryPairs.length.toLocaleString("en-US")} (binary search)
 * - Total tokens: ${byId.length.toLocaleString("en-US")}
 * - Pattern: ${LLAMA4_PATTERN}
 * - Special tokens: ${Object.keys(special).length.toLocaleString("en-US")}
 */

export const name = "llama4";

export const pat_str = ${JSON.stringify(LLAMA4_PATTERN)};

export const special_tokens: Record<string, number> = ${JSON.stringify(special, null, 2)};

// String-based encoder (UTF-8 tokens) - fast object lookup. It has no
// prototype, so names such as "toString" are not found by accident.
export const stringEncoder: Record<string, number> = {
  __proto__: null,
${stringEntries.join(",\n")}
} as any;

// Binary encoder (non-UTF-8 tokens) - pre-sorted for binary search
export const binaryEncoder: Array<[Uint8Array, number]> = [
${binaryEntries.join(",\n")}
];

// Decoder - plain object for mobile compatibility
export const decoder: Record<number, string | Uint8Array> = {
${decoderEntries.join(",\n")}
};
`;
}

function generateGemma4(tokenizer: any, source: Source): string {
  assert(
    JSON.stringify(tokenizer.normalizer) ===
      JSON.stringify({
        type: "Replace",
        pattern: { String: " " },
        content: "\u2581",
      }),
    "gemma4 normalizer changed"
  );
  // After the normalizer no space is left, so this split never fires and one
  // text is one word.
  assert(
    JSON.stringify(tokenizer.pre_tokenizer) ===
      JSON.stringify({
        type: "Split",
        pattern: { String: " " },
        behavior: "MergedWithPrevious",
        invert: false,
      }),
    "gemma4 pre-tokenizer changed"
  );
  const model = tokenizer.model;
  assert(
    model.type === "BPE" &&
      model.byte_fallback === true &&
      model.ignore_merges === false &&
      model.dropout === null &&
      model.continuing_subword_prefix === null &&
      model.end_of_word_suffix === null,
    "gemma4 model settings changed"
  );

  const special = assertAddedTokens(tokenizer.added_tokens);
  const byId = assertContiguous(model.vocab);
  assert(byId.length <= 1 << 18, "token ids must fit in 18 bits");
  for (const [text, id] of Object.entries(special)) {
    assert(model.vocab[text] === id, `special token ${text} is in the vocab`);
  }
  assert(
    !byId.some((piece) => /[\u2028\u2029\ud800-\udfff]/u.test(piece)),
    "no line separators or lone surrogates in pieces"
  );
  for (let b = 0; b < 256; b++) {
    const hex = b.toString(16).toUpperCase().padStart(2, "0");
    assert(model.vocab[`<0x${hex}>`] !== undefined, `byte token ${hex}`);
  }

  const merges: Array<[string, string]> = model.merges;
  const count = merges.length;
  const planes = new Uint8Array(count * 9);
  const seen = new Set<number>();
  merges.forEach(([left, right], i) => {
    const ids: number[] = [
      model.vocab[left],
      model.vocab[right],
      model.vocab[left + right],
    ];
    assert(
      ids.every((id) => id !== undefined),
      `merge ${i} has unknown parts`
    );
    const key = ids[0]! * (1 << 18) + ids[1]!;
    assert(!seen.has(key), `duplicate merge ${i}`);
    seen.add(key);
    ids.forEach((id, plane) => {
      planes[(plane * 3 + 0) * count + i] = id & 0xff;
      planes[(plane * 3 + 1) * count + i] = (id >> 8) & 0xff;
      planes[(plane * 3 + 2) * count + i] = (id >> 16) & 0xff;
    });
  });

  return `/**
 * GEMMA4 encoding
 * Auto-generated by scripts/generate-hf-encodings.ts - DO NOT EDIT
 *
${describeSource(source)}
 *
 * SentencePiece-style BPE, run by the codec below:
 * - Tokens: ${byId.length.toLocaleString("en-US")}
 * - Merges: ${count.toLocaleString("en-US")}
 * - Special tokens: ${Object.keys(special).length.toLocaleString("en-US")}
 */
import { createSentencePieceCodec } from "../sentencepiece";

export const kind = "sentencepiece";

export const name = "gemma4";

export const special_tokens: Record<string, number> = ${JSON.stringify(special, null, 2)};

// Token text by id.
export const vocab: string[] = [
${byId.map((piece) => `  ${JSON.stringify(piece)}`).join(",\n")}
];

// Merge list in merge order as nine byte planes, base64 encoded. See
// SentencePieceEncoding.
export const merges: string = ${JSON.stringify(Buffer.from(planes).toString("base64"))};

export const codec = createSentencePieceCodec({
  name,
  special_tokens,
  vocab,
  merges,
});
`;
}

const generators: Record<string, (tokenizer: any, source: Source) => string> = {
  llama4: generateLlama4,
  gemma4: generateGemma4,
};

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(generators);
for (const name of names) {
  const source = SOURCES[name];
  const generate = generators[name];
  assert(source !== undefined && generate !== undefined, `unknown ${name}`);
  const tokenizer = JSON.parse(
    (await downloadTokenizerJson(name)).toString("utf-8")
  );
  const outputFile = path.join(ENCODING_DIR, `${name}.ts`);
  // The repository formats src/ with Prettier, so write the formatted file.
  const code = await prettier.format(generate(tokenizer, source), {
    ...(await prettier.resolveConfig(outputFile)),
    filepath: outputFile,
  });
  fs.writeFileSync(outputFile, code);
  console.log(`${name}: ${outputFile} (${(code.length / 1e6).toFixed(2)} MB)`);
}
