/**
 * Lazy tables for the encoding modules.
 *
 * An encoding module used to build its tables (an object with 200k keys, a
 * decoder with 200k entries) while it was imported, so importing the barrel
 * `ai-tokenizer/encoding` paid for every encoding. A module now embeds its
 * data as one string and exports stand-ins for the tables. A stand-in builds
 * the real table on first use. A module namespace cannot hold a getter, and
 * the tables are public exports, so a stand-in is a Proxy.
 *
 * The Proxy wraps the real table, which starts empty. The first operation on
 * the Proxy fills that table in place, then forwards to it. So freezing,
 * sealing or defining a property on a stand-in changes the real table, and
 * Node's and Bun's `console.log` print its content. `Tokenizer` calls
 * {@link resolve} to get the real table, so a lookup in its hot loop never
 * goes through the Proxy.
 *
 * A Proxy cannot be copied by `structuredClone` or `postMessage` in V8 or
 * JavaScriptCore, whatever its target holds. Copy `{ ...table }` (or
 * `[...table]` for an array) instead.
 */

// Symbol.for, so an ESM and a CJS copy of this package agree on the key.
const REAL = Symbol.for("ai-tokenizer.lazy");
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * A stand-in for `target`, which must be empty: an empty object, or an empty
 * array for a table that is an array, so that `Array.isArray` holds. `fill`
 * runs once, on the first operation, and puts the table's content in `target`.
 */
export function lazy<T extends object>(
  target: T,
  fill: (target: T) => void
): T {
  let filled = false;
  const ensure = (): T => {
    if (!filled) {
      fill(target);
      filled = true;
    }
    return target;
  };
  // Both runtimes print a Proxy by its target and ask the target, not the
  // Proxy, for this method. The copy keeps the Proxy out of the printout.
  Object.defineProperty(target, INSPECT, {
    value: () =>
      Array.isArray(ensure())
        ? (target as unknown[]).slice()
        : Object.assign(Object.create(null), target),
    configurable: true,
    writable: true,
  });
  return new Proxy(target, {
    get: (t, key) =>
      key === REAL ? ensure() : (ensure(), Reflect.get(t, key)),
    set: (t, key, value) => (ensure(), Reflect.set(t, key, value)),
    has: (t, key) => (ensure(), Reflect.has(t, key)),
    deleteProperty: (t, key) => (ensure(), Reflect.deleteProperty(t, key)),
    ownKeys: (t) => (ensure(), Reflect.ownKeys(t)),
    getOwnPropertyDescriptor: (t, key) => (
      ensure(),
      Reflect.getOwnPropertyDescriptor(t, key)
    ),
    defineProperty: (t, key, descriptor) => (
      ensure(),
      Reflect.defineProperty(t, key, descriptor)
    ),
    getPrototypeOf: (t) => (ensure(), Reflect.getPrototypeOf(t)),
    setPrototypeOf: (t, prototype) => (
      ensure(),
      Reflect.setPrototypeOf(t, prototype)
    ),
    isExtensible: (t) => (ensure(), Reflect.isExtensible(t)),
    preventExtensions: (t) => (ensure(), Reflect.preventExtensions(t)),
  });
}

/** A stand-in for the array `load` returns. */
export function lazyArray<T>(load: () => T[]): T[] {
  return lazy<T[]>([], (target) => {
    const items = load();
    for (let i = 0; i < items.length; i++) target[i] = items[i]!;
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

/** Puts each table of a BPE encoding in its empty target. */
const FILL: {
  [K in keyof BpeTables]: (target: BpeTables[K], data: BpeData) => void;
} = {
  stringEncoder(target, { tokens }) {
    for (let rank = 0; rank < tokens.length; rank++) {
      const text = tokens[rank]!;
      if (text !== null && text !== "") target[text] = rank;
    }
  },
  binaryEncoder(target, { binary }) {
    for (const [hex, rank] of binary) target.push([fromHex(hex), rank]);
  },
  decoder(target, { tokens, binary }) {
    for (let rank = 0; rank < tokens.length; rank++) {
      const text = tokens[rank]!;
      if (text !== null && text !== "") target[rank] = text;
    }
    for (const [hex, rank] of binary) target[rank] = fromHex(hex);
    // A rank without a token stays a hole, as it was in an object literal.
    (target as unknown as unknown[]).length = tokens.length;
  },
};

/** The tables of one JSON string, parsed once and shared. */
const parsed = new Map<string, { data: BpeData; unfilled: number }>();

/**
 * One table of a BPE encoding, from the JSON its module embeds. Nothing is
 * parsed until a table is read, and a table is filled when it is first read.
 *
 * Each table is a call of its own, so a bundler that sees the call is pure can
 * drop a table, and the JSON with it, when nothing uses the encoding.
 */
export function bpeTable<K extends keyof BpeTables>(
  json: string,
  key: K
): BpeTables[K] {
  // The string encoder has no prototype, so a token such as "constructor" or
  // "__proto__" is a plain key and a missing token reads as undefined.
  const target = (
    key === "stringEncoder" ? Object.create(null) : []
  ) as BpeTables[K];
  return lazy(target, (table) => {
    let entry = parsed.get(json);
    if (entry === undefined) {
      entry = { data: JSON.parse(json) as BpeData, unfilled: 3 };
      parsed.set(json, entry);
    }
    (FILL[key] as (table: BpeTables[K], data: BpeData) => void)(
      table,
      entry.data
    );
    if (--entry.unfilled === 0) parsed.delete(json);
  });
}
