/**
 * Lazy tables for the encoding modules.
 *
 * An encoding module used to build its tables (an object with 200k keys, a
 * decoder with 200k entries) while it was imported, so importing the barrel
 * `ai-tokenizer/encoding` paid for every encoding. A module now embeds its
 * data as one string and exports stand-ins for the tables. A stand-in builds
 * the real table on first use. A module namespace cannot hold a getter, and
 * the tables are public exports, so a stand-in is a Proxy that forwards to the
 * real table.
 *
 * `Tokenizer` calls {@link resolve} to get the real table, so a lookup in its
 * hot loop never goes through the Proxy.
 */

// Symbol.for, so an ESM and a CJS copy of this package agree on the key.
const REAL = Symbol.for("ai-tokenizer.lazy");

/**
 * A stand-in for the table `load` returns. `placeholder` must be an empty
 * object, or an empty array when the table is an array, so that
 * `Array.isArray` and the Proxy invariants hold. `load` runs once.
 */
export function lazy<T extends object>(placeholder: T, load: () => T): T {
  let real: T | undefined;
  const get = (): T => (real ??= load());
  return new Proxy(placeholder, {
    get: (_, key) => (key === REAL ? get() : Reflect.get(get(), key)),
    has: (_, key) => Reflect.has(get(), key),
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor: (_, key) =>
      Reflect.getOwnPropertyDescriptor(get(), key),
    getPrototypeOf: () => Reflect.getPrototypeOf(get()),
    set: (_, key, value) => Reflect.set(get(), key, value),
    deleteProperty: (_, key) => Reflect.deleteProperty(get(), key),
  });
}

/** The real table behind a stand-in, or `value` itself when it is no stand-in. */
export function resolve<T>(value: T): T {
  return ((value as any)?.[REAL] as T | undefined) ?? value;
}

const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Strings stored as base64 of their UTF-8 text joined by U+0000. `atob` and a
 * split read them faster than JSON.parse reads a list of strings with escapes,
 * and the source holds each non-ASCII character in 3 bytes, not 6.
 */
export function decodeStrings(base64: string): string[] {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return utf8.decode(bytes).split("\0");
}

/** What a generated BPE module embeds, as JSON. */
export interface BpeData {
  /**
   * Token text by rank. `""` marks a token that is not valid UTF-8 (it is in
   * `binary`) and `null` a rank no token has.
   */
  tokens: Array<string | null>;
  /** Tokens that are not valid UTF-8 as [hex bytes, rank], sorted by bytes. */
  binary: Array<[string, number]>;
}

export interface BpeTables {
  stringEncoder: Record<string, number>;
  binaryEncoder: Array<[Uint8Array, number]>;
  decoder: Record<number, string | Uint8Array>;
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return bytes;
}

export function buildBpeTables({ tokens, binary }: BpeData): BpeTables {
  // No prototype, so a token such as "constructor" or "__proto__" is a plain
  // key and a missing token reads as undefined.
  const stringEncoder: Record<string, number> = Object.create(null);
  // The parsed token list becomes the decoder, to hold the strings once.
  const decoder = tokens as Array<string | Uint8Array | undefined | null>;
  for (let rank = 0; rank < tokens.length; rank++) {
    const text = tokens[rank]!;
    if (text === null) delete decoder[rank];
    else if (text !== "") stringEncoder[text] = rank;
  }
  const binaryEncoder = binary.map(([hex, rank]): [Uint8Array, number] => {
    const bytes = fromHex(hex);
    decoder[rank] = bytes;
    return [bytes, rank];
  });
  return {
    stringEncoder,
    binaryEncoder,
    decoder: decoder as BpeTables["decoder"],
  };
}

// One build per JSON string, shared by the three tables of a module.
const built = new Map<string, BpeTables>();

/**
 * One table of a BPE encoding, from the JSON its module embeds. Nothing is
 * parsed until a table is read, and the first read builds all three.
 *
 * Each table is a call of its own, so a bundler that sees the call is pure can
 * drop a table, and the JSON with it, when nothing uses the encoding.
 */
export function bpeTable<K extends keyof BpeTables>(
  json: string,
  key: K
): BpeTables[K] {
  const placeholder = (key === "stringEncoder" ? {} : []) as BpeTables[K];
  return lazy(placeholder, () => {
    let tables = built.get(json);
    if (tables === undefined) {
      tables = buildBpeTables(JSON.parse(json) as BpeData);
      built.set(json, tables);
    }
    return tables[key];
  });
}
