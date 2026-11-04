import { describe, test, expect, spyOn } from "bun:test";
import { inspect } from "node:util";
import {
  decodeStrings,
  bpeTable,
  lazy,
  lazyArray,
  resolve,
  type BpeData,
} from "./lazy";
import { encodeStrings } from "../scripts/encoding-source";
import Tokenizer, { type Encoding } from "./tokenizer";

describe("lazy", () => {
  const stand = (loads: { count: number } = { count: 0 }) =>
    lazy<Record<string, number>>(Object.create(null), (target) => {
      loads.count++;
      Object.assign(target, { a: 1, b: 2 });
    });

  test("fills nothing until the first operation, then fills once", () => {
    const loads = { count: 0 };
    const table = stand(loads);
    expect(loads.count).toBe(0);
    expect(table["a"]).toBe(1);
    expect("b" in table).toBe(true);
    expect(Object.keys(table)).toEqual(["a", "b"]);
    expect(loads.count).toBe(1);
  });

  test("an object stand-in reads like the object", () => {
    const table = stand();
    expect(JSON.stringify(table)).toBe('{"a":1,"b":2}');
    expect({ ...table }).toEqual({ a: 1, b: 2 });
    expect(Object.entries(table)).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    table["z"] = 3;
    delete table["a"];
    expect({ ...resolve(table) }).toEqual({ b: 2, z: 3 });
  });

  test("an array stand-in reads like the array", () => {
    const table = lazyArray(() => [10, 20, 30]);
    expect(Array.isArray(table)).toBe(true);
    expect(table.length).toBe(3);
    expect(Object.keys(table)).toEqual(["0", "1", "2"]);
    expect([...table]).toEqual([10, 20, 30]);
    expect(table.map((n) => n / 10)).toEqual([1, 2, 3]);
    expect(JSON.stringify(table)).toBe("[10,20,30]");
  });

  test("resolve returns the real table, and any other value unchanged", () => {
    const table = stand();
    const real = resolve(table);
    expect(real).not.toBe(table);
    expect(real).toEqual(Object.assign(Object.create(null), { a: 1, b: 2 }));
    expect(resolve(real)).toBe(real);
    const plain = { a: 1 };
    expect(resolve(plain)).toBe(plain);
    expect(resolve(null)).toBeNull();
    expect(resolve(undefined)).toBeUndefined();
    expect(resolve(5)).toBe(5);
  });

  // A Proxy over an empty placeholder cannot report a frozen or sealed state,
  // because the invariants are checked against its target.
  test("freeze, seal and preventExtensions act on the filled table", () => {
    const frozen = stand();
    Object.freeze(frozen);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen["a"]).toBe(1);
    expect(Object.keys(frozen)).toEqual(["a", "b"]);
    expect(Object.isFrozen(resolve(frozen))).toBe(true);

    const sealed = lazyArray(() => [1, 2]);
    Object.seal(sealed);
    expect(Object.isSealed(sealed)).toBe(true);
    expect([...sealed]).toEqual([1, 2]);

    const fixed = stand();
    Object.preventExtensions(fixed);
    expect(Object.isExtensible(fixed)).toBe(false);
    expect(fixed["b"]).toBe(2);
  });

  test("defineProperty defines on the filled table", () => {
    const table = stand();
    Object.defineProperty(table, "z", {
      value: 9,
      enumerable: true,
      configurable: false,
    });
    expect(table["z"]).toBe(9);
    expect(Object.keys(table)).toEqual(["a", "b", "z"]);
    expect(Object.getOwnPropertyDescriptor(table, "z")?.configurable).toBe(
      false
    );
  });

  test("printing shows the content, before and after the first read", () => {
    expect(inspect(stand())).toContain("a: 1");
    expect(inspect(lazyArray(() => [7, 8]))).toBe("[ 7, 8 ]");
    const read = stand();
    void read["a"];
    expect(inspect(read)).toContain("b: 2");
  });

  test("a spread copy survives structuredClone, the stand-in does not", () => {
    // V8 and JavaScriptCore refuse every Proxy, whatever its target holds.
    expect(() => structuredClone(stand())).toThrow();
    expect(structuredClone({ ...stand() })).toEqual({ a: 1, b: 2 });
    expect(structuredClone([...lazyArray(() => [1, 2])])).toEqual([1, 2]);
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
