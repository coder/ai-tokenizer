import type {
  AreaPatchImageTokens,
  ImageByDetail,
  MediaTokens,
  PatchImageTokens,
  TileImageTokens,
} from ".";
import type { ImageSize } from "./media";

/** A photo or a screenshot, as the usual size of an image that cannot be read. */
export const UNKNOWN_IMAGE_SIZE: ImageSize = { width: 1024, height: 1024 };

/**
 * What an image costs under a model's recipe. `size` is undefined for an
 * image whose pixels cannot be read here: a URL, a provider file id, a format
 * without a reader. Those cost as `UNKNOWN_IMAGE_SIZE`. `detail` is the
 * `imageDetail` option of OpenAI image parts.
 */
export function imageTokens(
  image: MediaTokens["image"],
  size: ImageSize | undefined,
  detail?: string
): number {
  const recipe = "default" in image ? byDetail(image, detail) : image;
  const { width, height } =
    size && size.width >= 1 && size.height >= 1 ? size : UNKNOWN_IMAGE_SIZE;
  switch (recipe.kind) {
    case "flat":
      return recipe.tokens;
    case "patches":
      return patchTokens(recipe, width, height);
    case "area-patches":
      return areaPatchTokens(recipe, width, height);
    case "tiles":
      return tileTokens(recipe, width, height);
  }
}

function byDetail(image: ImageByDetail, detail: string | undefined) {
  return (
    (detail === "low"
      ? image.low
      : detail === "high"
        ? image.high
        : undefined) ?? image.default
  );
}

function patchTokens(
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

function areaPatchTokens(
  recipe: AreaPatchImageTokens,
  width: number,
  height: number
): number {
  const { patch } = recipe;
  let w = width;
  let h = height;
  const long = Math.max(w, h);
  if (recipe.maxEdge !== undefined && long > recipe.maxEdge) {
    const scale = recipe.maxEdge / long;
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  let patches = Math.ceil(w / patch) * Math.ceil(h / patch);
  if (recipe.maxPatches !== undefined && patches > recipe.maxPatches) {
    // Scale to the cap by area, then down to a whole number of patches along
    // the side that has the fewer to spare.
    let scale = Math.sqrt((patch * patch * recipe.maxPatches) / (w * h));
    scale *= Math.min(
      Math.floor((w * scale) / patch) / ((w * scale) / patch),
      Math.floor((h * scale) / patch) / ((h * scale) / patch)
    );
    w = Math.max(1, Math.floor(w * scale));
    h = Math.max(1, Math.floor(h * scale));
    patches = Math.ceil(w / patch) * Math.ceil(h / patch);
  }
  const round = recipe.round === "floor" ? Math.floor : Math.ceil;
  return round(recipe.multiplier * patches) + recipe.overhead;
}

function tileTokens(
  recipe: TileImageTokens,
  width: number,
  height: number
): number {
  let w = width;
  let h = height;
  if (Math.max(w, h) > recipe.maxEdge) {
    const scale = recipe.maxEdge / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  if (Math.min(w, h) > recipe.maxShortEdge) {
    const scale = recipe.maxShortEdge / Math.min(w, h);
    w = Math.max(1, Math.floor(w * scale));
    h = Math.max(1, Math.floor(h * scale));
  }
  return (
    recipe.base +
    recipe.perTile * Math.ceil(w / recipe.tile) * Math.ceil(h / recipe.tile)
  );
}
