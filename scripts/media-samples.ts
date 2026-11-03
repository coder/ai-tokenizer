/**
 * Images and PDFs generated from nothing but a size, for the scripts that
 * measure what providers charge for media. The pixels do not matter to a
 * provider's price, so a plain grey image of any size is a few kilobytes.
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function ihdr(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grey
  return chunk("IHDR", header);
}

/** The first 33 bytes of a PNG of this size: enough to read it, no pixels. */
export function pngHeader(width: number, height: number): Buffer {
  return Buffer.concat([PNG_SIGNATURE, ihdr(width, height)]);
}

/** An 8-bit grey PNG. Every pixel is `grey`; a second grey draws a diagonal so no codec shortcut applies. */
export function greyPng(width: number, height: number, grey = 128): Buffer {
  const rows = Buffer.alloc(height * (width + 1), grey);
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0; // filter: none
    rows[y * (width + 1) + 1 + Math.floor((y * width) / height)] = 255 - grey;
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/**
 * The image sizes every provider is measured at: tiny, one patch either side
 * of a boundary, odd aspect ratios, and above each provider's resize cap.
 */
export const MEASURED_SIZES: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [8, 8],
  [14, 14],
  [27, 27],
  [28, 28],
  [29, 29],
  [56, 56],
  [100, 100],
  [200, 200],
  [256, 256],
  [300, 200],
  [384, 384],
  [385, 385],
  [512, 512],
  [513, 513],
  [640, 480],
  [768, 768],
  [769, 769],
  [1000, 1000],
  [1024, 1024],
  [1338, 579],
  [1568, 1568],
  [1569, 1569],
  [1920, 1080],
  [2048, 2048],
  [2576, 2576],
  [2577, 2577],
  [3000, 2000],
  [4000, 4000],
  [10, 1000],
  [1000, 10],
  [50, 2000],
  [2000, 50],
  [4000, 300],
];

/**
 * `count` image sizes drawn from a seeded generator: log-uniform edges, some
 * near-square and some far above any provider's cap, none over 20 megapixels.
 */
export function randomSizes(
  count: number,
  seed: number
): Array<[number, number]> {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const logUniform = (lo: number, hi: number) =>
    Math.round(Math.exp(Math.log(lo) + next() * (Math.log(hi) - Math.log(lo))));
  const sizes: Array<[number, number]> = [];
  while (sizes.length < count) {
    let w = logUniform(1, 5000);
    let h = logUniform(1, 5000);
    switch (sizes.length % 4) {
      case 1:
        h = Math.max(1, Math.round(w * (0.3 + next() * 1.4)));
        break;
      case 2:
        w = logUniform(900, 4000);
        h = logUniform(900, 4000);
        break;
      case 3:
        w = logUniform(1000, 3200);
        h = logUniform(300, 1200);
        break;
    }
    if (w * h <= 20e6) {
      sizes.push([w, h]);
    }
  }
  return sizes;
}
