/**
 * Writes the image recipe of the OpenAI models into src/models.json, from the
 * measurements in src/fixtures/media-openai.json. No key is needed:
 *
 *   bun scripts/generate-media-configs.ts
 *
 * A recipe is written only when it reproduces every measured case exactly
 * (see ./fit-media.ts). A measured model that is not in src/models.json is
 * reported and left out. The Claude models get theirs from
 * `generate-model-configs.ts --provider anthropic`, which measures their
 * message fields in the same run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { ModelTokens } from "../src";
import { fitOpenAiImage } from "./fit-media";

const path = new URL("../src/models.json", import.meta.url);
const catalog = JSON.parse(readFileSync(path, "utf8")) as Record<
  string,
  { tokens: ModelTokens }
>;
const measured = JSON.parse(
  readFileSync(
    new URL("../src/fixtures/media-openai.json", import.meta.url),
    "utf8"
  )
) as { models: Record<string, { cases: unknown[] }> };

let written = 0;
let missing = 0;
for (const [apiId, { cases }] of Object.entries(measured.models)) {
  const media = fitOpenAiImage(apiId);
  const entry = catalog[`openai/${apiId}`];
  if (!entry) {
    console.log(
      `openai/${apiId}: ${cases.length} cases fit, not in the catalog`
    );
    missing++;
    continue;
  }
  entry.tokens.media = media;
  console.log(`openai/${apiId}: ${cases.length} cases fit, recipe written`);
  written++;
}
writeFileSync(path, JSON.stringify(catalog, null, 2) + "\n");
console.log(`${written} recipes written, ${missing} models not in the catalog`);
