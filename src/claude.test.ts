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

test("every encoding in the namespace builds a Tokenizer", () => {
  for (const key of Object.keys(encoding) as Array<keyof typeof encoding>) {
    const tokenizer = new Tokenizer(encoding[key]);
    expect(tokenizer.encodingName).toBe(key);
    expect(tokenizer.count("hello world")).toBeGreaterThan(0);
  }
});
