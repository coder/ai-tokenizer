/**
 * Synchronous RFC 1951 inflate for PDF FlateDecode streams, small enough to
 * ship to the browser. Best effort: a corrupt or truncated stream gives the
 * bytes decoded before the damage, and output stops at `maxOutput` bytes.
 */

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0,
];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

/** A Huffman code as a lookup table indexed by the next `bits` input bits. */
interface Huffman {
  /** `symbol << 4 | codeLength`; 0 marks a bit pattern no code starts with. */
  entries: Int32Array;
  bits: number;
}

class Stop extends Error {}
const STOP = new Stop();

function huffman(lengths: ArrayLike<number>): Huffman {
  const count = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) count[lengths[i]!]!++;
  count[0] = 0;
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left = (left << 1) - count[len]!;
    if (left < 0) throw STOP; // over-subscribed
  }
  let bits = 15;
  while (bits > 1 && count[bits] === 0) bits--;
  const next = new Uint16Array(16);
  for (let len = 1, code = 0; len < 16; len++) {
    code = (code + count[len - 1]!) << 1;
    next[len] = code;
  }
  const entries = new Int32Array(1 << bits);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const len = lengths[symbol]!;
    if (len === 0) continue;
    const code = next[len]!++;
    // Deflate packs Huffman codes most significant bit first into an LSB-first stream.
    let reversed = 0;
    for (let i = 0; i < len; i++)
      reversed |= ((code >> i) & 1) << (len - 1 - i);
    for (let i = reversed; i < entries.length; i += 1 << len) {
      entries[i] = (symbol << 4) | len;
    }
  }
  return { entries, bits };
}

let fixed: [Huffman, Huffman] | undefined;

function fixedCodes(): [Huffman, Huffman] {
  if (!fixed) {
    const lengths = new Uint8Array(288);
    lengths.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280);
    fixed = [huffman(lengths), huffman(new Uint8Array(30).fill(5))];
  }
  return fixed;
}

export function inflate(
  input: Uint8Array,
  maxOutput = 32 * 1024 * 1024
): Uint8Array {
  let pos = 0;
  // A zlib (RFC 1950) header, which PDF writers are meant to add and some omit.
  if (
    input.length >= 2 &&
    (input[0]! & 0x0f) === 8 &&
    ((input[0]! << 8) | input[1]!) % 31 === 0
  ) {
    pos = input[1]! & 0x20 ? 6 : 2;
  }
  let bitBuffer = 0;
  let bitCount = 0;
  let out = new Uint8Array(Math.min(maxOutput, 1024 + input.length * 4));
  let length = 0;

  const bits = (n: number): number => {
    while (bitCount < n) {
      if (pos >= input.length) throw STOP;
      bitBuffer |= input[pos++]! << bitCount;
      bitCount += 8;
    }
    const value = bitBuffer & ((1 << n) - 1);
    bitBuffer >>>= n;
    bitCount -= n;
    return value;
  };
  const decode = (code: Huffman): number => {
    while (bitCount < code.bits && pos < input.length) {
      bitBuffer |= input[pos++]! << bitCount;
      bitCount += 8;
    }
    const entry = code.entries[bitBuffer & ((1 << code.bits) - 1)]!;
    const len = entry & 15;
    if (len === 0 || len > bitCount) throw STOP;
    bitBuffer >>>= len;
    bitCount -= len;
    return entry >> 4;
  };
  const reserve = (n: number) => {
    if (length + n <= out.length) return;
    if (length + n > maxOutput) throw STOP;
    const grown = new Uint8Array(
      Math.min(maxOutput, Math.max(out.length * 2, length + n))
    );
    grown.set(out.subarray(0, length));
    out = grown;
  };

  try {
    let final = 0;
    while (!final) {
      final = bits(1);
      const type = bits(2);
      if (type === 0) {
        // `decode` reads ahead, so hand whole buffered bytes back to the input.
        pos -= bitCount >> 3;
        bitBuffer = 0;
        bitCount = 0;
        if (pos + 4 > input.length) throw STOP;
        const size = input[pos]! | (input[pos + 1]! << 8);
        if ((size ^ (input[pos + 2]! | (input[pos + 3]! << 8))) !== 0xffff) {
          throw STOP;
        }
        pos += 4;
        const available = Math.min(size, input.length - pos);
        reserve(available);
        out.set(input.subarray(pos, pos + available), length);
        length += available;
        pos += available;
        if (available < size) throw STOP;
        continue;
      }
      let literals: Huffman;
      let distances: Huffman;
      if (type === 1) {
        [literals, distances] = fixedCodes();
      } else if (type === 2) {
        const literalCount = bits(5) + 257;
        const distanceCount = bits(5) + 1;
        const codeLengthCount = bits(4) + 4;
        const codeLengths = new Uint8Array(19);
        for (let i = 0; i < codeLengthCount; i++) {
          codeLengths[CODE_LENGTH_ORDER[i]!] = bits(3);
        }
        const codeLengthCode = huffman(codeLengths);
        const lengths = new Uint8Array(literalCount + distanceCount);
        for (let i = 0; i < lengths.length; ) {
          const symbol = decode(codeLengthCode);
          if (symbol < 16) {
            lengths[i++] = symbol;
            continue;
          }
          let repeat: number;
          let value = 0;
          if (symbol === 16) {
            if (i === 0) throw STOP;
            value = lengths[i - 1]!;
            repeat = 3 + bits(2);
          } else {
            repeat = symbol === 17 ? 3 + bits(3) : 11 + bits(7);
          }
          if (i + repeat > lengths.length) throw STOP;
          lengths.fill(value, i, i + repeat);
          i += repeat;
        }
        if (lengths[256] === 0) throw STOP;
        literals = huffman(lengths.subarray(0, literalCount));
        distances = huffman(lengths.subarray(literalCount));
      } else {
        throw STOP;
      }
      for (;;) {
        const symbol = decode(literals);
        if (symbol < 256) {
          reserve(1);
          out[length++] = symbol;
          continue;
        }
        if (symbol === 256) break;
        const lengthSymbol = symbol - 257;
        if (lengthSymbol >= 29) throw STOP;
        const size =
          LENGTH_BASE[lengthSymbol]! + bits(LENGTH_EXTRA[lengthSymbol]!);
        const distanceSymbol = decode(distances);
        if (distanceSymbol >= 30) throw STOP;
        const distance =
          DISTANCE_BASE[distanceSymbol]! +
          bits(DISTANCE_EXTRA[distanceSymbol]!);
        if (distance > length) throw STOP;
        reserve(size);
        for (let i = 0; i < size; i++) {
          out[length] = out[length - distance]!;
          length++;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
  }
  return out.subarray(0, length);
}
