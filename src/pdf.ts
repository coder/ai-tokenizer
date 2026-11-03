/**
 * A small, tolerant PDF reader: the page sizes a renderer shows and the text
 * layer of each page, which is what providers price a PDF by. Pure
 * TypeScript without Node APIs, so it runs in a browser too.
 */
import { inflate } from "./inflate";

export interface PdfPage {
  /** Points, after the CropBox and /Rotate are applied. */
  width: number;
  height: number;
  /** Lines in content order, joined with "\n"; runs of spaces collapsed. */
  text: string;
}

const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_OPERATIONS = 4_000_000;
const MAX_NESTING = 64;
const MAX_FETCH_DEPTH = 64;
const MAX_FORM_DEPTH = 8;
const STREAM_USE = 64;
const FONT_COST = 1024;
const MAX_FONTS = 64;
const MAX_OBJECTS = 100_000;
const MAX_PAGES = 100_000;
// More text than fits in any Anthropic request: the rest cannot be priced.
const MAX_TEXT = 8_000_000;
const LETTER: Box = [0, 0, 612, 792];

type Box = [number, number, number, number];
type Matrix = [number, number, number, number, number, number];

class Name {
  constructor(readonly name: string) {}
}
class Ref {
  constructor(readonly num: number) {}
}
class Keyword {
  constructor(readonly word: string) {}
}
class Stream {
  constructor(
    readonly dict: Dict,
    readonly raw: Uint8Array
  ) {}
}
type Dict = Map<string, Value>;
type Value =
  | null
  | boolean
  | number
  | Uint8Array
  | Name
  | Ref
  | Value[]
  | Dict
  | Stream;
type Token = Value | Keyword;

// Shared instances for the words the parsers compare by identity and for the
// common content operators. Other words get a fresh Keyword, so a hostile file
// cannot grow this table.
const keywords = new Map<string, Keyword>();
function intern(word: string): Keyword {
  const k = new Keyword(word);
  keywords.set(word, k);
  return k;
}
function keyword(word: string): Keyword {
  return keywords.get(word) ?? new Keyword(word);
}
const ARRAY_OPEN = intern("[");
const ARRAY_CLOSE = intern("]");
const DICT_OPEN = intern("<<");
const DICT_CLOSE = intern(">>");
const R = intern("R");
const OBJ = intern("obj");
const STREAM = intern("stream");
const XREF = intern("xref");
const TRAILER = intern("trailer");
// Words that only stand between objects: an array or dictionary that reaches
// one was never closed.
const OUTSIDE_OBJECTS = new Set<Token>([
  OBJ,
  STREAM,
  XREF,
  TRAILER,
  intern("endobj"),
  intern("endstream"),
  intern("startxref"),
]);
const N = intern("n");
const F = intern("f");
const JUNK = new Keyword("");
for (const word of "BT ET Tf Td TD Tm T* Tj TJ ' \" Tc Tw Tz TL Ts Tr q Q cm Do BI ID EI re m l c h f* S s B b n W W* g G rg RG k K cs CS sc SC scn SCN gs BDC BMC EMC endobj endstream".split(
  " "
)) {
  if (!keywords.has(word)) intern(word);
}

const REGULAR = 0;
const WHITESPACE = 1;
const DELIMITER = 2;
const CHAR_CLASS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) CHAR_CLASS[c] = WHITESPACE;
for (const c of "()<>[]{}/%") CHAR_CLASS[c.charCodeAt(0)] = DELIMITER;

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}
const PDF_HEADER = ascii("%PDF-");
const STARTXREF_BYTES = ascii("startxref");
const ENDSTREAM_BYTES = ascii("endstream");
const OBJ_BYTES = ascii("obj");
const TRAILER_BYTES = ascii("trailer");

function latin1(data: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < end; i += 4096) {
    text += String.fromCharCode(...data.subarray(i, Math.min(end, i + 4096)));
  }
  return text;
}

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  c |= 0x20;
  return c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
}

function isDigit(c: number | undefined): boolean {
  return c !== undefined && c >= 0x30 && c <= 0x39;
}

function find(data: Uint8Array, pattern: Uint8Array, from: number): number {
  const last = data.length - pattern.length;
  for (let i = data.indexOf(pattern[0]!, from); i >= 0 && i <= last; ) {
    let k = 1;
    while (k < pattern.length && data[i + k] === pattern[k]) k++;
    if (k === pattern.length) return i;
    i = data.indexOf(pattern[0]!, i + 1);
  }
  return -1;
}

function findLast(data: Uint8Array, pattern: Uint8Array): number {
  for (let i = data.lastIndexOf(pattern[0]!); i >= 0; ) {
    let k = 1;
    while (k < pattern.length && data[i + k] === pattern[k]) k++;
    if (k === pattern.length) return i;
    i = i > 0 ? data.lastIndexOf(pattern[0]!, i - 1) : -1;
  }
  return -1;
}

class Lexer {
  constructor(
    readonly data: Uint8Array,
    public pos: number,
    /** Every token costs the file one operation, wherever it is parsed. */
    readonly work: { operations: number }
  ) {}

  next(): Token | undefined {
    if (--this.work.operations < 0) return undefined;
    const data = this.data;
    let pos = this.pos;
    for (;;) {
      while (pos < data.length && CHAR_CLASS[data[pos]!] === WHITESPACE) pos++;
      if (data[pos] !== 0x25) break;
      while (pos < data.length && data[pos] !== 0x0a && data[pos] !== 0x0d) {
        pos++;
      }
    }
    if (pos >= data.length) {
      this.pos = pos;
      return undefined;
    }
    const c = data[pos]!;
    if (c === 0x28) return this.literal(pos + 1);
    if (c === 0x2f) return this.name(pos + 1);
    if (c === 0x3c) {
      if (data[pos + 1] === 0x3c) {
        this.pos = pos + 2;
        return DICT_OPEN;
      }
      return this.hex(pos + 1);
    }
    if (c === 0x3e && data[pos + 1] === 0x3e) {
      this.pos = pos + 2;
      return DICT_CLOSE;
    }
    if (CHAR_CLASS[c] === DELIMITER) {
      this.pos = pos + 1;
      return keyword(String.fromCharCode(c));
    }
    let end = pos;
    while (end < data.length && CHAR_CLASS[data[end]!] === REGULAR) end++;
    this.pos = end;
    return this.word(pos, end);
  }

  private word(start: number, end: number): Token {
    const data = this.data;
    let i = start;
    let sign = 1;
    if (data[i] === 0x2d || data[i] === 0x2b) {
      if (data[i] === 0x2d) sign = -1;
      i++;
    }
    let whole = 0;
    let fraction = 0;
    let divisor = 1;
    let digits = 0;
    let dot = false;
    for (; i < end; i++) {
      const c = data[i]!;
      if (c >= 0x30 && c <= 0x39) {
        digits++;
        if (!dot) whole = whole * 10 + c - 0x30;
        else if (divisor < 1e15) {
          fraction = fraction * 10 + c - 0x30;
          divisor *= 10;
        }
      } else if (c === 0x2e && !dot) {
        dot = true;
      } else {
        break;
      }
    }
    if (i === end && digits > 0) return sign * (whole + fraction / divisor);
    if (end - start > 32) return JUNK;
    let text = "";
    for (let k = start; k < end; k++) text += String.fromCharCode(data[k]!);
    if (text === "true") return true;
    if (text === "false") return false;
    if (text === "null") return null;
    return keyword(text);
  }

  private name(pos: number): Name {
    const data = this.data;
    let end = pos;
    while (end < data.length && CHAR_CLASS[data[end]!] === REGULAR) end++;
    this.pos = end;
    let text = "";
    // Readers allow 127 bytes: a longer name would cost its length again in
    // every string built from it.
    for (let i = pos; i < end && text.length < 127; i++) {
      const c = data[i]!;
      const high = c === 0x23 ? hexDigit(data[i + 1] ?? 0) : -1;
      const low = high >= 0 ? hexDigit(data[i + 2] ?? 0) : -1;
      if (low >= 0) {
        text += String.fromCharCode(high * 16 + low);
        i += 2;
      } else {
        text += String.fromCharCode(c);
      }
    }
    return new Name(text);
  }

  private literal(pos: number): Uint8Array {
    const data = this.data;
    // Most strings have no escapes and no nested parentheses: share their bytes.
    for (let end = pos; end < data.length; end++) {
      const c = data[end]!;
      if (c === 0x29) {
        this.pos = end + 1;
        return data.subarray(pos, end);
      }
      if (c === 0x5c || c === 0x28) break;
    }
    let out = new Uint8Array(64);
    let n = 0;
    let depth = 1;
    while (pos < data.length) {
      if (n === out.length) {
        const grown = new Uint8Array(2 * n);
        grown.set(out);
        out = grown;
      }
      let c = data[pos++]!;
      if (c === 0x5c) {
        c = data[pos++] ?? 0;
        if (c === 0x6e) out[n++] = 10;
        else if (c === 0x72) out[n++] = 13;
        else if (c === 0x74) out[n++] = 9;
        else if (c === 0x62) out[n++] = 8;
        else if (c === 0x66) out[n++] = 12;
        else if (c === 0x0d) {
          if (data[pos] === 0x0a) pos++;
        } else if (c === 0x0a) {
          // a line continuation
        } else if (c >= 0x30 && c <= 0x37) {
          let value = c - 0x30;
          for (
            let k = 0;
            k < 2 && data[pos]! >= 0x30 && data[pos]! <= 0x37;
            k++
          ) {
            value = value * 8 + data[pos++]! - 0x30;
          }
          out[n++] = value & 0xff;
        } else {
          out[n++] = c;
        }
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) break;
      out[n++] = c;
    }
    this.pos = pos;
    return out.subarray(0, n);
  }

