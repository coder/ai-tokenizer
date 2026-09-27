/**
 * Merge-cache eviction benchmark.
 *
 * Encodes many texts made of distinct non-vocabulary pieces, so most pieces
 * miss the cache and the default 100k-entry cache stays full and evicting.
 */

import { Tokenizer } from "../src/index";
import * as o200k from "../src/encoding/o200k_base";

const COUNT = 500_000;

let seed = 1;
function rand(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed >>> 8;
}

// Random letter runs (like base64 or identifier noise) are single regex
// pieces that are almost never in the vocabulary. Digits are split into
// 3-digit pieces by the pattern, so long numbers alone would not miss.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
function word(): string {
  let out = "";
  for (let i = 0; i < 12; i++) out += ALPHABET[rand() % ALPHABET.length];
  return out;
}

const texts: string[] = [];
for (let i = 0; i < COUNT; i++) {
  texts.push(`token ${word()} ${word()}`);
}

const tokenizer = new Tokenizer(o200k);
const start = performance.now();
let total = 0;
for (const text of texts) {
  total += tokenizer.encode(text).length;
}
const ms = performance.now() - start;
console.log(`${COUNT} texts, ${total} tokens, ${ms.toFixed(0)} ms`);
