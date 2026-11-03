/**
 * Ultra-optimized BPE tokenizer
 *
 * Optimizations applied:
 * - Pre-compiled regex patterns
 * - Shared TextEncoder/TextDecoder
 * - String-based encoding (no byte conversion for UTF-8)
 * - Binary search for non-UTF-8 tokens
 * - LRU merge cache for repeated encodings
 * - Sentinel values for branch elimination
 * - Cache-friendly rank updates
 * - Minimal allocations in hot paths
 * - ASCII fast path
 */

/**
 * Encoding data format (optimized)
 */
export interface Encoding {
  name: string;
  pat_str: string;
  special_tokens: Record<string, number>;
  stringEncoder: Record<string, number>;
  binaryEncoder: Array<[Uint8Array, number]>;
  decoder: Record<number, string | Uint8Array>;
}

/** An encoding that is not regex plus BPE brings its own algorithm. */
export interface Codec {
  encode(
    text: string,
    allowedSpecial?: Array<string> | "all",
    disallowedSpecial?: Array<string> | "all"
  ): number[];
  decode(tokens: number[]): string;
}

/** An encoding module with a `kind` brings its own codec. A BPE `Encoding` has none. */
export interface CodecEncoding {
  kind: string;
  name: string;
  codec: Codec;
}

/**
 * Ultra-optimized tokenizer for BPE encodings
 */
export default class Tokenizer {
  private readonly codec: Codec | null;
  private readonly name: string;
  private readonly patternRegex: RegExp;
  private readonly specialTokensRegex: RegExp | null;
  private readonly specialTokens: Record<string, number>;
  private readonly inverseSpecialTokens: Record<number, Uint8Array>;

  // Optimized dual storage (pre-built at generation time)
  private readonly stringRankEncoder: Record<string, number>;
  private readonly binaryRankEncoder: Array<[Uint8Array, number]>;
  private readonly decoder: Record<number, string | Uint8Array>;
  private readonly binaryFirstByteIndex: Array<Array<
    [Uint8Array, number]
  > | null>;

  private readonly specialTokenKeys: readonly string[];
  private readonly hasSpecialTokens: boolean;

  // Simple piece-level cache
  private readonly mergeCache: Map<string, number[]>;
  private readonly mergeCacheSize: number;
  // Insertion-ordered ring of cached keys for O(1) FIFO eviction.
  // Map#keys().next() is O(holes) in V8 once entries have been deleted.
  private readonly mergeCacheKeys: string[];
  private mergeCacheHead = 0;

  constructor(
    data: Encoding | CodecEncoding,
    extendedSpecialTokens?: Record<string, number>,
    mergeCacheSize: number = 100000
  ) {
    if (!(mergeCacheSize >= 0)) {
      throw new RangeError(`Invalid mergeCacheSize: ${mergeCacheSize}`);
    }
    this.codec = "kind" in data ? data.codec : null;
    if ("kind" in data) {
      if (Object.keys(extendedSpecialTokens ?? {}).length > 0) {
        throw new Error(`${data.name} does not support special tokens`);
      }
      // An inert BPE table, so the rest of the constructor stays as it is.
      data = {
        name: data.name,
        pat_str: "(?!)",
        special_tokens: {},
        stringEncoder: {},
        binaryEncoder: [],
        decoder: {},
      };
    }
    this.name = data.name;
    this.mergeCacheSize = mergeCacheSize;
    this.mergeCache = new Map();
    this.mergeCacheKeys = [];

    // Use pre-optimized storage directly (zero-cost initialization)
    this.stringRankEncoder = data.stringEncoder;
    this.binaryRankEncoder = data.binaryEncoder;
    this.decoder = data.decoder;
    // Build first-byte index to reduce binary search domain size
    const idx: Array<Array<[Uint8Array, number]> | null> = new Array(256).fill(
      null
    );
    for (let i = 0; i < this.binaryRankEncoder.length; i++) {
      const entry = this.binaryRankEncoder[i]!;
      const arr = entry[0];
      if (arr.length === 0) continue;
      const first = arr[0]!;
      let bucket = idx[first]!;
      if (bucket === null) {
        bucket = [];
        idx[first] = bucket;
      }
      bucket.push(entry);
    }
    this.binaryFirstByteIndex = idx;

    // tiktoken compiles pat_str with Rust's regex crate, where \s is Unicode
    // White_Space. JavaScript's \s also matches U+FEFF and misses U+0085.
    this.patternRegex = new RegExp(
      data.pat_str
        .replaceAll("\\s", "\\p{White_Space}")
        .replaceAll("\\S", "\\P{White_Space}"),
      "ug"
    );

    // Handle special tokens
    this.specialTokens = { ...data.special_tokens, ...extendedSpecialTokens };
    this.specialTokenKeys = Object.keys(this.specialTokens);
    this.hasSpecialTokens = this.specialTokenKeys.length > 0;

    // Pre-compile special tokens regex (only if needed)
    this.specialTokensRegex = this.hasSpecialTokens
      ? new RegExp(this.specialTokenKeys.map(escapeRegex).join("|"), "g")
      : null;

    // Pre-encode special tokens to Uint8Array
    this.inverseSpecialTokens = {};
    for (const [text, rank] of Object.entries(this.specialTokens)) {
      this.inverseSpecialTokens[rank] = textEncoder.encode(text);
    }
  }

