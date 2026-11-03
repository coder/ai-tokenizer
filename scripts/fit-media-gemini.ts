/**
 * Fits what Gemini charges for an image to src/fixtures/media-gemini.json (made
 * by scripts/measure-media-gemini.ts) and prints how many measurements each
 * formula reproduces. Run: bun scripts/fit-media-gemini.ts (needs no key).
 *
 * What the measurements show, through the Vercel AI Gateway:
 *
 * Gemini 3.5 Flash, either backend. The cost depends on the aspect ratio and
 * not on the pixel size: a 1x1 image costs the same as a 4000x4000 one. The
 * image becomes a grid of patches that keeps its aspect ratio and holds at
 * most `budget` patches, at one token per patch. The budget is 280, 560 or
 * 1120 for media resolution low, medium or high. High is the default.
 *   a = width / height
 *   tokens = min(budget, max(1, floor(sqrt(budget * a))) *
 *                        max(1, floor(sqrt(budget / a))))
 * The min and max only act beyond 1120:1, where the grid is one patch wide.
 *
 * Gemini 2.5 Flash, media resolution low or medium, one image in the request:
 * 66 or 258 tokens, at any size.
 *
 * Gemini 2.5 Flash, media resolution high, for one image in the request (the
 * Vertex default; on Google AI Studio the default is medium, not high):
 *   short = min(width, height), long = max(width, height)
 *   if long <= 384 and long < 2 * short: 258
 *   if long > 2500: short = floor(short * 2500 / long), long = 2500
 *                   if short == 0: 258
 *   crop = min(short, clamp(floor(short / 1.5), 256, 768))
 *   tokens = 258 * (1 + min(12, ceil(long / crop) * ceil(short / crop)))
 * With two or more images in the request, every image costs 258 tokens, and
 * Vertex rejects an explicit high.
 */
import { readFileSync } from "node:fs";

type Resolution = "default" | "low" | "medium" | "high";
type Case = {
  width: number;
  height: number;
  mediaResolution: Resolution;
  tokens?: number;
  error?: string;
};
type Run = { backend: string; baseline: number; cases: Case[] };
type Outcome = { tokens?: number; error?: string };
type Probe = {
  width: number;
  height: number;
  identicalImages: Record<string, number>;
  twoImagesAtHigh: Outcome;
  acrossMessages: Record<
    "firstMessageOnly" | "lastMessageOnly" | "both",
    number
  >;
  jpegInsteadOfPng: Array<{
    width: number;
    height: number;
    png: number;
    jpeg: number;
  }>;
};
type Fixture = {
  models: Record<string, Run>;
  modelsAiStudio: Record<string, Run>;
  probes: Record<string, Record<string, Probe>>;
};

const TILE = 258;
const BUDGETS = { low: 280, medium: 560, high: 1120, default: 1120 } as const;
const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));

/** Gemini 3.5 Flash: one token per patch of the aspect-fitted grid. */
function gemini3Tokens(
  width: number,
  height: number,
  resolution: Resolution
): number {
  const budget = BUDGETS[resolution];
  // floor(sqrt(x)) equals floor(sqrt(floor(x))), so the integer part is exact.
  const side = (x: number) => Math.max(1, Math.floor(Math.sqrt(Math.floor(x))));
  return Math.min(
    budget,
    side((budget * width) / height) * side((budget * height) / width)
  );
}

/** Gemini 2.5 Flash at media resolution high, one image in the request. */
function gemini25Tiles(width: number, height: number): number {
  let short = Math.min(width, height);
  let long = Math.max(width, height);
  if (long <= 384 && long < 2 * short) return TILE;
  if (long > 2500) {
    short = Math.floor((short * 2500) / long);
    long = 2500;
    if (short === 0) return TILE;
  }
  const crop = Math.min(short, clamp(Math.floor((2 * short) / 3), 256, 768));
  const crops = Math.ceil(long / crop) * Math.ceil(short / crop);
  return TILE * (1 + Math.min(12, crops));
}

/** The cost of the images of one request, or "error" when the backend refuses. */
function geminiRequestTokens(
  model: string,
  backend: string,
  sizes: Array<readonly [number, number]>,
  resolution: Resolution
): number | "error" {
  if (model === "google/gemini-3.5-flash") {
    return sizes.reduce(
      (sum, [w, h]) => sum + gemini3Tokens(w, h, resolution),
      0
    );
  }
  if (sizes.length === 1) {
    if (resolution === "low") return 66;
    const tiled =
      resolution === "high" ||
      (resolution === "default" && backend === "vertex");
    return tiled ? gemini25Tiles(...sizes[0]!) : TILE;
  }
  if (resolution !== "default" && resolution !== "high") {
    throw new Error(
      `no measurement of ${sizes.length} images at ${resolution}`
    );
  }
  return resolution === "high" && backend === "vertex"
    ? "error"
    : TILE * sizes.length;
}

