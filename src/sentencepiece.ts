/**
 * BPE tokenizer for SentencePiece-style vocabularies (Gemma 4, which Google
 * documents as the Gemini tokenizer).
 *
 * It reproduces the Hugging Face `tokenizers` BPE model exactly:
 * - the only normalization is " " -> "▁",
 * - there is no pre-tokenization, so one text is one word,
 * - a character missing from the vocabulary becomes its UTF-8 bytes as
 *   `<0xNN>` tokens,
 * - merges run in merge-list order (the merge index is the rank). Ties go to
 *   the leftmost position.
 *
 * A word can be a whole document, so the merge loop uses a heap and a
 * doubly linked symbol list. It runs in O(n log n), never O(n^2).
 */

/**
 * Encoding data format for {@link SentencePieceTokenizer}.
 */
export interface SentencePieceEncoding {
  name: string;
  special_tokens: Record<string, number>;
  /** Token text by id. A space is "▁" and a raw byte is "<0xNN>". */
  vocab: string[];
  /**
   * Base64 of the merge list in merge order. For `n` merges it holds nine
   * planes of `n` bytes: byte 0, 1 and 2 (little endian) of the left token
   * id, then the right token id, then the merged token id.
   */
  merges: string;
}

const SPACE_MARK_CODE_POINT = 0x2581;
const REPLACEMENT_CODE_POINT = 0xfffd;
// Merge index and position share one heap key: rank * 2^32 + position.
const KEY_RADIX = 4294967296;
const BYTE_TOKEN = /^<0x([0-9A-F]{2})>$/;

const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

function escapeRegex(str: string): string {
  return str.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function hashPair(left: number, right: number): number {
  let h = Math.imul(left ^ Math.imul(right, 0x85ebca6b), 0xc2b2ae35);
  h ^= h >>> 16;
  return h;
}

/**
 * Merge list as a hash table from a token pair to its merge index.
 */
class MergeTable {
  readonly left: Int32Array;
  readonly right: Int32Array;
  readonly merged: Int32Array;
  private readonly slots: Int32Array;
  private readonly mask: number;

  constructor(base64: string) {
    const bytes = decodeBase64(base64);
    if (bytes.length === 0 || bytes.length % 9 !== 0) {
      throw new Error("Invalid merge list: length is not a multiple of 9");
    }
    const count = bytes.length / 9;
    const readPlane = (plane: number): Int32Array => {
      const ids = new Int32Array(count);
      const base = plane * 3 * count;
      for (let i = 0; i < count; i++) {
        ids[i] =
          bytes[base + i]! |
          (bytes[base + count + i]! << 8) |
          (bytes[base + 2 * count + i]! << 16);
      }
      return ids;
    };
    this.left = readPlane(0);
    this.right = readPlane(1);
    this.merged = readPlane(2);

    let size = 1024;
    while (size < count * 2) size *= 2;
    this.mask = size - 1;
    this.slots = new Int32Array(size).fill(-1);
    for (let i = 0; i < count; i++) {
      let slot = hashPair(this.left[i]!, this.right[i]!) & this.mask;
      while (this.slots[slot] !== -1) slot = (slot + 1) & this.mask;
      this.slots[slot] = i;
    }
  }

  /** Merge index of the pair, or -1 when the pair never merges. */
  find(left: number, right: number): number {
    let slot = hashPair(left, right) & this.mask;
    for (;;) {
      const index = this.slots[slot]!;
      if (index === -1) return -1;
      if (this.left[index] === left && this.right[index] === right) {
        return index;
      }
      slot = (slot + 1) & this.mask;
    }
  }
}

/**
 * Min-heap of merge candidates. Keys are exact doubles below 2^53.
 */
class MergeHeap {
  private keys: Float64Array;
  size = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(Math.max(capacity, 16));
  }

  /** Append without restoring heap order. Call `heapify` afterwards. */
  append(key: number): void {
    if (this.size === this.keys.length) this.grow();
    this.keys[this.size++] = key;
  }

  heapify(): void {
    for (let i = (this.size >> 1) - 1; i >= 0; i--) this.siftDown(i);
  }

  push(key: number): void {
    if (this.size === this.keys.length) this.grow();
    const keys = this.keys;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! <= key) break;
      keys[i] = keys[parent]!;
      i = parent;
    }
    keys[i] = key;
  }

  pop(): number {
    const keys = this.keys;
    const top = keys[0]!;
    const last = keys[--this.size]!;
    if (this.size > 0) {
      keys[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private grow(): void {
    const next = new Float64Array(this.keys.length * 2);
    next.set(this.keys);
    this.keys = next;
  }

  private siftDown(start: number): void {
    const keys = this.keys;
    const size = this.size;
    const key = keys[start]!;
    let i = start;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= size) break;
      if (child + 1 < size && keys[child + 1]! < keys[child]!) child++;
      if (keys[child]! >= key) break;
      keys[i] = keys[child]!;
      i = child;
    }
    keys[i] = key;
  }
}

