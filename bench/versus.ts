/**
 * Comprehensive benchmark: ai-tokenizer vs other tokenizers
 * 
 * Compares o200k_base encoding performance across:
 * - tiktoken (native/WASM implementation)
 * - gpt-tokenizer (pure JS implementation)
 * 
 * Tests:
 * - Initialization time
 * - Encoding performance (various text sizes)
 * - Decoding performance
 * - Different text types (ASCII, Unicode, code, mixed)
 */

import { bench, run, group } from "mitata";
import { Tokenizer } from "../src/index";
import * as o200k from "../src/encoding/o200k_base";
import { encode, decode } from "gpt-tokenizer";
import { get_encoding } from "tiktoken";

const ENCODING_NAME = "o200k_base";

// Sample texts of different types
const texts = {
  small: "Hello, world!",
  medium: "The quick brown fox jumps over the lazy dog. ".repeat(100), // ~4.5KB
  large: `
Machine learning models process text by breaking it down into tokens.
Natural language processing has evolved significantly with large language models.
These models can understand context, generate coherent text, and perform various tasks.
`.repeat(5000), // ~500KB
  
  unicode: "Hello 世界! 🌍 Привет мир! مرحبا بالعالم! ".repeat(100),
  
  code: `
function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

const result = fibonacci(10);
console.log(result);
`.repeat(100),

  mixed: `
# Machine Learning Overview

Machine learning (ML) is a subset of artificial intelligence (AI) that provides systems the ability to automatically learn and improve from experience.

## Key Concepts:
- Supervised Learning: 监督学习
- Unsupervised Learning: 無監督学習
- Reinforcement Learning: 強化学習

\`\`\`python
def train_model(data, labels):
    model = NeuralNetwork()
    model.fit(data, labels)
    return model
\`\`\`

**Performance metrics**: accuracy: 95.5%, precision: 0.94, recall: 0.96
`.repeat(200)
};

// Initialize tokenizers
const aiTokenizer = new Tokenizer(o200k);
const tiktoken = get_encoding(ENCODING_NAME);

// Initialization benchmarks
group("initialization", () => {
  bench("ai-tokenizer", () => new Tokenizer(o200k));
  bench("tiktoken", () => {
    const enc = get_encoding(ENCODING_NAME);
    enc.free();
  });
});

// Warm up
aiTokenizer.encode(texts.small);
tiktoken.encode(texts.small);
encode(texts.small);

// Encoding benchmarks
group("encode: small text (~13 chars)", () => {
  bench("ai-tokenizer", () => aiTokenizer.encode(texts.small));
  bench("gpt-tokenizer", () => encode(texts.small));
  bench("tiktoken", () => tiktoken.encode(texts.small));
});

group("encode: medium text (~4.5KB)", () => {
  bench("ai-tokenizer", () => aiTokenizer.encode(texts.medium));
  bench("gpt-tokenizer", () => encode(texts.medium));
  bench("tiktoken", () => tiktoken.encode(texts.medium));
});

group("encode: large text (~500KB)", () => {
  bench("ai-tokenizer", () => aiTokenizer.encode(texts.large));
  bench("gpt-tokenizer", () => encode(texts.large));
  bench("tiktoken", () => tiktoken.encode(texts.large));
});

group("encode: unicode text", () => {
  bench("ai-tokenizer", () => aiTokenizer.encode(texts.unicode));
  bench("gpt-tokenizer", () => encode(texts.unicode));
  bench("tiktoken", () => tiktoken.encode(texts.unicode));
});

group("encode: code", () => {
  bench("ai-tokenizer", () => aiTokenizer.encode(texts.code));
  bench("gpt-tokenizer", () => encode(texts.code));
  bench("tiktoken", () => tiktoken.encode(texts.code));
});

group("encode: mixed content", () => {
  bench("ai-tokenizer", () => aiTokenizer.encode(texts.mixed));
  bench("gpt-tokenizer", () => encode(texts.mixed));
  bench("tiktoken", () => tiktoken.encode(texts.mixed));
});

// Decoding benchmarks
const tokens = aiTokenizer.encode(texts.large);
const u32Array = new Uint32Array(tokens);

group("decode: large token array", () => {
  bench("ai-tokenizer", () => aiTokenizer.decode(tokens));
  bench("gpt-tokenizer", () => decode(tokens));
  bench("tiktoken", () => tiktoken.decode(u32Array));
});

// Token counting
group("count: large text (~500KB)", () => {
  bench("ai-tokenizer", () => aiTokenizer.encode(texts.large).length);
  bench("gpt-tokenizer", () => encode(texts.large).length);
  bench("tiktoken", () => tiktoken.encode(texts.large).length);
});

await run();

// Cleanup
tiktoken.free();
