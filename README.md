# ai-tokenizer

[![CI](https://github.com/coder/ai-tokenizer/actions/workflows/ci.yml/badge.svg)](https://github.com/coder/ai-tokenizer/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/ai-tokenizer)](https://www.npmjs.com/package/ai-tokenizer)
[![npm downloads](https://img.shields.io/npm/dm/ai-tokenizer)](https://www.npmjs.com/package/ai-tokenizer)

A faster than tiktoken tokenizer with first-class support for Vercel's AI SDK.

- Supports the [AI SDK](https://github.com/vercel/ai) tool and message schema
- No WASM; highly portable; [5-7x faster](#performance) than tiktoken WASM
- \>=97% [accuracy](#accuracy) for top models (GPT-5, Claude Sonnet, Gemini):

<!-- POPULAR_MODELS_TABLE_START -->
| Model | ~500 tokens | ~5k tokens | ~50k tokens |
|-------|-------------|------------|-------------|
| openai/gpt-5.1-codex | 79.84% | 98.72% | 99.65% |
| anthropic/claude-opus-4.5 | 98.48% | 98.56% | 99.79% |
| google/gemini-3-pro-preview | 98.70% | 98.77% | 98.91% |

<!-- POPULAR_MODELS_TABLE_END -->

[Try it on the website:](https://coder.github.io/ai-tokenizer/)

[![Demo](https://raw.githubusercontent.com/coder/ai-tokenizer/main/demo.png)](https://coder.github.io/ai-tokenizer/)

## Usage

Install:

```sh
bun install ai-tokenizer
```

Estimate tokens with the AI SDK:

```ts
import Tokenizer, { models } from "ai-tokenizer";
import { count } from "ai-tokenizer/sdk";
import * as encoding from "ai-tokenizer/encoding";

// Find the respective model.
const model = models["openai/gpt-5"];
const tokenizer = new Tokenizer(encoding[model.encoding]);
const result = count({
  tokenizer,
  model,
  // Every message is counted separately
  messages,
  // Tool descriptions and input schemas are counted
  tools,
})

// {
//   total: 150,
//   messages: [
//     {
//       total: 120,
//       content: [
//         { type: "text", total: 100 },
//         { type: "tool-call", total: 20, input: 15 }
//       ]
//     }
//   ],
//   tools: {
//     total: 30,
//     definitions: {
//       myTool: {
//         name: 5,
//         description: 10,
//         inputSchema: 15
//       }
//     }
//   }
// }

// No API calls are performed; no keys.

const costUSD = result.total * model.pricing.input;
```

Estimate tokens using an encoding:

```ts
import { Tokenizer } from "ai-tokenizer"
import * as o200k_base from "ai-tokenizer/encoding/o200k_base"

const tokenizer = new Tokenizer(o200k_base);
const total = tokenizer.count("some text input");
```

> [!WARNING]
> Import encodings selectively based on what you need. Each encoding is 2-8MB uncompressed.

## Accuracy

Validated against actual API responses with pseudo-random messages:

<!-- ACCURACY_TABLE_START -->
| Model | ~500 tokens | ~5k tokens | ~50k tokens |
|-------|-------------|------------|-------------|
| alibaba/qwen-3-14b | 96.45% | 96.45% | N/A |
| alibaba/qwen-3-235b | 98.26% | 96.38% | N/A |
| alibaba/qwen-3-30b | 96.45% | 96.27% | N/A |
| alibaba/qwen-3-32b | 95.64% | 95.70% | N/A |
| alibaba/qwen3-235b-a22b-thinking | 96.06% | 96.34% | 95.98% |
| alibaba/qwen3-coder | 94.55% | 96.70% | 94.57% |
| alibaba/qwen3-coder-plus | 94.84% | 96.76% | 94.54% |
| alibaba/qwen3-max | 98.51% | 95.59% | 94.33% |
| alibaba/qwen3-next-80b-a3b-instruct | 95.66% | 96.71% | 95.81% |
| alibaba/qwen3-next-80b-a3b-thinking | 96.02% | 95.70% | 95.09% |
| alibaba/qwen3-vl-instruct | 95.08% | 96.73% | 96.04% |
| amazon/nova-lite | 98.10% | 92.67% | 90.17% |
| amazon/nova-micro | 98.10% | 92.10% | 89.20% |
| amazon/nova-pro | 98.10% | 92.82% | 90.16% |
| anthropic/claude-3-haiku | 97.61% | 99.32% | 99.77% |
| anthropic/claude-3-opus | 98.66% | 98.68% | 99.70% |
| anthropic/claude-3.5-haiku | 97.61% | 99.80% | 99.86% |
| anthropic/claude-3.5-sonnet | 97.93% | 99.26% | 99.67% |
| anthropic/claude-3.5-sonnet-20240620 | 98.01% | 99.98% | 99.86% |
| anthropic/claude-3.7-sonnet | 98.07% | 99.59% | 99.74% |
| anthropic/claude-haiku-4.5 | 98.48% | 98.67% | 99.62% |
| anthropic/claude-opus-4 | 98.07% | 99.39% | 99.74% |
| anthropic/claude-opus-4.1 | 97.78% | 99.83% | 99.80% |
| anthropic/claude-opus-4.5 | 98.48% | 98.56% | 99.79% |
| anthropic/claude-sonnet-4 | 98.22% | 99.89% | 99.83% |
| anthropic/claude-sonnet-4.5 | 98.48% | 98.91% | 99.70% |
| deepseek/deepseek-r1 | 96.24% | 98.67% | 98.10% |
| deepseek/deepseek-r1-distill-llama-70b | 98.20% | 99.08% | N/A |
| deepseek/deepseek-v3 | 95.30% | 95.37% | 95.19% |
| deepseek/deepseek-v3.1 | 97.40% | 95.85% | 96.46% |
| deepseek/deepseek-v3.1-terminus | 96.20% | 97.57% | 97.55% |
| deepseek/deepseek-v3.2-exp | 95.77% | 97.62% | 97.45% |
| deepseek/deepseek-v3.2-exp-thinking | 95.98% | 97.55% | 97.56% |
| google/gemini-2.0-flash | 97.97% | 99.69% | 99.95% |
| google/gemini-2.0-flash-lite | 98.18% | 99.65% | 99.77% |
| google/gemini-2.5-flash | 98.78% | 99.60% | 99.85% |
| google/gemini-2.5-flash-lite | 99.19% | 99.33% | 99.84% |
| google/gemini-2.5-flash-lite-preview-09-2025 | 92.74% | 99.63% | 99.74% |
| google/gemini-2.5-flash-preview-09-2025 | 92.53% | 99.69% | 99.74% |
| google/gemini-2.5-pro | 98.37% | 99.42% | 99.82% |
| google/gemini-3-pro-preview | 98.70% | 98.77% | 98.91% |
| meituan/longcat-flash-chat | 70.65% | 99.15% | 96.13% |
| meta/llama-3.1-8b | 98.69% | 90.67% | 89.69% |
| meta/llama-3.3-70b | 100.00% | 70.03% | 67.23% |
| meta/llama-4-scout | 0.00% | 56.65% | 66.03% |
| minimax/minimax-m2 | 94.13% | 74.53% | 72.83% |
| mistral/codestral | 93.78% | 91.86% | 91.89% |
| mistral/devstral-small | 98.77% | 94.09% | 93.72% |
| mistral/magistral-medium | 98.24% | 94.23% | 93.71% |
| mistral/magistral-small | 97.89% | 94.32% | 93.65% |
| mistral/mistral-large | 98.23% | 94.09% | N/A |
| mistral/mistral-medium | 98.06% | 93.96% | 93.79% |
| mistral/mistral-small | 96.73% | 92.78% | N/A |
| mistral/pixtral-large | 98.94% | 94.25% | 94.27% |
| moonshotai/kimi-k2 | 89.51% | NaN% | 82.80% |
| moonshotai/kimi-k2-0905 | 85.58% | 81.01% | 80.56% |
| moonshotai/kimi-k2-thinking | 95.02% | 92.80% | 91.96% |
| moonshotai/kimi-k2-thinking-turbo | 95.03% | 92.38% | 91.91% |
| moonshotai/kimi-k2-turbo | 94.51% | 92.36% | 91.83% |
| openai/gpt-4-turbo | 99.79% | 99.89% | 99.86% |
| openai/gpt-4.1 | 100.00% | 99.93% | 99.92% |
| openai/gpt-4.1-mini | 100.00% | 99.93% | 99.92% |
| openai/gpt-4o | 100.00% | 99.93% | 99.92% |
| openai/gpt-4o-mini | 100.00% | 99.93% | 99.92% |
| openai/gpt-5 | 99.16% | 99.43% | 99.47% |
| openai/gpt-5-chat | 100.00% | 99.93% | 99.92% |
| openai/gpt-5-codex | 99.17% | 99.43% | 99.47% |
| openai/gpt-5-mini | 99.16% | 99.43% | 99.47% |
| openai/gpt-5-nano | 99.16% | 99.43% | 99.46% |
| openai/gpt-5-pro | 99.17% | 99.43% | 99.47% |
| openai/gpt-5.1-codex | 79.84% | 98.72% | 99.65% |
| openai/gpt-5.1-codex-mini | 99.17% | 99.43% | 99.47% |
| openai/gpt-5.1-instant | 79.84% | 98.72% | 99.65% |
| openai/gpt-5.1-thinking | 79.84% | 98.72% | 99.64% |
| openai/gpt-oss-120b | 80.77% | 69.64% | 69.62% |
| openai/gpt-oss-20b | 68.55% | 60.79% | 60.98% |
| openai/gpt-oss-safeguard-20b | 75.60% | 64.08% | 63.67% |
| openai/o1 | 94.77% | 99.30% | 99.86% |
| openai/o3 | 99.16% | 99.43% | 99.46% |
| openai/o3-mini | 100.00% | NaN% | 99.92% |
| openai/o4-mini | 99.16% | 99.43% | 99.47% |
| prime-intellect/intellect-3 | 93.08% | 95.64% | 97.12% |
| stealth/sonoma-dusk-alpha | 99.47% | 71.65% | 66.69% |
| stealth/sonoma-sky-alpha | 99.46% | 69.52% | 66.49% |
| vercel/v0-1.0-md | 98.99% | 53.45% | 92.42% |
| vercel/v0-1.5-md | 98.96% | 53.55% | 92.39% |
| xai/grok-2 | 95.43% | 96.09% | 95.28% |
| xai/grok-2-vision | 94.44% | 95.68% | N/A |
| xai/grok-3 | 99.57% | 98.67% | 99.23% |
| xai/grok-3-fast | 99.57% | 98.59% | 99.13% |
| xai/grok-3-mini | 99.59% | 98.76% | 99.18% |
| xai/grok-3-mini-fast | 99.59% | 98.59% | 99.13% |
| xai/grok-4 | 99.72% | 73.95% | 67.43% |
| xai/grok-4-fast-non-reasoning | 90.02% | -22.27% | -52.27% |
| xai/grok-4-fast-reasoning | 99.29% | 71.17% | 66.72% |
| xai/grok-4.1-fast-non-reasoning | 99.65% | 71.70% | 66.76% |
| xai/grok-4.1-fast-reasoning | 99.28% | 71.50% | 66.62% |
| xai/grok-code-fast-1 | 80.14% | -13.63% | -51.13% |
| zai/glm-4.5 | 94.55% | 96.26% | 96.16% |
| zai/glm-4.5-air | 96.73% | 96.45% | 96.70% |
| zai/glm-4.5v | 95.17% | 95.56% | 95.36% |

<!-- ACCURACY_TABLE_END -->

*Accuracy shows percentage within actual token count.*

> [!WARNING]
> Not every tool/token scenario is tested for accuracy. There will be edge-cases where this is more/less accurate. If you find this inaccurate for your scenario, please open an issue.

Run `bun run scripts/generate-accuracy.ts` to update this table. Refer to [accuracy.json](./accuracy.json) for greater detail.

## Performance

ai-tokenizer is **5-7x faster than tiktoken** for counting tokens. It is on par with gpt-tokenizer.

```bash
$ bun bench/versus

clk: ~3.96 GHz
cpu: AMD Ryzen AI 9 HX 370 w/ Radeon 890M
runtime: bun 1.2.19 (x64-linux)

benchmark                   avg (min … max) p75 / p99    (min … top 1%)
------------------------------------------- -------------------------------
• initialization
------------------------------------------- -------------------------------
ai-tokenizer                  13.99 µs/iter  14.14 µs  █                   
                      (13.44 µs … 15.50 µs)  14.85 µs  █                   
                    (  0.00  b …   1.24 kb) 308.13  b ██▁█▁█▁▁▁▁█▁▁▁▁▁▁▁▁▁█

tiktoken                      85.05 ms/iter  85.68 ms         █      █     
                      (81.61 ms … 89.19 ms)  86.55 ms ▅       █  ▅ ▅▅█▅▅  ▅
                    (  0.00  b …   1.39 mb) 385.33 kb █▁▁▁▁▁▁▁█▁▁█▁█████▁▁█

• encode: small text (~13 chars)
------------------------------------------- -------------------------------
ai-tokenizer                   1.33 µs/iter   1.34 µs         ▇█           
                        (1.11 µs … 1.90 µs)   1.60 µs         ██           
                    (  0.00  b …   2.06 kb)   1.60 kb ▆▃▁▁▁▁▁▂███▃▄▂▃▂▃▂▁▁▂

gpt-tokenizer                  1.05 µs/iter   1.13 µs █                    
                      (926.82 ns … 1.65 µs)   1.53 µs ██    ▆              
                    (  0.00  b … 864.00  b) 352.86  b ██▂▁▁▁██▆▃▂▂▁▁▁▁▁▁▁▁▁

tiktoken                      32.23 µs/iter  30.19 µs  █                   
                     (27.83 µs … 468.68 µs)  66.56 µs  █                   
                    (  0.00  b …   1.13 mb)   5.27 kb ██▃▂▂▁▁▁▃▁▁▁▁▁▁▁▁▁▁▁▁

• encode: medium text (~4.5KB)
------------------------------------------- -------------------------------
ai-tokenizer                  89.81 µs/iter  92.53 µs    █                 
                     (66.07 µs … 372.65 µs) 208.17 µs  █ █▇                
                    (  0.00  b …   1.13 mb)  98.84 kb ▄█▃██▃▂▂▂▂▁▁▁▁▁▁▁▁▁▁▁

gpt-tokenizer                 76.97 µs/iter  80.01 µs  █   ▆               
                     (66.79 µs … 279.16 µs) 115.17 µs  █   █▅              
                    (  0.00  b … 384.00 kb)   5.44 kb ▆█▅█▆██▃▂▁▂▂▁▂▂▁▁▁▁▁▁

tiktoken                     651.22 µs/iter 649.48 µs  ▄█                  
                    (632.83 µs … 874.11 µs) 782.25 µs  ██                  
                    (  0.00  b … 192.00 kb)   4.31 kb ▄██▆▂▁▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁

• encode: large text (~500KB)
------------------------------------------- -------------------------------
ai-tokenizer                  19.07 ms/iter  20.23 ms                  ▅█  
                      (15.19 ms … 20.67 ms)  20.66 ms       ▃         ▃██▃▃
                    (  0.00  b …  26.44 mb)  19.22 mb ▄▁▄▄█▁█▁▁▁▄▁▁▁▄▄█████

gpt-tokenizer                 18.19 ms/iter  18.62 ms     █                
                      (15.35 ms … 23.68 ms)  22.91 ms     █ ▃              
                    (  0.00  b …  31.50 mb)   6.44 mb ▅▃▅▁█▁█▃▃▃▁▁█▁▁▁▁▅▁▁▅

tiktoken                     135.38 ms/iter 135.35 ms █     █ █            
                    (134.51 ms … 138.22 ms) 136.61 ms █▅ ▅ ▅█ █▅          ▅
                    (  0.00  b … 768.00 kb) 648.00 kb ██▁█▁██▁██▁▁▁▁▁▁▁▁▁▁█

• encode: unicode text
------------------------------------------- -------------------------------
ai-tokenizer                 118.76 µs/iter 118.95 µs     █                
                     (84.61 µs … 500.48 µs) 234.66 µs    ██                
                    (  0.00  b … 768.00 kb) 129.37 kb ▃▄▂██▇▄▄▂▂▂▂▁▁▁▁▁▁▁▁▁

gpt-tokenizer                231.35 µs/iter 256.95 µs   █▅▇█               
                      (139.24 µs … 2.08 ms) 489.02 µs   ████  █            
                    (  0.00  b …   2.41 mb) 260.61 kb ▃▅████▇▆█▆▃▂▂▂▁▁▁▂▁▁▁

tiktoken                     836.84 µs/iter 819.36 µs █                    
                      (799.44 µs … 1.97 ms)   1.39 ms █▅                   
                    (  0.00  b … 192.00 kb)   5.87 kb ██▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

• encode: code
------------------------------------------- -------------------------------
ai-tokenizer                 357.64 µs/iter 372.83 µs      █▄              
                      (278.58 µs … 1.04 ms) 591.56 µs  ▃   ██              
                    (  0.00  b …   1.31 mb) 364.10 kb ██▂▁▂██▅▃▂▂▁▂▂▁▁▁▁▁▁▁

gpt-tokenizer                316.39 µs/iter 316.25 µs  █▅                  
                    (279.98 µs … 919.92 µs) 622.31 µs  ██                  
                    (  0.00  b … 192.00 kb)  54.12 kb ▄██▅▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

tiktoken                       3.12 ms/iter   3.12 ms  ▆█                  
                        (3.05 ms … 3.72 ms)   3.52 ms  ██▃                 
                    (  0.00  b … 192.00 kb)  20.06 kb ▆███▅▃▁▁▁▁▂▂▂▂▁▁▂▁▁▁▂

• encode: mixed content
------------------------------------------- -------------------------------
ai-tokenizer                   2.44 ms/iter   2.48 ms         ▇█▄          
                        (2.06 ms … 2.89 ms)   2.81 ms        ▂████▃        
                    (  0.00  b …   3.56 mb)   2.36 mb ▁▂▂▁▁▁▁██████▄▃▆▄▂▂▁▂

gpt-tokenizer                  2.62 ms/iter   2.60 ms   █                  
                        (2.38 ms … 4.34 ms)   3.96 ms  ▅█                  
                    (576.00 kb …   4.88 mb)   1.34 mb ▄███▄▂▂▁▁▁▁▂▁▁▂▁▁▁▁▁▁

tiktoken                      15.35 ms/iter  15.37 ms ▂█ ▂                 
                      (15.17 ms … 16.35 ms)  15.80 ms ██▇█▂                
                    (  0.00  b … 192.00 kb)  93.54 kb █████▇▄▁▄▄▄▁▄▄▄▁▁▇▄▁▄

• decode: large token array
------------------------------------------- -------------------------------
ai-tokenizer                   1.57 ms/iter   1.93 ms █                    
                        (1.14 ms … 4.02 ms)   3.53 ms ██                   
                    (  0.00  b …   6.94 mb)   1.44 mb ██▄▃▁▁▁▁▁▂▃▄▄▃▂▁▁▁▁▁▁

gpt-tokenizer                876.67 µs/iter 857.62 µs  █                   
                      (628.32 µs … 3.95 ms)   2.34 ms  █                   
                    (  0.00  b …   6.00 mb)  27.15 kb ▁██▃▄▃▂▂▂▂▁▁▁▁▁▁▁▁▁▁▁

tiktoken                       1.64 ms/iter   1.67 ms  ▄  █                
                        (1.47 ms … 2.49 ms)   2.33 ms ▆█ ██▃               
                    (  0.00  b …   1.31 mb)   1.14 mb ██████▅▆▂▃▁▁▂▁▂▂▁▁▂▁▁

• count: large text (~500KB)
------------------------------------------- -------------------------------
ai-tokenizer                  18.33 ms/iter  19.52 ms                   █  
                      (14.94 ms … 20.09 ms)  20.05 ms ▃▆              ▆██▃ 
                    (  0.00  b …  25.33 mb)  18.64 mb ██▁▁▁▄▁▁▁▁▁▁▄▄▄█████▄

gpt-tokenizer                 16.65 ms/iter  18.26 ms  █               █   
                      (14.63 ms … 19.14 ms)  19.01 ms  ███          ▅  █   
                    (  0.00  b …   7.50 mb)   1.15 mb ▅████▁▅▅▁▁█▅▁▅██▁██▁█

tiktoken                     131.95 ms/iter 131.85 ms        █             
                    (130.24 ms … 138.35 ms) 133.42 ms      █ █             
                    (576.00 kb … 768.00 kb) 720.00 kb █▁██▁█▁█▁▁█▁█▁▁▁▁▁▁▁█
```

Run this yourself with `bun bench/versus`.

## License

[MIT](./LICENSE)