  /**
   * Add to FIFO cache. Callers only add keys that just missed the cache, so
   * every key appears in the ring once and the ring's oldest key is always
   * the oldest live key.
   */
  private addToMergeCache(key: string, value: number[]): void {
    if (this.mergeCacheSize === 0) return;
    const keys = this.mergeCacheKeys;
    if (this.mergeCache.size >= this.mergeCacheSize && keys.length > 0) {
      // Full: the slot at head holds the oldest live key.
      const head = this.mergeCacheHead;
      this.mergeCache.delete(keys[head]!);
      keys[head] = key;
      this.mergeCacheHead = (head + 1) % keys.length;
    } else {
      keys.push(key);
    }
    this.mergeCache.set(key, value);
  }

  /**
   * Encode a string piece using BPE with caching
   */
  private bytePairEncode(input: string): number[] {
    // Check cache first (no LRU update on access for speed)
    const cached = this.mergeCache.get(input);
    if (cached !== undefined) {
      return cached;
    }

    // BPE encode (direct string lookup already done in calling loop)
    const bytes = textEncoder.encode(input);
    const result = bytePairMerge(
      bytes,
      this.stringRankEncoder,
      this.binaryFirstByteIndex
    );

    // Cache result
    this.addToMergeCache(input, result);

    return result;
  }

  /**
   * Get encoding name
   */
  get encodingName(): string {
    return this.name;
  }

  /**
   * Encode text to tokens (optimized hot path)
   */
  encode(
    text: string,
    allowedSpecial: Array<string> | "all" = [],
    disallowedSpecial: Array<string> | "all" = "all"
  ): number[] {
    if (this.codec !== null) {
      return this.codec.encode(text, allowedSpecial, disallowedSpecial);
    }
    // Fast path: no special tokens to handle
    if (!this.hasSpecialTokens) {
      return this.encodeOrdinary(text);
    }

    const result: number[] = [];
    const allowedSet = new Set(
      allowedSpecial === "all" ? this.specialTokenKeys : allowedSpecial
    );

    const disallowedSet = new Set(
      disallowedSpecial === "all"
        ? this.specialTokenKeys.filter((x) => !allowedSet.has(x))
        : disallowedSpecial
    );

    // Check for disallowed special tokens
    if (disallowedSet.size > 0) {
      const disallowedRegex = new RegExp(
        [...disallowedSet].map(escapeRegex).join("|"),
        "g"
      );
      const match = text.match(disallowedRegex);
      if (match) {
        throw new Error(`Text contains disallowed special token: ${match[0]}`);
      }
    }

    let start = 0;
    const specialRegex = this.specialTokensRegex!;

    while (start < text.length) {
      let nextSpecial: RegExpMatchArray | null = null;
      let startFind = start;

      // Find next allowed special token
      while (true) {
        specialRegex.lastIndex = startFind;
        nextSpecial = specialRegex.exec(text);
        if (!nextSpecial || allowedSet.has(nextSpecial[0])) break;
        startFind = nextSpecial.index! + 1;
      }

      const end = nextSpecial?.index ?? text.length;

      // Encode ordinary text between special tokens
      this.encodeOrdinaryInto(text.substring(start, end), result);

      if (!nextSpecial) break;

      // Add special token
      result.push(this.specialTokens[nextSpecial[0]]!);
      start = nextSpecial.index! + nextSpecial[0].length;
    }

    return result;
  }

