/**
 * Long pieces: the split pattern bounds digit runs only, so one run of
 * underscores, spaces, dots or letters becomes a single piece. Merging such a
 * piece must scale about linearly with its length.
 * See https://github.com/coder/ai-tokenizer/issues/6.
 */

import { describe, test, expect } from "bun:test";
import Tokenizer from "./tokenizer";
import * as o200k from "./encoding/o200k_base";

// Linear time is about 0.15 s for 100k characters. The quadratic merge took
// 10 s or more, so this bound has 10x headroom for slow CI machines.
const LONG_PIECE_CHARS = 100_000;
const LONG_PIECE_BOUND_MS = 2_000;

const longPieces: Array<[string, string]> = [
  ["underscores", "_".repeat(LONG_PIECE_CHARS)],
  ["spaces", " ".repeat(LONG_PIECE_CHARS)],
  ["alternating letters", "ab".repeat(LONG_PIECE_CHARS / 2)],
  ["dots", ".".repeat(LONG_PIECE_CHARS)],
];

describe("long pieces", () => {
  test.each(longPieces)(
    "%s finish within a generous time bound",
    (_name, text) => {
      // A fresh tokenizer, so the merge cache cannot hide the cost.
      const tokenizer = new Tokenizer(o200k);
      const start = performance.now();
      const tokens = tokenizer.encode(text);
      const elapsedMs = performance.now() - start;

      expect(tokens.length).toBeGreaterThan(0);
      expect(tokenizer.decode(tokens)).toBe(text);
      expect(elapsedMs).toBeLessThan(LONG_PIECE_BOUND_MS);
    },
    60_000
  );
});
