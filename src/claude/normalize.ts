/**
 * Text to the marked stream that ./codec.ts tiles, and the marked stream back
 * to text for decode. Port of ctok's normalize.py and constants.py.
 *
 * Python indexes strings by codepoint, so every rule here works on codepoint
 * arrays and index ranges. The Unicode facts come from ./unicode.ts, which
 * holds ctok's own answers for Unicode 15.1, so no rule asks the JS engine.
 */
import { ASSIGNED, CCC, CLASS, FACT_RUNS, FLAG, LOWER } from "./unicode";

export const BOW = 0xfdd0;
export const EOW = 0xfdd1;
export const SHIFT = 0xfdd3;
export const CAPS = 0xfdd4;

/**
 * Literal U+FDD0..U+FDD4 in the text become U+E000..U+E004. nfc() strips BMP
 * private use, so the escapes cannot collide with text.
 */
const LITERAL = 0xfdd0;
const ESCAPE = 0xe000;
export const escapeLiteral = (cp: number) =>
  cp >= LITERAL && cp <= LITERAL + 4 ? ESCAPE + cp - LITERAL : cp;
export const unescapeLiteral = (cp: number) =>
  cp >= ESCAPE && cp <= ESCAPE + 4 ? LITERAL + cp - ESCAPE : cp;

export interface StreamRules {
  readonly foldQuotes: boolean;
  /** Shortest all-caps word that takes CAPS. null: never (ctok v4.7 and later). */
  readonly allcapsMin: number | null;
  /** The frame ends in a BOW that absorbs one raw leading space. */
  readonly frameBow: boolean;
}

export interface MarkedText {
  readonly stream: number[];
  /** The content-final newlines, cut from the stream for the frame tail. */
  readonly tailNewlines: number;
}

const FACTS = new Uint16Array(0x10000);
for (let k = 0, cp = 0; k < FACT_RUNS.length; k += 2) {
  const last = FACT_RUNS[k]!;
  FACTS.fill(FACT_RUNS[k + 1]!, cp, last + 1);
  cp = last + 1;
}
const LOWER_OF = new Map<number, number>();
for (let k = 0; k < LOWER.length; k += 2)
  LOWER_OF.set(LOWER[k]!, LOWER[k + 1]!);

/** ctok asks no category question of an astral codepoint: HARD, no flags. */
function facts(cp: number): number {
  return cp < 0x10000 ? FACTS[cp]! : CLASS.HARD;
}

// A sixth run class next to the five stream classes (ctok's _STRAY_MARK).
const STRAY = 5;
const classOf = (cp: number) => facts(cp) & 7;
const has = (cp: number, flag: number) => (facts(cp) & flag) !== 0;
const isSelector = (cp: number) => cp >= 0xfe00 && cp <= 0xfe0f;

function lower(cp: number): number {
  if (cp === 0x130) throw new Error("ctok never lowers U+0130");
  return LOWER_OF.get(cp) ?? cp;
}

function assigned(cp: number): boolean {
  let lo = 0;
  let hi = ASSIGNED.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ASSIGNED[mid * 2 + 1]! < cp) lo = mid + 1;
    else hi = mid;
  }
  return lo * 2 < ASSIGNED.length && ASSIGNED[lo * 2]! <= cp;
}

/** Canonical combining class of a codepoint, 0 for a starter. */
function ccc(cp: number): number {
  let lo = 0;
  let hi = CCC.length / 3;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (CCC[mid * 3 + 1]! < cp) lo = mid + 1;
    else hi = mid;
  }
  return lo * 3 < CCC.length && CCC[lo * 3]! <= cp ? CCC[lo * 3 + 2]! : 0;
}

/** The marks of one run, stably sorted by class. */
function sortMarks(marks: string): string {
  const chars = Array.from(marks);
  const classes = chars.map((ch) => ccc(ch.codePointAt(0)!));
  const order = chars
    .map((_, k) => k)
    .sort((a, b) => classes[a]! - classes[b]!);
  return order.map((k) => chars[k]!).join("");
}

/**
 * Sorts every run of marks by class before the engine's NFC. ICU and JSC order
 * a run by insertion, which is quadratic when it is out of order. The NFC text
 * stays the same: NFC stable-sorts each run by class too, and decomposing a
 * mark never changes its class (ctok-export.py asserts that).
 */
