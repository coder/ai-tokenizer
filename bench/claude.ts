/**
 * Claude encoding timings: 1M characters of prose and 100k of one repeated
 * character, each also at twice the size. A 2x/1x ratio near 2 is linear.
 *
 *   bun bench/claude.ts
 */
import { Tokenizer } from "../src/index";
import * as claude_v3 from "../src/encoding/claude_v3";
import * as claude_v4_7 from "../src/encoding/claude_v4_7";

const WORDS =
  "the of and to in is you that it he was for on are as with his they at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part".split(
    " "
  );

let seed = 7;
function rand(n: number): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return (seed >>> 8) % n;
}

function prose(chars: number): string {
  const parts: string[] = [];
  let length = 0;
  while (length < chars) {
    const words = Array.from(
      { length: 6 + rand(14) },
      () => WORDS[rand(WORDS.length)]!
    );
    words[0] = words[0]![0]!.toUpperCase() + words[0]!.slice(1);
    if (rand(4) === 0) words[rand(words.length)] += ",";
    const sentence = words.join(" ") + [".", "!", "?", "."][rand(4)]!;
    const sep = rand(6) === 0 ? "\n\n" : " ";
    parts.push(sentence + sep);
    length += sentence.length + sep.length;
  }
  return parts.join("").slice(0, chars);
}

function median(fn: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[1]!;
}

const inputs: Array<[string, (scale: number) => string]> = [
  ["prose 1M", (k) => prose(1_000_000 * k)],
  ...["a", " ", "\n", "!", "日"].map(
    (ch): [string, (scale: number) => string] => [
      `${JSON.stringify(ch)} x 100k`,
      (k) => ch.repeat(100_000 * k),
    ]
  ),
];

for (const encoding of [claude_v3, claude_v4_7]) {
  const tokenizer = new Tokenizer(encoding);
  const start = performance.now();
  tokenizer.count("warm up");
  console.log(
    `${encoding.name}: first count (builds the trie) ${(performance.now() - start).toFixed(0)} ms`
  );
  for (const [label, make] of inputs) {
    const one = make(1);
    const two = make(2);
    let count1 = 0;
    let count2 = 0;
    const t1 = median(() => (count1 = tokenizer.count(one)));
    const t2 = median(() => (count2 = tokenizer.count(two)));
    const tokens = `${count1}/${count2} tokens`;
    console.log(
      `  ${label.padEnd(14)} ${tokens.padEnd(22)} 1x ${t1.toFixed(0).padStart(5)} ms  2x ${t2.toFixed(0).padStart(5)} ms  2x/1x ${(t2 / t1).toFixed(2)}`
    );
  }
}
