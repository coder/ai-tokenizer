/**
 * The Claude count model behind the claude_v* encodings: the token catalog,
 * the min-cost tiling and the frame tail. Port of ctok's engine.py and
 * TokenizerModel in main.py.
 *
 * Token ids are synthetic (Anthropic does not publish its ids):
 *   [0, P)                   pieces[id]
 *   [P, P + 256)             the single byte id - P
 *   [P + 256, P + 256 + B)   bytePrefixes[id - P - 256]
 * Ties break as in ctok, so the ids follow ctok's tokenize() one to one.
 */
import type { Codec } from "../tokenizer";
import {
  BOW,
  CAPS,
  EOW,
  SHIFT,
  escapeLiteral,
  markText,
  unescapeLiteral,
  unmark,
  type StreamRules,
} from "./normalize";

/** One ctok family, as scripts/generate-claude-encodings.ts writes it. */
export interface ClaudeFamily extends StreamRules {
  readonly name: string;
  /** Newlines the frame adds to a content-final newline run before tiling. */
  readonly tailNewlines: number;
  /** The API drops trailing ASCII whitespace from the text before counting. */
  readonly trimTrailingWhitespace: boolean;
  /** Hex UTF-8 prefixes that cost one token on the byte floor. */
  readonly bytePrefixes: readonly string[];
  /** The cost-1 vocabulary in marker-glyph form, sorted by codepoints. */
  readonly pieces: readonly string[];
}

/** Reverse trie over codepoints. id is the piece that ends here, or -1. */
interface TrieNode {
  next: Map<number, TrieNode> | null;
  id: number;
}

interface Model {
  readonly root: ReadonlyMap<number, TrieNode>;
  /** The id of byte 0. */
  readonly byteBase: number;
  readonly prefixIds: ReadonlyMap<string, number>;
  readonly prefixBytes: readonly Uint8Array[];
  readonly maxPrefixBytes: number;
}

const BYTES = 256;
const NEWLINE = 0x0a;

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`claude codec: ${message}`);
}

// One model per vocabulary, built on first use and shared by every encoding
// and Tokenizer that reads it.
const models = new WeakMap<readonly string[], Model>();

export function createClaudeCodec(family: ClaudeFamily): Codec {
  const get = () => {
    let model = models.get(family.pieces);
    if (model === undefined) {
      model = buildModel(family);
      models.set(family.pieces, model);
    }
    return model;
  };
  return {
    encode: (text) => {
      if (family.trimTrailingWhitespace) text = trimTrailingWhitespace(text);
      // The API rejects empty content, so it has no count. Empty adds nothing.
      return text === "" ? [] : encode(get(), family, text);
    },
    decode: (tokens) => decode(get(), family, tokens),
  };
}

/** Python's str.rstrip(" \t\n\r\v\f"), with no regex to backtrack. */
function trimTrailingWhitespace(text: string): string {
  let end = text.length;
  while (end > 0) {
    const c = text.charCodeAt(end - 1);
    if (c !== 0x20 && (c < 0x09 || c > 0x0d)) break;
    end--;
  }
  return text.slice(0, end);
}

function buildModel(family: ClaudeFamily): Model {
  const root: TrieNode = { next: new Map(), id: -1 };
  family.pieces.forEach((piece, id) => {
    const cps = Array.from(piece, (c) => c.codePointAt(0)!);
    let node = root;
    for (let k = cps.length - 1; k >= 0; k--) {
      if (node.next === null) node.next = new Map();
      let child = node.next.get(cps[k]!);
      if (child === undefined) {
        child = { next: null, id: -1 };
        node.next.set(cps[k]!, child);
      }
      node = child;
    }
    assert(node.id === -1, `duplicate piece ${JSON.stringify(piece)}`);
    node.id = id;
  });
  const markers = [BOW, EOW, SHIFT, NEWLINE];
  if (family.allcapsMin !== null) markers.push(CAPS);
  for (const cp of markers) {
    assert(
      (root.next!.get(cp)?.id ?? -1) >= 0,
      `U+${cp.toString(16)} is not a piece`
    );
  }

  const byteBase = family.pieces.length;
  const prefixIds = new Map<string, number>();
  const prefixBytes: Uint8Array[] = [];
  let maxPrefixBytes = 1;
  family.bytePrefixes.forEach((hex, k) => {
    const bytes = Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
    assert(bytes.length >= 2 && !prefixIds.has(hex), `bad prefix ${hex}`);
    prefixIds.set(hex, byteBase + BYTES + k);
    prefixBytes.push(bytes);
    maxPrefixBytes = Math.max(maxPrefixBytes, bytes.length);
  });
  return { root: root.next!, byteBase, prefixIds, prefixBytes, maxPrefixBytes };
}