function orderMarks(text: string): string {
  let out = "";
  let copied = 0;
  let runStart = 0;
  let prev = 0;
  let ordered = true;
  for (let i = 0; i <= text.length; ) {
    // A starter past the end closes the last run.
    const cp = i < text.length ? text.codePointAt(i)! : 0;
    const cls = cp < CCC[0]! ? 0 : ccc(cp);
    if (cls === 0) {
      if (!ordered) {
        out +=
          text.slice(copied, runStart) + sortMarks(text.slice(runStart, i));
        copied = i;
        ordered = true;
      }
    } else if (prev === 0) {
      runStart = i;
    } else if (cls < prev) {
      ordered = false;
    }
    prev = cls;
    i += cp > 0xffff ? 2 : 1;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

const NON_ASCII = /[^\x00-\x7f]/;
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const STRIP_CONTROL = /[\x01-\x08\x0b-\x1f\x7f-\x9f]/g;
const STRIP_PRIVATE = /[\ue000-\uf8ff]/g;
const FUNNY_SPACE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f]/g;

/**
 * NFC as Python's Unicode 15.1 data does it. A codepoint unassigned in 15.1
 * is a starter with no mappings there, so it splits the text into runs that
 * the engine may normalize alone. Normalization stability makes the engine
 * agree with 15.1 inside each run.
 */
function pinnedNfc(text: string): string {
  if (!NON_ASCII.test(text)) return text;
  text = orderMarks(text);
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    if (cp >= 0x80 && !assigned(cp)) {
      out += text.slice(from, i).normalize("NFC") + text.slice(i, i + width);
      from = i + width;
    }
    i += width;
  }
  return out + text.slice(from).normalize("NFC");
}

/** ctok nfc(): the measured text normalization, in ctok's order. */
function nfc(text: string, foldQuotes: boolean): string {
  text = pinnedNfc(text.replace(LONE_SURROGATE, "\ufffd"));
  text = text.replace(STRIP_CONTROL, "").replace(/\0/g, " ");
  text = text.replace(/\u0e4d\u0e32/g, "\u0e33");
  text = text.replace(STRIP_PRIVATE, "");
  if (foldQuotes) {
    text = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
  }
  return text.replace(FUNNY_SPACE, " ");
}

interface Run {
  readonly kind: number;
  readonly start: number;
  readonly end: number;
}

/** ctok _runs(): class runs, stray-mark runs, then HARD runs split by kind. */
function splitRuns(s: Uint32Array): Run[] {
  if (s.length === 0) return [];
  const runs: Run[] = [];
  let start = 0;
  let kind = has(s[0]!, FLAG.strayMark) ? STRAY : classOf(s[0]!);
  for (let k = 1; k < s.length; k++) {
    const cp = s[k]!;
    const c = classOf(cp);
    const stray = has(cp, FLAG.strayMark);
    if ((kind === STRAY && stray) || c === kind) continue;
    runs.push({ kind, start, end: k });
    start = k;
    kind = stray && kind !== CLASS.WORDY ? STRAY : c;
  }
  runs.push({ kind, start, end: s.length });

  const split: Run[] = [];
  for (const run of runs) {
    if (run.kind !== CLASS.HARD || run.end - run.start === 1) {
      split.push(run);
      continue;
    }
    let from = run.start;
    let hk = hardKind(s[from]!);
    for (let k = from + 1; k < run.end; k++) {
      const cp = s[k]!;
      if (isSelector(cp) || hardKind(cp) === hk) continue;
      split.push({ kind: CLASS.HARD, start: from, end: k });
      from = k;
      hk = hardKind(cp);
    }
    split.push({ kind: CLASS.HARD, start: from, end: run.end });
  }
  return split;
}

function hardKind(cp: number): number {
  if (has(cp, FLAG.marksLikePunct)) return 0;
  if (has(cp, FLAG.digitBorder)) return 1;
  return 2;
}

const CONTRACTION_SUFFIXES = ["s", "t", "d", "m", "ll", "re", "ve"].map((x) =>
  Array.from(x, (c) => c.codePointAt(0)!)
);
const APOSTROPHE = 0x27;
const SPACE_CP = 0x20;
const NEWLINE = 0x0a;

/** The stream of one text, for one family. ctok tile()'s head plus stream(). */
export function markText(text: string, rules: StreamRules): MarkedText {
  const norm = nfc(text, rules.foldQuotes);
  const all = new Uint32Array(norm.length);
  let n = 0;
  for (const ch of norm) all[n++] = escapeLiteral(ch.codePointAt(0)!);
  let end = n;
  while (end > 0 && all[end - 1] === NEWLINE) end--;
  const tailNewlines = n - end;
  let start = 0;
  if (
    rules.frameBow &&
    text.startsWith(" ") &&
    end > 0 &&
    all[0] === SPACE_CP &&
    !(end > 1 && all[1] === SPACE_CP)
  ) {
    start = 1;
  }
  return { stream: markRuns(all.subarray(start, end), rules), tailNewlines };
}

