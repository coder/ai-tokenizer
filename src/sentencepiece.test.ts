import { describe, expect, test } from "bun:test";
import Tokenizer from "./tokenizer";
import * as encodings from "./encoding";
import * as gemma4 from "./encoding/gemma4";

describe("Tokenizer with the gemma4 encoding", () => {
  const tokenizer = new Tokenizer(gemma4);

  test("Tokenizer accepts every module of the encoding namespace", () => {
    for (const name of Object.keys(encodings) as Array<
      keyof typeof encodings
    >) {
      const count = new Tokenizer(encodings[name]).count("hello world");
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(5);
    }
  });

  test("empty text has no tokens", () => {
    expect(tokenizer.encode("")).toEqual([]);
    expect(tokenizer.count("")).toBe(0);
  });

  test("a space becomes the ▁ marker", () => {
    expect(tokenizer.encode(" hello  world ")).toEqual(
      [" hello", "  ", "world", " "].map((piece) =>
        gemma4.vocab.indexOf(piece.replaceAll(" ", "▁"))
      )
    );
  });

  test("decode restores the text, including byte-fallback characters", () => {
    for (const text of [
      "hello world",
      "  indented\n\tline\r\n",
      "日本語のテキスト 😀 👨‍👩‍👧",
      "NEL \u0085 and BOM \ufeff and NUL \u0000",
      "x▁y",
    ]) {
      const decoded = tokenizer.decode(tokenizer.encode(text));
      // "▁" and " " share one token, so "x▁y" comes back with a space.
      expect(decoded).toBe(text.replace(/▁/g, " "));
    }
  });

  test("decode keeps a BOM that arrives as byte tokens", () => {
    const bytes = ["<0xEF>", "<0xBB>", "<0xBF>"].map((piece) =>
      gemma4.vocab.indexOf(piece)
    );
    expect(tokenizer.decode(bytes)).toBe("\ufeff");
  });

  test("a lone surrogate counts as U+FFFD", () => {
    expect(tokenizer.encode("a\ud800b")).toEqual(tokenizer.encode("a\ufffdb"));
    expect(tokenizer.encode("a\udc00")).toEqual(tokenizer.encode("a\ufffd"));
  });

  test("special tokens follow the Tokenizer rules", () => {
    const text = "<bos>hi<eos>";
    expect(() => tokenizer.encode(text)).toThrow("disallowed special token");
    expect(tokenizer.encode(text, "all")).toEqual([2, 2202, 1]);
    expect(tokenizer.encode(text, ["<bos>"], [])).toEqual([
      2,
      2202,
      ...tokenizer.encode("<eos>", [], []),
    ]);
    expect(tokenizer.count(text)).toBe(tokenizer.encode(text, [], []).length);
    expect(tokenizer.count(text)).toBeGreaterThan(3);
  });

  test("a 200,000 character run without a space takes linear time", () => {
    const started = performance.now();
    const count = tokenizer.count("_".repeat(200_000));
    expect(count).toBeGreaterThan(0);
    // About 60 ms. Quadratic merging would take minutes.
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
