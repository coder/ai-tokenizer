import * as path from "node:path";

export const FIXTURE_DIR = path.join(import.meta.dirname, "../fixtures");

/**
 * A corpus sample is literal text, or a unit repeated `times` times. The
 * second form keeps long inputs small in the file.
 */
export interface CorpusSample {
  name: string;
  text?: string;
  unit?: string;
  times?: number;
}

export interface Corpus {
  samples: CorpusSample[];
  /** Texts with special-token strings, encoded with special tokens allowed. */
  special: string[];
}

export function sampleText(sample: CorpusSample): string {
  if (sample.text !== undefined) return sample.text;
  return sample.unit!.repeat(sample.times!);
}

/** FNV-1a over the token ids, to compare ids without storing them. */
export function hashIds(ids: number[]): number {
  let hash = 2166136261;
  for (const id of ids) {
    hash = Math.imul(hash ^ id, 16777619);
  }
  return hash >>> 0;
}
