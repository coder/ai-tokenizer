// Usage: bun .agents/skills/formal-verify-tokenizer/check.ts [--quick] [--fail-fast] [--seed N] [--tokenizer PATH]
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import * as fc from "fast-check";
import { get_encoding, type Tiktoken } from "tiktoken";
import type TokenizerClass from "../../../src/tokenizer";
import type { Encoding } from "../../../src/tokenizer";
import * as o200k_base from "../../../src/encoding/o200k_base";
import * as cl100k_base from "../../../src/encoding/cl100k_base";
import * as p50k_base from "../../../src/encoding/p50k_base";
import * as claude from "../../../src/encoding/claude";
import { ReferenceEncoder } from "./reference";

const { values: args } = parseArgs({
  options: {
    quick: { type: "boolean", default: false },
    "fail-fast": { type: "boolean", default: false },
    seed: { type: "string", default: "20261103" },
    tokenizer: {
      type: "string",
      default: resolve(import.meta.dir, "../../../src/tokenizer.ts"),
    },
  },
});
const seed = Number(args.seed);
const Tokenizer: typeof TokenizerClass = (await import(resolve(args.tokenizer)))
  .default;

type Mode = {
  name: string;
  allowed?: string[] | "all";
  disallowed?: string[] | "all";
};
type Encoder = {
  encode(
    text: string,
    allowed?: string[] | "all",
    disallowed?: string[] | "all"
  ): ArrayLike<number>;
};
type Outcome = { ok: true; tokens: number[] } | { ok: false };

const ENCODINGS: Array<{
  name: string;
  data: Encoding;
  tiktoken: Tiktoken | null;
}> = [
  {
    name: "o200k_base",
    data: o200k_base as Encoding,
    tiktoken: get_encoding("o200k_base"),
  },
  {
    name: "cl100k_base",
    data: cl100k_base as Encoding,
    tiktoken: get_encoding("cl100k_base"),
  },
  {
    name: "p50k_base",
    data: p50k_base as Encoding,
    tiktoken: get_encoding("p50k_base"),
  },
  { name: "claude", data: claude as Encoding, tiktoken: null },
];

let passed = 0;
let failed = 0;

