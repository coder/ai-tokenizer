/**
 * Generate optimized encodings from JSON files
 * 
 * Generates dual-storage format:
 * - String-based encoder for UTF-8 tokens (JSON.parse for ~2x faster init)
 * - Sorted binary encoder for non-UTF-8 tokens (binary search)
 * - NO decoder (Tokenizer builds it lazily from encoder on first decode())
 * 
 * Usage:
 *   bun run scripts/generate-encodings.ts
 */

import base64 from "base64-js";
import * as fs from "fs";
import * as path from "path";

const ENCODING_DIR = path.join(import.meta.dirname, "../src/encoding");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

/**
 * Try to convert bytes to UTF-8 string with round-trip verification
 */
function tryBytesToString(bytes: Uint8Array): string | undefined {
  try {
    const str = textDecoder.decode(bytes);
    const encoded = textEncoder.encode(str);
    
    if (encoded.length === bytes.length) {
      for (let i = 0; i < bytes.length; i++) {
        if (encoded[i] !== bytes[i]) return undefined;
      }
      return str;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// Find all .json files in the encoding directory
const jsonFiles = fs.readdirSync(ENCODING_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => path.join(ENCODING_DIR, f));

if (jsonFiles.length === 0) {
  console.log("❌ No .json files found in src/encoding/");
  process.exit(1);
}

console.log(`📦 Generating optimized encodings from ${jsonFiles.length} JSON file(s)...\n`);

for (const inputFile of jsonFiles) {
  const name = path.basename(inputFile, ".json");
  console.log(`Processing ${name}...`);
  
  // Read source data
  const source = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
  
  // Parse compressed BPE ranks
  // @ts-expect-error
  const uncompressed = source.bpe_ranks
    .split("\n")
    .filter(Boolean)
    .reduce<Record<string, number>>((memo: Record<string, number>, x: string) => {
      const [_, offsetStr, ...tokens] = x.split(" ") as [string, string, ...string[]];
      const offset = Number.parseInt(offsetStr, 10);
      tokens.forEach((token, i) => (memo[token] = offset + i));
      return memo;
    }, {});

  // Separate string vs binary tokens
  const stringEncoderObj: Record<string, number> = {};
  const binaryEncoderPairs: Array<{ bytes: number[]; rank: number }> = [];
  
  let stringCount = 0;
  let binaryCount = 0;

  for (const [token, rank] of Object.entries(uncompressed)) {
    const bytes = base64.toByteArray(token);
    const asString = tryBytesToString(bytes);
    
    if (asString !== undefined) {
      stringEncoderObj[asString] = rank as number;
      stringCount++;
    } else {
      // Store as binary (will be sorted for binary search)
      binaryEncoderPairs.push({ bytes: Array.from(bytes), rank: rank as number });
      binaryCount++;
    }
  }

  // Sort binary encoder pairs for binary search
  binaryEncoderPairs.sort((a, b) => {
    const minLen = Math.min(a.bytes.length, b.bytes.length);
    for (let i = 0; i < minLen; i++) {
      const diff = a.bytes[i]! - b.bytes[i]!;
      if (diff !== 0) return diff;
    }
    return a.bytes.length - b.bytes.length;
  });

  const binaryEncoderEntries = binaryEncoderPairs.map(
    ({ bytes, rank }) => `  [new Uint8Array([${bytes.join(",")}]), ${rank}]`
  );

  // Build JSON string for stringEncoder — V8 parses JSON ~2x faster than JS object literals
  const encoderJsonStr = JSON.stringify(stringEncoderObj);
  // Escape for embedding in a single-quoted JS string
  const escapedEncoderJson = encoderJsonStr
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");

  // Generate TypeScript module — NO decoder (Tokenizer builds it lazily)
  const moduleCode = `/**
 * ${name.toUpperCase()} encoding
 * Auto-generated - DO NOT EDIT
 *
 * Optimized dual-storage format:
 * - String tokens: ${stringCount.toLocaleString()} (JSON.parse for fast init)
 * - Binary tokens: ${binaryCount.toLocaleString()} (binary search)
 * - Total tokens: ${(stringCount + binaryCount).toLocaleString()}
 * - Pattern: ${source.pat_str}
 * - Special tokens: ${Object.keys(source.special_tokens).length}
 */

export const name = ${JSON.stringify(name)};

export const pat_str = ${JSON.stringify(source.pat_str)};

export const special_tokens: Record<string, number> = ${JSON.stringify(source.special_tokens, null, 2)};

// String-based encoder (UTF-8 tokens) - JSON.parse is ~2x faster than JS object literals in V8
export const stringEncoder: Record<string, number> = JSON.parse('${escapedEncoderJson}');

// Binary encoder (non-UTF-8 tokens) - pre-sorted for binary search
export const binaryEncoder: Array<[Uint8Array, number]> = [
${binaryEncoderEntries.join(",\n")}
];
`;

  // Write output
  const outputFile = inputFile.replace(".json", ".ts");
  fs.writeFileSync(outputFile, moduleCode);

  const sizeMB = (moduleCode.length / 1024 / 1024).toFixed(2);
  console.log(`  ✅ ${name}.ts (${sizeMB} MB)`);
  console.log(`     - String tokens: ${stringCount.toLocaleString()}`);
  console.log(`     - Binary tokens: ${binaryCount.toLocaleString()}`);
}

console.log(`\n🎉 Generated ${jsonFiles.length} encoding(s)!`);

