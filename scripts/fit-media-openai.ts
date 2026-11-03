/**
 * Checks the formula for each OpenAI model and detail against every case in
 * src/fixtures/media-openai.json, which scripts/measure-media-openai.ts
 * measured. No key is needed.
 *
 *   bun scripts/fit-media-openai.ts
 *
 * Prints one line per model and detail, the cases a formula misses under it,
 * and a count line. Exits 1 when a formula misses a case.
 *
 * Every formula is a count of tiles or patches, and a price per count:
 *
 * - Tiles (gpt-5, gpt-4o): `low` is the base price. Any other detail resizes
 *   the image, then adds a price per 512 px tile. `auto` and `original` are
 *   `high`.
 * - Patches (the others): 32 px patches. A longest-side limit shrinks the
 *   image to whole pixels, a patch cap shrinks it again, and the price is a
 *   multiple of the patch count plus one token. gpt-4.1-mini ignores `detail`.
 *   On gpt-5.5 and gpt-6.1-sol, `auto` is `original`, not `high`.
 *
 * The rounding of each resize is what the boundary sizes in the fixture pin
 * down: the longest-side step rounds to the nearest pixel, the 768 px
 * shortest-side step and the patch-cap step round down.
 */
import { readFileSync } from "node:fs";

const FIXTURE = new URL("../src/fixtures/media-openai.json", import.meta.url);

interface Case {
  width: number;
  height: number;
  detail: string;
  tokens?: number;
  error?: string;
}

interface Fixture {
  models: Record<string, { cases: Case[] }>;
  probes: Record<
    string,
    Record<string, Record<string, number | string | null>>
  >;
}

/** Tiles of 512 px after the image fits in 2048 px, and its shortest side in 768 px. */
function tiles(width: number, height: number): number {
  let w = width;
  let h = height;
  if (Math.max(w, h) > 2048) {
    const scale = 2048 / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  if (Math.min(w, h) > 768) {
    const scale = 768 / Math.min(w, h);
    w = Math.max(1, Math.floor(w * scale));
    h = Math.max(1, Math.floor(h * scale));
  }
  return Math.ceil(w / 512) * Math.ceil(h / 512);
}

/** Patches of 32 px after the longest side fits in `side` px and the count in `cap`. */
function patches(
  width: number,
  height: number,
  { side = Infinity, cap = Infinity } = {}
): number {
  let w = width;
  let h = height;
  if (Math.max(w, h) > side) {
    const scale = side / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  let count = Math.ceil(w / 32) * Math.ceil(h / 32);
  if (count > cap) {
    // Shrink to the cap, then to a whole number of patches along the side
    // that has the fewer to spare.
    let scale = Math.sqrt((1024 * cap) / (w * h));
    scale *= Math.min(
      Math.floor((w * scale) / 32) / ((w * scale) / 32),
      Math.floor((h * scale) / 32) / ((h * scale) / 32)
    );
    w = Math.max(1, Math.floor(w * scale));
    h = Math.max(1, Math.floor(h * scale));
    count = Math.ceil(w / 32) * Math.ceil(h / 32);
  }
  return count;
}

function unknown(detail: string): never {
  throw new Error(`no formula for detail ${detail}`);
}

const FITS: Record<
  string,
  (width: number, height: number, detail: string) => number
> = {
  "gpt-5": (w, h, detail) => (detail === "low" ? 70 : 70 + 140 * tiles(w, h)),
  "gpt-4o": (w, h, detail) => (detail === "low" ? 85 : 85 + 170 * tiles(w, h)),
  "gpt-4.1-mini": (w, h) =>
    Math.ceil(1.62 * patches(w, h, { side: 2048, cap: 1536 })) + 1,
  "gpt-5.5": (w, h, detail) => {
    const count =
      detail === "low"
        ? patches(w, h, { side: 512 })
        : detail === "high"
          ? patches(w, h, { side: 2048, cap: 2500 })
          : detail === "auto" || detail === "original"
            ? patches(w, h, { side: 6000, cap: 10000 })
            : unknown(detail);
    return Math.floor(1.2 * count) + 1;
  },
  "gpt-6.1-sol": (w, h, detail) => {
    const count =
      detail === "low"
        ? patches(w, h, { side: 512 })
        : detail === "high"
          ? patches(w, h, { cap: 2500 })
          : detail === "auto" || detail === "original"
            ? patches(w, h)
            : unknown(detail);
    return Math.floor(1.2 * count) + 1;
  },
};

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

let fits = 0;
let exact = 0;
let total = 0;
let rejected = 0;
let misses = 0;

for (const [model, { cases }] of Object.entries(fixture.models)) {
  const fit = FITS[model];
  if (!fit) throw new Error(`no formula for ${model}`);
  const details = [...new Set(cases.map((c) => c.detail))];
  for (const detail of details) {
    const measured = cases.filter((c) => c.detail === detail);
    rejected += measured.filter((c) => c.tokens === undefined).length;
    const checked = measured.filter(
      (c): c is Case & { tokens: number } => c.tokens !== undefined
    );
    const missed = checked.filter(
      (c) => fit(c.width, c.height, detail) !== c.tokens
    );
    const maxError = Math.max(
      0,
      ...missed.map((c) => Math.abs(fit(c.width, c.height, detail) - c.tokens))
    );
    console.log(
      `${model.padEnd(13)} ${detail.padEnd(9)} ${checked.length - missed.length}/${checked.length} exact, max abs error ${maxError}`
    );
    for (const c of missed.slice(0, 5)) {
      console.log(
        `  miss ${c.width}x${c.height}: measured ${c.tokens}, fit ${fit(c.width, c.height, detail)}`
      );
    }
    fits++;
    exact += checked.length - missed.length;
    total += checked.length;
    misses += missed.length;
  }
}

// What the formulas assume about the request, measured once per model.
let held = 0;
let probed = 0;
for (const [model, probes] of Object.entries(fixture.probes)) {
  const same = [
    probes.twoImages!.second === probes.twoImages!.one,
    probes.jpeg!.jpeg === probes.jpeg!.png,
    probes.detailOmitted!.omitted === probes.detailOmitted!.auto,
    probes.imageFirst!.imageFirst === probes.imageFirst!.textFirst,
  ];
  console.log(
    `${model.padEnd(13)} probes    ${same.filter(Boolean).length}/4 hold (second image, JPEG, detail omitted, image first)`
  );
  held += same.filter(Boolean).length;
  probed += same.length;
  misses += same.filter((ok) => !ok).length;
}

console.log(
  `${fits} model/detail fits, ${exact}/${total} cases exact, ${rejected} rejected, ${held}/${probed} probes hold`
);
if (misses > 0) process.exitCode = 1;
