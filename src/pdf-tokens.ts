import type { PdfTokens } from ".";

/**
 * What a PDF costs: the mean cost of a page times its page count. `bytes` is
 * undefined when the PDF is not inline (a URL, a provider file id), and a file
 * whose pages cannot be counted is one page.
 */
export function pdfTokens(
  recipe: PdfTokens,
  bytes: Uint8Array | undefined
): number {
  return recipe.averagePage * Math.max(1, bytes ? countPdfPages(bytes) : 0);
}

/**
 * The page objects of a PDF: `/Type /Page`, and not `/Type /Pages`, in the
 * bytes of the file. A file that keeps its page objects in a compressed
 * object stream has none to find and counts as 0.
 */
export function countPdfPages(bytes: Uint8Array): number {
  const type = [0x2f, 0x54, 0x79, 0x70, 0x65]; // "/Type"
  const page = [0x2f, 0x50, 0x61, 0x67, 0x65]; // "/Page"
  const isSpace = (byte: number | undefined) =>
    byte === 0x20 || (byte !== undefined && byte >= 0x09 && byte <= 0x0d);
  const isNameChar = (byte: number | undefined) =>
    byte !== undefined &&
    byte > 0x20 &&
    !"/<>[](){}%".includes(String.fromCharCode(byte));
  let pages = 0;
  for (let i = 0; i + type.length < bytes.length; i++) {
    if (bytes[i] !== 0x2f || !type.every((byte, k) => bytes[i + k] === byte)) {
      continue;
    }
    let at = i + type.length;
    while (isSpace(bytes[at])) at++;
    if (page.every((byte, k) => bytes[at + k] === byte)) {
      pages += isNameChar(bytes[at + page.length]) ? 0 : 1;
    }
  }
  return pages;
}
