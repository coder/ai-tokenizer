/**
 * What Anthropic charges for each PDF in src/fixtures/pdf/, from the free
 * count_tokens endpoint, written to src/fixtures/media-anthropic-pdf.json.
 *
 *   bun scripts/measure-media-anthropic-pdf.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countTokens, mapLimit } from "./anthropic";

const MODELS = [
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5-5",
];
const corpus = join(import.meta.dir, "../src/fixtures/pdf");
const output = join(
  import.meta.dir,
  "../src/fixtures/media-anthropic-pdf.json"
);

const files = readdirSync(corpus)
  .filter((name) => name.endsWith(".pdf"))
  .sort();

function body(model: string, pdf?: Buffer) {
  const content: unknown[] = [{ type: "text", text: "a" }];
  if (pdf) {
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: pdf.toString("base64"),
      },
    });
  }
  return { model, messages: [{ role: "user", content }] };
}

function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const message = /"message":"([^"]*)"/.exec(text)?.[1] ?? text;
  return message.slice(0, 120);
}

type Result = number | { error: string };
const models: Record<string, Record<string, Result>> = {};
let measured = 0;
let rejected = 0;

for (const model of MODELS) {
  const base = await countTokens(body(model));
  const results = await mapLimit(files, 4, async (name): Promise<Result> => {
    try {
      const pdf = readFileSync(join(corpus, name));
      return (await countTokens(body(model, pdf))) - base;
    } catch (error) {
      return { error: shortError(error) };
    }
  });
  models[model] = {};
  files.forEach((name, i) => {
    const result = results[i]!;
    models[model]![name] = result;
    if (typeof result === "number") measured++;
    else rejected++;
    console.log(
      `${model} ${name} ${typeof result === "number" ? result : `error: ${result.error}`}`
    );
  });
}

writeFileSync(
  output,
  JSON.stringify(
    {
      provider: "anthropic",
      measuredAt: "2026-11-03",
      unit: 'input tokens of a document block: count_tokens of a user message with text "a" and the PDF, minus count_tokens of the message with text "a" alone',
      models,
    },
    null,
    2
  ) + "\n"
);
console.log(`${measured} cases measured, ${rejected} rejected`);
