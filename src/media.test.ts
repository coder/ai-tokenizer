import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  imageSizeOf,
  mediaBytesOf,
  readImageSize,
  type ImageSize,
} from "./media";

/** Real files from scripts/generate-media-fixtures.py. The name ends in the size. */
const dir = join(import.meta.dir, "fixtures", "media");
const fixtures = readdirSync(dir)
  .sort()
  .map((name) => {
    const [, width, height] = /-(\d+)x(\d+)\.[a-z0-9]+$/.exec(name)!;
    return {
      name,
      bytes: new Uint8Array(readFileSync(join(dir, name))),
      size: { width: Number(width), height: Number(height) },
    };
  });

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("readImageSize", () => {
  test("reads the stored size of every real file", () => {
    expect(fixtures.length).toBeGreaterThan(10);
    for (const { name, bytes, size } of fixtures) {
      expect([name, readImageSize(bytes)]).toEqual([name, size]);
    }
  });
});

// Headers that no encoder writes: sizes at the limit of a field, and corrupt
// or unsupported data. Each builder follows the format's specification.
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const be32 = (n: number) => [...be16(n >>> 16), ...be16(n & 0xffff)];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [...le16(n & 0xffff), (n >>> 16) & 255];
const le32 = (n: number) => [...le16(n & 0xffff), ...le16(n >>> 16)];

const png = (width: number, height: number, firstChunk = "IHDR") => [
  ...[0x89, ...ascii("PNG\r\n\x1a\n")],
  ...be32(13),
  ...ascii(firstChunk),
  ...be32(width),
  ...be32(height),
  ...[8, 2, 0, 0, 0],
];
const gif = (width: number, height: number, version = "89a") => [
  ...ascii(`GIF${version}`),
  ...le16(width),
  ...le16(height),
  ...[0, 0, 0],
];
const segment = (code: number, payload: number[]) => [
  0xff,
  code,
  ...be16(payload.length + 2),
  ...payload,
];
const frame = (code: number, width: number, height: number) =>
  segment(code, [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0]);
const jpeg = (...parts: number[][]) => [0xff, 0xd8, ...parts.flat()];
const riff = (chunk: string, payload: number[]) => [
  ...ascii("RIFF"),
  ...le32(12 + payload.length),
  ...ascii("WEBP"),
  ...ascii(chunk),
  ...le32(payload.length),
  ...payload,
];
const vp8 = (
  width: number,
  height: number,
  frameTag = 0x10,
  startCode = [0x9d, 0x01, 0x2a]
) =>
  riff("VP8 ", [frameTag, 0, 0, ...startCode, ...le16(width), ...le16(height)]);
const vp8l = (width: number, height: number, version = 0) =>
  riff("VP8L", [
    0x2f,
    ...le32(width - 1 + ((height - 1) << 14) + (version << 29)),
  ]);
