/**
 * Exactness of the llama4 and gemma4 encodings.
 *
 * fixtures/hf-reference.json holds the token count and an FNV-1a hash of the
 * token ids that Hugging Face `tokenizers` produced for every sample in
 * fixtures/hf-corpus.json. Rebuild it with `bun scripts/compare-hf.ts fixture`.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Corpus,
  FIXTURE_DIR,
  hashIds,
  sampleText,
} from "../scripts/hf-fixture";
import { SOURCES } from "../scripts/hf-sources";
import Tokenizer from "./tokenizer";
import * as llama4 from "./encoding/llama4";
import * as gemma4 from "./encoding/gemma4";

interface Reference {
  source: unknown;
  /** [token count, hash of token ids] per corpus sample. */
  samples: Array<[number, number]>;
  /** Token ids per corpus special text. */
  special: number[][];
}

const corpus: Corpus = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "hf-corpus.json"), "utf-8")
);
const references: Record<string, Reference> = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "hf-reference.json"), "utf-8")
).encodings;

interface Subject {
  name: string;
  encode: (text: string) => number[];
  encodeWithSpecial: (text: string) => number[];
  /** Why a sample is not checked, when the engine has a known bug. */
  skipReason: (sampleName: string) => string | undefined;
}

// The default engine runs llama4. Both bugs are in src/tokenizer.ts and not in
// the encoding. Remove the skips once they are fixed there.
const llama4SkipReason = (sampleName: string): string | undefined => {
  // Quadratic time on a long run of one character (issue #6).
  if (sampleName.startsWith("long/")) return "slow engine";
  // TextDecoder drops a leading BOM when the engine looks up a rank (PR #8).
  if (sampleName === "edge/\\ufeffx") return "BOM rank lookup";
  return undefined;
};

const llama4Tokenizer = new Tokenizer(llama4);
const llama4Special = Object.keys(llama4.special_tokens);
const gemma4Tokenizer = new Tokenizer(gemma4);
const gemma4Special = Object.keys(gemma4.special_tokens);

const subjects: Subject[] = [
  {
    name: "llama4",
    encode: (text) => llama4Tokenizer.encode(text, [], []),
    encodeWithSpecial: (text) =>
      llama4Tokenizer.encode(text, llama4Special, []),
    skipReason: llama4SkipReason,
  },
  {
    name: "gemma4",
    encode: (text) => gemma4Tokenizer.encode(text, [], []),
    encodeWithSpecial: (text) =>
      gemma4Tokenizer.encode(text, gemma4Special, []),
    skipReason: () => undefined,
  },
];

for (const subject of subjects) {
  describe(`${subject.name} against Hugging Face tokenizers`, () => {
    const reference = references[subject.name]!;

    test("fixture was recorded for the pinned revision", () => {
      expect(reference.source).toEqual(SOURCES[subject.name]);
      expect(reference.samples.length).toBe(corpus.samples.length);
      expect(reference.special.length).toBe(corpus.special.length);
    });

    test("every sample has the reference token count and ids", () => {
      const mismatches: string[] = [];
      let exact = 0;
      const skipped: string[] = [];
      let tokens = 0;
      corpus.samples.forEach((sample, i) => {
        const reason = subject.skipReason(sample.name);
        if (reason !== undefined) {
          skipped.push(`${sample.name} (${reason})`);
          return;
        }
        const ids = subject.encode(sampleText(sample));
        const [count, hash] = reference.samples[i]!;
        if (ids.length === count && hashIds(ids) === hash) {
          exact++;
          tokens += count;
        } else {
          mismatches.push(
            `${sample.name}: ${ids.length} tokens, want ${count}`
          );
        }
      });
      console.log(
        `${subject.name}: ${exact}/${exact + mismatches.length} samples exact, ${tokens} tokens, ${skipped.length} skipped`
      );
      expect(mismatches).toEqual([]);
    }, 120_000);

    test("special tokens encode to their ids", () => {
      corpus.special.forEach((text, i) => {
        expect({ text, ids: subject.encodeWithSpecial(text) }).toEqual({
          text,
          ids: reference.special[i]!,
        });
      });
    });
  });
}