/** What the public documentation says, read the way it is written. */
function docs(model: string, width: number, height: number, level: Resolution) {
  if (model === "google/gemini-3.5-flash") return BUDGETS[level];
  if (Math.max(width, height) <= 384) return TILE;
  const crop = clamp(Math.floor(Math.min(width, height) / 1.5), 256, 768);
  return TILE * Math.ceil(width / crop) * Math.ceil(height / crop);
}

const fixture: Fixture = JSON.parse(
  readFileSync(
    new URL("../src/fixtures/media-gemini.json", import.meta.url),
    "utf8"
  )
);

let fits = 0;
let exact = 0;
let total = 0;
let worst = 0;
let docsExact = 0;
let probeExact = 0;
let probeTotal = 0;

function score(
  label: string,
  cases: Case[],
  predict: (c: Case) => number
): { exact: number; total: number; worst: number } {
  let hit = 0;
  let max = 0;
  let where = "";
  for (const c of cases) {
    const error = Math.abs(predict(c) - c.tokens!);
    if (error === 0) hit++;
    else if (error > max) {
      max = error;
      where = ` (worst ${c.width}x${c.height}: ${c.tokens} measured, ${predict(c)} predicted)`;
    }
  }
  console.log(
    `${label} ${hit}/${cases.length} exact, max abs error ${max}${max ? where : ""}`
  );
  return { exact: hit, total: cases.length, worst: max };
}

for (const [group, runs] of [
  ["vertex", fixture.models],
  ["google", fixture.modelsAiStudio],
] as const) {
  for (const [model, run] of Object.entries(runs)) {
    const short = model.replace("google/", "");
    for (const resolution of ["default", "low", "medium", "high"] as const) {
      const cases = run.cases.filter(
        (c) => c.mediaResolution === resolution && c.tokens !== undefined
      );
      const fit = score(
        `${group} ${short} ${resolution} fit:`,
        cases,
        (c) =>
          geminiRequestTokens(
            model,
            group,
            [[c.width, c.height]],
            resolution
          ) as number
      );
      fits++;
      exact += fit.exact;
      total += fit.total;
      worst = Math.max(worst, fit.worst);
      if (resolution === "default") {
        const hypothesis = score(
          `${group} ${short} ${resolution} docs:`,
          cases,
          (c) => docs(model, c.width, c.height, resolution)
        );
        docsExact += hypothesis.exact;
        score(
          `${group} ${short} ${resolution} sdk.ts today (85):`,
          cases,
          () => 85
        );
      }
    }

    const p = fixture.probes[group]![model]!;
    const at = (n: number): Array<readonly [number, number]> =>
      Array.from({ length: n }, () => [p.width, p.height] as const);
    const checks: Array<
      [string, number | "error" | undefined, number | "error"]
    > = [];
    for (const n of [1, 2, 3]) {
      checks.push([
        `${n} identical images`,
        p.identicalImages[n],
        geminiRequestTokens(model, group, at(n), "default"),
      ]);
    }
    checks.push([
      "two images at high",
      p.twoImagesAtHigh.error ? "error" : p.twoImagesAtHigh.tokens,
      geminiRequestTokens(model, group, at(2), "high"),
    ]);
    for (const [name, measured, n] of [
      ["image in the first message", p.acrossMessages.firstMessageOnly, 1],
      ["image in the last message", p.acrossMessages.lastMessageOnly, 1],
      ["images in both messages", p.acrossMessages.both, 2],
    ] as const) {
      checks.push([
        name,
        measured,
        geminiRequestTokens(model, group, at(n), "default"),
      ]);
    }
    for (const j of p.jpegInsteadOfPng) {
      const want = geminiRequestTokens(
        model,
        group,
        [[j.width, j.height]],
        "default"
      );
      checks.push([`png ${j.width}x${j.height}`, j.png, want]);
      checks.push([`jpeg ${j.width}x${j.height}`, j.jpeg, want]);
    }
    const hits = checks.filter(
      ([, measured, predicted]) => measured === predicted
    );
    for (const [name, measured, predicted] of checks) {
      if (measured !== predicted) {
        console.log(
          `${group} ${short} probe MISS ${name}: ${measured} measured, ${predicted} predicted`
        );
      }
    }
    console.log(
      `${group} ${short} probes fit: ${hits.length}/${checks.length} exact`
    );
    probeExact += hits.length;
    probeTotal += checks.length;
  }
}

console.log(
  `${fits} fits: ${exact}/${total} cases exact, max abs error ${worst}; ${probeExact}/${probeTotal} probe checks exact; docs hypothesis exact on ${docsExact}`
);
if (exact !== total || probeExact !== probeTotal) process.exitCode = 1;
