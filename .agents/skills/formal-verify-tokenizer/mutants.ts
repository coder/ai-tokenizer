// Usage: bun .agents/skills/formal-verify-tokenizer/mutants.ts
// Breaks src/tokenizer.ts in one place at a time (in a temp copy) and
// requires check.ts to fail on every broken copy.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = readFileSync(
  resolve(import.meta.dir, "../../../src/tokenizer.ts"),
  "utf8"
);
const check = resolve(import.meta.dir, "check.ts");

const MUTANTS: Array<{ name: string; from: string; to: string }> = [
  {
    name: "merge ties pick the rightmost pair",
    from: "if (rank < minRank) {",
    to: "if (rank <= minRank) {",
  },
  {
    name: "merge skips the left neighbor's rank update",
    from: "ranks[minIdx - 1] = getRank(minIdx - 1);",
    to: "",
  },
  {
    name: '"all" skips special tokens',
    from: "if (!this.hasSpecialTokens) {",
    to: 'if (!this.hasSpecialTokens || allowedSpecial === "all") {',
  },
  {
    name: "decoder strips the BOM",
    from: 'new TextDecoder("utf-8", { ignoreBOM: true })',
    to: 'new TextDecoder("utf-8")',
  },
  {
    name: "pattern keeps JavaScript's \\s",
    from: '.replaceAll("\\\\s", "\\\\p{White_Space}")',
    to: "",
  },
  {
    name: "rank lookups accept inherited properties",
    from: 'typeof directRank === "number"',
    to: "directRank !== undefined",
  },
  {
    name: "short-text lookup accepts inherited properties",
    from: 'if (typeof direct === "number") return [direct];',
    to: "if (direct !== undefined) return [direct];",
  },
  {
    name: "encodeOrdinary cache hit returns only the first token",
    from: "for (let i = 0; i < cached.length; i++) {",
    to: "for (let i = 0; i < Math.min(1, cached.length); i++) {",
  },
  {
    name: "decode drops special tokens",
    from: "this.decoder[token] ?? this.inverseSpecialTokens[token]!",
    to: "this.decoder[token]!",
  },
  {
    name: "cache ring head does not advance",
    from: "this.mergeCacheHead = (head + 1) % keys.length;",
    to: "this.mergeCacheHead = head;",
  },
  {
    name: "size 0 still caches",
    from: "if (this.mergeCacheSize === 0) return;",
    to: "",
  },
];

const dir = mkdtempSync(join(tmpdir(), "tokenizer-mutants-"));
let killed = 0;
let bad = 0;
try {
  for (const mutant of [{ name: "unmodified", from: "", to: "" }, ...MUTANTS]) {
    if (mutant.from !== "" && !source.includes(mutant.from)) {
      bad++;
      console.log(`STALE ${mutant.name}: source no longer contains the text`);
      continue;
    }
    const file = join(dir, "tokenizer.ts");
    writeFileSync(file, source.replaceAll(mutant.from, mutant.to));
    const proc = Bun.spawnSync(
      ["bun", check, "--quick", "--fail-fast", "--tokenizer", file],
      { stdout: "pipe", stderr: "pipe" }
    );
    const out = proc.stdout.toString();
    const fail = out.split("\n").find((line) => line.startsWith("FAIL")) ?? "";
    if (mutant.from === "") {
      if (proc.exitCode !== 0) bad++;
      console.log(
        `${proc.exitCode === 0 ? "CLEAN" : "DIRTY"} ${mutant.name} ${fail.slice(0, 200)}`
      );
    } else if (proc.exitCode === 1 && fail) {
      killed++;
      console.log(`KILLED ${mutant.name}: ${fail.slice(0, 200)}`);
    } else {
      bad++;
      console.log(`SURVIVED ${mutant.name} exit=${proc.exitCode}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`SUMMARY killed=${killed}/${MUTANTS.length} problems=${bad}`);
process.exit(bad === 0 && killed === MUTANTS.length ? 0 : 1);
