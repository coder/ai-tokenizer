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

/**
 * Ultra-optimized tokenizer for BPE encodings
 */
export default class Tokenizer {
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

  constructor(
    data: Encoding,
    extendedSpecialTokens?: Record<string, number>,
    mergeCacheSize: number = 100000
  ) {
    this.name = data.name;
    this.mergeCacheSize = mergeCacheSize;
    this.mergeCache = new Map();

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

    // Pre-compile pattern regex
    this.patternRegex = new RegExp(data.pat_str, "ug");

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
   * Add to LRU cache - simple approach matching gpt-tokenizer
   */
  private addToMergeCache(key: string, value: number[]): void {
    if (this.mergeCache.size >= this.mergeCacheSize) {
      // Remove least recently used (first key in Map)
      const firstKey = this.mergeCache.keys().next().value!;
      this.mergeCache.delete(firstKey);
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
    // Fast path: no special tokens to handle
    if (!this.hasSpecialTokens || allowedSpecial === "all") {
      return this.encodeOrdinary(text);
    }

    const result: number[] = [];
    const allowedSet = new Set(
      (allowedSpecial as any) === "all" ? this.specialTokenKeys : allowedSpecial
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
      if (direct !== undefined) return [direct];
    }

    const result: number[] = [];
    const regex = this.patternRegex;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = regex.exec(text)) !== null) {
      const piece = m[0];

      // Direct rank check (most common case)
      const directRank = this.stringRankEncoder[piece];
      if (directRank !== undefined) {
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
      if (directRank !== undefined) {
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
   * Count tokens in text
   */
  count(input: string): number {
    return this.encode(input).length;
  }
}

// Sentinel value for "no rank" - enables branchless comparisons
const NO_RANK = 0xffffffff;

// Shared instances (zero allocation after init)
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

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
 * Hyper-optimized BPE merge
 * Matches gpt-tokenizer's approach exactly but with our optimizations
 */
function bytePairMerge(
  piece: Uint8Array,
  stringRanks: Record<string, number>,
  binaryFirstByteIndex: Array<Array<[Uint8Array, number]> | null>
): number[] {
  const len = piece.length;

  // Ultra-fast inlined rank lookup
  const getRankForSlice = (slice: Uint8Array): number => {
    // Try string conversion (has inline ASCII fast path)
    const asString = tryBytesToString(slice);
    if (asString !== undefined) {
      const rank = stringRanks[asString];
      if (rank !== undefined) return rank;
    }

    // Binary search with first-byte index
    const bucket = binaryFirstByteIndex[slice[0]!]!;
    if (bucket !== null) {
      const rank = binarySearchBytes(bucket, slice);
      if (rank !== -1) return rank;
    }
    return NO_RANK;
  };

  const starts: number[] = [];
  const ranks: number[] = [];

  // Inline getRank helper
  const getRank = (
    startIndex: number,
    pairStart?: number,
    pairEnd?: number
  ): number => {
    if (pairStart === undefined) pairStart = starts[startIndex];
    if (pairEnd === undefined) pairEnd = starts[startIndex + 2];
    if (pairEnd === undefined) return NO_RANK;
    return getRankForSlice(piece.subarray(pairStart, pairEnd));
  };

  // Initialize starts and ranks
  for (let i = 0; i <= len; i++) {
    starts[i] = i;
    if (i < len - 1) {
      ranks[i] = getRank(i, i, i + 2);
    } else {
      ranks[i] = NO_RANK;
    }
  }

  // Main merge loop
  while (starts.length > 1) {
    let minRank = NO_RANK;
    let minIdx = -1;

    // Find minimum rank
    const ranksLen = ranks.length - 1;
    for (let i = 0; i < ranksLen; i++) {
      const rank = ranks[i]!;
      if (rank < minRank) {
        minRank = rank!;
        minIdx = i;
      }
    }

    if (minRank === NO_RANK || minIdx === -1) break;

    // Remove elements
    starts.splice(minIdx + 1, 1);
    ranks.splice(minIdx, 1);

    // Update ranks
    ranks[minIdx] = getRank(minIdx);
    if (minIdx > 0) {
      ranks[minIdx - 1] = getRank(minIdx - 1);
    }
  }

  // Build output
  const output: number[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const pairStart = starts[i];
    const pairEnd = starts[i + 1];
    const rank = getRankForSlice(piece.subarray(pairStart, pairEnd));
    if (rank !== NO_RANK) {
      output.push(rank);
    }
  }

  return output;
}