function encode(model: Model, family: ClaudeFamily, text: string): number[] {
  const { stream, tailNewlines } = markText(text, family);
  const ids = tile(model, stream);
  if (tailNewlines > 0) {
    // ctok frame_tail(): the frame pays for the last token of the run.
    const run = new Array<number>(tailNewlines + family.tailNewlines);
    const tail = tile(model, run.fill(NEWLINE));
    for (let k = 0; k < tail.length - 1; k++) ids.push(tail[k]!);
  }
  return ids;
}

/**
 * ctok min_vocab_tile() plus the span expansion of tile(). The one-codepoint
 * edge is a piece or the byte floor. Then the trie walks toward earlier
 * starts and replaces on a tie, so the longest final piece wins.
 */
function tile(model: Model, s: readonly number[]): number[] {
  const n = s.length;
  const best = new Int32Array(n + 1);
  const par = new Int32Array(n + 1);
  const edge = new Int32Array(n + 1);
  const floors = new Map<number, number[]>();
  const floor = (cp: number) => {
    let ids = floors.get(cp);
    if (ids === undefined) {
      ids = byteFloor(model, cp);
      floors.set(cp, ids);
    }
    return ids;
  };
  const root = model.root;
  for (let end = 1; end <= n; end++) {
    let node = root.get(s[end - 1]!);
    if (node !== undefined && node.id >= 0) {
      best[end] = best[end - 1]! + 1;
      edge[end] = node.id;
    } else {
      best[end] = best[end - 1]! + floor(s[end - 1]!).length;
      edge[end] = -1;
    }
    par[end] = end - 1;
    for (let start = end - 2; node !== undefined && start >= 0; start--) {
      node = node.next?.get(s[start]!);
      if (
        node !== undefined &&
        node.id >= 0 &&
        best[start]! + 1 <= best[end]!
      ) {
        best[end] = best[start]! + 1;
        par[end] = start;
        edge[end] = node.id;
      }
    }
  }
  const ids: number[] = [];
  for (let end = n; end > 0; end = par[end]!) {
    if (edge[end]! >= 0) ids.push(edge[end]!);
    else {
      const chunks = floor(s[end - 1]!);
      for (let k = chunks.length - 1; k >= 0; k--) ids.push(chunks[k]!);
    }
  }
  assert(ids.length === best[n], "tiling lost a token");
  return ids.reverse();
}

/**
 * ctok ByteFloor.chunks(): one codepoint that no piece covers, as a min-cost
 * tiling of its UTF-8 bytes. Starts ascend and replace only on strict
 * improvement, as in ctok min_tile().
 */
function byteFloor(model: Model, cp: number): number[] {
  assert(
    cp !== BOW && cp !== EOW && cp !== SHIFT && cp !== CAPS,
    "marker without a piece"
  );
  const bytes = utf8(unescapeLiteral(cp));
  const n = bytes.length;
  const best = [0, Infinity, Infinity, Infinity, Infinity];
  const par = [0, 0, 0, 0, 0];
  const hexOf = (j: number, i: number) => {
    let h = "";
    for (let k = j; k < i; k++) h += bytes[k]!.toString(16).padStart(2, "0");
    return h;
  };
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - model.maxPrefixBytes); j < i; j++) {
      const piece = i - j === 1 || model.prefixIds.has(hexOf(j, i));
      if (piece && best[j]! + 1 < best[i]!) {
        best[i] = best[j]! + 1;
        par[i] = j;
      }
    }
  }
  const ids: number[] = [];
  for (let i = n; i > 0; i = par[i]!) {
    const j = par[i]!;
    const id =
      i - j === 1
        ? model.byteBase + bytes[j]!
        : model.prefixIds.get(hexOf(j, i));
    assert(id !== undefined, "byte chunk without an id");
    ids.push(id);
  }
  return ids.reverse();
}

function utf8(cp: number): number[] {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) {
    return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  }
  return [
    0xf0 | (cp >> 18),
    0x80 | ((cp >> 12) & 0x3f),
    0x80 | ((cp >> 6) & 0x3f),
    0x80 | (cp & 0x3f),
  ];
}

const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Ids to normalized text. Lossy: see unmark(). */
function decode(model: Model, family: ClaudeFamily, tokens: number[]): string {
  const { byteBase } = model;
  const limit = byteBase + BYTES + model.prefixBytes.length;
  const stream: number[] = [];
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length === 0) return;
    for (const ch of utf8Decoder.decode(Uint8Array.from(bytes))) {
      // Bytes are text: a decoded marker codepoint is a literal, not a marker.
      stream.push(escapeLiteral(ch.codePointAt(0)!));
    }
    bytes = [];
  };
  for (const id of tokens) {
    if (!Number.isInteger(id) || id < 0 || id >= limit) {
      throw new RangeError(`${family.name}: unknown token id ${id}`);
    }
    if (id < byteBase) {
      flush();
      for (const ch of family.pieces[id]!) stream.push(ch.codePointAt(0)!);
    } else if (id < byteBase + BYTES) {
      bytes.push(id - byteBase);
    } else {
      bytes.push(...model.prefixBytes[id - byteBase - BYTES]!);
    }
  }
  flush();
  return unmark(stream);
}