  /**
   * Encode ordinary text (no special tokens) - ultra-optimized hot path
   */
  private encodeOrdinary(text: string): number[] {
    // Quick single-token check for very short text
    if (text.length < 10) {
      const direct = this.stringRankEncoder[text];
      if (typeof direct === "number") return [direct];
    }

    const result: number[] = [];
    const regex = this.patternRegex;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = regex.exec(text)) !== null) {
      const piece = m[0];

      // Direct rank check (most common case)
      const directRank = this.stringRankEncoder[piece];
      if (typeof directRank === "number") {
        result.push(directRank);
        continue;
      }

      // Cache check
      const cached = this.mergeCache.get(piece);
      if (cached !== undefined) {
        for (let i = 0; i < cached.length; i++) {
          result.push(cached[i]!);
        }
        continue;
      }

      // BPE encode
      const bytes = textEncoder.encode(piece);
      const tokens = bytePairMerge(
        bytes,
        this.stringRankEncoder,
        this.binaryFirstByteIndex
      );

      // Cache and add tokens
      this.addToMergeCache(piece, tokens);
      for (let i = 0; i < tokens.length; i++) {
        result.push(tokens[i]!);
      }
    }

    return result;
  }

  /**
   * Encode ordinary text into existing array (used by special token handling)
   */
  private encodeOrdinaryInto(text: string, result: number[]): void {
    const regex = this.patternRegex;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = regex.exec(text)) !== null) {
      const piece = m[0];

      // Direct rank check
      const directRank = this.stringRankEncoder[piece];
      if (typeof directRank === "number") {
        result.push(directRank);
        continue;
      }

      const tokens = this.bytePairEncode(piece);
      for (let i = 0; i < tokens.length; i++) {
        result.push(tokens[i]!);
      }
    }
  }

  /**
   * Decode tokens to text (optimized - handles strings directly)
   */
  decode(tokens: number[]): string {
    if (this.codec !== null) return this.codec.decode(tokens);
    let result = "";
    let byteBuffer: Uint8Array | null = null;
    let bufferSize = 0;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const value = this.decoder[token] ?? this.inverseSpecialTokens[token]!;

      if (value === undefined) continue;

      // If it's a string, flush buffer and append string directly
      if (typeof value === "string") {
        if (byteBuffer !== null) {
          result += textDecoder.decode(byteBuffer!.subarray(0, bufferSize));
          byteBuffer = null;
          bufferSize = 0;
        }
        result += value;
      } else {
        // It's a Uint8Array, accumulate in buffer
        if (byteBuffer === null) {
          byteBuffer = new Uint8Array(1024); // Start with reasonable size
        }

        // Expand buffer if needed
        if (bufferSize + value.length > byteBuffer.length) {
          const newBuffer: Uint8Array = new Uint8Array(
            Math.max(byteBuffer.length * 2, bufferSize + value.length)
          );
          newBuffer.set(byteBuffer.subarray(0, bufferSize));
          byteBuffer = newBuffer;
        }

        byteBuffer!.set(value, bufferSize);
        bufferSize += value.length;
      }
    }

    // Flush any remaining bytes
    if (byteBuffer !== null && bufferSize > 0) {
      result += textDecoder.decode(byteBuffer.subarray(0, bufferSize));
    }

    return result;
  }

  /**
   * Count tokens in text. Special-token text such as "<|endoftext|>" counts
   * as ordinary text, the way chat APIs count it in message content.
   */
  count(input: string): number {
    return this.encode(input, [], []).length;
  }
}

// Sentinel value for "no rank" - enables branchless comparisons
const NO_RANK = 0xffffffff;

// Shared instances (zero allocation after init)
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Fast UTF-8 validation without try/catch overhead
 * Based on gpt-tokenizer's implementation
 */
