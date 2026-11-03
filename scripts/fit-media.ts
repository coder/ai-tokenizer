/**
 * The image recipe of each provider, found by checking candidates against the
 * measurements in src/fixtures/media-*.json. A candidate is taken only when it
 * reproduces every measured size exactly, so a recipe in src/models.json is
 * what the API charged, not what its documentation says.
 */
import { readFileSync } from "node:fs";
import type { ImageTokens, PatchImageTokens } from "../src";
import { imageTokens } from "../src/image-tokens";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../src/fixtures/${name}`, import.meta.url), "utf8")
  );

interface Measured {
  width: number;
  height: number;
  tokens: number;
}

/** Every (size, tokens) pair measured for one model. */
function measuredSizes(
  file: string,
  model: string
): { sizes: Measured[]; label: string } {
  const data = fixture(file);
  const entry = data.models[model];
  if (!entry) {
    throw new Error(`${file} has no measurements of ${model}`);
  }
  const sizes: Measured[] = entry.cases.filter(
    (c: Partial<Measured>) => c.tokens !== undefined
  );
  (data.denseSizes as Array<[number, number]> | undefined)?.forEach(
    ([width, height], i) =>
      sizes.push({ width, height, tokens: entry.dense[i] as number })
  );
  return { sizes, label: `${model} (${sizes.length} sizes)` };
}

function mismatches(recipe: ImageTokens, sizes: Measured[]): string[] {
  return sizes
    .filter((s) => imageTokens(recipe, s) !== s.tokens)
    .map(
      (s) => `${s.width}x${s.height}: ${s.tokens} vs ${imageTokens(recipe, s)}`
    );
}

/**
 * Anthropic prices an image per 28 px patch. Its two tiers differ in the
 * limits only: the long edge and the number of patches.
 */
const ANTHROPIC_LIMITS = [
  { maxEdge: 1568, maxPatches: 1568 },
  { maxEdge: 2576, maxPatches: 4784 },
];

export function fitAnthropicImage(model: string): { image: PatchImageTokens } {
  const { sizes, label } = measuredSizes("media-anthropic.json", model);
  const tiny = sizes.find((s) => s.width === 1 && s.height === 1);
  if (!tiny) {
    throw new Error(`${label}: the 1x1 image was not measured`);
  }
  const misses: string[] = [];
  for (const limits of ANTHROPIC_LIMITS) {
    const image: PatchImageTokens = {
      patch: 28,
      ...limits,
      // A 1x1 image is one patch.
      overhead: tiny.tokens - 1,
    };
    const wrong = mismatches(image, sizes);
    if (wrong.length === 0) {
      return { image };
    }
    misses.push(
      `${limits.maxEdge}/${limits.maxPatches}: ${wrong.length} wrong, e.g. ${wrong[0]}`
    );
  }
  throw new Error(`${label}: no recipe fits\n  ${misses.join("\n  ")}`);
}