const vp8x = (width: number, height: number) =>
  riff("VP8X", [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);

const dims = (width: number, height: number): ImageSize => ({ width, height });
const handBuilt: [string, number[], ImageSize | undefined][] = [
  ["PNG, 32-bit sides", png(2 ** 31 - 1, 65536), dims(2 ** 31 - 1, 65536)],
  ["PNG, a side over 2^31-1", png(2 ** 31, 1), undefined],
  ["PNG, zero width", png(0, 5), undefined],
  ["PNG, zero height", png(5, 0), undefined],
  ["PNG, first chunk is not IHDR", png(5, 5, "CgBI"), undefined],
  ["GIF, 16-bit sides", gif(65535, 65535), dims(65535, 65535)],
  ["GIF, zero height", gif(5, 0), undefined],
  ["GIF, unknown version", gif(5, 5, "89b"), undefined],
  ["JPEG, 16-bit sides", jpeg(frame(0xc0, 65535, 65534)), dims(65535, 65534)],
  [
    "JPEG, arithmetic coding (SOF9)",
    jpeg(frame(0xc9, 300, 200)),
    dims(300, 200),
  ],
  ["JPEG, lossless (SOF3)", jpeg(frame(0xc3, 300, 200)), dims(300, 200)],
  [
    "JPEG, DHT, JPG and DAC segments before the frame",
    jpeg(
      segment(0xc4, [0, 1]),
      segment(0xc8, [1]),
      segment(0xcc, [1]),
      frame(0xc1, 9, 7)
    ),
    dims(9, 7),
  ],
  [
    "JPEG, fill bytes and standalone markers before the frame",
    jpeg([0xff, 0xff, 0xff, 0x01, 0xff, 0xd0, 0xff, 0xff], frame(0xc2, 9, 7)),
    dims(9, 7),
  ],
  [
    "JPEG, a segment of the largest length before the frame",
    jpeg(segment(0xe1, new Array(65533).fill(0xff)), frame(0xc0, 9, 7)),
    dims(9, 7),
  ],
  [
    "JPEG, height 0 (the height comes in a DNL segment)",
    jpeg(frame(0xc0, 9, 0)),
    undefined,
  ],
  [
    "JPEG, scan before any frame",
    jpeg(segment(0xda, [0, 0]), frame(0xc0, 9, 7)),
    undefined,
  ],
  [
    "JPEG, end of image before any frame",
    jpeg([0xff, 0xd9], frame(0xc0, 9, 7)),
    undefined,
  ],
  [
    "JPEG, data where a marker should be",
    jpeg([0x00, 0x01], frame(0xc0, 9, 7)),
    undefined,
  ],
  [
    "JPEG, stuffed byte where a marker should be",
    jpeg([0xff, 0x00], frame(0xc0, 9, 7)),
    undefined,
  ],
  [
    "JPEG, segment length below 2",
    jpeg([0xff, 0xe0, 0, 1], frame(0xc0, 9, 7)),
    undefined,
  ],
  ["JPEG, endless fill bytes", jpeg(new Array(200_000).fill(0xff)), undefined],
  [
    "JPEG, endless standalone markers",
    jpeg(new Array(100_000).fill([0xff, 0x01]).flat()),
    undefined,
  ],
  [
    "WebP lossy, scaling bits set",
    vp8(37 | (3 << 14), 23 | (1 << 14)),
    dims(37, 23),
  ],
  ["WebP lossy, zero width", vp8(0, 5), undefined],
  ["WebP lossy, not a key frame", vp8(37, 23, 0x11), undefined],
  ["WebP lossy, wrong start code", vp8(37, 23, 0x10, [0, 0, 0]), undefined],
  ["WebP lossless, 14-bit sides", vp8l(16384, 16384), dims(16384, 16384)],
  ["WebP lossless, unknown version", vp8l(37, 23, 1), undefined],
  [
    "WebP extended, 24-bit sides",
    vp8x(2 ** 24, 100_000),
    dims(2 ** 24, 100_000),
  ],
  [
    "RIFF but not WebP",
    [
      ...ascii("RIFF"),
      ...le32(40),
      ...ascii("WAVEfmt "),
      ...new Array(30).fill(0),
    ],
    undefined,
  ],
  ["WebP, unknown first chunk", riff("EXIF", new Array(18).fill(1)), undefined],
  ["BMP", [...ascii("BM"), ...new Array(60).fill(0)], undefined],
  ["PDF", ascii("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"), undefined],
  [
    "SVG",
    ascii('<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg"/>'),
    undefined,
  ],
  ["empty", [], undefined],
];

describe("readImageSize and imageSizeOf on hand-built headers", () => {
  for (const [label, bytes, expected] of handBuilt) {
    test(label, () => {
      const data = Uint8Array.from(bytes);
      expect(readImageSize(data)).toEqual(expected);
      expect(imageSizeOf(data)).toEqual(expected);
      expect(imageSizeOf(toBase64(data))).toEqual(expected);
    });
  }
});

/** A part payload in each form AI SDK v5, v6 and v7 callers give it. */
const inside = (bytes: Uint8Array) => {
  // A byte offset other than 0, as a pooled Buffer or a slice of a file has.
  const outer = new Uint8Array(bytes.length + 9);
  outer.set(bytes, 5);
  return { outer, at: 5, length: bytes.length };
};
const forms: [string, (bytes: Uint8Array) => unknown][] = [
  ["base64", toBase64],
  ["data URL", (b) => `data:image/png;base64,${toBase64(b)}`],
  ["data URL object", (b) => new URL(`data:image/png;base64,${toBase64(b)}`)],
  [
    "v7 data URL object",
    (b) => ({
      type: "data",
      data: new URL(`data:image/png;base64,${toBase64(b)}`),
    }),
  ],
  [
    "data URL with a parameter and capitals",
    (b) => `DATA:image/png;name=a.png;BASE64,${toBase64(b)}`,
  ],
  [
    "base64 in lines of 76 characters",
    (b) => toBase64(b).replace(/.{76}/g, "$&\r\n"),
  ],
  [
    "base64 in lines of 28 characters",
    (b) => toBase64(b).replace(/.{28}/g, "$&\n"),
  ],
  [
    "URL-safe base64 without padding",
    (b) =>
      toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  ],
  ["Uint8Array", (b) => b.slice()],
  ["Buffer", (b) => Buffer.from(b)],
  [
    "Uint8Array view into a larger buffer",
    (b) => {
      const { outer, at, length } = inside(b);
      return outer.subarray(at, at + length);
    },
  ],
  ["ArrayBuffer", (b) => b.slice().buffer],
  [
    "SharedArrayBuffer",
    (b) => {
      const shared = new SharedArrayBuffer(b.length);
      new Uint8Array(shared).set(b);
      return shared;
    },
  ],
  [
    "DataView into a larger buffer",
    (b) => {
      const { outer, at, length } = inside(b);
      return new DataView(outer.buffer, at, length);
    },
  ],
  ["AI SDK v7 data with base64", (b) => ({ type: "data", data: toBase64(b) })],
  ["AI SDK v7 data with bytes", (b) => ({ type: "data", data: b.slice() })],
];

describe("imageSizeOf and mediaBytesOf accept", () => {
  for (const [form, make] of forms) {
    test(form, () => {
      for (const { name, bytes, size } of fixtures) {
        expect([name, imageSizeOf(make(bytes))]).toEqual([name, size]);
        expect([name, mediaBytesOf(make(bytes))]).toEqual([name, bytes]);
      }
    });
  }

  test("the URL-safe alphabet, missing padding and whitespace in a short string", () => {
    expect(mediaBytesOf("-_-_")).toEqual(Uint8Array.of(0xfb, 0xff, 0xbf));
    expect(mediaBytesOf("AQI")).toEqual(Uint8Array.of(1, 2));
    expect(mediaBytesOf(" AQID\n\tBAUG ")).toEqual(
      Uint8Array.of(1, 2, 3, 4, 5, 6)
    );
  });
});

describe("imageSizeOf and mediaBytesOf refuse", () => {
  const png = fixtures.find((f) => f.name.startsWith("png-rgb"))!;
  const refused: [string, unknown][] = [
    ["a URL object", new URL("https://example.com/a.png")],
    ["an https URL", "https://example.com/a.png"],
    ["an http URL", "http://example.com/a.png"],
    ["a v7 URL", { type: "url", url: new URL("https://example.com/a.png") }],
    [
      "a v7 reference",
      { type: "reference", reference: { openai: "file-abc123" } },
    ],
    ["a provider reference", { openai: "file-abc123" }],
    ["v7 inline text", { type: "text", text: toBase64(png.bytes) }],
    [
      "v7 data inside v7 data",
      { type: "data", data: { type: "data", data: png.bytes } },
    ],
    ["a string that is not base64", "this is not base64!"],
    ["base64 with a dangling character", "iVBOR"],
    ["a data URL that is not base64", "data:text/plain,QUJD"],
    ["a data URL object that is not base64", new URL("data:text/plain,QUJD")],
    [
      "a data URL without a comma",
      `data:image/png;base64;${toBase64(png.bytes)}`,
    ],
    ["an array of numbers", Array.from(png.bytes)],
    ["a number", 85],
    ["null", null],
    ["undefined", undefined],
  ];
  for (const [label, data] of refused) {
    test(label, () => {
      expect(imageSizeOf(data)).toBeUndefined();
      expect(mediaBytesOf(data)).toBeUndefined();
    });
  }

  test("valid base64 of an unknown format: bytes, but no size", () => {
    const text = toBase64(Uint8Array.from(ascii("hello, world")));
    expect(imageSizeOf(text)).toBeUndefined();
    expect(mediaBytesOf(text)).toEqual(Uint8Array.from(ascii("hello, world")));
  });
});

/** A small deterministic random generator, so a failure repeats. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const isSizeOrUndefined = (found: ImageSize | undefined) =>
  found === undefined ||
  (Number.isInteger(found.width) &&
    Number.isInteger(found.height) &&
    found.width > 0 &&
    found.height > 0);

describe("damaged input", () => {
  test("a prefix of a file reports the real size or nothing", () => {
    for (const { name, bytes, size } of fixtures) {
      const step = Math.max(1, Math.floor(bytes.length / 300));
      for (let n = 0; n <= bytes.length; n++) {
        const found = readImageSize(bytes.subarray(0, n));
        if (found !== undefined)
          expect([name, n, found]).toEqual([name, n, size]);
      }
      for (let n = 0; n <= bytes.length; n += step) {
        const found = imageSizeOf(toBase64(bytes.subarray(0, n)));
        if (found !== undefined)
          expect([name, n, found]).toEqual([name, n, size]);
      }
    }
  });

  test("flipped bytes and random bytes never throw", () => {
    const next = random(1);
    const small = fixtures.filter((f) => f.bytes.length < 2048);
    let read = 0;
    for (let i = 0; i < 3000; i++) {
      let bytes: Uint8Array;
      if (i % 3 === 0) {
        bytes = Uint8Array.from(
          { length: Math.floor(next() * 200) },
          () => next() * 256
        );
      } else {
        bytes = small[Math.floor(next() * small.length)]!.bytes.slice();
        for (let flips = Math.ceil(next() * 3); flips > 0; flips--) {
          bytes[Math.floor(next() * bytes.length)] = next() * 256;
        }
        bytes = bytes.subarray(0, Math.ceil(next() * bytes.length));
      }
      const text = String.fromCharCode(...bytes);
      const found = [
        readImageSize(bytes),
        imageSizeOf(bytes),
        imageSizeOf(toBase64(bytes)),
        imageSizeOf(`data:;base64,${toBase64(bytes)}`),
        imageSizeOf(text),
      ];
      mediaBytesOf(text);
      expect(found.every(isSizeOrUndefined)).toBe(true);
      read += found.filter(Boolean).length;
    }
    // Most flips leave a header that still reads: the loop reached the parsers.
    expect(read).toBeGreaterThan(1000);
  });

  test("values that throw on access are not payloads", () => {
    const detached = new ArrayBuffer(8);
    const view = new Uint8Array(detached);
    structuredClone(detached, { transfer: [detached] });
    const throwing = {
      get type(): string {
        throw new Error("no");
      },
    };
    for (const data of [detached, view, throwing]) {
      expect(imageSizeOf(data)).toBeUndefined();
      expect(mediaBytesOf(data)).toBeUndefined();
    }
  });
});

describe("a long base64 string", () => {
  const lengths: number[] = [];
  const original = globalThis.atob;
  beforeEach(() => {
    lengths.length = 0;
    globalThis.atob = (text) => {
      lengths.push(text.length);
      return original(text);
    };
  });
  afterEach(() => {
    globalThis.atob = original;
  });

  /** The file, then 4 MB that the reader must not need. */
  const withTail = (name: string) => {
    const { bytes, size } = fixtures.find((f) => f.name.startsWith(name))!;
    const padded = new Uint8Array(bytes.length + 4_000_000);
    padded.set(bytes);
    return {
      text: toBase64(padded),
      size,
      fileBase64Length: Math.ceil(bytes.length / 3) * 4,
    };
  };

  // The most characters `atob` may get, over all its calls.
  const files: [string, (fileBase64Length: number) => number][] = [
    ["png-rgb", () => 256],
    ["gif-89a", () => 256],
    ["webp-lossy-vp8-37", () => 256],
    ["webp-animated", () => 256],
    ["jpeg-baseline", () => 8192],
    // The frame header is behind 70 KB of EXIF and ICC. Prefixes that grow by
    // doubling decode at most 4 times what the header needs.
    ["jpeg-icc", (fileBase64Length) => 4 * fileBase64Length],
  ];
  for (const [name, limit] of files) {
    test(`${name} is read without decoding the 4 MB after it`, () => {
      const { text, size, fileBase64Length } = withTail(name);
      expect(text.length).toBeGreaterThan(5_000_000);
      for (const data of [text, `data:image/x;base64,${text}`]) {
        lengths.length = 0;
        expect(imageSizeOf(data)).toEqual(size);
        const total = lengths.reduce((sum, length) => sum + length, 0);
        expect(total).toBeGreaterThan(0);
        expect(total).toBeLessThanOrEqual(limit(fileBase64Length));
      }
    });
  }
});
