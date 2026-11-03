import { describe, test, expect, spyOn } from "bun:test";
import {
  decodeStrings,
  bpeTable,
  buildBpeTables,
  lazy,
  resolve,
  type BpeData,
} from "./lazy";
import { encodeStrings } from "../scripts/encoding-source";
import Tokenizer, { type Encoding } from "./tokenizer";

describe("lazy", () => {
  test("builds nothing until a read, then builds once", () => {
    let loads = 0;
    const table = lazy<Record<string, number>>({}, () => {
      loads++;
      return { a: 1, b: 2 };
    });
    expect(loads).toBe(0);
    expect(table["a"]).toBe(1);
    expect("b" in table).toBe(true);
    expect(Object.keys(table)).toEqual(["a", "b"]);
    expect(loads).toBe(1);
  });

  test("an object stand-in reads like the object", () => {
    const real: Record<string, number> = { x: 1, y: 2 };
    const table = lazy<Record<string, number>>({}, () => real);
    expect(JSON.stringify(table)).toBe(JSON.stringify(real));
    expect({ ...table }).toEqual(real);
    expect(Object.entries(table)).toEqual([
      ["x", 1],
      ["y", 2],
    ]);
    table["z"] = 3;
    delete table["x"];
    expect(real).toEqual({ y: 2, z: 3 });
  });

  test("an array stand-in reads like the array", () => {
    const real = [10, 20, 30];
    const table = lazy<number[]>([], () => real);
    expect(Array.isArray(table)).toBe(true);
    expect(table.length).toBe(3);
    expect(Object.keys(table)).toEqual(["0", "1", "2"]);
    expect([...table]).toEqual(real);
    expect(table.map((n) => n / 10)).toEqual([1, 2, 3]);
    expect(JSON.stringify(table)).toBe("[10,20,30]");
  });

  test("resolve returns the real table, and any other value unchanged", () => {
    const real = { a: 1 };
    const table = lazy<Record<string, number>>({}, () => real);
    expect(resolve(table)).toBe(real);
    const plain = { a: 1 };
    expect(resolve(plain)).toBe(plain);
    expect(resolve(null)).toBeNull();
    expect(resolve(undefined)).toBeUndefined();
    expect(resolve(5)).toBe(5);
  });
});

describe("decodeStrings", () => {
  test("reads what encodeStrings writes", () => {
    const strings = [
      "\ufeffbom",
      "▁the",
      "😀 astral",
      "\n\r\t",
      "",
      "a",
      "<0x0A>",
    ];
    expect(decodeStrings(encodeStrings(strings))).toEqual(strings);
  });

  test("encodeStrings refuses a string it could not read back", () => {
    expect(() => encodeStrings(["a\0b"])).toThrow();
    expect(() => encodeStrings(["\ud800"])).toThrow();
  });
});

// "" marks a byte token, null a rank no token has.
const data: BpeData = {
  tokens: [null, "a", "b", "ab", "", "constructor", "__proto__"],
  binary: [["ff", 4]],
};

describe("bpeTable", () => {
  const json = JSON.stringify(data);
  const tables = () => ({
    stringEncoder: bpeTable(json, "stringEncoder"),
    binaryEncoder: bpeTable(json, "binaryEncoder"),
    decoder: bpeTable(json, "decoder"),
  });

  test("parses its JSON once, on the first read of any table", () => {
    const text = JSON.stringify({ tokens: ["x", "y"], binary: [] });
    const parse = spyOn(JSON, "parse");
    try {
      const encoder = bpeTable(text, "stringEncoder");
      const decoder = bpeTable(text, "decoder");
      expect(parse).not.toHaveBeenCalledWith(text);
      void encoder["x"];
      void decoder[0];
      expect(parse.mock.calls.filter(([arg]) => arg === text)).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
  });

  test("builds the three tables from the token list", () => {
    const { stringEncoder, binaryEncoder, decoder } = tables();
    expect(stringEncoder["ab"]).toBe(3);
    expect(decoder[3]).toBe("ab");
    expect(decoder[4]).toEqual(new Uint8Array([0xff]));
    expect(binaryEncoder).toEqual([[new Uint8Array([0xff]), 4]]);
    expect(decoder[0]).toBeUndefined();
    expect(0 in decoder).toBe(false);
    expect(decoder[99]).toBeUndefined();
  });

  test("a token named like an Object.prototype member is a plain key", () => {
    const { stringEncoder } = tables();
    expect(stringEncoder["constructor"]).toBe(5);
    expect(stringEncoder["__proto__"]).toBe(6);
    expect(stringEncoder["toString"]).toBeUndefined();
    expect(stringEncoder["hasOwnProperty"]).toBeUndefined();
  });

  test("a Tokenizer on stand-in tables equals one on literal tables", () => {
    const tokens = ["a", "b", "c", "ab", "bc", " ", "abc"];
    const literal: Encoding = {
      name: "tiny",
      pat_str: "\\S+| +",
      special_tokens: {},
      stringEncoder: Object.fromEntries(tokens.map((t, rank) => [t, rank])),
      binaryEncoder: [],
      decoder: { ...tokens },
    };
    const text = JSON.stringify({ tokens, binary: [] } satisfies BpeData);
    const standIn: Encoding = {
      ...literal,
      stringEncoder: bpeTable(text, "stringEncoder"),
      binaryEncoder: bpeTable(text, "binaryEncoder"),
      decoder: bpeTable(text, "decoder"),
    };
    const input = "abc ab bc cab";
    const expected = new Tokenizer(literal).encode(input);
    const tokenizer = new Tokenizer(standIn);
    expect(tokenizer.encode(input)).toEqual(expected);
    expect(tokenizer.decode(expected)).toBe(input);
    // The hot loop must read the real table, not go through the Proxy.
    expect((tokenizer as any).stringRankEncoder).toBe(
      resolve(standIn.stringEncoder)
    );
  });
});