  private hex(pos: number): Uint8Array {
    const [bytes, end] = readHex(this.data, pos);
    this.pos = end;
    return bytes;
  }
}

/** Hex digits up to `>`, whitespace skipped; an odd final digit is padded with 0. */
function readHex(data: Uint8Array, pos: number): [Uint8Array, number] {
  let end = data.indexOf(0x3e, pos);
  if (end < 0) end = data.length;
  const out = new Uint8Array((end - pos + 1) >> 1);
  let n = 0;
  let high = -1;
  for (; pos < end; pos++) {
    const digit = hexDigit(data[pos]!);
    if (digit < 0) continue;
    if (high < 0) high = digit;
    else {
      out[n++] = high * 16 + digit;
      high = -1;
    }
  }
  if (high >= 0) out[n++] = high * 16;
  return [out.subarray(0, n), Math.min(end + 1, data.length)];
}

/** The value that starts with `token`; `refs` reads `N G R` as a reference. */
function parse(
  lexer: Lexer,
  token: Token | undefined,
  refs: boolean,
  depth = 0
): Value {
  if ((lexer.work.operations -= 16) < 0) return null;
  if (token === ARRAY_OPEN && depth < MAX_NESTING) {
    const array: Value[] = [];
    for (let t = lexer.next(); t !== undefined && t !== ARRAY_CLOSE; ) {
      if (t === DICT_CLOSE || OUTSIDE_OBJECTS.has(t)) break;
      array.push(parse(lexer, t, refs, depth + 1));
      t = lexer.next();
    }
    return array;
  }
  if (token === DICT_OPEN && depth < MAX_NESTING) {
    const dict: Dict = new Map();
    for (let t = lexer.next(); t !== undefined && t !== DICT_CLOSE; ) {
      if (OUTSIDE_OBJECTS.has(t)) break;
      if (t instanceof Name) {
        const value = lexer.next();
        if (
          value === DICT_CLOSE ||
          value === undefined ||
          OUTSIDE_OBJECTS.has(value)
        ) {
          break;
        }
        dict.set(t.name, parse(lexer, value, refs, depth + 1));
      }
      t = lexer.next();
    }
    return dict;
  }
  if (refs && typeof token === "number" && Number.isInteger(token)) {
    const save = lexer.pos;
    const gen = lexer.next();
    if (typeof gen === "number" && lexer.next() === R) return new Ref(token);
    lexer.pos = save;
  }
  return token === undefined || token instanceof Keyword ? null : token;
}

/** Where an object is: at a file offset, or inside an object stream. */
type Entry = { offset: number } | { stream: number };
interface ObjectStream {
  data: Uint8Array;
  offsets: Map<number, number>;
}
interface PageNode {
  dict: Dict;
  mediaBox: Value;
  cropBox: Value;
  rotate: Value;
  resources: Value;
}

class PdfFile {
  private readonly entries = new Map<number, Entry>();
  private scanned: Map<number, Entry> | undefined;
  private scannedTrailers: Dict[] = [];
  private readonly cache = new Map<number, Value>();
  private readonly loading = new Set<number>();
  private readonly objectStreams = new Map<number, ObjectStream | null>();
  readonly fonts = new Map<Dict, Font>();
  private readonly cmaps = new WeakMap<Stream, CMap | undefined>();
  private fetchDepth = 0;
  private endstreamSearch = { from: Infinity, at: -1 };
  private budget = MAX_DOCUMENT_BYTES;
  // Bytes the object parser may still read. A file reads each object once or
  // twice, but objects that overlap, or strings that never close, would read
  // to the end of the file again for every object that starts inside them.
  private parseLeft: number;
  operations = MAX_OPERATIONS;
  textLeft = MAX_TEXT;
  readonly trailers: Dict[] = [];
  encrypted = false;

  constructor(
    readonly data: Uint8Array,
    /** Bytes before `%PDF-`: some files have xref offsets counted from the header. */
    readonly header: number
  ) {
    this.parseLeft = 8 * data.length;
  }

  resolve(value: Value | undefined): Value {
    for (let i = 0; value instanceof Ref && i < 16; i++) {
      value = this.fetch(value.num);
    }
    return value instanceof Ref || value === undefined ? null : value;
  }

  dict(value: Value | undefined): Dict | undefined {
    const resolved = this.resolve(value);
    if (resolved instanceof Map) return resolved;
    return resolved instanceof Stream ? resolved.dict : undefined;
  }

  number(value: Value | undefined): number | undefined {
    const resolved = this.resolve(value);
    return typeof resolved === "number" && Number.isFinite(resolved)
      ? resolved
      : undefined;
  }

  name(value: Value | undefined): string | undefined {
    const resolved = this.resolve(value);
    return resolved instanceof Name ? resolved.name : undefined;
  }

  array(value: Value | undefined): Value[] | undefined {
    const resolved = this.resolve(value);
    return Array.isArray(resolved) ? resolved : undefined;
  }

  fetch(num: number): Value {
    if (this.cache.has(num)) return this.cache.get(num)!;
    if (this.loading.has(num) || this.fetchDepth >= MAX_FETCH_DEPTH)
      return null;
    this.loading.add(num);
    this.fetchDepth++;
    let value = this.load(this.entries.get(num), num);
    if (value === undefined) value = this.load(this.scan().get(num), num);
    this.fetchDepth--;
    this.loading.delete(num);
    this.cache.set(num, value ?? null);
    return value ?? null;
  }

  private load(entry: Entry | undefined, num: number): Value | undefined {
    if (!entry) return undefined;
    if ("offset" in entry) {
      return (
        this.parseAt(entry.offset, num) ??
        (this.header
          ? this.parseAt(entry.offset + this.header, num)
          : undefined)
      );
    }
    return this.fromObjectStream(entry.stream, num);
  }

  /** The indirect object `num G obj ... endobj` at `offset`. */
  private parseAt(offset: number, num?: number): Value | undefined {
    if (offset < 0 || offset >= this.data.length || this.parseLeft < 0) {
      return undefined;
    }
    const lexer = new Lexer(this.data, offset, this);
    try {
      const found = lexer.next();
      if (typeof found !== "number" || (num !== undefined && found !== num)) {
        return undefined;
      }
      if (typeof lexer.next() !== "number" || lexer.next() !== OBJ)
        return undefined;
      const value = parse(lexer, lexer.next(), true);
      if (!(value instanceof Map) || lexer.next() !== STREAM) return value;
      return this.readStream(value, lexer.pos);
    } finally {
      this.parseLeft -= lexer.pos - offset;
    }
  }

  private readStream(dict: Dict, pos: number): Stream {
    const data = this.data;
    if (data[pos] === 0x0d) pos++;
    if (data[pos] === 0x0a) pos++;
    const length = this.number(dict.get("Length"));
    let end = -1;
    if (length !== undefined && length >= 0 && pos + length <= data.length) {
      let after = pos + length;
      while (after < data.length && CHAR_CLASS[data[after]!] === WHITESPACE) {
        after++;
      }
      if (find(data.subarray(after, after + 9), ENDSTREAM_BYTES, 0) === 0) {
        end = pos + length;
      }
    }
    if (end < 0) {
      end = this.findEndstream(pos);
      if (data[end - 1] === 0x0a) end--;
      if (data[end - 1] === 0x0d) end--;
    }
    return new Stream(dict, data.subarray(pos, Math.max(pos, end)));
  }

  // Streams without a usable /Length search for `endstream`. Remembering the
  // last answer keeps a file of many unterminated streams linear.
  private findEndstream(from: number): number {
    const last = this.endstreamSearch;
    if (from >= last.from && (last.at < 0 || from <= last.at)) {
      return last.at < 0 ? this.data.length : last.at;
    }
    const at = find(this.data, ENDSTREAM_BYTES, from);
    this.parseLeft -= (at < 0 ? this.data.length : at) - from;
    this.endstreamSearch = { from, at };
    return at < 0 ? this.data.length : at;
  }

  private fromObjectStream(streamNum: number, num: number): Value | undefined {
    let objects = this.objectStreams.get(streamNum);
    if (objects === undefined) {
      const stream = this.fetch(streamNum);
      objects = stream instanceof Stream ? this.objectStream(stream) : null;
      this.objectStreams.set(streamNum, objects);
    }
    const offset = objects?.offsets.get(num);
    if (offset === undefined || this.parseLeft < 0) return undefined;
    const lexer = new Lexer(objects!.data, offset, this);
    const value = parse(lexer, lexer.next(), true);
    this.parseLeft -= lexer.pos - offset;
    return value;
  }

