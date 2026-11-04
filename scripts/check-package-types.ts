/**
 * Typechecks the README example against the packed tarball, the way a
 * consumer installs it. Run `bun run build` first: it needs the declarations.
 *
 * Regression check for https://github.com/coder/ai-tokenizer/issues/1: a
 * Tokenizer from "ai-tokenizer" must be assignable to the Tokenizer that
 * `count` from "ai-tokenizer/sdk" expects.
 *
 *   bun scripts/check-package-types.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const installedVersion = (name: string): string =>
  JSON.parse(
    readFileSync(join(repoRoot, "node_modules", name, "package.json"), "utf8")
  ).version;

// The README example, with `messages` and `tools` declared.
const example = `import Tokenizer, { models } from "ai-tokenizer";
import { count } from "ai-tokenizer/sdk";
import * as encoding from "ai-tokenizer/encoding";
import type { ModelMessage, ToolSet } from "ai";

declare const messages: ModelMessage[];
declare const tools: ToolSet;

const model = models["openai/gpt-5"];
const tokenizer = new Tokenizer(encoding[model.encoding]);
export const result = count({ tokenizer, model, messages, tools });
export const total: number = result.total;
export const claudeResult = count({
  tokenizer: new Tokenizer(encoding.claude_v5),
  model,
  messages,
});
`;

const resolutions: Array<{
  name: string;
  file: string;
  module: string;
  moduleResolution: string;
}> = [
  {
    name: "bundler",
    file: "index.ts",
    module: "esnext",
    moduleResolution: "bundler",
  },
  {
    name: "node16 (ESM)",
    file: "index.ts",
    module: "node16",
    moduleResolution: "node16",
  },
  {
    name: "node16 (CJS)",
    file: "index.cts",
    module: "node16",
    moduleResolution: "node16",
  },
  {
    name: "node10",
    file: "index.ts",
    module: "commonjs",
    moduleResolution: "node10",
  },
];

const run = (cwd: string, command: string, args: string[]): string =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });

const workDir = mkdtempSync(join(tmpdir(), "ai-tokenizer-types-"));
let failed = 0;
try {
  const packDir = join(workDir, "pack");
  const consumerDir = join(workDir, "consumer");
  run(workDir, "mkdir", [packDir, consumerDir]);

  const tarball = join(
    packDir,
    JSON.parse(
      run(repoRoot, "npm", ["pack", "--json", "--pack-destination", packDir])
    )[0].filename
  );

  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" })
  );
  run(consumerDir, "npm", [
    "install",
    "--no-audit",
    "--no-fund",
    `typescript@${installedVersion("typescript")}`,
    `ai@${installedVersion("ai")}`,
    "@types/node",
    tarball,
  ]);

  for (const resolution of resolutions) {
    writeFileSync(join(consumerDir, resolution.file), example);
    const tsconfig = join(
      consumerDir,
      `tsconfig.${resolution.moduleResolution}.json`
    );
    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "es2022",
          module: resolution.module,
          moduleResolution: resolution.moduleResolution,
          types: ["node"],
        },
        files: [resolution.file],
      })
    );

    let output = "";
    let threw = false;
    try {
      output = run(consumerDir, "node", [
        join("node_modules", "typescript", "bin", "tsc"),
        "-p",
        tsconfig,
      ]);
    } catch (error) {
      threw = true;
      const { stdout, stderr } = error as { stdout?: string; stderr?: string };
      output = `${stdout ?? ""}${stderr ?? ""}` || String(error);
    }
    // Every diagnostic counts, including option errors in the tsconfig, which
    // make tsc skip the check of the example. Only declarations of other
    // packages are not ours to check. A failed run with no diagnostic at all
    // is an error too.
    const lines = output.split("\n").filter((line) => line.trim() !== "");
    const diagnostics = lines.filter((line) => /error TS\d+/.test(line));
    const errors =
      threw && diagnostics.length === 0
        ? lines
        : diagnostics.filter(
            (line) => !/^node_modules\/(?!ai-tokenizer\/)/.test(line)
          );

    if (errors.length === 0) {
      console.log(`PASS ${resolution.name}`);
    } else {
      failed++;
      console.log(`FAIL ${resolution.name}`);
      for (const line of errors) console.log(`  ${line}`);
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(
  `package types: ${resolutions.length - failed} of ${resolutions.length} resolutions typecheck`
);
process.exit(failed === 0 ? 0 : 1);