/**
 * Tokenizer for {@link SentencePieceEncoding} data. It has the same public
 * counting surface as the default `Tokenizer` class.
 */
export default class SentencePieceTokenizer {
  private readonly name: string;
  private readonly vocab: string[];
  private readonly merges: MergeTable;
  private readonly characterIds: Map<number, number>;
  private readonly byteIds: Int32Array;
  private readonly byteValues: Int16Array;
  private readonly specialTokens: Record<string, number>;
  private readonly specialTokenKeys: readonly string[];
  private readonly specialTokensRegex: RegExp | null;

  constructor(data: SentencePieceEncoding) {
    this.name = data.name;
    this.vocab = data.vocab;
    this.merges = new MergeTable(data.merges);

    this.characterIds = new Map();
    this.byteIds = new Int32Array(256).fill(-1);
    this.byteValues = new Int16Array(data.vocab.length).fill(-1);
    for (let id = 0; id < data.vocab.length; id++) {
      const piece = data.vocab[id]!;
      const codePoint = piece.codePointAt(0);
      if (codePoint === undefined) continue;
      if (piece.length === (codePoint > 0xffff ? 2 : 1)) {
        this.characterIds.set(codePoint, id);
      } else if (piece.length === 6) {
        const match = BYTE_TOKEN.exec(piece);
        if (match !== null) {
          const value = Number.parseInt(match[1]!, 16);
          this.byteIds[value] = id;
          this.byteValues[id] = value;
        }
      }
    }
    for (let value = 0; value < 256; value++) {
      if (this.byteIds[value] === -1) {
        throw new Error(`Encoding ${data.name} has no byte token for ${value}`);
      }
    }
    if (!this.characterIds.has(REPLACEMENT_CODE_POINT)) {
      throw new Error(`Encoding ${data.name} has no U+FFFD token`);
    }

    this.specialTokens = { ...data.special_tokens };
    // Longest first, so an alternation prefers the longest token.
    this.specialTokenKeys = Object.keys(this.specialTokens).sort(
      (a, b) => b.length - a.length
    );
    this.specialTokensRegex =
      this.specialTokenKeys.length > 0
        ? new RegExp(this.specialTokenKeys.map(escapeRegex).join("|"), "g")
        : null;
  }

  get encodingName(): string {
    return this.name;
  }

  /**
   * Encode text to token ids. The special token arguments follow
   * `Tokenizer.encode`: tokens in `allowedSpecial` become their id, and
   * `disallowedSpecial` throws when the text contains one of its tokens.
   */
  encode(
    text: string,
    allowedSpecial: Array<string> | "all" = [],
    disallowedSpecial: Array<string> | "all" = "all"
  ): number[] {
    const result: number[] = [];
    const allowedSet = new Set(
      allowedSpecial === "all" ? this.specialTokenKeys : allowedSpecial
    );
    const disallowed =
      disallowedSpecial === "all"
        ? this.specialTokenKeys.filter((token) => !allowedSet.has(token))
        : disallowedSpecial;
    for (const token of disallowed) {
      if (text.includes(token)) {
        throw new Error(`Text contains disallowed special token: ${token}`);
      }
    }

    const regex = this.specialTokensRegex;
    if (regex === null || allowedSet.size === 0) {
      this.encodeOrdinaryInto(text, result);
      return result;
    }

    let start = 0;
    while (start < text.length) {
      let next: RegExpExecArray | null;
      let searchFrom = start;
      for (;;) {
        regex.lastIndex = searchFrom;
        next = regex.exec(text);
        if (next === null || allowedSet.has(next[0])) break;
        searchFrom = next.index + 1;
      }
      const end = next === null ? text.length : next.index;
      this.encodeOrdinaryInto(text.substring(start, end), result);
      if (next === null) break;
      result.push(this.specialTokens[next[0]]!);
      start = next.index + next[0].length;
    }
    return result;
  }