  private objectStream(stream: Stream): ObjectStream | null {
    // Object streams are encrypted with the rest of the file.
    const data = this.encrypted ? undefined : this.decode(stream);
    const count = this.number(stream.dict.get("N"));
    const first = this.number(stream.dict.get("First"));
    if (!data || count === undefined || first === undefined) return null;
    this.parseLeft += data.length;
    const lexer = new Lexer(data, 0, this);
    const offsets = new Map<number, number>();
    for (let i = 0; i < count && offsets.size < MAX_OBJECTS; i++) {
      const num = lexer.next();
      const offset = lexer.next();
      if (typeof num !== "number" || typeof offset !== "number") break;
      if (!offsets.has(num)) offsets.set(num, first + offset);
    }
    return { data, offsets };
  }

  /** The decoded bytes of a stream, or undefined for filters this reader skips. */
  decode(stream: Stream): Uint8Array | undefined {
    // Every use is charged, so a stream that every page or form draws is not
    // free to read again, even when it is raw or empty.
    if ((this.operations -= STREAM_USE) < 0) return undefined;
    const filters = this.resolve(stream.dict.get("Filter"));
    const params = this.resolve(
      stream.dict.get("DecodeParms") ?? stream.dict.get("DP")
    );
    const filterList = Array.isArray(filters)
      ? filters
      : filters
        ? [filters]
        : [];
    const paramList = Array.isArray(params) ? params : [params];
    let data = stream.raw;
    this.budget -= data.length;
    if (this.budget < 0) return undefined;
    for (let i = 0; i < filterList.length; i++) {
      if (this.budget <= 0 || --this.operations < 0) return undefined;
      switch (this.name(filterList[i])) {
        case "FlateDecode":
        case "Fl":
          data = inflate(data, Math.min(MAX_STREAM_BYTES, this.budget));
          data = this.unpredict(data, this.dict(paramList[i] ?? null));
          break;
        case "LZWDecode":
        case "LZW": {
          const params = this.dict(paramList[i] ?? null);
          data = lzw(
            data,
            this.number(params?.get("EarlyChange")) === 0 ? 0 : 1,
            Math.min(MAX_STREAM_BYTES, this.budget)
          );
          data = this.unpredict(data, params);
          break;
        }
        case "RunLengthDecode":
        case "RL":
          data = runLength(data, Math.min(MAX_STREAM_BYTES, this.budget));
          break;
        case "ASCIIHexDecode":
        case "AHx":
          data = readHex(data, 0)[0];
          break;
        case "ASCII85Decode":
        case "A85":
          data = ascii85(data, Math.min(MAX_STREAM_BYTES, this.budget));
          break;
        default:
          return undefined;
      }
      this.budget -= data.length;
    }
    return data;
  }

  /** A CMap stream, parsed once however many fonts share it. */
  cmap(stream: Stream): CMap | undefined {
    if (!this.cmaps.has(stream)) {
      const data = this.decode(stream);
      this.cmaps.set(stream, data && parseCMap(this, data));
    }
    return this.cmaps.get(stream);
  }

  /** Undoes a PNG predictor, which xref streams use. */
  private unpredict(data: Uint8Array, params: Dict | undefined): Uint8Array {
    const predictor = params && this.number(params.get("Predictor"));
    if (!params || predictor === undefined || predictor < 10) return data;
    const colors = this.number(params.get("Colors")) ?? 1;
    const bits = this.number(params.get("BitsPerComponent")) ?? 8;
    const columns = this.number(params.get("Columns")) ?? 1;
    const pixel = Math.max(1, Math.ceil((colors * bits) / 8));
    const row = Math.ceil((colors * bits * columns) / 8);
    if (!(row > 0)) return data;
    const rows = Math.floor(data.length / (row + 1));
    const out = new Uint8Array(rows * row);
    for (let r = 0; r < rows; r++) {
      const type = data[r * (row + 1)]!;
      const input = r * (row + 1) + 1;
      const at = r * row;
      for (let i = 0; i < row; i++) {
        const left = i >= pixel ? out[at + i - pixel]! : 0;
        const up = r > 0 ? out[at + i - row]! : 0;
        const upLeft = r > 0 && i >= pixel ? out[at + i - row - pixel]! : 0;
        let value = data[input + i]!;
        if (type === 1) value += left;
        else if (type === 2) value += up;
        else if (type === 3) value += (left + up) >> 1;
        else if (type === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        }
        out[at + i] = value;
      }
    }
    return out;
  }

  /** Follows `startxref` and every /Prev; the newest entry for an object wins. */
  readXref(): void {
    const at = findLast(this.data, STARTXREF_BYTES);
    if (at < 0) return;
    let offset = new Lexer(this.data, at + STARTXREF_BYTES.length, this).next();
    const seen = new Set<number>();
    while (
      typeof offset === "number" &&
      !seen.has(offset) &&
      seen.size < 1024
    ) {
      seen.add(offset);
      const trailer = this.readSection(offset);
      if (!trailer) return;
      this.trailers.push(trailer);
      // A hybrid file's /XRefStm lists the objects its xref table marks free.
      const xrefStream = trailer.get("XRefStm");
      if (typeof xrefStream === "number") this.readSection(xrefStream);
      offset = trailer.get("Prev") as Value;
    }
  }

  private readSection(offset: number): Dict | undefined {
    for (const at of this.header ? [offset, offset + this.header] : [offset]) {
      if (this.parseLeft < 0) return undefined;
      const lexer = new Lexer(this.data, at, this);
      const first = lexer.next();
      const trailer =
        first === XREF
          ? this.readTable(lexer)
          : typeof first === "number"
            ? this.readXrefStream(at)
            : undefined;
      this.parseLeft -= lexer.pos - at;
      if (trailer) return trailer;
    }
    return undefined;
  }

  private readTable(lexer: Lexer): Dict | undefined {
    for (;;) {
      const token = lexer.next();
      if (token === TRAILER) {
        const trailer = parse(lexer, lexer.next(), true);
        return trailer instanceof Map ? trailer : undefined;
      }
      const count = lexer.next();
      if (typeof token !== "number" || typeof count !== "number")
        return undefined;
      let start = token;
      for (let i = 0; i < count; i++) {
        const offset = lexer.next();
        const gen = lexer.next();
        const type = lexer.next();
        if (typeof offset !== "number" || typeof gen !== "number")
          return undefined;
        // Some writers number the first subsection from 1 and still list object 0.
        if (i === 0 && start === 1 && type === F && gen === 65535) start = 0;
        if (type === N && offset > 0 && !this.entries.has(start + i)) {
          this.entries.set(start + i, { offset });
        }
      }
    }
  }

  private readXrefStream(offset: number): Dict | undefined {
    const stream = this.parseAt(offset);
    if (!(stream instanceof Stream)) return undefined;
    const widths = this.array(stream.dict.get("W"))?.map((w) => this.number(w));
    const data = this.decode(stream);
    if (!data || widths?.length !== 3 || widths.some((w) => w === undefined)) {
      return undefined;
    }
    const [typeWidth, aWidth, bWidth] = widths as number[];
    const rowLength = typeWidth! + aWidth! + bWidth!;
    const size = this.number(stream.dict.get("Size")) ?? 0;
    const index = this.array(stream.dict.get("Index")) ?? [0, size];
    let pos = 0;
    const field = (width: number, fallback: number) => {
      if (width === 0) return fallback;
      let value = 0;
      for (let i = 0; i < width; i++) value = value * 256 + data[pos++]!;
      return value;
    };
    for (let k = 0; k + 1 < index.length && rowLength > 0; k += 2) {
      const start = this.number(index[k]) ?? 0;
      const count = this.number(index[k + 1]) ?? 0;
      for (let i = 0; i < count && pos + rowLength <= data.length; i++) {
        if ((this.operations -= 16) < 0 || this.entries.size >= MAX_OBJECTS) {
          return stream.dict;
        }
        const type = field(typeWidth!, 1);
        const a = field(aWidth!, 0);
        field(bWidth!, 0); // a generation, or an index in the object stream
        if (this.entries.has(start + i)) continue;
        if (type === 1) this.entries.set(start + i, { offset: a });
        else if (type === 2) this.entries.set(start + i, { stream: a });
      }
    }
    return stream.dict;
  }

  /** Every `N G obj` in the file, for files whose xref is missing or wrong. */
  private scan(): Map<number, Entry> {
    if (this.scanned) return this.scanned;
    const found = new Map<number, Entry>();
    this.scanned = found;
    const data = this.data;
    const back = (p: number, wanted: number) => {
      const start = p;
      while (p >= 0 && start - p < 32) {
        const c = data[p]!;
        if (
          wanted === WHITESPACE ? CHAR_CLASS[c] !== WHITESPACE : !isDigit(c)
        ) {
          break;
        }
        p--;
      }
      return p === start ? -2 : p;
    };
    for (
      let i = find(data, OBJ_BYTES, 0);
      i >= 0;
      i = find(data, OBJ_BYTES, i + 3)
    ) {
      if (found.size >= MAX_OBJECTS) break;
      const after = data[i + 3];
      if (after !== undefined && CHAR_CLASS[after] === REGULAR) continue;
      const genEnd = back(i - 1, WHITESPACE);
      const genStart = genEnd >= 0 ? back(genEnd, 0) : -2;
      const numEnd = genStart >= 0 ? back(genStart, WHITESPACE) : -2;
      const numStart = numEnd >= 0 ? back(numEnd, 0) : -2;
      if (numStart < -1) continue;
      if (numStart >= 0 && CHAR_CLASS[data[numStart]!] === REGULAR) continue;
      found.set(Number(latin1(data, numStart + 1, numEnd + 1)), {
        offset: numStart + 1,
      });
    }
    for (const [num, entry] of [...found]) {
      const value = this.parseAt((entry as { offset: number }).offset, num);
      if (
        !(value instanceof Stream) ||
        this.name(value.dict.get("Type")) !== "ObjStm"
      ) {
        continue;
      }
      if (!this.objectStreams.has(num)) {
        this.objectStreams.set(num, this.objectStream(value));
      }
      for (const objectNum of this.objectStreams.get(num)?.offsets.keys() ??
        []) {
        if (found.size >= MAX_OBJECTS) break;
        if (!found.has(objectNum)) {
          found.set(objectNum, { stream: num });
        }
      }
    }
    for (
      let i = find(data, TRAILER_BYTES, 0);
      i >= 0 && this.parseLeft >= 0;
      i = find(data, TRAILER_BYTES, i + 7)
    ) {
      const lexer = new Lexer(data, i + 7, this);
      const trailer = parse(lexer, lexer.next(), true);
      this.parseLeft -= lexer.pos - i;
      if (trailer instanceof Map) this.scannedTrailers.push(trailer);
    }
    return found;
  }

