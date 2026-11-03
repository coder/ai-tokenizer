import type { PdfTokens } from ".";
import { readPdf } from "./pdf";
import type Tokenizer from "./tokenizer";

/**
 * What a PDF costs: the document block, then each page as an image and as the
 * text a PDF engine reads out of it. `bytes` is undefined when the PDF is not
 * inline (a URL, a provider file id).
 */
export function pdfTokens(
  recipe: PdfTokens,
  tokenizer: Tokenizer,
  bytes: Uint8Array | undefined
): number {
  const pdf = bytes && hasPdfHeader(bytes) ? readPdf(bytes) : undefined;
  if (!pdf || pdf.pages.length === 0) {
    return recipe.unreadable;
  }
  let total = recipe.base;
  for (const page of pdf.pages) {
    total += pageImageTokens(recipe.page, page.width, page.height);
    total += recipe.perPage;
    if (page.text) {
      total += textTokens(tokenizer, page.text) - recipe.textDiscount;
    }
  }
  return total;
}

/** A PDF starts with `%PDF-` within its first kilobyte, as readers allow. */
function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = Math.min(bytes.length, 1024) - 4;
  for (let i = 0; i < head; i++) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 &&
      bytes[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The tokens of a page's text where the API puts it: after a newline and
 * before a space. Counted alone, the first and last tokens of a text can
 * merge differently (CJK, digits), which is a token or two a page.
 */
function textTokens(tokenizer: Tokenizer, text: string): number {
  return (
    tokenizer.countUntrimmed(`\n${text} `) - tokenizer.countUntrimmed("\n ")
  );
}

/**
 * The image of a page, in points. The page is drawn with its long edge at
 * `edge` pixels, and that edge steps down one pixel at a time until the
 * patches fit. The short edge rounds down at every step.
 */
function pageImageTokens(
  page: PdfTokens["page"],
  width: number,
  height: number
): number {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (!(long > 0) || !Number.isFinite(long)) {
    return 1 + page.overhead;
  }
  const patches = (edge: number) =>
    Math.ceil(edge / page.patch) *
    Math.ceil(Math.max(1, Math.floor((short * edge) / long)) / page.patch);
  let fits = 1;
  let over = page.edge + 1;
  if (patches(page.edge) <= page.maxPatches) {
    fits = page.edge;
  } else {
    while (over - fits > 1) {
      const mid = (fits + over) >> 1;
      if (patches(mid) <= page.maxPatches) {
        fits = mid;
      } else {
        over = mid;
      }
    }
  }
  return patches(fits) + page.overhead;
}