function isValidUTF8(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const byte1 = bytes[i];
    let numBytes = 0;
    let codePoint = 0;

    // Determine the number of bytes in the current UTF-8 character
    if (byte1! <= 0x7f) {
      numBytes = 1;
      codePoint = byte1!;
    } else if ((byte1! & 0xe0) === 0xc0) {
      numBytes = 2;
      codePoint = byte1! & 0x1f;
      if (byte1! <= 0xc1) return false; // Overlong encoding
    } else if ((byte1! & 0xf0) === 0xe0) {
      numBytes = 3;
      codePoint = byte1! & 0x0f;
    } else if ((byte1! & 0xf8) === 0xf0) {
      numBytes = 4;
      codePoint = byte1! & 0x07;
      if (byte1! > 0xf4) return false; // Code points above U+10FFFF
    } else {
      return false;
    }

    // Ensure there are enough continuation bytes
    if (i + numBytes > bytes.length) return false;

    // Process continuation bytes
    for (let j = 1; j < numBytes; j++) {
      const byte = bytes[i + j];
      if ((byte! & 0xc0) !== 0x80) return false;
      codePoint = (codePoint << 6) | (byte! & 0x3f);
    }

    // Check for overlong encodings
    if (numBytes === 2 && codePoint < 0x80) return false;
    if (numBytes === 3 && codePoint < 0x800) return false;
    if (numBytes === 4 && codePoint < 0x10000) return false;

    // Check for surrogate halves (U+D800 to U+DFFF)
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;

    // Check for code points above U+10FFFF
    if (codePoint > 0x10ffff) return false;

    i += numBytes;
  }
  return true;
}

/**
 * Try to convert bytes to UTF-8 string (optimized, no try/catch)
 */
function tryBytesToString(bytes: Uint8Array): string | undefined {
  if (!isValidUTF8(bytes)) {
    return undefined;
  }
  return textDecoder.decode(bytes);
}

/**
 * Binary search on sorted byte array pairs
 */
function binarySearchBytes(
  sortedArray: Array<[Uint8Array, number]>,
  key: Uint8Array
): number {
  let low = 0;
  let high = sortedArray.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const midKey = sortedArray[mid]![0];

    let cmp = 0;
    const maxLen = Math.min(midKey.length, key.length);

    for (let i = 0; i < maxLen; i++) {
      cmp = midKey[i]! - key[i]!;
      if (cmp !== 0) break;
    }

    if (cmp === 0) {
      cmp = midKey.length - key.length;
    }

    if (cmp === 0) {
      return sortedArray[mid]![1];
    }

    if (cmp < 0) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return -1;
}

/**
 * Escape regex special characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
}

/**
 * Byte pair merge in O(n log n) for a piece of n bytes.
 *
 * The parts form a linked list, and a min-heap of adjacent pairs ordered by
 * (rank, position) picks the next merge: the lowest rank first, the leftmost
 * pair among equal ranks. Exported for tests; not part of the public API.
 */