  private catalog(trailers: Dict[]): Dict | undefined {
    for (const trailer of trailers) {
      const root = this.dict(trailer.get("Root"));
      if (root?.has("Pages")) return root;
    }
    return undefined;
  }

  private walk(catalog: Dict | undefined): PageNode[] {
    const pages: PageNode[] = [];
    const seen = new Set<Dict>();
    const visit = (
      node: Value,
      inherited: Omit<PageNode, "dict">,
      depth: number
    ) => {
      const dict = this.dict(node);
      if (
        !dict ||
        seen.has(dict) ||
        depth > MAX_NESTING ||
        pages.length >= MAX_PAGES
      ) {
        return;
      }
      seen.add(dict);
      const own = {
        mediaBox: dict.get("MediaBox") ?? inherited.mediaBox,
        cropBox: dict.get("CropBox") ?? inherited.cropBox,
        rotate: dict.get("Rotate") ?? inherited.rotate,
        resources: dict.get("Resources") ?? inherited.resources,
      };
      const kids = this.array(dict.get("Kids"));
      const type = this.name(dict.get("Type"));
      if (kids && type !== "Page") {
        for (const kid of kids) visit(kid, own, depth + 1);
      } else if (type === "Page" || (!kids && type !== "Pages")) {
        pages.push({ dict, ...own });
      }
    };
    const root = catalog?.get("Pages");
    if (root) {
      visit(
        root,
        { mediaBox: null, cropBox: null, rotate: null, resources: null },
        0
      );
    }
    return pages;
  }

  pageNodes(): PageNode[] {
    this.readXref();
    this.encrypted = this.trailers.some((trailer) => trailer.has("Encrypt"));
    let pages = this.walk(this.catalog(this.trailers));
    if (pages.length === 0) {
      this.scan();
      this.encrypted ||= this.scannedTrailers.some((t) => t.has("Encrypt"));
      pages = this.walk(this.catalog([...this.scannedTrailers].reverse()));
    }
    if (pages.length === 0) pages = this.walk(this.findCatalog());
    if (pages.length === 0) pages = this.loosePages();
    return pages;
  }

  private objectNums(): number[] {
    const nums = new Set([...this.entries.keys(), ...this.scan().keys()]);
    return [...nums].sort((a, b) => a - b);
  }

  private findCatalog(): Dict | undefined {
    let catalog: Dict | undefined;
    for (const num of this.objectNums()) {
      const dict = this.dict(this.fetch(num));
      if (
        dict &&
        this.name(dict.get("Type")) === "Catalog" &&
        dict.has("Pages")
      ) {
        catalog = dict;
      }
    }
    return catalog;
  }

  /** Every /Type /Page object, for files whose page tree is broken. */
  private loosePages(): PageNode[] {
    const pages: PageNode[] = [];
    for (const num of this.objectNums()) {
      const dict = this.dict(this.fetch(num));
      if (
        dict &&
        this.name(dict.get("Type")) === "Page" &&
        pages.length < MAX_PAGES
      ) {
        const parent = this.dict(dict.get("Parent"));
        pages.push({
          dict,
          mediaBox: dict.get("MediaBox") ?? parent?.get("MediaBox") ?? null,
          cropBox: dict.get("CropBox") ?? parent?.get("CropBox") ?? null,
          rotate: dict.get("Rotate") ?? parent?.get("Rotate") ?? null,
          resources: dict.get("Resources") ?? parent?.get("Resources") ?? null,
        });
      }
    }
    return pages;
  }

  box(value: Value): Box | undefined {
    const numbers = this.array(value)?.map((v) => this.number(v));
    if (
      !numbers ||
      numbers.length < 4 ||
      numbers.some((n) => n === undefined)
    ) {
      return undefined;
    }
    const [x1, y1, x2, y2] = numbers as number[];
    const box: Box = [
      Math.min(x1!, x2!),
      Math.min(y1!, y2!),
      Math.max(x1!, x2!),
      Math.max(y1!, y2!),
    ];
    return box[2] > box[0] && box[3] > box[1] ? box : undefined;
  }
}

/** PDF LZW, MSB first, with clear (256) and end-of-data (257) codes. */
function lzw(data: Uint8Array, earlyChange: number, limit: number): Uint8Array {
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  let out = new Uint8Array(Math.min(limit, 1024 + data.length * 4));
  let length = 0;
  let pos = 0;
  let buffer = 0;
  let bits = 0;
  let width = 9;
  let next = 258;
  let previous = -1;
  let first = 0;
  while (length < limit) {
    while (bits < width && pos < data.length) {
      buffer = (buffer << 8) | data[pos++]!;
      bits += 8;
    }
    if (bits < width) break;
    bits -= width;
    const code = (buffer >>> bits) & ((1 << width) - 1);
    if (code === 257) break;
    if (code === 256) {
      width = 9;
      next = 258;
      previous = -1;
      continue;
    }
    if (code > next || (code === next && previous < 0)) break;
    let c = code;
    let n = 0;
    if (c === next) {
      stack[n++] = first;
      c = previous;
    }
    while (c >= 258 && n < stack.length - 1) {
      stack[n++] = suffix[c]!;
      c = prefix[c]!;
    }
    if (c > 255) break;
    stack[n++] = first = c;
    if (length + n > out.length) {
      const grown = new Uint8Array(
        Math.min(limit, Math.max(2 * out.length, length + n))
      );
      grown.set(out);
      out = grown;
    }
    while (n > 0 && length < limit) out[length++] = stack[--n]!;
    if (previous >= 0 && next < 4096) {
      prefix[next] = previous;
      suffix[next++] = first;
      if (next + earlyChange === 1 << width && width < 12) width++;
    }
    previous = code;
  }
  return out.subarray(0, length);
}

function runLength(data: Uint8Array, limit: number): Uint8Array {
  const out = new Uint8Array(Math.min(limit, data.length * 128));
  let length = 0;
  for (let pos = 0; pos < data.length && length < limit; ) {
    const n = data[pos++]!;
    if (n === 128) break;
    if (n < 128) {
      const count = Math.min(n + 1, data.length - pos, limit - length);
      out.set(data.subarray(pos, pos + count), length);
      pos += count;
      length += count;
    } else {
      if (pos >= data.length) break;
      const end = Math.min(limit, length + 257 - n);
      out.fill(data[pos++]!, length, end);
      length = end;
    }
  }
  return out.subarray(0, length);
}

