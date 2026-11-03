/**
 * Byte pair merge tests.
 *
 * 1. Long pieces: the split pattern bounds digit runs only, so one run of
 *    underscores, spaces, dots or letters becomes a single piece. Merging such
 *    a piece must scale about linearly with its length.
 *    See https://github.com/coder/ai-tokenizer/issues/6.
 * 2. Differential: bytePairMerge must return exactly what the original
 *    quadratic algorithm (copied below) returns, on random and real pieces.
 * 3. End to end: Tokenizer#encode must match tiktoken on long single-piece
 *    inputs.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { get_encoding, type Tiktoken, type TiktokenEncoding } from "tiktoken";
import Tokenizer, { bytePairMerge, type Encoding } from "./tokenizer";
import * as o200k from "./encoding/o200k_base";
import * as cl100k from "./encoding/cl100k_base";
import * as p50k from "./encoding/p50k_base";
import * as claude from "./encoding/claude";

// Linear time is about 0.15 s for 100k characters. The quadratic merge took
// 10 s or more, so this bound has 10x headroom for slow CI machines.
const LONG_PIECE_CHARS = 100_000;
const LONG_PIECE_BOUND_MS = 2_000;

const longPieces: Array<[string, string]> = [
  ["underscores", "_".repeat(LONG_PIECE_CHARS)],
  ["spaces", " ".repeat(LONG_PIECE_CHARS)],
  ["alternating letters", "ab".repeat(LONG_PIECE_CHARS / 2)],
  ["dots", ".".repeat(LONG_PIECE_CHARS)],
];

// Shaped like OCR output of a scanned form: long field rules, dot leaders and
// blank runs of different lengths, about 1.1M characters. The run lengths
// differ, so the merge cache cannot answer them.
const ocrLikeDocument = Array.from(
  { length: 24 },
  (_, i) => `Field ${i}: ${"_. "[i % 3]!.repeat(45_000 + i * 173)}\n`
).join("");

describe("long pieces", () => {
  test.each(longPieces)(
    "%s finish within a generous time bound",
    (_name, text) => {
      // A fresh tokenizer, so the merge cache cannot hide the cost.
      const tokenizer = new Tokenizer(o200k);
      const start = performance.now();
      const tokens = tokenizer.encode(text);
      const elapsedMs = performance.now() - start;

      expect(tokens.length).toBeGreaterThan(0);
      expect(tokenizer.decode(tokens)).toBe(text);
      expect(elapsedMs).toBeLessThan(LONG_PIECE_BOUND_MS);
    },
    60_000
  );

  test("an OCR-like document of about 1.1M characters finishes within a generous time bound", () => {
    expect(ocrLikeDocument.length).toBeGreaterThan(1_000_000);
    const tokenizer = new Tokenizer(o200k);
    const start = performance.now();
    const count = tokenizer.count(ocrLikeDocument);
    const elapsedMs = performance.now() - start;

    expect(count).toBeGreaterThan(0);
    // The quadratic merge needed minutes; linear time is about 1 s.
    expect(elapsedMs).toBeLessThan(20_000);
  }, 60_000);
});

const NO_RANK = 0xffffffff;
const textEncoder = new TextEncoder();

/**
 * The merge from 1.0.6, which this fix replaced, with its rank lookup passed
 * in. Do not "improve" this copy: it is the reference the new merge must match
 * exactly.
 */
function legacyBytePairMerge(
  piece: Uint8Array,
  getRankForSlice: (slice: Uint8Array) => number
): number[] {
  const len = piece.length;

  const starts: number[] = [];
  const ranks: number[] = [];

  // Inline getRank helper
  const getRank = (
    startIndex: number,
    pairStart?: number,
    pairEnd?: number
  ): number => {
    if (pairStart === undefined) pairStart = starts[startIndex];
    if (pairEnd === undefined) pairEnd = starts[startIndex + 2];
    if (pairEnd === undefined) return NO_RANK;
    return getRankForSlice(piece.subarray(pairStart, pairEnd));
  };

  // Initialize starts and ranks
  for (let i = 0; i <= len; i++) {
    starts[i] = i;
    if (i < len - 1) {
      ranks[i] = getRank(i, i, i + 2);
    } else {
      ranks[i] = NO_RANK;
    }
  }

  // Main merge loop
  while (starts.length > 1) {
    let minRank = NO_RANK;
    let minIdx = -1;

    // Find minimum rank
    const ranksLen = ranks.length - 1;
    for (let i = 0; i < ranksLen; i++) {
      const rank = ranks[i]!;
      if (rank < minRank) {
        minRank = rank!;
        minIdx = i;
      }
    }

    if (minRank === NO_RANK || minIdx === -1) break;

    // Remove elements
    starts.splice(minIdx + 1, 1);
    ranks.splice(minIdx, 1);

    // Update ranks
    ranks[minIdx] = getRank(minIdx);
    if (minIdx > 0) {
      ranks[minIdx - 1] = getRank(minIdx - 1);
    }
  }

  // Build output
  const output: number[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const pairStart = starts[i];
    const pairEnd = starts[i + 1];
    const rank = getRankForSlice(piece.subarray(pairStart, pairEnd));
    if (rank !== NO_RANK) {
      output.push(rank);
    }
  }

  return output;
}

