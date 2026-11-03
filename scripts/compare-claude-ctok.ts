/**
 * Dev parity check: the TypeScript port against Python ctok at CTOK_COMMIT.
 * Not run in CI. Needs `uv` (it fetches ctok and Python 3.13, the newest
 * Python that ctok's CI tests).
 *
 *   bun scripts/compare-claude-ctok.ts [--ctok <path to a ctok clone>] [--n 5000]
 *
 * The corpus is seeded synthetic text plus this repo's source files. With
 * --ctok, it adds ctok's recorded corpora (UDHR, Rosetta Code, MultiPL-E) and
 * also compares claude_v3 with their recorded count_tokens values.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Tokenizer from "../src/tokenizer";
import * as claude_v3 from "../src/encoding/claude_v3";
import * as claude_v4_7 from "../src/encoding/claude_v4_7";
import { CTOK_COMMIT, CTOK_REPO } from "./ctok";

const { values: args } = parseArgs({
  options: { ctok: { type: "string" }, n: { type: "string", default: "5000" } },
});

interface Doc {
  id: string;
  text: string;
  recordedV3?: number;
}

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "the of and to in is you that it he was for on are as with his they at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part".split(
    " "
  );
const CONTRACTIONS = [
  "'s",
  "'t",
  "'re",
  "'ve",
  "'m",
  "'ll",
  "'d",
  "'S",
  "'LL",
  "'x",
];
// Inclusive codepoint ranges that cover every class ctok distinguishes.
const RANGES: Array<[number, number]> = [
  [0x21, 0x7e],
  [0xa0, 0xff],
  [0x100, 0x17f],
  [0x180, 0x24f],
  [0x250, 0x2af],
  [0x300, 0x36f],
  [0x370, 0x3ff],
  [0x400, 0x4ff],
  [0x530, 0x58f],
  [0x590, 0x5ff],
  [0x600, 0x6ff],
  [0x700, 0x74f],
  [0x900, 0x97f],
  [0x980, 0x9ff],
  [0xb80, 0xbff],
  [0xc80, 0xcff],
  [0xe00, 0xe7f],
  [0xe80, 0xeff],
  [0xf00, 0xfff],
  [0x10a0, 0x10ff],
  [0x1100, 0x11ff],
  [0x1200, 0x137f],
  [0x13a0, 0x13ff],
  [0x16a0, 0x16ff],
  [0x1c80, 0x1c8f],
  [0x1e00, 0x1eff],
  [0x1f00, 0x1fff],
  [0x2000, 0x206f],
  [0x2070, 0x209f],
  [0x20a0, 0x20cf],
  [0x2100, 0x218f],
  [0x2190, 0x21ff],
  [0x2200, 0x22ff],
  [0x2460, 0x24ff],
  [0x2500, 0x257f],
  [0x2600, 0x26ff],
  [0x2700, 0x27bf],
  [0x3000, 0x303f],
  [0x3040, 0x30ff],
  [0x4e00, 0x9fff],
  [0xa6e0, 0xa6ff],
  [0xa720, 0xa7ff],
  [0xac00, 0xd7a3],
  [0xe000, 0xe00f],
  [0xfb00, 0xfb4f],
  [0xfdd0, 0xfdd4],
  [0xfe00, 0xfe0f],
  [0xff00, 0xffef],
  [0x10000, 0x1007f],
  [0x1d400, 0x1d7ff],
  [0x1f300, 0x1f5ff],
  [0x1f600, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2001f],
  [0xe0100, 0xe010f],
];
const SEPARATORS = [
  " ",
  " ",
  " ",
  "  ",
  "   ",
  "\n",
  "\n\n",
  "\t",
  "\r\n",
  "\u3000",
  "\u00a0",
  "",
];

function synthetic(rand: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const parts: string[] = [];
  const n = 1 + Math.floor(rand() * 40);
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.45) {
      let w = pick(WORDS);
      const c = rand();
      if (c < 0.15) w = w.toUpperCase();
      else if (c < 0.35) w = w[0]!.toUpperCase() + w.slice(1);
      if (rand() < 0.08) w += pick(CONTRACTIONS);
      parts.push(w);
    } else if (r < 0.6) {
      parts.push(
        String(Math.floor(rand() * 10 ** (1 + Math.floor(rand() * 8))))
      );
    } else if (r < 0.95) {
      const [lo, hi] = pick(RANGES);
      let s = "";
      const len = 1 + Math.floor(rand() * 6);
      for (let j = 0; j < len; j++) {
        const cp = lo + Math.floor(rand() * (hi - lo + 1));
        s += String.fromCodePoint(cp);
      }
      parts.push(s);
    } else {
      parts.push(
        pick([
          "'",
          '"',
          "“",
          "”",
          "‘",
          "’",
          "...",
          "!?",
          "()",
          "{}",
          "=>",
          "\u0001",
        ])
      );
    }
    parts.push(pick(SEPARATORS));
  }
  if (rand() < 0.1) parts.unshift(" ");
  if (rand() < 0.1) parts.push("\n".repeat(1 + Math.floor(rand() * 40)));
  return parts.join("");
}

function repoChunks(): Doc[] {
  const files = [
    "README.md",
    "LICENSE",
    ...readdirSync("src")
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/${f}`),
    ...readdirSync("scripts").map((f) => `scripts/${f}`),
  ];
  const docs: Doc[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/(?<=\n)/);
    for (let i = 0; i < lines.length; i += 60) {
      docs.push({
        id: `${file}:${i + 1}`,
        text: lines.slice(i, i + 60).join(""),
      });
    }
  }
  return docs;
}

function ctokCorpora(root: string): Doc[] {
  const docs: Doc[] = [];
  const corpora = {
    udhr: "f",
    rosetta: "id",
    rosetta_holdout: "id",
    multipl_e: "lang",
  };
  for (const [name, key] of Object.entries(corpora)) {
    const dir = join(root, "tests", "fixtures");
    const rows = new TextDecoder()
      .decode(Bun.gunzipSync(readFileSync(join(dir, `${name}.jsonl.gz`))))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, string>);
    const recorded = JSON.parse(
      readFileSync(join(dir, `${name}_counts.json`), "utf8")
    ).v3;
    if (recorded.model !== "claude-opus-4-5") {
      throw new Error(`${name}: v3 counts were recorded on ${recorded.model}`);
    }
    for (const row of rows) {
      const id = row[key]!;
      // ctok's recorded counts include its 7-token v3 frame.
      docs.push({
        id: `${name}:${id}`,
        text: row.text!,
        recordedV3: recorded.counts[id] - 7,
      });
    }
  }
  return docs;
}

const rand = mulberry32(0x5eed);
const docs: Doc[] = [];
for (let i = 0; i < Number(args.n); i++)
  docs.push({ id: `synthetic:${i}`, text: synthetic(rand) });
docs.push(...repoChunks());
if (args.ctok) docs.push(...ctokCorpora(args.ctok));

const dir = mkdtempSync(join(tmpdir(), "ctok-compare-"));
const input = join(dir, "corpus.jsonl");
const output = join(dir, "ctok.jsonl");
writeFileSync(
  input,
  docs.map((d) => JSON.stringify({ id: d.id, text: d.text })).join("\n") + "\n"
);

const PY = `
import json, sys
import ctok.engine as engine
from ctok.main import _family, _model, token_count

# The documented divergence: on the 4.8+ frame a content-final run of n
# newlines tiles as n newlines, not n + 2 (see claude_v4_7's frame tail).
ctok_frame_tail = engine.frame_tail
v48 = _model("v4.8")
def frame_tail(n, model):
    if model is not v48 or n == 0:
        return ctok_frame_tail(n, model)
    run = "\\n" * n
    _total, spans = engine.min_vocab_tile(run, model.trie, lambda _at: 1)
    return [run[j:i] for j, i in spans][:-1]

def counts(text):
    engine.frame_tail = ctok_frame_tail
    row = {"3.0": token_count(text, "3.0") - 7, "4.8-ctok": token_count(text, "4.8") - 6}
    engine.frame_tail = frame_tail
    row["4.8"] = token_count(text, "4.8") - 6
    return row

assert _model("v3").message_overhead == 7 and v48.message_overhead == 6
with open(sys.argv[1], encoding="utf-8") as f, open(sys.argv[2], "w", encoding="utf-8") as out:
    for line in f:
        r = json.loads(line)
        out.write(json.dumps({"id": r["id"], **counts(r["text"])}) + "\\n")
`;
const proc = Bun.spawnSync(
  [
    "uv",
    "run",
    "--quiet",
    "--no-project",
    "--python",
    "3.13",
    "--with",
    `ctok @ git+${CTOK_REPO}@${CTOK_COMMIT}`,
    "python",
    "-c",
    PY,
    input,
    output,
  ],
  { stdout: "inherit", stderr: "inherit" }
);
if (proc.exitCode !== 0) throw new Error(`ctok exited with ${proc.exitCode}`);

const expected = new Map<string, Record<"3.0" | "4.8" | "4.8-ctok", number>>();
for (const line of readFileSync(output, "utf8").split("\n")) {
  if (!line) continue;
  const r = JSON.parse(line);
  expected.set(r.id, r);
}

const tokenizers = [
  { name: "claude_v3", version: "3.0", tokenizer: new Tokenizer(claude_v3) },
  {
    name: "claude_v4_7",
    version: "4.8",
    tokenizer: new Tokenizer(claude_v4_7),
  },
] as const;
const preview = (s: string) =>
  JSON.stringify(s.length > 60 ? s.slice(0, 60) + "…" : s);

for (const { name, version, tokenizer } of tokenizers) {
  let exact = 0;
  for (const doc of docs) {
    const want = expected.get(doc.id)![version];
    const got = tokenizer.count(doc.text);
    if (got === want) exact++;
    else
      console.log(
        `MISMATCH ${name} ${doc.id} ts=${got} ctok=${want} ${preview(doc.text)}`
      );
  }
  console.log(`${name} vs ctok ${version}: ${exact}/${docs.length} exact`);
}
const retiled = docs.filter(
  (d) => expected.get(d.id)!["4.8"] !== expected.get(d.id)!["4.8-ctok"]
);
console.log(
  `documents where the 4.8 newline-tail fix changes ctok's count: ${retiled.length}/${docs.length}`
);

const recorded = docs.filter((d) => d.recordedV3 !== undefined);
if (recorded.length > 0) {
  let exact = 0;
  for (const doc of recorded) {
    const got = tokenizers[0].tokenizer.count(doc.text);
    if (got === doc.recordedV3) exact++;
    else
      console.log(
        `MISMATCH claude_v3 ${doc.id} ts=${got} api=${doc.recordedV3}`
      );
  }
  console.log(
    `claude_v3 vs recorded count_tokens (claude-opus-4-5): ${exact}/${recorded.length} exact`
  );
}
