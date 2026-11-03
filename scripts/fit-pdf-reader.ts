/**
 * How close src/pdf.ts gets to what Anthropic charges for each PDF in
 * src/fixtures/pdf/, against src/fixtures/media-anthropic-pdf.json. No keys.
 *
 *   bun scripts/fit-pdf-reader.ts [--text]
 *
 * Predicted tokens = c0 + the sum over pages of (page image + k + the tokens
 * of the page's text). A page is priced as an image whose long edge is 1568
 * px. `--text` also prints the extracted text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPdf } from "../src/pdf";
import Tokenizer from "../src/tokenizer";
import * as claudeV3 from "../src/encoding/claude_v3";
import * as claudeV47 from "../src/encoding/claude_v4_7";
import * as claudeV48 from "../src/encoding/claude_v4_8";
import * as claudeV5 from "../src/encoding/claude_v5";

// `textDiscount`: on these models a page with text costs one token less than
// k + its text's tokens (count_tokens on one-line probe pages and on every
// corpus page).
const MODELS: Record<
  string,
  { c0: number; k: number; textDiscount: number; tokenizer: Tokenizer }
> = {
  "claude-opus-4-6": {
    c0: 23,
    k: 19,
    textDiscount: 0,
    tokenizer: new Tokenizer(claudeV3),
  },
  "claude-opus-4-7": {
    c0: 26,
    k: 20,
    textDiscount: 1,
    tokenizer: new Tokenizer(claudeV47),
  },
  "claude-opus-4-8": {
    c0: 26,
    k: 20,
    textDiscount: 1,
    tokenizer: new Tokenizer(claudeV48),
  },
  "claude-opus-5-5": {
    c0: 26,
    k: 20,
    textDiscount: 1,
    tokenizer: new Tokenizer(claudeV5),
  },
};

/**
 * Tokens of a page's text where the API puts it: after a newline and before a
 * space. Counted alone, a text's first and last tokens can merge differently
 * (CJK, digits, a leading space), which is 1 or 2 tokens a page.
 */
function textTokens(tokenizer: Tokenizer, text: string): number {
  if (!text) return 0;
  return (
    tokenizer.countUntrimmed(`\n${text} `) - tokenizer.countUntrimmed("\n ")
  );
}

/** Image tokens of a page rendered with its long edge at 1568 px. */
function pageImage(width: number, height: number): number {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  for (let edge = 1568; edge > 0; edge--) {
    // The short edge rounds down: Letter is 1530 patches only that way.
    const other = Math.max(1, Math.floor((short * edge) / long));
    const patches = Math.ceil(edge / 28) * Math.ceil(other / 28);
    if (patches <= 1568) return patches + 3;
  }
  return 4;
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../src/fixtures/media-anthropic-pdf.json"),
    "utf8"
  )
) as { models: Record<string, Record<string, number | { error: string }>> };
const corpus = join(import.meta.dir, "../src/fixtures/pdf");
const showText = process.argv.includes("--text");

const errors: number[] = [];
const files = Object.keys(fixture.models["claude-opus-4-6"]!).sort();
for (const name of files) {
  const pdf = readPdf(new Uint8Array(readFileSync(join(corpus, name))));
  let worst = 0;
  const cells: string[] = [];
  for (const [model, { c0, k, textDiscount, tokenizer }] of Object.entries(
    MODELS
  )) {
    const api = fixture.models[model]?.[name];
    if (typeof api !== "number") continue;
    const predicted = pdf
      ? c0 +
        pdf.pages.reduce(
          (sum, page) =>
            sum +
            pageImage(page.width, page.height) +
            k +
            (page.text ? textTokens(tokenizer, page.text) - textDiscount : 0),
          0
        )
      : 0;
    const error = ((predicted - api) / api) * 100;
    if (Math.abs(error) >= Math.abs(worst)) worst = error;
    const delta = predicted - api;
    cells.push(
      `${model.slice(7)} ${api}/${predicted} (${delta > 0 ? "+" : ""}${delta}, ${error.toFixed(1)}%)`
    );
  }
  errors.push(worst);
  console.log(
    `${name} pages=${pdf?.pages.length ?? "none"} ${cells.join(" ")}`
  );
  if (showText) {
    pdf?.pages.forEach((page, i) =>
      console.log(`--- page ${i + 1}\n${page.text}`)
    );
  }
}

const sorted = errors.map(Math.abs).sort((a, b) => a - b);
const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
console.log(
  `${errors.length} files, max abs error ${sorted.at(-1)!.toFixed(1)}%, median ${median.toFixed(1)}%, ` +
    `${sorted.filter((e) => e <= 5).length} within 5%, ${sorted.filter((e) => e <= 15).length} within 15%`
);