/** At most `limit` bytes, like `inflate`: each `z` is four. */
function ascii85(data: Uint8Array, limit: number): Uint8Array {
  const out = new Uint8Array(Math.min(limit, 4 * data.length));
  let n = 0;
  let group = 0;
  let count = 0;
  const write = (bytes: number) => {
    for (let k = 0; k < bytes && n < out.length; k++) {
      out[n++] = (group >>> (24 - 8 * k)) & 0xff;
    }
  };
  for (let i = 0; i < data.length && n < out.length; i++) {
    const c = data[i]!;
    if (c === 0x7e) break;
    if (c === 0x7a && count === 0) {
      n = Math.min(n + 4, out.length);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    group = group * 85 + (c - 0x21);
    if (++count === 5) {
      write(4);
      group = 0;
      count = 0;
    }
  }
  if (count > 1) {
    for (let k = count; k < 5; k++) group = group * 85 + 84;
    write(count - 1);
  }
  return out.slice(0, n);
}

// Encodings and glyph names -------------------------------------------------

// WinAnsiEncoding draws a bullet at the codes Windows-1252 leaves unused.
const WIN_ANSI_7F = "•€•‚ƒ„…†‡ˆ‰Š‹Œ•Ž••‘’“”•–—˜™š›œ•žŸ";
const MAC_ROMAN_80 =
  "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø" +
  "¿¡¬√ƒ≈∆«»…\u00a0ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\0ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ";
const STANDARD_A1 =
  "¡¢£⁄¥ƒ§¤'“«‹›ﬁﬂ\0–†‡·\0¶•‚„”»…‰\0¿\0`´ˆ˜¯˘˙¨\0˚¸\0˝˛ˇ—" +
  "\0".repeat(16) +
  "Æ\0ª\0\0\0\0ŁØŒº\0\0\0\0\0æ\0\0\0ı\0\0łøœß\0\0\0\0";

function table(
  high: string,
  from: number,
  ascii: (c: number) => string
): string[] {
  const codes = Array.from({ length: 256 }, (_, c) =>
    c >= 0x20 && c < 0x7f ? ascii(c) : c === 9 ? "\t" : ""
  );
  for (let i = 0; i < high.length; i++) {
    codes[from + i] = high[i] === "\0" ? "" : high[i]!;
  }
  return codes;
}

const plainAscii = (c: number) => String.fromCharCode(c);
const ENCODINGS: Record<string, string[]> = {
  WinAnsiEncoding: table(
    WIN_ANSI_7F +
      Array.from({ length: 96 }, (_, i) => String.fromCharCode(0xa0 + i)).join(
        ""
      ),
    0x7f,
    plainAscii
  ),
  MacRomanEncoding: table(MAC_ROMAN_80, 0x80, plainAscii),
  // StandardEncoding draws 0x27 and 0x60 as curly quotes.
  StandardEncoding: table(STANDARD_A1, 0xa1, (c) =>
    c === 0x27 ? "’" : c === 0x60 ? "‘" : String.fromCharCode(c)
  ),
};

// prettier-ignore
const GLYPH_NAMES: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$",
  percent: "%", ampersand: "&", quotesingle: "'", quoteright: "’",
  parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",",
  hyphen: "-", period: ".", slash: "/", zero: "0", one: "1", two: "2",
  three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8",
  nine: "9", colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">",
  question: "?", at: "@", bracketleft: "[", backslash: "\\",
  bracketright: "]", asciicircum: "^", underscore: "_", grave: "`",
  quoteleft: "‘", braceleft: "{", bar: "|", braceright: "}", asciitilde: "~",
  exclamdown: "¡", cent: "¢", sterling: "£", fraction: "⁄", yen: "¥",
  florin: "ƒ", section: "§", currency: "¤", quotedblleft: "“",
  guillemotleft: "«", guilsinglleft: "‹", guilsinglright: "›", fi: "ﬁ",
  fl: "ﬂ", ff: "ﬀ", ffi: "ﬃ", ffl: "ﬄ", endash: "–", emdash: "—", dagger: "†",
  daggerdbl: "‡", periodcentered: "·", paragraph: "¶", bullet: "•",
  quotesinglbase: "‚", quotedblbase: "„", quotedblright: "”",
  guillemotright: "»", ellipsis: "…", perthousand: "‰", questiondown: "¿",
  acute: "´", circumflex: "ˆ", tilde: "˜", macron: "¯", breve: "˘",
  dotaccent: "˙", dieresis: "¨", ring: "˚", cedilla: "¸", hungarumlaut: "˝",
  ogonek: "˛", caron: "ˇ", AE: "Æ", ae: "æ", OE: "Œ", oe: "œ",
  ordfeminine: "ª", ordmasculine: "º", Lslash: "Ł", lslash: "ł", Oslash: "Ø",
  oslash: "ø", dotlessi: "ı", germandbls: "ß", Euro: "€", trademark: "™",
  copyright: "©", registered: "®", degree: "°", plusminus: "±", multiply: "×",
  divide: "÷", mu: "µ", logicalnot: "¬", brokenbar: "¦", onehalf: "½",
  onequarter: "¼", threequarters: "¾", onesuperior: "¹", twosuperior: "²",
  threesuperior: "³", minus: "−", Eth: "Ð", eth: "ð", Thorn: "Þ", thorn: "þ",
  nbspace: "\u00a0", nonbreakingspace: "\u00a0", sfthyphen: "\u00ad",
  softhyphen: "\u00ad",
};
// prettier-ignore
const ACCENTS: Record<string, string> = {
  acute: "\u0301", grave: "\u0300", circumflex: "\u0302", tilde: "\u0303",
  dieresis: "\u0308", ring: "\u030a", cedilla: "\u0327", caron: "\u030c",
  macron: "\u0304", breve: "\u0306", ogonek: "\u0328", dotaccent: "\u0307",
  hungarumlaut: "\u030b", commaaccent: "\u0326",
};
const ACCENTED =
  /^([A-Za-z])(acute|grave|circumflex|tilde|dieresis|ring|cedilla|caron|macron|breve|ogonek|dotaccent|hungarumlaut|commaaccent)$/;

/** The text of a glyph name from a font's /Differences. */
function glyphText(name: string): string {
  const base = name.split(".")[0]!;
  if (base.includes("_")) return base.split("_").map(glyphText).join("");
  const known = GLYPH_NAMES[base];
  if (known !== undefined) return known;
  if (/^[A-Za-z]$/.test(base)) return base;
  const accented = ACCENTED.exec(base);
  if (accented) return (accented[1]! + ACCENTS[accented[2]!]).normalize("NFC");
  const uni = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(base);
  if (uni) {
    return String.fromCharCode(
      ...uni[1]!.match(/.{4}/g)!.map((hex) => parseInt(hex, 16))
    );
  }
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(base);
  if (u) {
    const code = parseInt(u[1]!, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : "";
  }
  return "";
}

// Fonts ----------------------------------------------------------------------

/** A ToUnicode or encoding CMap: code space ranges and code-to-text maps. */
interface CMap {
  spaces: Array<[bytes: number, low: number, high: number]>;
  chars: Map<number, string>;
  ranges: Array<[bytes: number, low: number, high: number, text: string]>;
}

const MAX_EXPANDED_RANGE = 256;
const MAX_GLYPHS = 1 << 16;
// More codes than a CMap of one- and two-byte codes can map.
const MAX_CMAP_CODES = 1 << 17;

function codeKey(code: number, bytes: number): number {
  return bytes * 2 ** 32 + code;
}

function bigEndian(bytes: Uint8Array): number {
  let value = 0;
  for (const b of bytes) value = value * 256 + b;
  return value;
}

/** A CMap's text for a code; the CMap format allows 512 bytes at most. */
function utf16(bytes: Uint8Array): string {
  if (bytes.length > 512) return "";
  if (bytes.length === 1) return String.fromCharCode(bytes[0]!);
  let text = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    text += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  }
  return text;
}

function shifted(text: string, by: number): string {
  if (!text) return text;
  return (
    text.slice(0, -1) +
    String.fromCharCode(text.charCodeAt(text.length - 1) + by)
  );
}

function parseCMap(file: PdfFile, data: Uint8Array): CMap {
  const cmap: CMap = { spaces: [], chars: new Map(), ranges: [] };
  const set = (key: number, text: string) => {
    if ((file.operations -= 32) > 0 && cmap.chars.size < MAX_CMAP_CODES) {
      cmap.chars.set(key, text);
    }
  };
  const lexer = new Lexer(data, 0, file);
  const take = (end: string, arity: number, use: (values: Value[]) => void) => {
    for (;;) {
      const values: Value[] = [];
      for (let i = 0; i < arity; i++) {
        const token = lexer.next();
        if (
          token === undefined ||
          (token instanceof Keyword && token.word === end)
        ) {
          return;
        }
        values.push(parse(lexer, token, false));
      }
      use(values);
    }
  };
  for (let token = lexer.next(); token !== undefined; token = lexer.next()) {
    if (!(token instanceof Keyword)) continue;
    if (token.word === "begincodespacerange") {
      take("endcodespacerange", 2, ([low, high]) => {
        if (
          low instanceof Uint8Array &&
          high instanceof Uint8Array &&
          low.length &&
          low.length <= 4
        ) {
          cmap.spaces.push([low.length, bigEndian(low), bigEndian(high)]);
        }
      });
    } else if (token.word === "beginbfchar") {
      take("endbfchar", 2, ([code, text]) => {
        if (code instanceof Uint8Array && code.length && code.length <= 4) {
          set(
            codeKey(bigEndian(code), code.length),
            text instanceof Uint8Array
              ? utf16(text)
              : text instanceof Name
                ? glyphText(text.name)
                : ""
          );
        }
      });
    } else if (token.word === "beginbfrange") {
      take("endbfrange", 3, ([lowBytes, highBytes, text]) => {
        if (
          !(lowBytes instanceof Uint8Array) ||
          !(highBytes instanceof Uint8Array)
        )
          return;
        // Codes are 1 to 4 bytes, so `code++` below always moves.
        const bytes = lowBytes.length;
        const low = bigEndian(lowBytes);
        const high = bigEndian(highBytes);
        if (!bytes || bytes > 4 || high < low) return;
        if (Array.isArray(text)) {
          text.slice(0, high - low + 1).forEach((t, i) => {
            if (t instanceof Uint8Array) set(codeKey(low + i, bytes), utf16(t));
          });
        } else if (text instanceof Uint8Array) {
          const first = utf16(text);
          if (high - low < MAX_EXPANDED_RANGE) {
            for (let code = low; code <= high; code++) {
              set(codeKey(code, bytes), shifted(first, code - low));
            }
          } else {
            cmap.ranges.push([bytes, low, high, first]);
          }
        }
      });
    }
  }
  return cmap;
}

