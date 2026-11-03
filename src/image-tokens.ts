import type { ImageTokens, PatchImageTokens } from ".";

import type { ImageSize } from "./media";

/**
 * What an image of this size costs under a model's recipe. `size` is
 * undefined for an image whose pixels cannot be read here: a URL, a provider
 * file id, a format without a reader. Those cost as `UNKNOWN_IMAGE_SIZE`.
 */
export function imageTokens(
  recipe: ImageTokens,
  size: ImageSize | undefined
): number {
  const { width, height } = size ?? UNKNOWN_IMAGE_SIZE;
  return patchImageTokens(recipe, width, height);
}

/** A photo or a screenshot, as the usual size of an image that cannot be read. */
export const UNKNOWN_IMAGE_SIZE: ImageSize = { width: 1024, height: 1024 };

function patchImageTokens(
  recipe: PatchImageTokens,
  width: number,
  height: number
): number {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const patches = (longEdge: number) =>
    Math.ceil(longEdge / recipe.patch) *
    Math.ceil(
      Math.max(1, Math.round((short * longEdge) / long)) / recipe.patch
    );

  let edge = Math.min(long, recipe.maxEdge);
  if (patches(edge) > recipe.maxPatches) {
    // `patches` never shrinks as the edge grows, so the largest edge that
    // fits is found by bisection.
    let fits = 1;
    let over = edge;
    while (over - fits > 1) {
      const mid = (fits + over) >> 1;
      if (patches(mid) <= recipe.maxPatches) {
        fits = mid;
      } else {
        over = mid;
      }
    }
    edge = fits;
  }
  return patches(edge) + recipe.overhead;
}