/** ctok stream_norm() after its head rules: runs to markers, then the seam. */
function markRuns(s: Uint32Array, rules: StreamRules): number[] {
  const runs = splitRuns(s);
  if (runs.length === 0) return rules.frameBow ? [BOW] : [];
  const out: number[] = [];
  const body = (r: Run) => {
    for (let k = r.start; k < r.end; k++) out.push(s[k]!);
  };
  const first = (r: Run) => s[r.start]!;
  const last = (r: Run) => s[r.end - 1]!;
  const isApostrophe = (r: Run) =>
    r.end - r.start === 1 && first(r) === APOSTROPHE;

  const hardBow = (r: Run) =>
    isSelector(first(r)) || has(first(r), FLAG.marksLikePunct);
  const hardEow = (r: Run) =>
    isSelector(last(r)) || has(last(r), FLAG.marksLikePunct);
  // Astral digits never take border markers, so reading them as non-digits
  // (facts() gives them no flags) leaves the stream unchanged.
  const digitRun = (r: Run) => {
    const cat = facts(first(r)) & (FLAG.nd | FLAG.no);
    if (cat === 0) return false;
    for (let k = r.start + 1; k < r.end; k++) {
      if ((facts(s[k]!) & (FLAG.nd | FLAG.no)) !== cat) return false;
    }
    return true;
  };
  const digitBow = (r: Run) => digitRun(r) && has(first(r), FLAG.digitBorder);
  const digitEow = (r: Run) => digitRun(r) && has(last(r), FLAG.digitBorder);
  const takesRightBorder = (r: Run) =>
    r.kind === CLASS.PUNCT ||
    hardEow(r) ||
    ((r.kind === CLASS.DIGIT || r.kind === CLASS.HARD) &&
      digitRun(r) &&
      digitEow(r));
  const opensWord = (i: number) =>
    isApostrophe(runs[i]!) &&
    i + 1 < runs.length &&
    (runs[i + 1]!.kind === CLASS.WORDY || runs[i + 1]!.kind === STRAY);
  const contractionSeam = (i: number) => {
    const r = runs[i]!;
    const suffix = CONTRACTION_SUFFIXES.some(
      (x) =>
        x.length === r.end - r.start &&
        x.every((cp, k) => s[r.start + k] === cp)
    );
    if (!suffix || i === 0) return false;
    const prev = runs[i - 1]!;
    if (prev.kind !== CLASS.PUNCT || !isApostrophe(prev)) return false;
    return i < 2 || !takesRightBorder(runs[i - 2]!);
  };
  const bordersSpace = (i: number, side: -1 | 1) => {
    const j = i + side;
    if (j < 0) return rules.frameBow;
    if (j >= runs.length) return false;
    const r = runs[j]!;
    if (r.kind !== CLASS.SPACE) return false;
    if (side < 0) return last(r) === SPACE_CP;
    return (
      first(r) === SPACE_CP &&
      !(r.end - r.start > 1 && s[r.start + 1] === SPACE_CP)
    );
  };

  const head = runs[0]!;
  const headQuote = opensWord(0);
  const hasOwnBow =
    !headQuote &&
    (head.kind === CLASS.WORDY ||
      head.kind === CLASS.PUNCT ||
      head.kind === STRAY ||
      hardBow(head) ||
      ((head.kind === CLASS.DIGIT || head.kind === CLASS.HARD) &&
        digitBow(head)) ||
      (head.kind === CLASS.SPACE && first(head) === SPACE_CP));
  if (!hasOwnBow && rules.frameBow) out.push(headQuote ? SPACE_CP : BOW);

  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    if (r.kind === CLASS.WORDY) {
      const fused = i > 0 && runs[i - 1]!.kind === STRAY;
      const mark = fused ? 0 : markCase(s, r, rules.allcapsMin);
      if (mark !== 0) out.push(mark);
      if (!fused && !contractionSeam(i)) out.push(BOW);
      if (mark === 0) body(r);
      else writeLowered(s, r, mark, out);
      out.push(EOW);
    } else if (r.kind === STRAY) {
      out.push(BOW);
      body(r);
      if (!(i + 1 < runs.length && runs[i + 1]!.kind === CLASS.WORDY)) {
        out.push(EOW);
      }
    } else if (r.kind === CLASS.PUNCT || hardBow(r) || hardEow(r)) {
      const punct = r.kind === CLASS.PUNCT;
      if (bordersSpace(i, -1) && !opensWord(i) && (punct || hardBow(r))) {
        out.push(BOW);
      }
      body(r);
      if (bordersSpace(i, 1) && (punct || hardEow(r))) out.push(EOW);
    } else if (
      (r.kind === CLASS.DIGIT || r.kind === CLASS.HARD) &&
      digitRun(r)
    ) {
      if (digitBow(r) && bordersSpace(i, -1)) out.push(BOW);
      body(r);
      if (digitEow(r) && bordersSpace(i, 1)) out.push(EOW);
    } else {
      body(r);
    }
  }
  return seam(out);
}