const bytesKey = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("latin1");

/**
 * Rank lookup built straight from the encoding data, independent of the
 * tokenizer's own lookup. A slice that is valid UTF-8 is looked up as a string
 * token first and as a binary token second, as in the tokenizer.
 */
function rankLookup(encoding: Encoding): (slice: Uint8Array) => number {
  const stringRanks = new Map(Object.entries(encoding.stringEncoder));
  const binaryRanks = new Map<string, number>();
  for (const [bytes, rank] of encoding.binaryEncoder) {
    binaryRanks.set(bytesKey(bytes), rank);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return (slice) => {
    let text: string | undefined;
    try {
      text = decoder.decode(slice);
    } catch {
      text = undefined;
    }
    return (
      (text === undefined ? undefined : stringRanks.get(text)) ??
      binaryRanks.get(bytesKey(slice)) ??
      NO_RANK
    );
  };
}

// U+FEFF. Before the tokenizer decoded with ignoreBOM, a slice starting with
// these bytes was looked up without them, which the lookup above does not do.
const hasBom = (bytes: Uint8Array): boolean =>
  bytes.some(
    (byte, i) => byte === 0xef && bytes[i + 1] === 0xbb && bytes[i + 2] === 0xbf
  );

/** Small seeded generator (mulberry32): the corpus is the same on every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const repoRoot = join(import.meta.dir, "..");
const corpusFiles = [
  join(repoRoot, "README.md"),
  join(repoRoot, "LICENSE"),
  ...["src", "bench", "scripts", "site"].flatMap((dir) =>
    readdirSync(join(repoRoot, dir), { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && /\.(ts|js|html|css)$/.test(entry.name)
      )
      .map((entry) => join(repoRoot, dir, entry.name))
  ),
];
const multilingual = [
  "你好世界,这是一个没有空格的很长的中文句子,用来测试分词器在长片段上的表现。".repeat(
    30
  ),
  "こんにちは世界、これは長い日本語の文章です。スペースがありません。".repeat(
    30
  ),
  "مرحبا بالعالم هذه جملة طويلة باللغة العربية لاختبار المحلل".repeat(30),
  "Привет мир! Это длинное предложение на русском языке для проверки. ".repeat(
    30
  ),
  "Hello 👋 🌍 🚀 naïve café Ünïcödé ".repeat(60),
  "😀".repeat(500) + "世".repeat(500) + "é".repeat(500),
];
const corpusTexts = [
  ...corpusFiles.map((file) => readFileSync(file, "utf8")),
  ...multilingual,
];

const encodings = {
  o200k_base: o200k,
  cl100k_base: cl100k,
  p50k_base: p50k,
  claude,
};

/** Pieces that stress the merge, from several generators. */
function syntheticPieces(encoding: Encoding, seed: number): Uint8Array[] {
  const random = seededRandom(seed);
  const int = (max: number) => Math.floor(random() * max);
  const pieces: Uint8Array[] = [];

  // Random bytes, mostly invalid UTF-8.
  for (let i = 0; i < 400; i++) {
    pieces.push(Uint8Array.from({ length: 1 + int(200) }, () => int(256)));
  }

  // One repeated byte at every length: ties everywhere.
  for (const byte of [0x5f, 0x20, 0x2e, 0x61, 0x0a, 0x30, 0xff, 0xe4]) {
    for (let length = 1; length <= 300; length++) {
      pieces.push(new Uint8Array(length).fill(byte));
    }
  }

  // Two or three letters: many equal ranks.
  for (let i = 0; i < 300; i++) {
    const alphabet = 2 + int(2);
    pieces.push(
      Uint8Array.from({ length: 1 + int(400) }, () => 97 + int(alphabet))
    );
  }

  // Concatenated vocabulary tokens, cut at a random byte: merge-rich input.
  const stringTokens = Object.keys(encoding.stringEncoder);
  const binaryTokens = encoding.binaryEncoder.map(([bytes]) => bytes);
  for (let i = 0; i < 300; i++) {
    const target = 1 + int(i % 20 === 0 ? 2000 : 400);
    const bytes: number[] = [];
    while (bytes.length < target) {
      const token =
        int(8) === 0
          ? binaryTokens[int(binaryTokens.length)]!
          : textEncoder.encode(stringTokens[int(stringTokens.length)]!);
      bytes.push(...token);
    }
    pieces.push(Uint8Array.from(bytes.slice(0, target)));
  }

  // Random code points from scripts with 2, 3 and 4 byte UTF-8.
  const ranges: Array<[number, number]> = [
    [0xa0, 0xff],
    [0x600, 0x6ff],
    [0x4e00, 0x9fff],
    [0x1f300, 0x1f64f],
  ];
  for (let i = 0; i < 200; i++) {
    const [low, high] = ranges[int(ranges.length)]!;
    const chars = Array.from({ length: 1 + int(300) }, () =>
      String.fromCodePoint(low + int(high - low + 1))
    );
    pieces.push(textEncoder.encode(chars.join("")));
  }

  return pieces;
}

/** Every distinct pattern match in the corpus, as UTF-8 bytes. */
function corpusPieces(encoding: Encoding): Uint8Array[] {
  const pattern = new RegExp(encoding.pat_str, "ug");
  const seen = new Set<string>();
  for (const text of corpusTexts) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) seen.add(match[0]);
  }
  return [...seen].map((piece) => textEncoder.encode(piece));
}

