// A second, deliberately naive implementation of tiktoken's encode. It shares
// no code with src/tokenizer.ts, so the check can compare the two on the
// encodings tiktoken does not ship (claude).
import type { Encoding } from "../../../src/tokenizer";

const utf8 = new TextEncoder();

// tiktoken compiles pat_str with Rust's regex crate, where \s is Unicode
// White_Space. JavaScript's \s also matches U+FEFF and misses U+0085.
const WHITE_SPACE =
  "\\t\\n\\v\\f\\r \\x85\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";

function rustPattern(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const next = pattern[++i]!;
      if (next === "s") out += inClass ? WHITE_SPACE : `[${WHITE_SPACE}]`;
      else if (next === "S" && !inClass) out += `[^${WHITE_SPACE}]`;
      else if (next === "S") throw new Error("\\S inside a class");
      else out += c + next;
      continue;
    }
    if (c === "[") inClass = true;
    if (c === "]") inClass = false;
    out += c;
  }
  return out;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

export class ReferenceEncoder {
  private readonly ranks = new Map<string, number>();
  private readonly pattern: RegExp;
  private readonly special: Map<string, number>;

  constructor(data: Encoding) {
    for (const [text, rank] of Object.entries(data.stringEncoder)) {
      this.ranks.set(latin1(utf8.encode(text)), rank);
    }
    for (const [bytes, rank] of data.binaryEncoder) {
      this.ranks.set(latin1(bytes), rank);
    }
    this.pattern = new RegExp(rustPattern(data.pat_str), "gu");
    this.special = new Map(Object.entries(data.special_tokens));
  }

  get specialTokens(): string[] {
    return [...this.special.keys()];
  }

  encode(
    text: string,
    allowedSpecial: string[] | "all" = [],
    disallowedSpecial: string[] | "all" = "all"
  ): number[] {
    const allowed =
      allowedSpecial === "all" ? this.specialTokens : allowedSpecial;
    const disallowed =
      disallowedSpecial === "all"
        ? this.specialTokens.filter((t) => !allowed.includes(t))
        : disallowedSpecial;
    for (const token of disallowed) {
      if (text.includes(token)) {
        throw new Error(`disallowed special token: ${token}`);
      }
    }

    const out: number[] = [];
    let ordinaryStart = 0;
    let i = 0;
    while (i < text.length) {
      const token = this.longestAllowedAt(text, i, allowed);
      if (token === undefined) {
        i++;
        continue;
      }
      this.encodeOrdinary(text.slice(ordinaryStart, i), out);
      out.push(this.special.get(token)!);
      i += token.length;
      ordinaryStart = i;
    }
    this.encodeOrdinary(text.slice(ordinaryStart), out);
    return out;
  }

  private longestAllowedAt(
    text: string,
    at: number,
    allowed: string[]
  ): string | undefined {
    let best: string | undefined;
    for (const token of allowed) {
      if (!this.special.has(token)) continue;
      if (!text.startsWith(token, at)) continue;
      if (best === undefined || token.length > best.length) best = token;
    }
    return best;
  }

  private encodeOrdinary(text: string, out: number[]): void {
    for (const match of text.matchAll(this.pattern)) {
      const parts = [...utf8.encode(match[0])].map((b) =>
        String.fromCharCode(b)
      );
      // Merge the lowest-ranked adjacent pair, leftmost on ties, until no
      // adjacent pair is a token.
      while (parts.length > 1) {
        let best = -1;
        let bestRank = Infinity;
        for (let j = 0; j + 1 < parts.length; j++) {
          const rank = this.ranks.get(parts[j]! + parts[j + 1]!);
          if (rank !== undefined && rank < bestRank) {
            best = j;
            bestRank = rank;
          }
        }
        if (best === -1) break;
        parts.splice(best, 2, parts[best]! + parts[best + 1]!);
      }
      for (const part of parts) {
        const rank = this.ranks.get(part);
        if (rank === undefined) {
          throw new Error(`no token for bytes ${JSON.stringify(part)}`);
        }
        out.push(rank);
      }
    }
  }
}
