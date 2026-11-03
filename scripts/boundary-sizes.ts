/**
 * Image sizes that tell apart recipes whose limits differ by one or two. A
 * fixture fitted at random sizes fits every limit near the true one, and the
 * sizes below are the few that do not: for each limit on the grid, a size
 * where it prices an image differently from its neighbors.
 */
import type { PatchImageTokens } from "../src";
import { imageTokens } from "../src/image-tokens";

const REACH = 2;

function hypotheses(maxEdge: number, maxPatches: number): PatchImageTokens[] {
  const result: PatchImageTokens[] = [];
  for (let edge = maxEdge - REACH; edge <= maxEdge + REACH; edge++) {
    for (
      let patches = maxPatches - REACH;
      patches <= maxPatches + REACH;
      patches++
    ) {
      result.push({
        kind: "patches",
        patch: 28,
        maxEdge: edge,
        maxPatches: patches,
        overhead: 3,
      });
    }
  }
  return result;
}

/** Candidate sizes: just past the edge limit, and with a patch count at the limit. */
function candidates(
  maxEdge: number,
  maxPatches: number
): Array<[number, number]> {
  const sizes: Array<[number, number]> = [];
  for (const long of [
    maxEdge - 1,
    maxEdge,
    maxEdge + 1,
    maxEdge + 2,
    2 * maxEdge - 1,
    2 * maxEdge + 1,
    3 * maxEdge + 7,
  ]) {
    for (let short = 1; short <= 300; short++) {
      sizes.push([long, short]);
    }
  }
  for (let nx = 1; nx <= Math.ceil(maxEdge / 28); nx++) {
    for (let ny = 1; ny <= nx; ny++) {
      if (Math.abs(nx * ny - maxPatches) > 4) continue;
      for (const [dx, dy] of [
        [0, 0],
        [13, 27],
        [27, 0],
        [0, 14],
      ] as const) {
        const w = 28 * nx - dx;
        const h = 28 * ny - dy;
        sizes.push([w, h], [h, w]);
      }
    }
  }
  return sizes;
}

/**
 * A small set of sizes that separates the recipes of the grid around
 * (`maxEdge`, `maxPatches`) from each other as far as any size can, chosen
 * greedily.
 */
export function boundarySizes(
  maxEdge: number,
  maxPatches: number
): Array<[number, number]> {
  const grid = hypotheses(maxEdge, maxPatches);
  const pool = candidates(maxEdge, maxPatches).map((size) => ({
    size,
    prices: grid.map((recipe) =>
      imageTokens(recipe, { width: size[0], height: size[1] })
    ),
  }));
  // Each class holds the recipes that no chosen size has told apart yet.
  let classes: number[][] = [grid.map((_, i) => i)];
  const chosen: Array<[number, number]> = [];
  while (classes.some((c) => c.length > 1)) {
    let best:
      | { size: [number, number]; split: number[][]; gain: number }
      | undefined;
    for (const { size, prices } of pool) {
      const split = classes.flatMap((c) => {
        const byPrice = new Map<number, number[]>();
        for (const i of c)
          byPrice.set(prices[i]!, [...(byPrice.get(prices[i]!) ?? []), i]);
        return [...byPrice.values()];
      });
      const gain = split.length - classes.length;
      if (gain > (best?.gain ?? 0)) best = { size, split, gain };
    }
    // What is left prices every candidate alike, so no measurement can tell
    // those recipes apart (a cap of 1569 patches cannot be reached when 1569
    // is 3 x 523).
    if (!best) break;
    chosen.push(best.size);
    classes = best.split;
  }
  return chosen;
}
