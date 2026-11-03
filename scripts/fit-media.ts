/**
 * The image recipe of each provider, found by checking candidates against the
 * measurements in src/fixtures/media-*.json. A candidate is taken only when it
 * reproduces every measured size exactly, so a recipe in src/models.json is
 * what the API charged, not what its documentation says.
 */
import { readFileSync } from "node:fs";
import type {
  AreaPatchImageTokens,
  BudgetImageTokens,
  CropImageTokens,
  MediaTokens,
  PatchImageTokens,
  TileImageTokens,
} from "../src";
import { imageTokens } from "../src/image-tokens";
import { readPdf } from "../src/pdf";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../src/fixtures/${name}`, import.meta.url), "utf8")
  );

interface Measured {
  width: number;
  height: number;
  tokens: number;
  detail?: string;
}

/** Every (size, tokens) pair measured for one Anthropic model. */
function anthropicSizes(model: string): { sizes: Measured[]; label: string } {
  const data = fixture("media-anthropic.json");
  const entry = data.models[model];
  if (!entry) {
    throw new Error(`media-anthropic.json has no measurements of ${model}`);
  }
  const sizes: Measured[] = entry.cases.filter(
    (c: Partial<Measured>) => c.tokens !== undefined
  );
  (data.denseSizes as Array<[number, number]>).forEach(([width, height], i) =>
    sizes.push({ width, height, tokens: entry.dense[i] as number })
  );
  (data.boundarySizes as Array<[number, number]>).forEach(
    ([width, height], i) =>
      sizes.push({ width, height, tokens: entry.boundary[i] as number })
  );
  return { sizes, label: `${model} (${sizes.length} sizes)` };
}

function mismatches(image: MediaTokens["image"], sizes: Measured[]): string[] {
  return sizes
    .filter((s) => imageTokens(image, s, { detail: s.detail }) !== s.tokens)
    .map(
      (s) =>
        `${s.width}x${s.height}${s.detail ? ` ${s.detail}` : ""}: ${s.tokens} vs ${imageTokens(image, s, { detail: s.detail })}`
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
  const { sizes, label } = anthropicSizes(model);
  const tiny = sizes.find((s) => s.width === 1 && s.height === 1);
  if (!tiny) {
    throw new Error(`${label}: the 1x1 image was not measured`);
  }
  const misses: string[] = [];
  for (const limits of ANTHROPIC_LIMITS) {
    const image: PatchImageTokens = {
      kind: "patches",
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

const patchesOf = (
  recipe: Omit<AreaPatchImageTokens, "kind" | "patch">
): AreaPatchImageTokens => ({ kind: "area-patches", patch: 32, ...recipe });

const tilesOf = (base: number, perTile: number): TileImageTokens => ({
  kind: "tiles",
  tile: 512,
  maxEdge: 2048,
  maxShortEdge: 768,
  base,
  perTile,
});

/**
 * OpenAI's models fall in three families, and `detail` moves the limits in
 * each. The recipe of a model is one of these candidates, and only when it
 * reproduces every case measured at every detail.
 */
const OPENAI_CANDIDATES = (low: number, one: number) => [
  // Tiles: `low` is the base, one tile is the rest of a 1x1 image.
  {
    default: tilesOf(low, one - low),
    low: { kind: "flat", tokens: low },
  } satisfies MediaTokens["image"],
  patchesOf({
    maxEdge: 2048,
    maxPatches: 1536,
    multiplier: 1.62,
    round: "ceil",
    overhead: 1,
  }),
  {
    default: patchesOf({
      maxEdge: 6000,
      maxPatches: 10000,
      multiplier: 1.2,
      round: "floor",
      overhead: 1,
    }),
    low: patchesOf({
      maxEdge: 512,
      multiplier: 1.2,
      round: "floor",
      overhead: 1,
    }),
    high: patchesOf({
      maxEdge: 2048,
      maxPatches: 2500,
      multiplier: 1.2,
      round: "floor",
      overhead: 1,
    }),
  },
  {
    default: patchesOf({ multiplier: 1.2, round: "floor", overhead: 1 }),
    low: patchesOf({
      maxEdge: 512,
      multiplier: 1.2,
      round: "floor",
      overhead: 1,
    }),
    high: patchesOf({
      maxPatches: 2500,
      multiplier: 1.2,
      round: "floor",
      overhead: 1,
    }),
  },
];

export function fitOpenAiImage(model: string): MediaTokens {
  const entry = fixture("media-openai.json").models[model];
  if (!entry) {
    throw new Error(`media-openai.json has no measurements of ${model}`);
  }
  const sizes: Measured[] = entry.cases.filter(
    (c: Partial<Measured>) => c.tokens !== undefined
  );
  const at1x1 = (detail: string) =>
    sizes.find((s) => s.width === 1 && s.height === 1 && s.detail === detail)
      ?.tokens;
  const low = at1x1("low");
  const one = at1x1("auto");
  if (low === undefined || one === undefined) {
    throw new Error(`${model}: the 1x1 image was not measured`);
  }
  const misses: string[] = [];
  for (const image of OPENAI_CANDIDATES(low, one)) {
    const wrong = mismatches(image, sizes);
    if (wrong.length === 0) {
      return { image };
    }
    misses.push(`${wrong.length} wrong, e.g. ${wrong[0]}`);
  }
  throw new Error(
    `${model} (${sizes.length} cases): no recipe fits\n  ${misses.join("\n  ")}`
  );
}

/**
 * Gemini through the AI Gateway, which tries Vertex first. At the default
 * media resolution Gemini 2.5 Flash crops the image (on Google AI Studio the
 * default is a flat 258 tokens instead) and Gemini 3.5 Flash fits it into a
 * budget of patches. Both are checked at the default resolution only.
 */
const GEMINI_CANDIDATES: Array<MediaTokens["image"]> = [
  {
    kind: "crops",
    tile: 258,
    singleTileEdge: 384,
    maxEdge: 2500,
    minCrop: 256,
    maxCrop: 768,
    maxCrops: 12,
    several: 258,
  } satisfies CropImageTokens,
  { kind: "budget", budget: 1120 } satisfies BudgetImageTokens,
];

export function fitGeminiImage(model: string): MediaTokens {
  const entry = fixture("media-gemini.json").models[model];
  if (!entry) {
    throw new Error(`media-gemini.json has no measurements of ${model}`);
  }
  const sizes: Measured[] = entry.cases.filter(
    (c: { mediaResolution: string; tokens?: number }) =>
      c.mediaResolution === "default" && c.tokens !== undefined
  );
  const misses: string[] = [];
  for (const image of GEMINI_CANDIDATES) {
    const wrong = mismatches(image, sizes);
    if (wrong.length === 0) {
      return { image };
    }
    misses.push(`${wrong.length} wrong, e.g. ${wrong[0]}`);
  }
  throw new Error(
    `${model} (${sizes.length} cases): no recipe fits\n  ${misses.join("\n  ")}`
  );
}

/**
 * What a PDF costs when it cannot be read: the mean cost of a page of the PDF
 * corpus, measured on the model that counts with this encoding.
 */
export function unreadablePdfTokens(encoding: string): number {
  const model = {
    claude_v3: "claude-opus-4-6",
    claude_v4_7: "claude-opus-4-7",
    claude_v4_8: "claude-opus-4-8",
    claude_v5: "claude-opus-5-5",
  }[encoding];
  if (!model) {
    throw new Error(`no PDF measurements for the encoding ${encoding}`);
  }
  const measured = fixture("media-anthropic-pdf.json").models[model] as Record<
    string,
    number | { error: string }
  >;
  let tokens = 0;
  let pages = 0;
  for (const [file, cost] of Object.entries(measured)) {
    if (typeof cost !== "number") continue;
    const pdf = readPdf(
      readFileSync(new URL(`../src/fixtures/pdf/${file}`, import.meta.url))
    );
    tokens += cost;
    pages += pdf?.pages.length ?? 0;
  }
  return Math.round(tokens / pages);
}