/**
 * ctok mark_case(): the case marker a whole word takes (0 for none). A marked
 * word is written lowered by writeLowered().
 */
function markCase(
  s: Uint32Array,
  r: Run,
  allcapsMin: number | null
): 0 | typeof SHIFT | typeof CAPS {
  let dotted = false;
  for (let k = r.start; k < r.end; k++) {
    if (s[k] === 0x1e9e) return 0;
    if (s[k] === 0x130) dotted = true;
  }
  const head = s[r.start]!;
  const upperAfterHead = (skipDotted: boolean) => {
    for (let k = r.start + 1; k < r.end; k++) {
      if (skipDotted && s[k] === 0x130) continue;
      if (has(s[k]!, FLAG.upper)) return true;
    }
    return false;
  };
  if (dotted) {
    return has(head, FLAG.upper) && head !== 0x130 && !upperAfterHead(true)
      ? SHIFT
      : 0;
  }
  if (allcapsMin !== null && r.end - r.start >= allcapsMin) {
    let cased = false;
    let allUpper = true;
    let unlowerable = false;
    for (let k = r.start; k < r.end; k++) {
      const f = facts(s[k]!);
      if (f & (FLAG.upper | FLAG.lower)) cased = true;
      if ((f & FLAG.lower) !== 0 && (f & FLAG.upper) === 0) allUpper = false;
      if (f & FLAG.unlowerable) unlowerable = true;
    }
    if (cased && allUpper && !unlowerable) return CAPS;
  }
  if (lower(head) === head) return 0;
  return has(head, FLAG.upper) && !upperAfterHead(false) ? SHIFT : 0;
}

/** The lowered body of a word that markCase() marked. U+0130 stays literal. */
function writeLowered(s: Uint32Array, r: Run, mark: number, out: number[]) {
  for (let k = r.start; k < r.end; k++) {
    const cp = s[k]!;
    if (cp === 0x130) {
      out.push(cp);
      continue;
    }
    const low = lower(cp);
    // The CAPS body lowers final sigma like any other sigma.
    out.push(mark === CAPS && low === 0x3c2 ? 0x3c3 : low);
  }
}

/**
 * ctok SEAM_RE: `(.)EOW (SHIFT|CAPS)*BOW` loses its space. `.` is any
 * codepoint but a newline. Compacts in place, left to right like re.sub.
 */
function seam(s: number[]): number[] {
  let w = 0;
  for (let p = 0; p < s.length; ) {
    if (
      p + 2 < s.length &&
      s[p] !== NEWLINE &&
      s[p + 1] === EOW &&
      s[p + 2] === SPACE_CP
    ) {
      let q = p + 3;
      while (q < s.length && (s[q] === SHIFT || s[q] === CAPS)) q++;
      if (q < s.length && s[q] === BOW) {
        s[w++] = s[p]!;
        s[w++] = EOW;
        for (let k = p + 3; k <= q; k++) s[w++] = s[k]!;
        p = q + 1;
        continue;
      }
    }
    s[w++] = s[p++]!;
  }
  s.length = w;
  return s;
}

/**
 * Best-effort inverse of markText() over decoded stream codepoints. BOW goes,
 * EOW before `(SHIFT|CAPS)* BOW` (the seam) is one space, other EOW goes,
 * SHIFT upper-cases the next codepoint and CAPS every codepoint to the next
 * EOW. Escaped literal markers come back.
 */
export function unmark(s: readonly number[]): string {
  const out: string[] = [];
  let shift = false;
  let caps = false;
  for (let k = 0; k < s.length; k++) {
    const cp = s[k]!;
    if (cp === BOW) continue;
    if (cp === SHIFT) shift = true;
    else if (cp === CAPS) caps = true;
    else if (cp === EOW) {
      caps = false;
      let q = k + 1;
      while (q < s.length && (s[q] === SHIFT || s[q] === CAPS)) q++;
      if (q < s.length && s[q] === BOW) out.push(" ");
    } else if (unescapeLiteral(cp) !== cp) {
      out.push(String.fromCodePoint(unescapeLiteral(cp)));
    } else {
      const ch = String.fromCodePoint(cp);
      out.push(shift || caps ? ch.toUpperCase() : ch);
      shift = false;
    }
  }
  return out.join("");
}
