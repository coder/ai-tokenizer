/**
 * Compare the llama4 and gemma4 encodings with the Hugging Face `tokenizers`
 * reference, token id by token id.
 *
 * Usage:
 *   bun scripts/compare-hf.ts compare <llama4|gemma4> <file|dir|@list>... [--slices N] [--max-chars N]
 *   bun scripts/compare-hf.ts fixture
 *
 * `compare` reads every UTF-8 text file under the paths. Each file is one
 * sample, and `--slices` adds N random substrings per file. A `.jsonl` file
 * holds one JSON string sample per line instead. It prints one line
 * per mismatch and ends with a count line. The exit code is 1 on a mismatch.
 *
 * `fixture` rewrites fixtures/hf-reference.json from fixtures/hf-corpus.json.
 *
 * The reference needs `uv` (it runs `uvx --with tokenizers python`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Tokenizer from "../src/tokenizer";
import SentencePieceTokenizer from "../src/sentencepiece";
import * as llama4 from "../src/encoding/llama4";
import * as gemma4 from "../src/encoding/gemma4";
import { type Corpus, FIXTURE_DIR, hashIds, sampleText } from "./hf-fixture";
import { SOURCES, tokenizerJsonPath } from "./hf-sources";

const BATCH_CHARS = 20_000_000;

type Encode = (text: string) => number[];

function loadEncoder(name: string): Encode {
  if (name === "llama4") {
    const tokenizer = new Tokenizer(llama4);
    return (text) => tokenizer.encode(text, [], []);
  }
  if (name === "gemma4") {
    const tokenizer = new SentencePieceTokenizer(gemma4);
    return (text) => tokenizer.encode(text, [], []);
  }
  throw new Error(`Unknown encoding: ${name}`);
}

/** Token ids from the Hugging Face reference, one array per sample. */
async function referenceIds(
  name: string,
  texts: string[],
  special = false
): Promise<number[][]> {
  const tokenizerJson = await tokenizerJsonPath(name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hf-reference-"));
  try {
    const samplesFile = path.join(dir, "samples.jsonl");
    const idsFile = path.join(dir, "ids.jsonl");
    fs.writeFileSync(
      samplesFile,
      texts.map((text) => JSON.stringify(text) + "\n").join("")
    );
    const run = Bun.spawnSync(
      [
        "uvx",
        "--with",
        "tokenizers",
        "python",
        path.join(import.meta.dirname, "hf-reference.py"),
        tokenizerJson,
        samplesFile,
        idsFile,
        ...(special ? ["--special"] : []),
      ],
      { stdout: "pipe", stderr: "inherit" }
    );
    if (run.exitCode !== 0) throw new Error("hf-reference.py failed");
    console.log(run.stdout.toString().trim());
    const lines = fs.readFileSync(idsFile, "utf-8").split("\n");
    lines.pop();
    if (lines.length !== texts.length)
      throw new Error("reference lost samples");
    return lines.map((line) => JSON.parse(line) as number[]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function* batches(texts: string[]): Generator<string[]> {
  let batch: string[] = [];
  let chars = 0;
  for (const text of texts) {
    batch.push(text);
    chars += text.length;
    if (chars >= BATCH_CHARS) {
      yield batch;
      batch = [];
      chars = 0;
    }
  }
  if (batch.length > 0) yield batch;
}

function walk(target: string, files: string[]): void {
  if (target.startsWith("@")) {
    // "@list.txt": one path per line.
    for (const line of fs.readFileSync(target.slice(1), "utf-8").split("\n")) {
      if (line !== "") walk(line, files);
    }
    return;
  }
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target).sort()) {
      walk(path.join(target, entry), files);
    }
  } else if (stat.isFile()) {
    files.push(target);
  }
}

/** Small seeded generator, so a run can be repeated. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function readSamples(paths: string[], slices: number, maxChars: number) {
  const files: string[] = [];
  for (const target of paths) walk(target, files);
  const random = mulberry32(20261103);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts: string[] = [];
  const names: string[] = [];
  for (const file of files) {
    if (file.endsWith(".jsonl")) {
      const lines = fs.readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (line === "") return;
        texts.push(JSON.parse(line) as string);
        names.push(`${file}:${i + 1}`);
      });
      continue;
    }
    let text: string;
    try {
      text = decoder.decode(fs.readFileSync(file));
    } catch {
      continue;
    }
    if (text.length === 0) continue;
    if (text.length > maxChars) text = text.slice(0, maxChars);
    if (isHighSurrogate(text.charCodeAt(text.length - 1))) {
      text = text.slice(0, -1);
    }
    texts.push(text);
    names.push(file);
    for (let i = 0; i < slices; i++) {
      const length = Math.max(
        1,
        Math.floor(Math.exp(random() * Math.log(4000)))
      );
      let start = Math.floor(random() * text.length);
      let end = Math.min(text.length, start + length);
      if (isLowSurrogate(text.charCodeAt(start))) start++;
      if (isLowSurrogate(text.charCodeAt(end))) end++;
      if (start >= end) continue;
      texts.push(text.slice(start, end));
      names.push(`${file}[${start}:${end}]`);
    }
  }
  return { texts, names };
}

async function compare(name: string, args: string[]): Promise<number> {
  const option = (flag: string, fallback: number): number => {
    const at = args.indexOf(flag);
    if (at === -1) return fallback;
    const [, value] = args.splice(at, 2);
    return Number(value);
  };
  const slices = option("--slices", 0);
  const maxChars = option("--max-chars", 300_000);
  const { texts, names } = readSamples(args, slices, maxChars);

  const encode = loadEncoder(name);
  let mismatches = 0;
  let tokens = 0;
  let chars = 0;
  let offset = 0;
  const started = performance.now();
  for (const batch of batches(texts)) {
    const expected = await referenceIds(name, batch);
    for (let i = 0; i < batch.length; i++) {
      const actual = encode(batch[i]!);
      const reference = expected[i]!;
      tokens += reference.length;
      chars += batch[i]!.length;
      let at = 0;
      while (
        at < actual.length &&
        at < reference.length &&
        actual[at] === reference[at]
      ) {
        at++;
      }
      if (at !== actual.length || at !== reference.length) {
        mismatches++;
        if (mismatches <= 10) {
          console.log(
            `MISMATCH ${names[offset + i]} token ${at}: ${actual[at]} != ${reference[at]} (${actual.length} vs ${reference.length} tokens)`
          );
        }
      }
    }
    offset += batch.length;
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `${name}: ${texts.length} samples, ${chars} chars, ${tokens} tokens, ${mismatches} mismatches (${seconds}s)`
  );
  return mismatches === 0 ? 0 : 1;
}

async function writeFixture(): Promise<void> {
  const corpus: Corpus = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, "hf-corpus.json"), "utf-8")
  );
  const texts = corpus.samples.map(sampleText);
  const encodings: Record<string, unknown> = {};
  for (const name of Object.keys(SOURCES)) {
    const ids = await referenceIds(name, texts);
    const special = await referenceIds(name, corpus.special, true);
    encodings[name] = {
      source: SOURCES[name],
      samples: ids.map((sampleIds) => [sampleIds.length, hashIds(sampleIds)]),
      special,
    };
  }
  fs.writeFileSync(
    path.join(FIXTURE_DIR, "hf-reference.json"),
    JSON.stringify({ encodings }) + "\n"
  );
  console.log(
    `fixture: ${texts.length} samples and ${corpus.special.length} special texts x ${Object.keys(SOURCES).length} encodings`
  );
}

const [command, ...rest] = process.argv.slice(2);
if (command === "compare" && rest.length >= 2) {
  process.exit(await compare(rest[0]!, rest.slice(1)));
} else if (command === "fixture") {
  await writeFixture();
} else {
  console.error(fs.readFileSync(import.meta.filename, "utf-8").split("*/")[0]);
  process.exit(2);
}
