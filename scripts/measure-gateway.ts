/**
 * Measure input tokens through the Vercel AI Gateway and compare them with
 * the offline encodings. This costs money (a few cents per model).
 *
 * Usage:
 *   AI_GATEWAY_API_KEY=... bun scripts/measure-gateway.ts <model>... [--json out.json]
 *
 * Each model gets a one-letter baseline "a" and 11 samples from
 * fixtures/hf-corpus.json. The content tokens of a sample are
 *   content = prompt_tokens(sample) - prompt_tokens("a") + 1
 * because the baseline holds the message framing plus one token. The ratio
 * is content / offline count, where the offline count is the encoding of the
 * model family (llama4 for meta/*, gemma4 for google/*) and, for comparison,
 * o200k_base. The script prints one line per sample and per model, and ends
 * with a count line. It never prints the key.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Tokenizer from "../src/tokenizer";
import * as gemma4 from "../src/encoding/gemma4";
import * as llama4 from "../src/encoding/llama4";
import * as o200k from "../src/encoding/o200k_base";
import { type Corpus, FIXTURE_DIR, sampleText } from "./hf-fixture";

const SAMPLES = [
  "wiki/en/Unicode",
  "wiki/zh/长城",
  "wiki/ja/東京",
  "wiki/ar/القاهرة",
  "wiki/hi/भारत",
  "wiki/ru/Москва",
  "wiki/de/Berlin",
  "file/src/tokenizer.ts",
  "file//usr/lib/python3.14/argparse.py",
  "file/package.json",
  "inline/emoji",
];

const key = process.env.AI_GATEWAY_API_KEY;
if (!key) {
  console.error("AI_GATEWAY_API_KEY is not set");
  process.exit(2);
}

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonPath = jsonAt === -1 ? undefined : args.splice(jsonAt, 2)[1];
const models = args;

const corpus: Corpus = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "hf-corpus.json"), "utf-8")
);
const texts = SAMPLES.map((name) => {
  const sample = corpus.samples.find((candidate) => candidate.name === name);
  if (sample === undefined) throw new Error(`No corpus sample ${name}`);
  return { name, text: sampleText(sample) };
});

const o200kTokenizer = new Tokenizer(o200k);
const llama4Tokenizer = new Tokenizer(llama4);
const gemma4Tokenizer = new Tokenizer(gemma4);
const familyCounters: Record<string, (text: string) => number> = {
  meta: (text) => llama4Tokenizer.encode(text, [], []).length,
  google: (text) => gemma4Tokenizer.encode(text, [], []).length,
};

let cost = 0;
let requests = 0;

async function promptTokens(model: string, content: string): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(
      "https://ai-gateway.vercel.sh/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content }],
          max_tokens: 16,
        }),
      }
    );
    const body: any = await response.json().catch(() => ({}));
    if (response.ok && body.usage?.prompt_tokens !== undefined) {
      requests++;
      cost += Number(body.usage.cost ?? 0);
      return body.usage.prompt_tokens as number;
    }
    if (attempt >= 3 || (response.status < 500 && response.status !== 429)) {
      throw new Error(
        `${model}: HTTP ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 200)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
  }
}

interface Row {
  name: string;
  content: number;
  offline: number;
  o200k: number;
}

const results: Record<string, unknown> = {};
for (const model of models) {
  const family = model.split("/")[0]!;
  const count = familyCounters[family];
  if (count === undefined) throw new Error(`No encoding for ${model}`);
  try {
    const baseline = await promptTokens(model, "a");
    const rows: Row[] = [];
    for (const { name, text } of texts) {
      const content = (await promptTokens(model, text)) - baseline + 1;
      const offline = count(text);
      const o200kCount = o200kTokenizer.encode(text, [], []).length;
      rows.push({ name, content, offline, o200k: o200kCount });
      console.log(
        `${model} ${name} content=${content} offline=${offline} ratio=${(content / offline).toFixed(4)} o200k=${o200kCount} ratio_o200k=${(content / o200kCount).toFixed(4)}`
      );
    }
    const sum = (pick: (row: Row) => number) =>
      rows.reduce((total, row) => total + pick(row), 0);
    const ratios = rows.map((row) => row.content / row.offline);
    console.log(
      `${model} baseline=${baseline} total_ratio=${(sum((r) => r.content) / sum((r) => r.offline)).toFixed(4)} min=${Math.min(...ratios).toFixed(4)} max=${Math.max(...ratios).toFixed(4)} total_ratio_o200k=${(sum((r) => r.content) / sum((r) => r.o200k)).toFixed(4)}`
    );
    results[model] = { baseline, rows };
  } catch (error) {
    console.log(`${model} FAILED ${(error as Error).message}`);
    results[model] = { error: (error as Error).message };
  }
}
console.log(
  `${models.length} models, ${requests} requests, cost $${cost.toFixed(4)}`
);
if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
