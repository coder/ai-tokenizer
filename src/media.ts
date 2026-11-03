/**
 * Image sizes read from file headers, without decoding any pixels. Nothing
 * here may use Node-only APIs: the module also runs in browsers and workers.
 */

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Where the answer is still unknown: the bytes ended inside a JPEG header, and
 * this many bytes (in total, counted from the start) are needed to go on.
 */
type NeedBytes = number;

type Sniffed = ImageSize | NeedBytes | undefined;

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) =>
  b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

function hasAscii(b: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (b[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** A size with a zero side is a corrupt header, not an empty image. */
function sizeOrUndefined(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** The PNG specification limits each side to 2^31-1. */
const PNG_MAX_SIDE = 0x7fffffff;

function pngSize(b: Uint8Array): ImageSize | undefined {
  // The signature, then the first chunk, which must be IHDR: length(4) "IHDR"
  // width(4) height(4), all big-endian.
  if (b.length < 24 || !hasAscii(b, 0, "\x89PNG\r\n\x1a\n")) return undefined;
  if (!hasAscii(b, 12, "IHDR")) return undefined;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  if (width > PNG_MAX_SIDE || height > PNG_MAX_SIDE) return undefined;
  return sizeOrUndefined(width, height);
}

function gifSize(b: Uint8Array): ImageSize | undefined {
  if (b.length < 10) return undefined;
  if (!hasAscii(b, 0, "GIF87a") && !hasAscii(b, 0, "GIF89a")) return undefined;
  return sizeOrUndefined(u16le(b, 6), u16le(b, 8));
}

function webpSize(b: Uint8Array): ImageSize | undefined {
  if (!hasAscii(b, 0, "RIFF") || !hasAscii(b, 8, "WEBP")) return undefined;
  // The first chunk (at 12) holds the size. Its own size and the RIFF size are
  // not read: truncated files get them wrong.
  if (hasAscii(b, 12, "VP8 ")) {
    // Lossy. Frame tag(3, bit 0 clear for a key frame), start code 9D 01 2A,
    // then width and height as 14 bits each. The top 2 bits of each are an
    // upscaling hint, not part of the size.
    if (b.length < 30 || (b[20]! & 1) !== 0) return undefined;
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return sizeOrUndefined(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (hasAscii(b, 12, "VP8L")) {
    // Lossless. Signature 0x2F, then a little-endian bit field: width-1 (14
    // bits), height-1 (14 bits), alpha flag (1), version (3, must be 0).
    if (b.length < 25 || b[20] !== 0x2f) return undefined;
    const bits =
      (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    if (bits >>> 29 !== 0) return undefined;
    return sizeOrUndefined((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (hasAscii(b, 12, "VP8X")) {
    // Extended (alpha, EXIF, animation). Flags(4), then the canvas width-1 and
    // height-1 as 24-bit little-endian. An animation's size is its canvas.
    if (b.length < 30) return undefined;
    return sizeOrUndefined(u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  return undefined;
}

/** Start-of-frame markers. C4 (DHT), C8 (JPG) and CC (DAC) sit in the range but are not frames. */
const isJpegFrame = (code: number) =>
  code >= 0xc0 &&
  code <= 0xcf &&
  code !== 0xc4 &&
  code !== 0xc8 &&
  code !== 0xcc;

function jpegSize(b: Uint8Array): Sniffed {
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let at = 2;
  for (;;) {
    if (at + 4 > b.length) return at + 4;
    if (b[at] !== 0xff) return undefined;
    const code = b[at + 1]!;
    // Any number of 0xFF fill bytes may come before a marker code.
    if (code === 0xff) {
      at++;
      continue;
    }
    // FF 00 is a stuffed data byte, never a marker. Standalone markers (TEM,
    // RSTn, SOI) have no length field.
    if (code === 0x00) return undefined;
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd8)) {
      at += 2;
      continue;
    }
    // The scan or the end of the image came before any frame header.
    if (code === 0xd9 || code === 0xda) return undefined;
    const length = u16be(b, at + 2);
    if (isJpegFrame(code)) {
      // length(2) precision(1) height(2) width(2) ...: height comes first.
      if (length < 8) return undefined;
      if (at + 9 > b.length) return at + 9;
      return sizeOrUndefined(u16be(b, at + 7), u16be(b, at + 5));
    }
    // EXIF, ICC and thumbnails can fill a segment before the frame header, and
    // an EXIF thumbnail has a frame header of its own: skip by length.
    if (length < 2) return undefined;
    at += 2 + length;
  }
}

function sniff(b: Uint8Array): Sniffed {
  switch (b[0]) {
    case 0x89:
      return pngSize(b);
    case 0xff:
      return jpegSize(b);
    case 0x47:
      return gifSize(b);
    case 0x52:
      return webpSize(b);
    default:
      return undefined;
  }
}

/**
 * The size of a PNG, JPEG, GIF or WebP image, from its header. The size is the
 * one stored in the file: an EXIF orientation does not turn it. Returns
 * undefined for any other format and for truncated or corrupt data.
 */
export function readImageSize(bytes: Uint8Array): ImageSize | undefined {
  const found = sniff(bytes);
  return typeof found === "object" ? found : undefined;
}

const ASCII_WHITESPACE = /[\t\n\f\r ]+/g;

/**
 * The first `maxBytes` bytes of a base64 string (all of them when it is
 * shorter), decoding no more of the string than that. `complete` says that
 * the whole string was decoded. Undefined when the string is not base64.
 *
 * It accepts ASCII whitespace and missing padding, as `atob` does, and the
 * URL-safe alphabet (`-_`), which `atob` rejects.
 */
function decodeBase64(
  text: string,
  maxBytes: number
): { bytes: Uint8Array; complete: boolean } | undefined {
  // A multiple of 4 characters is whole bytes, so the cut is clean.
  const wanted = Math.ceil(maxBytes / 3) * 4;
  const clean = (end: number) =>
    text
      .slice(0, end)
      .replace(ASCII_WHITESPACE, "")
      .replace(/[-_]/g, (c) => (c === "-" ? "+" : "/"));
  let end = wanted;
  let chars = clean(end);
  while (chars.length < wanted && end < text.length) {
    end = Math.min(text.length, end * 2);
    chars = clean(end);
  }
  const complete = end >= text.length && chars.length <= wanted;
  if (chars.length > wanted) chars = chars.slice(0, wanted);
  try {
    const binary = atob(chars);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, complete };
  } catch {
    return undefined;
  }
}

/**
 * The base64 text of a string payload: the string itself, or the payload of a
 * `data:<type>;base64,<payload>` URL. Undefined for other URLs, and for data
 * URLs that are not base64.
 */
function base64Of(text: string): string | undefined {
  if (!/^data:/i.test(text)) return text;
  const comma = text.indexOf(",");
  if (comma < 0 || !text.slice(0, comma).toLowerCase().endsWith(";base64")) {
    return undefined;
  }
  return text.slice(comma + 1);
}

const isArrayBuffer = (value: unknown): value is ArrayBufferLike => {
  // The tag, not `instanceof`: a buffer made in another realm (a worker, a vm
  // context) fails `instanceof` in this one.
  const tag = Object.prototype.toString.call(value);
  return tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]";
};

const isTaggedData = (
  value: unknown
): value is { type: "data"; data: unknown } =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === "data";

/**
 * What the inline forms of a part payload hold: bytes, or the base64 text of
 * bytes not yet decoded. Undefined for URLs, provider references, inline text
 * and anything else that is not image or file bytes.
 */
function inlineOf(data: unknown): Uint8Array | string | undefined {
  try {
    // AI SDK v7 wraps bytes as { type: "data", data }. Only one layer: the
    // inner value is never unwrapped again.
    const payload = isTaggedData(data) ? data.data : data;
    if (typeof payload === "string") return base64Of(payload);
    // Any typed array or DataView, a Node Buffer included, as the bytes it views.
    if (ArrayBuffer.isView(payload)) {
      return new Uint8Array(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength
      );
    }
    if (isArrayBuffer(payload)) return new Uint8Array(payload);
  } catch {
    // A throwing getter or a detached buffer is not a payload.
  }
  return undefined;
}

/** The PNG, GIF and WebP headers that hold a size all end by byte 30. */
const FIRST_READ = 64;
const FIRST_JPEG_READ = 4096;

/**
 * The size of the image in a part payload, as AI SDK callers give it: a base64
 * string, a `data:` URL, bytes (`Uint8Array`, `Buffer`, `ArrayBuffer`,
 * `SharedArrayBuffer`, `DataView`) or AI SDK v7 `{ type: "data", data }`.
 * Returns undefined for URLs, provider references, text and unknown formats.
 *
 * It decodes only as much base64 as the header needs: the first bytes for a
 * PNG, GIF or WebP, and growing prefixes for a JPEG until its frame header.
 * So a megabyte string costs the same as a short one, and it does not check
 * that the rest of the string is base64.
 */
export function imageSizeOf(data: unknown): ImageSize | undefined {
  const inline = inlineOf(data);
  if (inline === undefined) return undefined;
  if (typeof inline !== "string") return readImageSize(inline);
  let wanted = FIRST_READ;
  for (;;) {
    const prefix = decodeBase64(inline, wanted);
    if (!prefix) return undefined;
    const found = sniff(prefix.bytes);
    if (typeof found === "object") return found;
    if (found === undefined || prefix.complete) return undefined;
    // `found` is where the header walk stopped, so a big EXIF or ICC segment is
    // skipped in one step. Doubling keeps the total decoded within a constant
    // factor of the prefix the header needs, whatever the segment sizes.
    wanted = Math.max(found, wanted * 2, FIRST_JPEG_READ);
  }
}

/**
 * Every byte of an inline payload, in the forms `imageSizeOf` takes. Bytes
 * given as bytes are not copied. Undefined for URLs, provider references,
 * inline text, and base64 that is not valid.
 */
export function mediaBytesOf(data: unknown): Uint8Array | undefined {
  const inline = inlineOf(data);
  if (typeof inline !== "string") return inline;
  return decodeBase64(inline, Infinity)?.bytes;
}
