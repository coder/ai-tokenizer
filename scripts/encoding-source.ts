/**
 * Shared by the encoding generators: the strings an encoding module embeds,
 * and the source of a lazy BPE module.
 *
 * A generated module holds its tables as one string and builds them on first
 * use (src/lazy.ts), so importing the module does no work.
 */

import * as prettier from "prettier";
import type { BpeData } from "../src/lazy";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

/**
 * `value` as JSON inside a template literal without substitutions. The text is
 * ASCII, so the engine stores the source as one byte per character. A
 * template literal keeps the JSON's double quotes unescaped, and the bundler
 * leaves it as it is. A string literal would become `\"` at every quote.
 */
export function jsonTemplateLiteral(value: unknown): string {
  const json = JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  return `\`${json.replace(/[\\`$]/g, "\\$&")}\``;
}

/** The base64 that `decodeStrings` (src/lazy.ts) reads. */
export function encodeStrings(strings: readonly string[]): string {
  for (const text of strings) {
    if (text.includes("\0")) throw new Error("A string holds U+0000");
    if (/[\ud800-\udfff]/u.test(text))
      throw new Error("A string holds a lone surrogate");
  }
  return Buffer.from(strings.join("\0"), "utf-8").toString("base64");
}

/** Format generated source the way `bun run format` would. */
export async function formatSource(
  filepath: string,
  source: string
): Promise<string> {
  return prettier.format(source, {
    ...(await prettier.resolveConfig(filepath)),
    filepath,
  });
}

/** The string for bytes that are valid UTF-8 and survive a round trip. */
function bytesToString(bytes: Uint8Array): string | undefined {
  const text = textDecoder.decode(bytes);
  const again = textEncoder.encode(text);
  if (again.length !== bytes.length) return undefined;
  for (let i = 0; i < bytes.length; i++) {
    if (again[i] !== bytes[i]) return undefined;
  }
  return text;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const minLength = Math.min(a.length, b.length);
  for (let i = 0; i < minLength; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Token bytes by rank from the `bpe_ranks` text of a tiktoken JSON export:
 * "<count> <offset> <base64 token>..." lines, the tokens of a line having
 * consecutive ranks from the offset.
 */
export function tiktokenBytesByRank(
  bpeRanks: string
): Array<Uint8Array | undefined> {
  const bytesByRank: Array<Uint8Array | undefined> = [];
  for (const line of bpeRanks.split("\n")) {
    if (!line) continue;
    const [, offsetStr, ...tokens] = line.split(" ") as [
      string,
      string,
      ...string[],
    ];
    const offset = Number.parseInt(offsetStr, 10);
    tokens.forEach((token, i) => {
      if (bytesByRank[offset + i] !== undefined) {
        throw new Error(`Rank ${offset + i} appears twice`);
      }
      bytesByRank[offset + i] = new Uint8Array(Buffer.from(token, "base64"));
    });
  }
  return bytesByRank;
}

export interface BpeModuleSpec {
  /** Output file name without the extension, e.g. "o200k_base". */
  name: string;
  /** The generator's path, e.g. "scripts/generate-encodings.ts". */
  generator: string;
  /** Comment lines for the source of the data, in the header. */
  provenance?: string[];
  patStr: string;
  specialTokens: Record<string, number>;
  /** Annotate `special_tokens` as `Record<string, number>`. */
  annotateSpecialTokens?: boolean;
  /** Token bytes by rank. A rank without a token is undefined. */
  bytesByRank: ReadonlyArray<Uint8Array | undefined>;
}

export interface BpeStats {
  stringTokens: number;
  binaryTokens: number;
}

/** The data a BPE module embeds. Exported for tests. */
export function bpeData(bytesByRank: ReadonlyArray<Uint8Array | undefined>): {
  data: BpeData;
  stats: BpeStats;
} {
  const tokens: BpeData["tokens"] = [];
  const binary: Array<{ bytes: Uint8Array; rank: number }> = [];
  let stringTokens = 0;
  for (let rank = 0; rank < bytesByRank.length; rank++) {
    const bytes = bytesByRank[rank];
    if (bytes === undefined) {
      tokens.push(null);
      continue;
    }
    if (bytes.length === 0) throw new Error(`Rank ${rank} is an empty token`);
    const text = bytesToString(bytes);
    if (text === undefined) {
      tokens.push("");
      binary.push({ bytes, rank });
    } else {
      tokens.push(text);
      stringTokens++;
    }
  }
  // Binary search needs the pairs sorted by their bytes.
  binary.sort((a, b) => compareBytes(a.bytes, b.bytes));
  return {
    data: {
      tokens,
      binary: binary.map(({ bytes, rank }) => [hex(bytes), rank]),
    },
    stats: { stringTokens, binaryTokens: binary.length },
  };
}

export function bpeModuleSource(spec: BpeModuleSpec): string {
  const { data, stats } = bpeData(spec.bytesByRank);
  const total = stats.stringTokens + stats.binaryTokens;
  const specialType = spec.annotateSpecialTokens
    ? ": Record<string, number>"
    : "";
  return `/**
 * ${spec.name.toUpperCase()} encoding
 * Auto-generated by ${spec.generator} - DO NOT EDIT
 *
${(spec.provenance ?? []).map((line) => ` * ${line}\n`).join("")}${spec.provenance ? " *\n" : ""} * The tables are built from one JSON string on first use, not on import:
 * - String tokens: ${stats.stringTokens.toLocaleString("en-US")} (object lookup)
 * - Binary tokens: ${stats.binaryTokens.toLocaleString("en-US")} (binary search)
 * - Total tokens: ${total.toLocaleString("en-US")}
 * - Pattern: ${spec.patStr}
 * - Special tokens: ${Object.keys(spec.specialTokens).length.toLocaleString("en-US")}
 */
import { lazyBpeTables } from "../lazy";

export const name = ${JSON.stringify(spec.name)};

export const pat_str = ${JSON.stringify(spec.patStr)};

export const special_tokens${specialType} = ${JSON.stringify(spec.specialTokens, null, 2)};

const tables = lazyBpeTables(${jsonTemplateLiteral(data)});

// String-based encoder (UTF-8 tokens): token text to rank.
export const stringEncoder: Record<string, number> = tables.stringEncoder;

// Binary encoder (non-UTF-8 tokens), pre-sorted for binary search.
export const binaryEncoder: Array<[Uint8Array, number]> = tables.binaryEncoder;

// Decoder: rank to token text, or to bytes for a non-UTF-8 token.
export const decoder: Record<number, string | Uint8Array> = tables.decoder;
`;
}
