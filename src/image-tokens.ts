import type {
  AreaPatchImageTokens,
  BudgetImageTokens,
  CropImageTokens,
  ImageByDetail,
  MediaTokens,
  PatchImageTokens,
  TileImageTokens,
} from ".";
import type { ImageSize } from "./media";

/** A photo or a screenshot, as the usual size of an image that cannot be read. */
export const UNKNOWN_IMAGE_SIZE: ImageSize = { width: 1024, height: 1024 };

export interface ImageContext {
  /** The `imageDetail` option of an OpenAI image part: `low`, `high`, `auto` or `original`. */
  detail?: string;
  /** How many images the whole request holds. Needed by `crops` recipes only. */
  images?: number;
}

/** Whether pricing an image needs to know how many images the request holds. */
export function needsImageCount(image: MediaTokens["image"]): boolean {
  return [image, ...("default" in image ? Object.values(image) : [])].some(
    (recipe) => "kind" in recipe && recipe.kind === "crops"
  );
}

/**
 * What an image costs under a model's recipe. `size` is undefined for an
 * image whose pixels cannot be read here: a URL, a provider file id, a format
 * without a reader. Those cost as `UNKNOWN_IMAGE_SIZE`.
 */
export function imageTokens(
  image: MediaTokens["image"],
  size: ImageSize | undefined,
  context: ImageContext = {}
): number {
  const recipe = "default" in image ? byDetail(image, context.detail) : image;
  const { width, height } =
    size && isSide(size.width) && isSide(size.height)
      ? size
      : UNKNOWN_IMAGE_SIZE;
  switch (recipe.kind) {
    case "flat":
      return recipe.tokens;
    case "patches":
      return patchTokens(recipe, width, height);
    case "area-patches":
      return areaPatchTokens(recipe, width, height);
    case "tiles":
      return tileTokens(recipe, width, height);
    case "crops":
      return cropTokens(recipe, width, height, context.images ?? 1);
    case "budget":
      return budgetTokens(recipe, width, height);
    default:
      throw new Error(
        `Unknown image recipe: ${JSON.stringify((recipe as { kind?: unknown }).kind)}`
      );
  }
}

const isSide = (side: number) => Number.isFinite(side) && side >= 1;

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
    // A side of less than one patch is not rounded down to 0 patches.
    const wholePatches = (side: number) => {
      const patches = (side * scale) / patch;
      return patches < 1 ? 1 : Math.floor(patches) / patches;
    };
    scale *= Math.min(wholePatches(w), wholePatches(h));
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

function cropTokens(
  recipe: CropImageTokens,
  width: number,
  height: number,
  images: number
): number {
  if (images > 1) {
    return recipe.several;
  }
  let short = Math.min(width, height);
  let long = Math.max(width, height);
  if (long <= recipe.singleTileEdge && long < 2 * short) {
    return recipe.tile;
  }
  if (long > recipe.maxEdge) {
    short = Math.floor((short * recipe.maxEdge) / long);
    long = recipe.maxEdge;
    if (short === 0) {
      return recipe.tile;
    }
  }
  const crop = Math.min(
    short,
    Math.min(
      recipe.maxCrop,
      Math.max(recipe.minCrop, Math.floor((2 * short) / 3))
    )
  );
  const crops = Math.ceil(long / crop) * Math.ceil(short / crop);
  return recipe.tile * (1 + Math.min(recipe.maxCrops, crops));
}

function budgetTokens(
  recipe: BudgetImageTokens,
  width: number,
  height: number
): number {
  // floor(sqrt(x)) equals floor(sqrt(floor(x))), so the integer part is exact.
  const side = (x: number) => Math.max(1, Math.floor(Math.sqrt(Math.floor(x))));
  return Math.min(
    recipe.budget,
    side((recipe.budget * width) / height) *
      side((recipe.budget * height) / width)
  );
}