function lookup(
  file: PdfFile,
  cmap: CMap,
  code: number,
  bytes: number
): string | undefined {
  const text = cmap.chars.get(codeKey(code, bytes));
  if (text !== undefined) return text;
  for (const [n, low, high, first] of cmap.ranges) {
    if (--file.operations < 0) break;
    if (n === bytes && code >= low && code <= high)
      return shifted(first, code - low);
  }
  return undefined;
}

/**
 * pdfium shows a code with no Unicode as the code itself: a CID, or a byte the
 * encoding leaves undefined. That is right for the predefined UCS-2 CMaps and
 * what count_tokens charges for everything else.
 */
function unmapped(code: number): string {
  return code > 0 && code < 0xd800 ? String.fromCharCode(code) : "";
}

function extractedText(text: string): string {
  // pdfium drops these controls and spells ligatures out. Do this once per
  // glyph, not after a CMap repeats a ligature millions of times.
  return text
    .replace(/[\u0002\u0003\u0093\u0094\u0096-\u0098\ufffe]/g, "")
    .replace(/[\ufb00-\ufb06]/g, (c) => c.normalize("NFKC"));
}

interface Glyph {
  text: string;
  /** Advance in thousandths of an em. */
  width: number;
  /** Single-byte code 32, the only code word spacing (Tw) applies to. */
  space: boolean;
}

interface Font {
  glyphs(bytes: Uint8Array): Iterable<Glyph>;
  /** Above and below the baseline, in thousandths of an em. */
  ascent: number;
  descent: number;
  /** Width of the glyph that shows a space, 0 when no code does. */
  spaceWidth: number;
}

function metrics(
  file: PdfFile,
  descriptor: Dict | undefined
): Pick<Font, "ascent" | "descent"> {
  const ascent = file.number(descriptor?.get("Ascent")) ?? 0;
  const descent = file.number(descriptor?.get("Descent")) ?? 0;
  return ascent > 0 && ascent < 2000 && descent <= 0 && descent > -1000
    ? { ascent, descent }
    : { ascent: 750, descent: -250 };
}

// Advance widths of the standard fonts for codes 32 to 126 (from their AFM
// files), for the files that use them without /Widths.
const STANDARD_WIDTHS: Record<string, string> = {
  helvetica:
    "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 " +
    "556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 " +
    "667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 " +
    "667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 " +
    "556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 " +
    "556 500 722 500 500 500 334 260 334 584",
  helveticaBold:
    "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 " +
    "556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 " +
    "722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 " +
    "667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 " +
    "611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 " +
    "611 556 778 556 556 500 389 280 389 584",
  times:
    "250 333 408 500 500 833 778 180 333 333 500 564 250 333 250 278 500 " +
    "500 500 500 500 500 500 500 500 500 278 278 564 564 564 444 921 722 " +
    "667 667 722 611 556 722 722 333 389 722 611 889 722 722 556 722 667 " +
    "556 611 722 722 944 722 722 611 333 278 333 469 500 333 444 500 444 " +
    "500 444 333 500 500 278 278 500 278 778 500 500 500 500 333 389 278 " +
    "500 500 722 500 500 444 480 200 480 541",
  timesBold:
    "250 333 555 500 500 1000 833 278 333 333 500 570 250 333 250 278 500 " +
    "500 500 500 500 500 500 500 500 500 333 333 570 570 570 500 930 722 " +
    "667 722 722 667 611 778 778 389 500 778 667 944 722 778 611 778 722 " +
    "556 667 722 722 1000 722 722 667 333 278 333 581 500 333 500 556 444 " +
    "556 444 333 500 556 278 333 556 278 833 556 500 556 556 444 389 333 " +
    "556 500 722 500 500 444 394 220 394 520",
  timesItalic:
    "250 333 420 500 500 833 778 214 333 333 500 675 250 333 250 278 500 " +
    "500 500 500 500 500 500 500 500 500 333 333 675 675 675 500 920 611 " +
    "611 667 722 611 611 722 722 333 444 667 556 833 667 722 611 722 611 " +
    "500 556 722 611 833 611 556 556 389 278 389 422 500 333 500 500 444 " +
    "500 444 278 500 500 278 278 444 278 722 500 500 500 500 389 389 278 " +
    "500 444 667 444 444 389 400 275 400 541",
  timesBoldItalic:
    "250 389 555 500 500 833 778 278 333 333 500 570 250 333 250 278 500 " +
    "500 500 500 500 500 500 500 500 500 333 333 570 570 570 500 832 667 " +
    "667 667 722 667 667 722 778 389 500 667 611 889 722 722 611 722 667 " +
    "556 611 722 667 889 667 611 611 333 278 333 570 500 333 500 500 444 " +
    "500 444 333 500 556 278 278 500 278 778 556 500 500 500 389 389 278 " +
    "556 444 667 500 444 389 348 220 348 570",
};
const standardWidths = new Map<string, number[]>();

/** The width of a glyph of a standard font, by the text it shows. */
function standardWidth(baseFont: string, text: string): number {
  if (/Courier/i.test(baseFont)) return 600;
  const family = /Times/i.test(baseFont) ? "times" : "helvetica";
  const style =
    (/Bold/i.test(baseFont) ? "Bold" : "") +
    (family === "times" && /Italic|Oblique/i.test(baseFont) ? "Italic" : "");
  const key = family + style;
  let widths = standardWidths.get(key);
  if (!widths) {
    widths = STANDARD_WIDTHS[key]!.split(" ").map(Number);
    standardWidths.set(key, widths);
  }
  const code = text.normalize("NFD").charCodeAt(0);
  return code >= 32 && code <= 126 ? widths[code - 32]! : 500;
}

function simpleFont(
  file: PdfFile,
  dict: Dict,
  toUnicode: CMap | undefined
): Font {
  const encoding = file.resolve(dict.get("Encoding"));
  const baseName =
    encoding instanceof Name
      ? encoding.name
      : file.name((encoding as Dict | null)?.get?.("BaseEncoding"));
  const codes = [...(ENCODINGS[baseName ?? ""] ?? ENCODINGS.StandardEncoding!)];
  const differences =
    encoding instanceof Map
      ? file.array(encoding.get("Differences"))
      : undefined;
  let code = 0;
  for (const item of differences ?? []) {
    if (--file.operations < 0) break;
    const value = file.resolve(item);
    if (typeof value === "number") code = value;
    else if (value instanceof Name && code >= 0 && code < 256)
      codes[code++] = glyphText(value.name);
  }
  const widths = file.array(dict.get("Widths"));
  const firstChar = file.number(dict.get("FirstChar")) ?? 0;
  const descriptor = file.dict(dict.get("FontDescriptor"));
  const baseFont = file.name(dict.get("BaseFont")) ?? "";
  const matrix = file.array(dict.get("FontMatrix"));
  const scale = matrix ? (file.number(matrix[0]) ?? 0.001) * 1000 : 1;
  const text = (code: number) =>
    (toUnicode &&
      (lookup(file, toUnicode, code, 1) ?? lookup(file, toUnicode, code, 2))) ||
    codes[code] ||
    unmapped(code);
  const advance = new Float64Array(256);
  if (widths) {
    advance.fill(file.number(descriptor?.get("MissingWidth")) ?? 0);
    for (
      let code = Math.max(0, firstChar);
      code < 256 && code - firstChar < widths.length;
      code++
    ) {
      const width = file.number(widths[code - firstChar]);
      if (width !== undefined) advance[code] = width;
    }
  } else {
    for (let code = 0; code < 256; code++) {
      advance[code] = standardWidth(baseFont, codes[code] || " ");
    }
  }
  const glyphs = Array.from({ length: 256 }, (_, code) => ({
    text: extractedText(text(code)),
    width: advance[code]! * scale,
    space: code === 32,
  }));
  const space = glyphs.findIndex((glyph) => glyph.text === " ");
  return {
    ...metrics(file, descriptor),
    spaceWidth: space < 0 ? 0 : glyphs[space]!.width,
    *glyphs(bytes) {
      for (const byte of bytes) yield glyphs[byte]!;
    },
  };
}