describe("differential: bytePairMerge matches the original algorithm", () => {
  let total = 0;
  let identical = 0;
  let skipped = 0;

  afterAll(() => {
    console.log(
      `differential: encodings=${Object.keys(encodings).length} pieces=${total} identical=${identical} skipped_bom=${skipped}`
    );
  });

  describe.each(Object.entries(encodings))("%s", (name, encoding) => {
    const tokenizer = new Tokenizer(encoding);
    const lookup = rankLookup(encoding);
    const stringRanks = tokenizer["stringRankEncoder"];
    const binaryIndex = tokenizer["binaryFirstByteIndex"];

    const check = (kind: string, pieces: Uint8Array[]) => {
      const mismatches: string[] = [];
      for (const piece of pieces) {
        if (hasBom(piece)) {
          skipped++;
          continue;
        }
        total++;
        const expected = legacyBytePairMerge(piece, lookup);
        const actual = bytePairMerge(piece, stringRanks, binaryIndex);
        if (
          actual.length === expected.length &&
          actual.every((rank, i) => rank === expected[i])
        ) {
          identical++;
        } else if (mismatches.length < 3) {
          mismatches.push(
            `${Buffer.from(piece).toString("hex").slice(0, 80)} expected ${expected.slice(0, 8)} got ${actual.slice(0, 8)}`
          );
        }
      }
      console.log(`${name} ${kind}: pieces=${pieces.length}`);
      expect(mismatches).toEqual([]);
    };

    test("random and adversarial pieces", () => {
      check("synthetic", syntheticPieces(encoding, 1234));
    }, 60_000);

    test("pieces of real text", () => {
      const pieces = corpusPieces(encoding);
      expect(pieces.length).toBeGreaterThan(1_000);
      check("corpus", pieces);
    }, 60_000);

    test("empty and single-byte pieces", () => {
      check("tiny", [
        new Uint8Array(0),
        ...Array.from({ length: 256 }, (_, i) => Uint8Array.of(i)),
      ]);
    });
  });
});

describe("end to end: long single-piece inputs match tiktoken", () => {
  const references: Array<[string, TiktokenEncoding, Encoding]> = [
    ["o200k_base", "o200k_base", o200k],
    ["cl100k_base", "cl100k_base", cl100k],
    ["p50k_base", "p50k_base", p50k],
  ];
  const runs = ["_", " ", ".", "a", "ab", "\n", "世", "😀", "é", "1"];
  const lengths = [
    1, 2, 3, 5, 31, 100, 127, 128, 129, 255, 256, 257, 1_000, 4_097,
  ];
  let compared = 0;

  afterAll(() => {
    console.log(`end to end: inputs=${compared} identical=${compared}`);
  });

  describe.each(references)("%s", (_name, tiktokenName, encoding) => {
    let reference: Tiktoken;
    const tokenizer = new Tokenizer(encoding);

    beforeAll(() => {
      reference = get_encoding(tiktokenName);
    });
    afterAll(() => reference.free());

    test("runs of one repeated character", () => {
      for (const run of runs) {
        for (const length of lengths) {
          const text = run.repeat(length);
          expect(tokenizer.encode(text)).toEqual(
            Array.from(reference.encode(text))
          );
          compared++;
        }
      }
    }, 60_000);
  });
});
