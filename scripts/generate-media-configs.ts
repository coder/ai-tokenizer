/**
 * Writes the image recipe of the OpenAI and Gemini models into
 * src/models.json, from the measurements in src/fixtures/media-*.json. No key
 * is needed:
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
import type { MediaTokens, ModelTokens } from "../src";
import { fitGeminiImage, fitOpenAiImage } from "./fit-media";

const path = new URL("../src/models.json", import.meta.url);
const catalog = JSON.parse(readFileSync(path, "utf8")) as Record<
  string,
  { tokens: ModelTokens }
>;
let written = 0;
let missing = 0;
function write(
  provider: string,
  fixture: string,
  fit: (id: string) => MediaTokens
) {
  const measured = JSON.parse(
    readFileSync(new URL(`../src/fixtures/${fixture}`, import.meta.url), "utf8")
  ) as { models: Record<string, unknown> };
  for (const id of Object.keys(measured.models)) {
    const media = fit(id);
    const catalogId = id.includes("/") ? id : `${provider}/${id}`;
    const entry = catalog[catalogId];
    if (!entry) {
      console.log(`${catalogId}: fits every measured case, not in the catalog`);
      missing++;
      continue;
    }
    entry.tokens.media = media;
    console.log(`${catalogId}: fits every measured case, recipe written`);
    written++;
  }
}

write("openai", "media-openai.json", fitOpenAiImage);
write("google", "media-gemini.json", fitGeminiImage);
writeFileSync(path, JSON.stringify(catalog, null, 2) + "\n");
console.log(`${written} recipes written, ${missing} models not in the catalog`);