export function bytePairMerge(
  piece: Uint8Array,
  stringRanks: Record<string, number>,
  binaryFirstByteIndex: Array<Array<[Uint8Array, number]> | null>
): number[] {
  const n = piece.length;

  // Ultra-fast inlined rank lookup
  const getRankForSlice = (slice: Uint8Array): number => {
    // Try string conversion (has inline ASCII fast path)
    const asString = tryBytesToString(slice);
    if (asString !== undefined) {
      const rank = stringRanks[asString];
      if (typeof rank === "number") return rank;
    }

    // Binary search with first-byte index
    const bucket = binaryFirstByteIndex[slice[0]!]!;
    if (bucket !== null) {
      const rank = binarySearchBytes(bucket, slice);
      if (rank !== -1) return rank;
    }
    return NO_RANK;
  };

  const output: number[] = [];
  if (n === 0) return output;

  // A part is named by the index of its first byte. next[i] is where the part
  // after i starts (n for the last part), or -1 once i was merged into the part
  // on its left. partRank[i] is the rank of i's part if it was merged.
  const next = new Int32Array(n + 1);
  const prev = new Int32Array(n);
  const partRank = new Uint32Array(n).fill(NO_RANK);
  for (let i = 0; i < n; i++) {
    next[i] = i + 1;
    prev[i] = i - 1;
  }
  next[n] = -1;

  // Heap entry: merge the part at `pos` with the part after it; together they
  // span [pos, end). An entry is live while pos still has a right neighbour
  // whose own right edge is `end`. Every merge adds at most two entries and
  // removes one, so 2n slots are enough.
  const capacity = 2 * n;
  const heapRank = new Uint32Array(capacity);
  const heapPos = new Int32Array(capacity);
  const heapEnd = new Int32Array(capacity);
  let size = 0;

  const siftUp = (index: number): void => {
    const rank = heapRank[index]!;
    const pos = heapPos[index]!;
    const end = heapEnd[index]!;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const parentRank = heapRank[parent]!;
      if (
        parentRank < rank ||
        (parentRank === rank && heapPos[parent]! < pos)
      ) {
        break;
      }
      heapRank[index] = parentRank;
      heapPos[index] = heapPos[parent]!;
      heapEnd[index] = heapEnd[parent]!;
      index = parent;
    }
    heapRank[index] = rank;
    heapPos[index] = pos;
    heapEnd[index] = end;
  };

  // Typed arrays drop writes past their end, so check the bound here.
  const push = (rank: number, pos: number, end: number): void => {
    if (size >= capacity) throw new RangeError("bytePairMerge: heap is full");
    heapRank[size] = rank;
    heapPos[size] = pos;
    heapEnd[size] = end;
    siftUp(size++);
  };

  const siftDown = (index: number): void => {
    const rank = heapRank[index]!;
    const pos = heapPos[index]!;
    const end = heapEnd[index]!;
    const half = size >> 1;
    while (index < half) {
      let child = 2 * index + 1;
      const right = child + 1;
      if (
        right < size &&
        (heapRank[right]! < heapRank[child]! ||
          (heapRank[right] === heapRank[child] &&
            heapPos[right]! < heapPos[child]!))
      ) {
        child = right;
      }
      const childRank = heapRank[child]!;
      if (rank < childRank || (rank === childRank && pos < heapPos[child]!)) {
        break;
      }
      heapRank[index] = childRank;
      heapPos[index] = heapPos[child]!;
      heapEnd[index] = heapEnd[child]!;
      index = child;
    }
    heapRank[index] = rank;
    heapPos[index] = pos;
    heapEnd[index] = end;
  };

  // Only a pair whose rank is below NO_RANK can merge.
  for (let i = 0; i + 2 <= n; i++) {
    const rank = getRankForSlice(piece.subarray(i, i + 2));
    if (rank < NO_RANK) {
      heapRank[size] = rank;
      heapPos[size] = i;
      heapEnd[size] = i + 2;
      size++;
    }
  }
  for (let i = (size >> 1) - 1; i >= 0; i--) siftDown(i);

  while (size > 0) {
    const rank = heapRank[0]!;
    const pos = heapPos[0]!;
    const end = heapEnd[0]!;
    size--;
    if (size > 0) {
      heapRank[0] = heapRank[size]!;
      heapPos[0] = heapPos[size]!;
      heapEnd[0] = heapEnd[size]!;
      siftDown(0);
    }

    const right = next[pos]!;
    if (right < 0 || next[right] !== end) continue;

    next[pos] = end;
    next[right] = -1;
    partRank[pos] = rank;
    if (end < n) {
      prev[end] = pos;
      const afterEnd = next[end]!;
      const rankWithNext = getRankForSlice(piece.subarray(pos, afterEnd));
      if (rankWithNext < NO_RANK) push(rankWithNext, pos, afterEnd);
    }
    const left = prev[pos]!;
    if (left >= 0) {
      const rankWithLeft = getRankForSlice(piece.subarray(left, end));
      if (rankWithLeft < NO_RANK) push(rankWithLeft, left, end);
    }
  }

  for (let i = 0; i < n; i = next[i]!) {
    let rank = partRank[i]!;
    if (rank === NO_RANK) {
      rank = getRankForSlice(piece.subarray(i, i + 1));
    }
    if (rank !== NO_RANK) {
      output.push(rank);
    }
  }

  return output;
}