function compositeFont(
  file: PdfFile,
  dict: Dict,
  toUnicode: CMap | undefined
): Font {
  const encoding = file.resolve(dict.get("Encoding"));
  let spaces: CMap["spaces"] = [[2, 0, 0xffff]];
  if (encoding instanceof Stream) {
    const embedded = file.cmap(encoding)?.spaces;
    if (embedded?.length) spaces = embedded;
  } else if (
    encoding instanceof Name &&
    !encoding.name.startsWith("Identity") &&
    toUnicode?.spaces.length
  ) {
    spaces = toUnicode.spaces;
  }
  const identity =
    encoding instanceof Name && encoding.name.startsWith("Identity");
  const descendant = file.dict(
    file.array(dict.get("DescendantFonts"))?.[0] ?? null
  );
  const defaultWidth = file.number(descendant?.get("DW")) ?? 1000;
  const widths = new Map<number, number>();
  const w = file.array(descendant?.get("W")) ?? [];
  for (
    let i = 0;
    i < w.length && widths.size < 65536 && file.operations > 0;

  ) {
    const first = file.number(w[i]);
    const next = file.resolve(w[i + 1]);
    if (first === undefined) break;
    if (Array.isArray(next)) {
      for (let k = 0; k < next.length && widths.size < 65536; k++) {
        if ((file.operations -= 16) < 0) break;
        widths.set(first + k, file.number(next[k]) ?? defaultWidth);
      }
      i += 2;
    } else {
      // Counted from 0: past 2 ** 53, `first + 1` is `first`.
      const count = Math.min((file.number(next) ?? first) - first, 65535);
      const width = file.number(w[i + 2]) ?? defaultWidth;
      for (let k = 0; k <= count; k++) {
        if ((file.operations -= 16) < 0) break;
        widths.set(first + k, width);
      }
      i += 3;
    }
  }
  const lengths = [...new Set(spaces.map(([n]) => n))].sort((a, b) => a - b);
  const width = (code: number) =>
    identity ? (widths.get(code) ?? defaultWidth) : defaultWidth;
  let space = -1;
  file.operations -= toUnicode?.chars.size ?? 0;
  for (const [key, text] of toUnicode?.chars ?? []) {
    if (text === " ") {
      space = key % 2 ** 32;
      break;
    }
  }
  const cache = new Map<number, Glyph>();
  return {
    ...metrics(file, file.dict(descendant?.get("FontDescriptor"))),
    spaceWidth: space < 0 ? 0 : width(space),
    *glyphs(bytes) {
      for (let i = 0; i < bytes.length && file.operations > 0; ) {
        if ((file.operations -= spaces.length) < 0) break;
        let n = lengths.find((length) => {
          const code = bigEndian(bytes.subarray(i, i + length));
          return (
            i + length <= bytes.length &&
            spaces.some(
              ([sn, low, high]) => sn === length && code >= low && code <= high
            )
          );
        });
        n ??= lengths[0]!;
        const code = bigEndian(bytes.subarray(i, i + n));
        i += n;
        const key = codeKey(code, n);
        let glyph = cache.get(key);
        if (!glyph) {
          if ((file.operations -= 16) < 0) break;
          glyph = {
            text: extractedText(
              (toUnicode && lookup(file, toUnicode, code, n)) || unmapped(code)
            ),
            width: width(code),
            space: n === 1 && code === 32,
          };
          if (cache.size < MAX_GLYPHS) cache.set(key, glyph);
        }
        yield glyph;
      }
    },
  };
}

// Content streams ------------------------------------------------------------

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function translate(m: Matrix, x: number, y: number): Matrix {
  return [
    m[0],
    m[1],
    m[2],
    m[3],
    x * m[0] + y * m[2] + m[4],
    x * m[1] + y * m[3] + m[5],
  ];
}

interface GraphicsState {
  ctm: Matrix;
  font: Font | undefined;
  size: number;
  charSpace: number;
  wordSpace: number;
  scale: number;
  leading: number;
  rise: number;
}

type Point = [number, number];

/** A text-showing operator (Tj, TJ, ' or "): pdfium spaces and breaks lines between these. */
interface Run {
  text: string;
  font: Font;
  /** The operator's strings and adjustments, to recognise overprinted text. */
  items: Value[];
  /** Device space: where the operator starts and where its last visible glyph ends. */
  start: Point;
  end: Point;
  direction: Point;
  em: number;
  /** Widths of the first and last glyphs, in thousandths of an em. */
  firstWidth: number;
  lastWidth: number;
}

function sameItems(a: Value[], b: Value[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!(x instanceof Uint8Array && y instanceof Uint8Array)) {
      if (x !== y) return false;
      continue;
    }
    if (x.length !== y.length) return false;
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
  }
  return true;
}

function normalizeThreshold(width: number, a: number, b: number, c: number) {
  return width / (width < a ? 2 : width < b ? 4 : width < c ? 5 : 6);
}

/**
 * A TJ adjustment of this many thousandths of an em starts a word: half the
 * font's space, or a share of the glyph's width when the space is missing or
 * wider than a third of an em.
 */
function kerningThreshold(font: Font, width: number): number {
  const space = font.spaceWidth;
  return space > 0 && space <= 1000 / 3
    ? space / 2
    : normalizeThreshold(width, 300, 500, 700);
}

/**
 * Joins text runs into a page's text the way pdfium's text extraction does,
 * which is what count_tokens charges for (core/fpdftext/cpdf_textpage.cpp):
 * its thresholds for a space and for a new line between two runs, its
 * rejoining of a word hyphenated across lines, and its skipping of a run
 * drawn again on top of itself (fake bold).
 */
class TextSink {
  private text = "";
  private lineStart = 0;
  private last: Run | undefined;
  private readonly recent: Run[] = [];

  add(run: Run) {
    const overprint = this.recent.some(
      (other) =>
        Math.abs(run.start[0] - other.start[0]) <=
          0.9 * (other.lastWidth / 1000) * other.em &&
        Math.abs(run.start[1] - other.start[1]) <= other.em / 8 &&
        other.font === run.font &&
        other.em === run.em &&
        sameItems(other.items, run.items)
    );
    if (overprint) return;
    this.recent.push(run);
    if (this.recent.length > 5) this.recent.shift();
    if (!run.text) return;
    const last = this.last;
    if (last) {
      const x = run.start[0] - last.end[0];
      const y = run.start[1] - last.end[1];
      const [dx, dy] = last.direction;
      const along = x * dx + y * dy;
      const across = y * dx - x * dy;
      const lastWidth = (last.lastWidth / 1000) * last.em;
      const firstWidth = (run.firstWidth / 1000) * run.em;
      const shift = Math.max(lastWidth, firstWidth) / 4;
      const turned = run.direction[0] * dx + run.direction[1] * dy < 0.9;
      // A baseline move within the last run's glyph box keeps the line.
      const above = Math.max(2 * shift, (last.font.ascent / 1000) * last.em);
      const below = Math.min(-3 * shift, (last.font.descent / 1000) * last.em);
      if (turned || across > above || across < below) {
        this.breakLine(run.text);
      } else if (!this.text.endsWith(" ") && !run.text.startsWith(" ")) {
        const wider = Math.max(last.lastWidth, run.firstWidth);
        const gap =
          (normalizeThreshold(wider, 400, 700, 800) / 1000) *
          (last.lastWidth >= run.firstWidth ? last.em : run.em);
        if (
          Math.abs(along) > gap &&
          (Math.abs(along + lastWidth) > gap + lastWidth || along > firstWidth)
        ) {
          this.text += " ";
        }
      }
    }
    this.text += run.text;
    this.last = run;
  }

  private breakLine(next: string) {
    // A letter, a hyphen and then a letter or digit: one word split across lines.
    const tail = /\p{L}[-\u00ad] *$/u.exec(this.text.slice(-64));
    if (
      tail &&
      this.text.length - this.lineStart >= tail[0].length &&
      /^[\p{L}\p{N}]/u.test(next)
    ) {
      this.text = this.text.slice(0, this.text.length - tail[0].length + 1);
      return;
    }
    this.text += "\n";
    this.lineStart = this.text.length;
  }

  finish(): string {
    return this.text
      .split("\n")
      .map((line) => line.replace(/ +/g, " "))
      .filter((line) => line.trim())
      .join("\n")
      .trim();
  }
}

class TextExtractor {
  private readonly forms = new Set<Stream>();
  private tm: Matrix = [1, 0, 0, 1, 0, 0];
  private tlm: Matrix = [1, 0, 0, 1, 0, 0];
  private state: GraphicsState = {
    ctm: [1, 0, 0, 1, 0, 0],
    font: undefined,
    size: 0,
    charSpace: 0,
    wordSpace: 0,
    scale: 1,
    leading: 0,
    rise: 0,
  };
  readonly sink = new TextSink();

  constructor(
    private readonly file: PdfFile,
    private readonly clip: Box
  ) {}

  private font(resources: Dict | undefined, name: Value): Font | undefined {
    const named = this.file.dict(resources?.get("Font"));
    const dict =
      name instanceof Name ? this.file.dict(named?.get(name.name)) : undefined;
    if (!dict) return undefined;
    const fonts = this.file.fonts;
    if (!fonts.has(dict)) {
      const stream = this.file.resolve(dict.get("ToUnicode"));
      const toUnicode =
        stream instanceof Stream ? this.file.cmap(stream) : undefined;
      // A file can name a new font for every Tf: each costs its tables, and
      // only the most recent are kept.
      this.file.operations -= FONT_COST;
      if (this.file.operations < 0) return undefined;
      if (fonts.size >= MAX_FONTS) fonts.delete(fonts.keys().next().value!);
      fonts.set(
        dict,
        this.file.name(dict.get("Subtype")) === "Type0"
          ? compositeFont(this.file, dict, toUnicode)
          : simpleFont(this.file, dict, toUnicode)
      );
    }
    return fonts.get(dict);
  }

