/**
 * Tokenizer correctness tests
 * Validates against tiktoken and gpt-tokenizer
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import Tokenizer from "./tokenizer";
import * as o200k from "./encoding/o200k_base";
import * as cl100k from "./encoding/cl100k_base";
import { get_encoding, type Tiktoken } from "tiktoken";
import { encode as gptEncode, decode as gptDecode } from "gpt-tokenizer";

describe("correctness", () => {
  let tiktokenO200k: Tiktoken;
  let tiktokenCl100k: Tiktoken;
  const aiTokenizerO200k = new Tokenizer(o200k);
  const aiTokenizerCl100k = new Tokenizer(cl100k);

  beforeAll(() => {
    tiktokenO200k = get_encoding("o200k_base");
    tiktokenCl100k = get_encoding("cl100k_base");
  });

  afterAll(() => {
    try {
      tiktokenO200k.free();
      tiktokenCl100k.free();
    } catch {
      // Ignore cleanup errors
    }
  });

  const testCases = [
    // Basic cases
    { name: "empty string", text: "" },
    { name: "single char", text: "a" },
    { name: "simple word", text: "hello" },
    { name: "simple sentence", text: "Hello, world!" },

    // Unicode cases
    { name: "unicode - chinese", text: "你好世界" },
    { name: "unicode - japanese", text: "こんにちは世界" },
    { name: "unicode - emoji", text: "Hello 👋 🌍 🚀" },
    { name: "unicode - mixed", text: "Hello 世界! 🌍 Привет мир!" },
    { name: "unicode - arabic", text: "مرحبا بالعالم" },

    // Code cases
    {
      name: "code - typescript",
      text: "function hello(name: string): string { return `Hello, ${name}!`; }",
    },
    {
      name: "code - python",
      text: 'def hello(name: str) -> str:\n    return f"Hello, {name}!"',
    },
    {
      name: "code - json",
      text: '{"name": "John", "age": 30, "city": "New York"}',
    },

    // Edge cases
    { name: "whitespace", text: "   \n\t  \r\n  " },
    { name: "numbers", text: "123456789 3.14159 1e10" },
    { name: "special chars", text: "!@#$%^&*()_+-=[]{}|;':\",./<>?" },
    { name: "repeated chars", text: "aaaaabbbbcccc" },
    {
      name: "long text",
      text: "The quick brown fox jumps over the lazy dog. ".repeat(100),
    },

    // Real-world cases
    {
      name: "markdown",
      text: "# Title\n\n## Subtitle\n\n- Item 1\n- Item 2\n\n**Bold** and *italic*",
    },
    { name: "url", text: "https://example.com/path?query=value&other=123" },
    { name: "email", text: "user.name+tag@example.co.uk" },
  ];

  describe("vs tiktoken (o200k_base)", () => {
    test.each(testCases)("encode matches: $name", ({ text }) => {
      const aiTokens = aiTokenizerO200k.encode(text);
      const tikTokens = Array.from(tiktokenO200k.encode(text));

      expect(aiTokens).toEqual(tikTokens);
    });

    test.each(testCases)("decode matches: $name", ({ text }) => {
      const tikTokens = tiktokenO200k.encode(text);
      const aiDecoded = aiTokenizerO200k.decode(Array.from(tikTokens));
      const tikDecoded = new TextDecoder().decode(
        tiktokenO200k.decode(tikTokens)
      );

      expect(aiDecoded).toBe(tikDecoded);
      expect(aiDecoded).toBe(text);
    });

    test.each(testCases)("round-trip: $name", ({ text }) => {
      const tokens = aiTokenizerO200k.encode(text);
      const decoded = aiTokenizerO200k.decode(tokens);

      expect(decoded).toBe(text);
    });

    test.each(testCases)("token count matches: $name", ({ text }) => {
      const aiCount = aiTokenizerO200k.count(text);
      const tikCount = tiktokenO200k.encode(text).length;

      expect(aiCount).toBe(tikCount);
    });
  });

  describe("vs tiktoken (cl100k_base)", () => {
    const samples = [
      { name: "simple", text: "Hello, world!" },
      {
        name: "sentence",
        text: "The quick brown fox jumps over the lazy dog.",
      },
      { name: "unicode", text: "你好世界 Hello World 🌍" },
      { name: "code", text: "function test() { return 42; }" },
    ];

    test.each(samples)("encode matches: $name", ({ text }) => {
      const aiTokens = aiTokenizerCl100k.encode(text);
      const tikTokens = Array.from(tiktokenCl100k.encode(text));

      expect(aiTokens).toEqual(tikTokens);
    });

    test.each(samples)("decode matches: $name", ({ text }) => {
      const tikTokens = tiktokenCl100k.encode(text);
      const aiDecoded = aiTokenizerCl100k.decode(Array.from(tikTokens));
      const tikDecoded = new TextDecoder().decode(
        tiktokenCl100k.decode(tikTokens)
      );

      expect(aiDecoded).toBe(tikDecoded);
      expect(aiDecoded).toBe(text);
    });
  });

  describe("vs gpt-tokenizer", () => {
    test.each(testCases)("encode: $name", ({ text }) => {
      const aiTokens = aiTokenizerO200k.encode(text);
      const gptTokens = gptEncode(text);

      expect(aiTokens).toEqual(gptTokens);
    });

    test.each(testCases)("decode: $name", ({ text }) => {
      const tokens = gptEncode(text);
      const aiDecoded = aiTokenizerO200k.decode(tokens);
      const gptDecoded = gptDecode(tokens);

      expect(aiDecoded).toBe(gptDecoded);
    });
  });

  describe("edge cases", () => {
    test("handles very long text", () => {
      const longText = "Lorem ipsum dolor sit amet. ".repeat(10000);
      const aiTokens = aiTokenizerO200k.encode(longText);
      const gptTokens = gptEncode(longText);
      const tikTokens = Array.from(tiktokenO200k.encode(longText));

      expect(aiTokens).toEqual(gptTokens);
      expect(aiTokens).toEqual(tikTokens);
    });

    test("handles null bytes", () => {
      const textWithNull = "hello\x00world";
      const aiTokens = aiTokenizerO200k.encode(textWithNull);
      const gptTokens = gptEncode(textWithNull);
      const tikTokens = Array.from(tiktokenO200k.encode(textWithNull));

      expect(aiTokens).toEqual(gptTokens);
      expect(aiTokens).toEqual(tikTokens);
    });

    test("handles all printable ASCII", () => {
      let ascii = "";
      for (let i = 32; i < 127; i++) {
        ascii += String.fromCharCode(i);
      }

      const aiTokens = aiTokenizerO200k.encode(ascii);
      const tikTokens = Array.from(tiktokenO200k.encode(ascii));

      expect(aiTokens).toEqual(tikTokens);
    });

    test("handles mixed newlines", () => {
      const text = "line1\nline2\r\nline3\rline4";
      const aiTokens = aiTokenizerO200k.encode(text);
      const gptTokens = gptEncode(text);
      const tikTokens = Array.from(tiktokenO200k.encode(text));

      expect(aiTokens).toEqual(gptTokens);
      expect(aiTokens).toEqual(tikTokens);
    });

    test("cache doesn't affect correctness", () => {
      const text = "repeated text for cache test";

      const first = aiTokenizerO200k.encode(text);
      const second = aiTokenizerO200k.encode(text);
      const third = aiTokenizerO200k.encode(text);
      const gptTokens = gptEncode(text);

      expect(first).toEqual(gptTokens);
      expect(second).toEqual(gptTokens);
      expect(third).toEqual(gptTokens);
    });

    test("decode handles unknown tokens gracefully", () => {
      const maxToken = 200000;
      const tokens = [100, maxToken - 1];

      const decoded = aiTokenizerO200k.decode(tokens);
      expect(typeof decoded).toBe("string");
    });

    test("round-trip encoding/decoding", () => {
      const texts = [
        "Hello, world!",
        "你好世界 🌍",
        "Mixed 日本語 text with symbols: !@#$%",
        "function() { return 42; }",
      ];

      for (const text of texts) {
        const tokens = aiTokenizerO200k.encode(text);
        const decoded = aiTokenizerO200k.decode(tokens);
        expect(decoded).toBe(text);
      }
    });
  });
});

describe("merge cache", () => {
  // Seeded texts full of distinct non-vocabulary pieces (UUIDs, SHAs, long
  // numbers, base64) so a small cache evicts constantly.
  function makeTexts(count: number): string[] {
    let seed = 42;
    const rand = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed >>> 8;
    };
    const pick = (alphabet: string, length: number) => {
      let out = "";
      for (let i = 0; i < length; i++)
        out += alphabet[rand() % alphabet.length];
      return out;
    };
    const hex = "0123456789abcdef";
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const b64 =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const texts: string[] = [];
    for (let i = 0; i < count; i++) {
      const uuid = `${pick(hex, 8)}-${pick(hex, 4)}-${pick(hex, 4)}-${pick(hex, 4)}-${pick(hex, 12)}`;
      // Repeat some pieces so the small cache also serves hits.
      const repeat = texts.length > 0 ? texts[rand() % texts.length]! : "";
      texts.push(
        `id ${uuid} sha ${pick(hex, 40)} n=${pick("0123456789", 30)} ` +
          `${pick(b64, 24)}== ${pick(lower, 14)} ${repeat.slice(0, 20)}`
      );
    }
    return texts;
  }

  test("small cache matches an unbounded cache and stays bounded", () => {
    const small = new Tokenizer(o200k, undefined, 8);
    const unbounded = new Tokenizer(o200k, undefined, Infinity);
    const cache = (small as unknown as { mergeCache: Map<string, number[]> })
      .mergeCache;
    for (const text of makeTexts(500)) {
      expect(small.encode(text)).toEqual(unbounded.encode(text));
      expect(cache.size).toBeLessThanOrEqual(8);
    }
    expect(cache.size).toBe(8);
  });

  test("evicts in insertion order", () => {
    const tokenizer = new Tokenizer(o200k, undefined, 3);
    const cache = (
      tokenizer as unknown as {
        mergeCache: Map<string, number[]>;
      }
    ).mergeCache;
    for (const piece of ["qzxvw", "qzxvy", "qzxvz", "qzxvq"]) {
      tokenizer.encode(piece);
    }
    expect([...cache.keys()]).toEqual(["qzxvy", "qzxvz", "qzxvq"]);
  });
});
