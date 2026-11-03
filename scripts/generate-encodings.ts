/**
 * Generate the tiktoken-style encodings from the JSON files in src/encoding/.
 *
 * Each module embeds its tables as one JSON string and builds them on first
 * use (see src/lazy.ts and scripts/encoding-source.ts).
 *
 * Usage:
 *   bun scripts/generate-encodings.ts
 */

import * as fs from "fs";
import * as path from "path";
import {
  bpeModuleSource,
  formatSource,
  tiktokenBytesByRank,
} from "./encoding-source";

const ENCODING_DIR = path.join(import.meta.dirname, "../src/encoding");

// Find all .json files in the encoding directory
const jsonFiles = fs
  .readdirSync(ENCODING_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => path.join(ENCODING_DIR, f));

if (jsonFiles.length === 0) {
  console.log("No .json files found in src/encoding/");
  process.exit(1);
}

for (const inputFile of jsonFiles) {
  const name = path.basename(inputFile, ".json");
  const source = JSON.parse(fs.readFileSync(inputFile, "utf-8"));

  const bytesByRank = tiktokenBytesByRank(source.bpe_ranks);

  const outputFile = inputFile.replace(".json", ".ts");
  const code = await formatSource(
    outputFile,
    bpeModuleSource({
      name,
      generator: "scripts/generate-encodings.ts",
      patStr: source.pat_str,
      specialTokens: source.special_tokens,
      bytesByRank,
    })
  );
  fs.writeFileSync(outputFile, code);
  console.log(`${name}: ${outputFile} (${(code.length / 1e6).toFixed(2)} MB)`);
}

console.log(`Generated ${jsonFiles.length} encoding(s)`);
