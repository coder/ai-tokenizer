import { afterAll, describe, expect, test } from "bun:test";
import Tokenizer from "./tokenizer";
import * as encoding from "./encoding";
import * as claude_v3 from "./encoding/claude_v3";
import * as claude_v4_7 from "./encoding/claude_v4_7";
import fixture from "./fixtures/claude-count-tokens.json";

const tokenizers = {
  claude_v3: new Tokenizer(claude_v3),
  claude_v4_7: new Tokenizer(claude_v4_7),
};
const names = Object.keys(tokenizers) as Array<keyof typeof tokenizers>;

describe("count_tokens parity", () => {
  let exact = 0;
  for (const name of names) {
    const frame = fixture.encodings[name].frame;
    for (const c of fixture.cases) {
      test(`${name}: ${c.name}`, () => {
        expect(tokenizers[name].count(c.text)).toBe(
          c.input_tokens[name] - frame
        );
        exact++;
      });
    }
  }
  afterAll(() => {
    const total = names.length * fixture.cases.length;
    console.log(`claude count_tokens fixture: ${exact}/${total} exact`);
  });
});

describe.each(names)("%s", (name) => {
  const tokenizer = tokenizers[name];
  const prose =
    'The quick brown fox jumps over the lazy dog. It\'s 9:30, and the NASA team said: "Ship it!"\nNew line, (parens) and a tab\there.';

  test("empty text has no tokens", () => {
    expect(tokenizer.encode("")).toEqual([]);
    expect(tokenizer.count("")).toBe(0);
  });

  test("count is the number of encoded ids", () => {
    for (const c of fixture.cases) {
      expect(tokenizer.encode(c.text).length).toBe(tokenizer.count(c.text));
    }
  });

  test("decode restores plain ASCII prose", () => {
    expect(tokenizer.decode(tokenizer.encode(prose))).toBe(prose);
  });

  test("decode rejects ids it did not produce", () => {
    expect(() => tokenizer.decode([-1])).toThrow(RangeError);
    expect(() => tokenizer.decode([1.5])).toThrow(RangeError);
    expect(() => tokenizer.decode([Number.MAX_SAFE_INTEGER])).toThrow(
      RangeError
    );
  });

  test("special-token options do not change ids", () => {
    expect(tokenizer.encode(prose, "all", [])).toEqual(tokenizer.encode(prose));
  });

  test("extended special tokens are rejected", () => {
    const encodingModule = name === "claude_v3" ? claude_v3 : claude_v4_7;
    expect(() => new Tokenizer(encodingModule, { "<|x|>": 1 })).toThrow();
    expect(new Tokenizer(encodingModule, {}).count("a")).toBe(1);
  });
});

describe.each(names)("%s combining marks", (name) => {
  const tokenizer = tokenizers[name];

  test("canonically equivalent mark orders encode the same", () => {
    for (const k of [1, 2, 5, 40]) {
      const sorted = "a" + "\u0316".repeat(k) + "\u0301".repeat(k);
      const reversed = "a" + "\u0301".repeat(k) + "\u0316".repeat(k);
      expect(tokenizer.encode(reversed)).toEqual(tokenizer.encode(sorted));
    }
  });

  test("random marks and starters encode as their NFC form", () => {
    // Marks of many classes (two astral), and codepoints that decompose into marks.
    const pool = Array.from(
      "ae\u0300\u0301\u0316\u0323\u0327\u0334\u0345\u05b0\u093c\u094d\u0f71\u0f72\u0f74" +
        "\u0344\u0340\u0f73\u0958\u1100\u1161\u11a8\u212b\u{1d165}\u{1d16d}\u{1d15e}\u{10a0d}"
    );
    let seed = 11;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    for (let i = 0; i < 3000; i++) {
      const text = Array.from(
        { length: 1 + rand(12) },
        () => pool[rand(pool.length)]!
      ).join("");
      expect(tokenizer.encode(text)).toEqual(
        tokenizer.encode(text.normalize("NFC"))
      );
    }
  });

  test("a long run of out-of-order marks takes linear time", () => {
    const text = "a" + "\u0301".repeat(32_768) + "\u0316".repeat(32_768);
    const start = performance.now();
    expect(tokenizer.count(text)).toBeGreaterThan(0);
    // Quadratic reordering took about 13 s here.
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

test("every encoding in the namespace builds a Tokenizer", () => {
  for (const key of Object.keys(encoding) as Array<keyof typeof encoding>) {
    const tokenizer = new Tokenizer(encoding[key]);
    expect(tokenizer.encodingName).toBe(key);
    expect(tokenizer.count("hello world")).toBeGreaterThan(0);
  }
});