  /** A Tj or TJ: strings, and TJ adjustments in thousandths of an em. */
  private show(items: Value[]) {
    const state = this.state;
    const font = state.font;
    if (!font) return;
    const m = multiply(this.tm, state.ctm);
    const point = (x: number, y: number): Point => [
      x * m[0] + y * m[2] + m[4],
      x * m[1] + y * m[3] + m[5],
    ];
    const length = Math.hypot(m[0], m[1]) || 1;
    const bottom = state.rise + (font.descent / 1000) * state.size;
    const top = state.rise + (font.ascent / 1000) * state.size;
    const run: Run = {
      text: "",
      font,
      items,
      start: point(0, state.rise),
      end: point(0, state.rise),
      direction: [m[0] / length, m[1] / length],
      em: Math.abs(state.size) * Math.hypot(m[2], m[3]),
      firstWidth: 0,
      lastWidth: 0,
    };
    let x = 0;
    let kerning = 0;
    let glyphs = 0;
    for (const item of items) {
      if (--this.file.operations < 0) break;
      if (typeof item === "number") {
        kerning -= item;
        x -= (item / 1000) * state.size * state.scale;
        continue;
      }
      if (!(item instanceof Uint8Array)) continue;
      const file = this.file;
      for (const glyph of font.glyphs(item)) {
        if ((file.operations -= Math.max(1, glyph.text.length)) < 0) break;
        const width = (glyph.width / 1000) * state.size * state.scale;
        // Renderers drop text outside the visible page, so its tokens are not charged.
        if (this.visible(m, x, x + width, bottom, top)) {
          if (
            kerning &&
            glyphs > 0 &&
            run.text &&
            !run.text.endsWith(" ") &&
            kerning >= kerningThreshold(font, glyph.width)
          ) {
            run.text += " ";
          }
          if (!run.text) run.firstWidth = glyph.width;
          run.text += glyph.text;
          if ((file.textLeft -= glyph.text.length) < 0) file.operations = 0;
          run.lastWidth = glyph.width;
          run.end = point(x + width, state.rise);
        }
        kerning = 0;
        glyphs++;
        x +=
          width +
          (state.charSpace + (glyph.space ? state.wordSpace : 0)) * state.scale;
      }
    }
    this.sink.add(run);
    this.tm = translate(this.tm, x, 0);
  }

  /** Whether the box from x0 to x1 and bottom to top in text space, mapped by m, meets the clip box. */
  private visible(
    m: Matrix,
    x0: number,
    x1: number,
    bottom: number,
    top: number
  ): boolean {
    const [left, low, right, high] = this.clip;
    const ax = x0 * m[0] + m[4];
    const bx = x1 * m[0] + m[4];
    const cx = Math.min(bottom * m[2], top * m[2]);
    const dx = Math.max(bottom * m[2], top * m[2]);
    if (Math.min(ax, bx) + cx >= right || Math.max(ax, bx) + dx <= left) {
      return false;
    }
    const ay = x0 * m[1] + m[5];
    const by = x1 * m[1] + m[5];
    const cy = Math.min(bottom * m[3], top * m[3]);
    const dy = Math.max(bottom * m[3], top * m[3]);
    return Math.min(ay, by) + cy < high && Math.max(ay, by) + dy > low;
  }

  private nextLine(x: number, y: number) {
    this.tlm = translate(this.tlm, x, y);
    this.tm = this.tlm;
  }

  run(data: Uint8Array, resources: Dict | undefined, depth: number) {
    const file = this.file;
    const lexer = new Lexer(data, 0, file);
    const operands: Value[] = [];
    const saved: GraphicsState[] = [];
    const n = (i: number) => {
      const value = operands[operands.length - i];
      return typeof value === "number" ? value : 0;
    };
    for (let token = lexer.next(); token !== undefined; token = lexer.next()) {
      if (
        !(token instanceof Keyword) ||
        token === ARRAY_OPEN ||
        token === DICT_OPEN
      ) {
        if (operands.length > 64) operands.length = 0;
        operands.push(parse(lexer, token, false));
        continue;
      }
      const state = this.state;
      switch (token.word) {
        case "q":
          if (saved.length < 256) saved.push({ ...state });
          break;
        case "Q":
          this.state = saved.pop() ?? state;
          break;
        case "cm":
          state.ctm = multiply([n(6), n(5), n(4), n(3), n(2), n(1)], state.ctm);
          break;
        case "BT":
          this.tm = this.tlm = [1, 0, 0, 1, 0, 0];
          break;
        case "Tf":
          state.font = this.font(
            resources,
            operands[operands.length - 2] ?? null
          );
          state.size = n(1);
          break;
        case "Tc":
          state.charSpace = n(1);
          break;
        case "Tw":
          state.wordSpace = n(1);
          break;
        case "Tz":
          state.scale = n(1) / 100;
          break;
        case "TL":
          state.leading = n(1);
          break;
        case "Ts":
          state.rise = n(1);
          break;
        case "Td":
          this.nextLine(n(2), n(1));
          break;
        case "TD":
          state.leading = -n(1);
          this.nextLine(n(2), n(1));
          break;
        case "Tm":
          this.tm = this.tlm = [n(6), n(5), n(4), n(3), n(2), n(1)];
          break;
        case "T*":
          this.nextLine(0, -state.leading);
          break;
        case "Tj":
          this.show(operands.slice(-1));
          break;
        case "'":
          this.nextLine(0, -state.leading);
          this.show(operands.slice(-1));
          break;
        case '"':
          state.wordSpace = n(3);
          state.charSpace = n(2);
          this.nextLine(0, -state.leading);
          this.show(operands.slice(-1));
          break;
        case "TJ": {
          const items = operands[operands.length - 1];
          if (Array.isArray(items)) this.show(items);
          break;
        }
        case "Do": {
          const name = operands[operands.length - 1];
          const xobjects = file.dict(resources?.get("XObject"));
          const form =
            name instanceof Name
              ? file.resolve(xobjects?.get(name.name))
              : null;
          if (
            form instanceof Stream &&
            file.name(form.dict.get("Subtype")) === "Form" &&
            depth < MAX_FORM_DEPTH &&
            !this.forms.has(form)
          ) {
            const content = file.decode(form);
            if (content) {
              const matrix = file
                .array(form.dict.get("Matrix"))
                ?.map((v) => file.number(v) ?? 0);
              const outer = { ...state };
              const { tm, tlm } = this;
              if (matrix?.length === 6)
                state.ctm = multiply(matrix as Matrix, state.ctm);
              this.forms.add(form);
              this.run(
                content,
                file.dict(form.dict.get("Resources")) ?? resources,
                depth + 1
              );
              this.forms.delete(form);
              this.state = outer;
              this.tm = tm;
              this.tlm = tlm;
            }
          }
          break;
        }
        case "ID": {
          // Inline image data: binary bytes up to the whitespace before `EI`.
          let end = lexer.pos + 1;
          for (;;) {
            end = find(data, EI_BYTES, end);
            if (end < 0) return;
            const after = data[end + 2];
            if (
              CHAR_CLASS[data[end - 1]!] === WHITESPACE &&
              (after === undefined || CHAR_CLASS[after] !== REGULAR)
            ) {
              break;
            }
            end += 2;
          }
          lexer.pos = end + 2;
          break;
        }
      }
      operands.length = 0;
    }
  }
}

const EI_BYTES = ascii("EI");

function pageText(file: PdfFile, page: PageNode, box: Box): string {
  const contents = file.resolve(page.dict.get("Contents"));
  const parts: Uint8Array[] = [];
  for (const item of Array.isArray(contents) ? contents : [contents]) {
    if (file.operations < 0) break;
    const stream = file.resolve(item);
    const data = stream instanceof Stream ? file.decode(stream) : undefined;
    if (stream instanceof Stream && data === undefined) return "";
    if (data) parts.push(data, NEWLINE);
  }
  const data = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0)
  );
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  const extractor = new TextExtractor(file, box);
  extractor.run(data, file.dict(page.resources), 0);
  return extractor.sink.finish();
}

const NEWLINE = ascii("\n");

/** The CropBox clipped to the MediaBox: the part of the page a renderer shows. */
function visibleBox(file: PdfFile, page: PageNode): Box {
  const media = file.box(page.mediaBox) ?? LETTER;
  const crop = file.box(page.cropBox);
  if (!crop) return media;
  const clipped: Box = [
    Math.max(crop[0], media[0]),
    Math.max(crop[1], media[1]),
    Math.min(crop[2], media[2]),
    Math.min(crop[3], media[3]),
  ];
  return clipped[2] > clipped[0] && clipped[3] > clipped[1] ? clipped : media;
}

/**
 * Pages of a PDF, best effort, never throws. undefined when the bytes are not
 * a PDF or the page tree cannot be found. Pages whose content cannot be decoded
 * have empty text. Work and output are capped for hostile or oversized files.
 */
export function readPdf(bytes: Uint8Array): { pages: PdfPage[] } | undefined {
  try {
    const header = find(
      bytes.subarray(0, 1024 + PDF_HEADER.length),
      PDF_HEADER,
      0
    );
    if (header < 0) return undefined;
    const file = new PdfFile(bytes, header);
    const nodes = file.pageNodes();
    if (nodes.length === 0) return undefined;
    let textLeft = MAX_TEXT;
    const pages = nodes.map((node) => {
      const box = visibleBox(file, node);
      const quarterTurns = Math.round((file.number(node.rotate) ?? 0) / 90);
      const [width, height] =
        ((quarterTurns % 4) + 4) % 2
          ? [box[3] - box[1], box[2] - box[0]]
          : [box[2] - box[0], box[3] - box[1]];
      let text = "";
      if (!file.encrypted) {
        try {
          text = pageText(file, node, box).slice(0, textLeft);
          textLeft -= text.length;
        } catch {
          // A page whose content cannot be read still counts as a page.
        }
      }
      return { width, height, text };
    });
    return { pages };
  } catch {
    return undefined;
  }
}
