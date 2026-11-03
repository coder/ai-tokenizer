import { describe, expect, test } from "bun:test";
import Tokenizer from "./tokenizer";
import SentencePieceTokenizer from "./sentencepiece";
import * as encodings from "./encoding";
import * as gemma4 from "./encoding/gemma4";
import * as llama4 from "./encoding/llama4";

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

  test("special token ids", () => {
    const text = "<bos>hi<eos>";
    expect(tokenizer.encode(text, "all")).toEqual([2, 2202, 1]);
    expect(tokenizer.encode(text, ["<bos>"], [])).toEqual([
      2,
      2202,
      ...tokenizer.encode("<eos>", [], []),
    ]);
  });

  test("a 200,000 character run without a space takes linear time", () => {
    const started = performance.now();
    const count = tokenizer.count("_".repeat(200_000));
    expect(count).toBeGreaterThan(0);
    // About 60 ms. Quadratic merging would take minutes.
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

// Both encodings must treat special-token text the way the default engine
// does (PR #8 and PR #9): `count` counts it as ordinary text, `encode` throws
// on it unless it is allowed, and an allowed token becomes its id.
describe.each([
  ["llama4", llama4],
  ["gemma4", gemma4],
])("special tokens in %s", (_name, encoding) => {
  const tokenizer = new Tokenizer(encoding);
  const [token, id] = Object.entries(encoding.special_tokens)[0]!;
  const text = `a ${token} b`;
  const before = tokenizer.encode("a ", [], []);
  const after = tokenizer.encode(" b", [], []);

  test("encode throws by default", () => {
    expect(() => tokenizer.encode(text)).toThrow(
      `Text contains disallowed special token: ${token}`
    );
  });

  test("encode(text, 'all') and an allow list emit the id", () => {
    const expected = [...before, id, ...after];
    expect(tokenizer.encode(text, "all")).toEqual(expected);
    expect(tokenizer.encode(text, [token])).toEqual(expected);
  });

  test("an explicit disallow list throws even when allowed is empty", () => {
    expect(() => tokenizer.encode(text, [], [token])).toThrow(
      "disallowed special token"
    );
  });

  test("count treats the token as ordinary text", () => {
    const ordinary = tokenizer.encode(text, [], []);
    expect(tokenizer.count(text)).toBe(ordinary.length);
    expect(ordinary).not.toContain(id);
  });
});

describe("SentencePieceTokenizer extended special tokens", () => {
  const custom = { "<custom>": 300000 };
  const engine = new SentencePieceTokenizer(gemma4, custom);

  test("decode keeps a token outside the vocabulary", () => {
    const ids = engine.encode("a<custom>b", "all", []);
    expect(ids).toContain(300000);
    expect(engine.decode(ids)).toBe("a<custom>b");
  });

  test("Tokenizer refuses extended special tokens for a codec encoding", () => {
    expect(() => new Tokenizer(gemma4, custom)).toThrow(
      "gemma4 does not support special tokens"
    );
  });
});