function short(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function report(
  property: string,
  failure: string | null,
  detail: string
): void {
  if (failure === null) {
    passed++;
    console.log(`PASS ${property} ${detail}`);
    return;
  }
  failed++;
  console.log(`FAIL ${property} ${failure}`);
  if (args["fail-fast"]) finish();
}

function finish(): never {
  console.log(`SUMMARY pass=${passed} fail=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

function run(encoder: Encoder, text: string, mode: Mode): Outcome {
  try {
    return {
      ok: true,
      tokens: Array.from(encoder.encode(text, mode.allowed, mode.disallowed)),
    };
  } catch {
    return { ok: false };
  }
}

function same(a: Outcome, b: Outcome): boolean {
  if (!a.ok || !b.ok) return a.ok === b.ok;
  return (
    a.tokens.length === b.tokens.length &&
    a.tokens.every((t, i) => t === b.tokens[i])
  );
}

function modesFor(specials: string[]): Mode[] {
  const first = specials[0]!;
  return [
    { name: "ordinary", allowed: [], disallowed: [] },
    { name: "all", allowed: "all" },
    { name: "default" },
    { name: `only ${first}`, allowed: [first] },
    { name: `only ${first}, rest ordinary`, allowed: [first], disallowed: [] },
  ];
}

// Returns a counterexample description, or null when every oracle agrees.
function compare(
  text: string,
  modes: Mode[],
  ours: InstanceType<typeof TokenizerClass>,
  oracles: Array<[string, Encoder]>
): string | null {
  for (const mode of modes) {
    const got = run(ours, text, mode);
    for (const [oracleName, oracle] of oracles) {
      const want = run(oracle, text, mode);
      if (!same(got, want)) {
        return `input=${short(text)} mode="${mode.name}" ours=${short(got.ok ? got.tokens : "throws")} ${oracleName}=${short(want.ok ? want.tokens : "throws")}`;
      }
    }
    if (got.ok && mode.name !== "default" && text.isWellFormed()) {
      const back = ours.decode(got.tokens);
      if (back !== text) {
        return `input=${short(text)} mode="${mode.name}" decode(encode(input))=${short(back)}`;
      }
    }
  }
  return null;
}

function oraclesFor(
  enc: (typeof ENCODINGS)[number],
  reference: ReferenceEncoder
): Array<[string, Encoder]> {
  const oracles: Array<[string, Encoder]> = [["reference", reference]];
  if (enc.tiktoken) oracles.unshift(["tiktoken", enc.tiktoken]);
  return oracles;
}

const CHUNKS = [
  "a",
  "Z",
  "7",
  " ",
  "  ",
  "\n",
  "\r\n",
  "\t",
  ".",
  "'s",
  "'S",
  "123",
  "é",
  "中",
  "👋",
  "\u0301",
  "\u00a0",
  "\ufeff",
  "\u0085",
  "<|",
  "|>",
  "<|endoftext",
  "<|endoftext|>",
  "<|endofprompt|>",
  "<|fim_prefix|>",
  "<EOT>",
  "<META>",
  "<META_START>",
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
];

function checkCodepoints(
  enc: (typeof ENCODINGS)[number],
  ours: InstanceType<typeof TokenizerClass>,
  oracles: Array<[string, Encoder]>
): void {
  const stride = args.quick ? 61 : 1;
  const ordinary = [{ name: "ordinary", allowed: [], disallowed: [] }];
  const oracle = oracles[0]!;
  const started = performance.now();
  let count = 0;
  for (let cp = 0; cp <= 0x10ffff; cp += stride) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    count++;
    const failure = compare(String.fromCodePoint(cp), ordinary, ours, [oracle]);
    if (failure)
      return report(
        `codepoints/${enc.name}`,
        `U+${cp.toString(16).toUpperCase()} ${failure}`,
        ""
      );
  }
  report(
    `codepoints/${enc.name}`,
    null,
    `${count} scalar values vs ${oracle[0]} in ${((performance.now() - started) / 1000).toFixed(1)}s`
  );
}

function checkChunks(
  enc: (typeof ENCODINGS)[number],
  ours: InstanceType<typeof TokenizerClass>,
  oracles: Array<[string, Encoder]>,
  modes: Mode[]
): void {
  let count = 0;
  let failure: string | null = null;
  let level = [""];
  // Shortest strings first, so the first counterexample is a shortest one.
  for (let depth = 1; depth <= 3 && failure === null; depth++) {
    const next: string[] = [];
    for (const prefix of level) {
      for (const chunk of CHUNKS) {
        const text = prefix + chunk;
        next.push(text);
        count++;
        failure = compare(text, modes, ours, oracles);
        if (failure) break;
      }
      if (failure) break;
    }
    level = next;
  }
  report(
    `chunks/${enc.name}`,
    failure,
    `${count} strings x ${modes.length} modes vs ${oracles.map((o) => o[0]).join("+")}`
  );
}

function checkRandom(
  enc: (typeof ENCODINGS)[number],
  oracles: Array<[string, Encoder]>,
  modes: Mode[]
): void {
  // Two instances so that the result must not depend on what the merge cache
  // holds or evicts from earlier inputs.
  const big = new Tokenizer(enc.data);
  const tiny = new Tokenizer(enc.data, undefined, 2);
  const text = fc
    .array(
      fc.oneof(
        fc.constantFrom(...CHUNKS),
        fc.string({ unit: "grapheme" }),
        fc.string({ unit: "grapheme-ascii" }),
        fc.string({ unit: "binary" }),
        fc.stringMatching(/^[a-z0-9 ]{1,40}$/)
      ),
      { maxLength: 12 }
    )
    .map((parts) => parts.join(""));
  const numRuns = args.quick ? 300 : 3000;
  const result = fc.check(
    fc.property(
      text,
      (input) =>
        compare(input, modes, big, oracles) === null &&
        compare(input, modes, tiny, oracles) === null
    ),
    { seed, numRuns }
  );
  if (!result.failed)
    return report(`random/${enc.name}`, null, `${numRuns} runs seed=${seed}`);
  const input = result.counterexample![0] as string;
  const failure =
    compare(input, modes, big, oracles) ?? compare(input, modes, tiny, oracles);
  report(
    `random/${enc.name}`,
    `${failure} (seed=${seed} path=${result.counterexamplePath})`,
    ""
  );
}

// Every sequence of encodes over a few pieces that miss the vocabulary, for
// several cache sizes. After each step the cache must hold exactly what a
// plain FIFO queue of that size holds, in the same order.
function checkCache(): void {
  const pieces = ["qzxvw", "qzxvy", "qzxvz", "qzxvq"];
  const length = args.quick ? 4 : 6;
  const sizes = [0, 1, 2, 3, Infinity];
  const enc = ENCODINGS[0]!;
  const reference = new ReferenceEncoder(enc.data);
  let sequences = 0;
  for (const size of sizes) {
    for (let n = 0; n < pieces.length ** length; n++) {
      sequences++;
      const tokenizer = new Tokenizer(enc.data, undefined, size);
      const internals = tokenizer as unknown as {
        mergeCache: Map<string, number[]>;
        mergeCacheKeys: string[];
      };
      const model: string[] = [];
      const steps: string[] = [];
      for (
        let i = 0, rest = n;
        i < length;
        i++, rest = Math.floor(rest / pieces.length)
      ) {
        const piece = pieces[rest % pieces.length]!;
        steps.push(piece);
        const tokens = tokenizer.encode(piece);
        if (!model.includes(piece)) {
          model.push(piece);
          if (model.length > size) model.shift();
        }
        const cached = [...internals.mergeCache.keys()];
        const ring = new Set(internals.mergeCacheKeys);
        const want = reference.encode(piece);
        const failure =
          short(tokens) !== short(want)
            ? `encode(${short(piece)})=${short(tokens)} reference=${short(want)}`
            : short(cached) !== short(model)
              ? `cache=${short(cached)} fifo=${short(model)}`
              : ring.size !== cached.length || cached.some((k) => !ring.has(k))
                ? `ring=${short(internals.mergeCacheKeys)} cache=${short(cached)}`
                : null;
        if (failure) {
          return report(
            "cache",
            `size=${size} steps=${short(steps)} ${failure}`,
            ""
          );
        }
      }
    }
  }
  report(
    "cache",
    null,
    `${sequences} sequences of ${length} encodes, sizes ${sizes.join(",")}`
  );
}

for (const enc of ENCODINGS) {
  const reference = new ReferenceEncoder(enc.data);
  const oracles = oraclesFor(enc, reference);
  const modes = modesFor(reference.specialTokens);
  const ours = new Tokenizer(enc.data);
  checkCodepoints(enc, ours, oracles);
  checkChunks(enc, ours, oracles, modes);
  checkRandom(enc, oracles, modes);
}
checkCache();
finish();
