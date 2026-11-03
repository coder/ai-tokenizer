/**
 * Cost of loading an encoding: heap, RSS and time, each in a fresh process.
 *
 * Every scenario runs in its own child process, `--runs` times (default 5),
 * and the table shows the median. A scenario is one or more phases. A phase
 * is an import, then `new Tokenizer(encoding)`, then the first `encode`. Each
 * phase reports what it added after a forced GC.
 *
 *   bun bench/import-cost.ts                      # dist/ on node and bun
 *   bun bench/import-cost.ts --root ../other-checkout --runtime node
 *   bun bench/import-cost.ts --target src --runtime bun
 *   bun bench/import-cost.ts --only claude_v3   # scenarios whose label has it
 *
 * `dist/` must be built first (`bun run build --dts=false`).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Scenario {
  label: string;
  /** Module names under encoding/, "index" is the barrel. */
  imports: string[];
  /** Encoding to construct a Tokenizer from, as `module.export`. */
  construct?: { module: string; exportName?: string };
}

const SCENARIOS: Scenario[] = [
  { label: "barrel import", imports: ["index"] },
  { label: "o200k_base import", imports: ["o200k_base"] },
  { label: "llama4 import", imports: ["llama4"] },
  { label: "gemma4 import", imports: ["gemma4"] },
  { label: "claude_v3 import", imports: ["claude_v3"] },
  { label: "claude_v5 import", imports: ["claude_v5"] },
  {
    label: "o200k_base: new Tokenizer + first encode",
    imports: ["o200k_base"],
    construct: { module: "o200k_base" },
  },
  {
    label: "llama4: new Tokenizer + first encode",
    imports: ["llama4"],
    construct: { module: "llama4" },
  },
  {
    label: "gemma4: new Tokenizer + first encode",
    imports: ["gemma4"],
    construct: { module: "gemma4" },
  },
  {
    label: "claude_v3: new Tokenizer + first encode",
    imports: ["claude_v3"],
    construct: { module: "claude_v3" },
  },
  {
    label: "README: barrel, then o200k_base",
    imports: ["index"],
    construct: { module: "index", exportName: "o200k_base" },
  },
];

const CHILD = `
const [, , spec] = process.argv;
const { root, target, imports, construct } = JSON.parse(spec);
const ext = target === "src" ? "ts" : "js";
const dir = target === "src" ? "src" : "dist";
const gc = () => {
  if (typeof Bun !== "undefined") Bun.gc(true);
  else globalThis.gc();
};
const snap = () => {
  gc();
  const m = process.memoryUsage();
  return { heap: m.heapUsed, rss: m.rss, t: performance.now() };
};
const phases = {};
const phase = async (name, fn) => {
  const a = snap();
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  const b = snap();
  phases[name] = { heapMB: (b.heap - a.heap) / 1048576, rssMB: (b.rss - a.rss) / 1048576, ms };
  return value;
};
const tokenizerPath = target === "src" ? "src/tokenizer.ts" : "dist/index.js";
const Tokenizer = (await import(root + "/" + tokenizerPath)).default;
const modules = {};
await phase("import", async () => {
  for (const name of imports) {
    modules[name] = await import(root + "/" + dir + "/encoding/" + name + "." + ext);
  }
});
if (construct) {
  const mod = modules[construct.module];
  const enc = construct.exportName ? mod[construct.exportName] : mod;
  const tok = await phase("construct", () => new Tokenizer(enc));
  const n = await phase("encode", () => tok.encode("Hello, world! The quick brown fox.").length);
  if (n < 1) throw new Error("encode returned no tokens");
}
console.log(JSON.stringify(phases));
`;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}

const root = resolve(arg("root", join(import.meta.dirname, "..")));
// With --before, each run alternates between the two checkouts, so drift in
// the machine's load reaches both sides alike.
const beforeArg = arg("before", "");
const sides = beforeArg
  ? [
      { name: "before", root: resolve(beforeArg) },
      { name: "after", root },
    ]
  : [{ name: "after", root }];
const target = arg("target", "dist");
const runs = Number(arg("runs", "5"));
const runtimes = arg("runtime", "node,bun").split(",");
const only = arg("only", "");

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

const dir = mkdtempSync(join(tmpdir(), "import-cost-"));
const childFile = join(dir, "child.mjs");
writeFileSync(childFile, CHILD);

type Samples = Record<
  string,
  { heapMB: number[]; rssMB: number[]; ms: number[] }
>;

function measure(runtime: string, side: { root: string }, scenario: Scenario) {
  const spec = JSON.stringify({
    root: side.root,
    target,
    imports: scenario.imports,
    construct: scenario.construct,
  });
  const cmd =
    runtime === "node"
      ? ["node", "--expose-gc", childFile, spec]
      : ["bun", childFile, spec];
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `${runtime} ${scenario.label} failed: ${r.stderr.slice(0, 500)}`
    );
  }
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as Record<
    string,
    { heapMB: number; rssMB: number; ms: number }
  >;
}

let rows = 0;
for (const runtime of runtimes) {
  if (runtime === "node" && target === "src") continue;
  for (const scenario of SCENARIOS) {
    if (!scenario.label.includes(only)) continue;
    const present = sides.every((side) =>
      scenario.imports.every((m) =>
        existsSync(
          target === "src"
            ? join(side.root, "src/encoding", `${m}.ts`)
            : join(side.root, "dist/encoding", `${m}.js`)
        )
      )
    );
    if (!present) {
      console.log(`${runtime}\t${scenario.label}\tskipped (module missing)`);
      continue;
    }
    const samples = sides.map((): Samples => ({}));
    for (let i = 0; i < runs; i++) {
      const order = sides.map((_, k) => k);
      if (i % 2 === 1) order.reverse();
      for (const k of order) {
        const phases = measure(runtime, sides[k]!, scenario);
        for (const [name, v] of Object.entries(phases)) {
          const s = (samples[k]![name] ??= { heapMB: [], rssMB: [], ms: [] });
          s.heapMB.push(v.heapMB);
          s.rssMB.push(v.rssMB);
          s.ms.push(v.ms);
        }
      }
    }
    for (const name of Object.keys(samples[0]!)) {
      const cell = (
        label: string,
        pick: "heapMB" | "rssMB" | "ms",
        unit: string
      ) => {
        const show = (k: number) => {
          const xs = samples[k]![name]![pick];
          return `${median(xs).toFixed(1)} (${Math.min(...xs).toFixed(1)}-${Math.max(...xs).toFixed(1)})`;
        };
        return `${label} ${sides.map((_, k) => show(k)).join(" -> ")} ${unit}`;
      };
      console.log(
        [
          runtime,
          scenario.label,
          name,
          cell("heap", "heapMB", "MB"),
          cell("rss", "rssMB", "MB"),
          cell("time", "ms", "ms"),
        ].join("\t")
      );
      rows++;
    }
  }
}
console.log(
  `rows: ${rows} (median and range of ${runs} fresh processes per side, ${sides.map((s) => s.name).join(" -> ")}, target ${target})`
);
