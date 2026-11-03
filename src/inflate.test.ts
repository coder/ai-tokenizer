import { describe, expect, test } from "bun:test";
import { constants, deflateRawSync, deflateSync } from "node:zlib";
import { inflate } from "./inflate";

function seeded(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    bytes[i] = seed >>> 24;
  }
  return bytes;
}

const INPUTS: Record<string, Uint8Array> = {
  empty: new Uint8Array(),
  random: seeded(100_000, 1),
  repetitive: Uint8Array.from({ length: 200_000 }, (_, i) => i % 17),
  // Incompressible runs between text make zlib follow Huffman blocks with stored ones.
  mixed: Uint8Array.from([
    ...seeded(70_000, 2),
    ..."the quick brown fox "
      .repeat(4000)
      .split("")
      .map((c) => c.charCodeAt(0)),
    ...seeded(70_000, 3),
  ]),
  text: new TextEncoder().encode(
    "BT /F1 12 Tf 72 720 Td (The quick brown fox jumps over the lazy dog.) Tj ET\n".repeat(
      3000
    )
  ),
};

// Level 0 writes stored blocks, Z_FIXED fixed Huffman blocks, and the default
// strategy dynamic Huffman blocks.
const OPTIONS = {
  stored: { level: 0 },
  fixed: { strategy: constants.Z_FIXED },
  dynamic: { level: 9 },
  huffmanOnly: { strategy: constants.Z_HUFFMAN_ONLY },
  rle: { strategy: constants.Z_RLE },
};

describe("inflate", () => {
  test("inflates what node:zlib deflates, with and without a zlib header", () => {
    for (const [input, bytes] of Object.entries(INPUTS)) {
      for (const [option, options] of Object.entries(OPTIONS)) {
        for (const deflate of [deflateSync, deflateRawSync]) {
          const out = inflate(deflate(bytes, options));
          expect(
            Buffer.from(out).equals(Buffer.from(bytes)),
            `${input} ${option} ${deflate.name}`
          ).toBe(true);
        }
      }
    }
  });

  test("stops at the output cap and keeps what a truncated stream decoded", () => {
    const bomb = deflateSync(new Uint8Array(64 * 1024 * 1024), { level: 9 });
    expect(inflate(bomb, 1024 * 1024).length).toBeLessThanOrEqual(1024 * 1024);

    const text = INPUTS.text!;
    for (const options of [OPTIONS.stored, OPTIONS.dynamic]) {
      const deflated = deflateSync(text, options);
      const out = inflate(deflated.subarray(0, deflated.length >> 1));
      expect(out.length).toBeGreaterThan(0);
      expect(out.length).toBeLessThan(text.length);
      expect(
        Buffer.from(out).equals(Buffer.from(text.subarray(0, out.length)))
      ).toBe(true);
    }
  });
});