  /**
   * Decode token ids to text. Byte tokens are joined and read as UTF-8.
   */
  decode(tokens: number[]): string {
    let result = "";
    let bytes: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const byteValue = this.byteValues[token];
      if (byteValue !== undefined && byteValue !== -1) {
        bytes.push(byteValue);
        continue;
      }
      const piece = this.vocab[token];
      if (piece === undefined) continue;
      if (bytes.length > 0) {
        result += textDecoder.decode(new Uint8Array(bytes));
        bytes = [];
      }
      result += piece.replace(/▁/g, " ");
    }
    if (bytes.length > 0) {
      result += textDecoder.decode(new Uint8Array(bytes));
    }
    return result;
  }

  /**
   * Count tokens in text. Special token text counts as ordinary text.
   */
  count(input: string): number {
    return this.encode(input, [], []).length;
  }

  private encodeOrdinaryInto(text: string, result: number[]): void {
    if (text.length === 0) return;
    const symbols = this.initialSymbols(text);
    const count = symbols.length;
    const merges = this.merges;
    const mergedIds = merges.merged;

    const prev = new Int32Array(count);
    const next = new Int32Array(count);
    const alive = new Uint8Array(count).fill(1);
    for (let i = 0; i < count; i++) {
      prev[i] = i - 1;
      next[i] = i + 1 < count ? i + 1 : -1;
    }

    const heap = new MergeHeap(count);
    for (let i = 0; i + 1 < count; i++) {
      const rank = merges.find(symbols[i]!, symbols[i + 1]!);
      if (rank !== -1) heap.append(rank * KEY_RADIX + i);
    }
    heap.heapify();

    while (heap.size > 0) {
      const key = heap.pop();
      const rank = Math.floor(key / KEY_RADIX);
      const pos = key - rank * KEY_RADIX;
      if (alive[pos] === 0) continue;
      const right = next[pos]!;
      if (right === -1) continue;
      // Skip a queue entry that went stale after its neighbours merged.
      const current = merges.find(symbols[pos]!, symbols[right]!);
      if (current === -1 || mergedIds[current] !== mergedIds[rank]) continue;

      symbols[pos] = mergedIds[rank]!;
      alive[right] = 0;
      const after = next[right]!;
      next[pos] = after;
      if (after !== -1) prev[after] = pos;

      const before = prev[pos]!;
      if (before !== -1) {
        const beforeRank = merges.find(symbols[before]!, symbols[pos]!);
        if (beforeRank !== -1) heap.push(beforeRank * KEY_RADIX + before);
      }
      if (after !== -1) {
        const afterRank = merges.find(symbols[pos]!, symbols[after]!);
        if (afterRank !== -1) heap.push(afterRank * KEY_RADIX + pos);
      }
    }

    for (let i = 0; i !== -1; i = next[i]!) result.push(symbols[i]!);
  }

  /**
   * One symbol per character after the space marker rule. A character the
   * vocabulary lacks becomes one symbol per UTF-8 byte.
   */
  private initialSymbols(text: string): Int32Array {
    const symbols: number[] = [];
    const length = text.length;
    for (let i = 0; i < length; i++) {
      let codePoint = text.charCodeAt(i);
      if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < length) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
          i++;
        }
      }
      // A lone surrogate becomes U+FFFD, as UTF-8 encoding would make it.
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        codePoint = REPLACEMENT_CODE_POINT;
      } else if (codePoint === 0x20) {
        codePoint = SPACE_MARK_CODE_POINT;
      }

      const id = this.characterIds.get(codePoint);
      if (id !== undefined) {
        symbols.push(id);
      } else if (codePoint < 0x80) {
        symbols.push(this.byteIds[codePoint]!);
      } else if (codePoint < 0x800) {
        symbols.push(this.byteIds[0xc0 | (codePoint >> 6)]!);
        symbols.push(this.byteIds[0x80 | (codePoint & 0x3f)]!);
      } else if (codePoint < 0x10000) {
        symbols.push(this.byteIds[0xe0 | (codePoint >> 12)]!);
        symbols.push(this.byteIds[0x80 | ((codePoint >> 6) & 0x3f)]!);
        symbols.push(this.byteIds[0x80 | (codePoint & 0x3f)]!);
      } else {
        symbols.push(this.byteIds[0xf0 | (codePoint >> 18)]!);
        symbols.push(this.byteIds[0x80 | ((codePoint >> 12) & 0x3f)]!);
        symbols.push(this.byteIds[0x80 | ((codePoint >> 6) & 0x3f)]!);
        symbols.push(this.byteIds[0x80 | (codePoint & 0x3f)]!);
      }
    }
    return Int32Array.from(symbols);
  }
}
