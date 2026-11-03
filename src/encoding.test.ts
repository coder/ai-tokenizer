import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bpeData, tiktokenBytesByRank } from "../scripts/encoding-source";
import { lazyBpeTables, resolve } from "./lazy";

const ENCODING_DIR = join(import.meta.dirname, "encoding");

describe("importing the encodings", () => {
  // A table built at import costs about 40 MB per encoding. Importing every
  // encoding while no table is built measured 79 MB of RSS in Bun. With the
  // tables built it was 432 MB.
  test("builds no table and stays small", () => {
    const dir = mkdtempSync(join(tmpdir(), "encoding-import-"));
    const script = join(dir, "import.mjs");
    writeFileSync(
      script,
      `
      const parsed = [];
      const parse = JSON.parse;
      JSON.parse = (text, ...rest) => {
        if (typeof text === "string" && text.length > 100_000) parsed.push(text.length);
        return parse(text, ...rest);
      };
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      await import(${JSON.stringify(join(ENCODING_DIR, "index.ts"))});
      Bun.gc(true);
      const rssMB = (process.memoryUsage().rss - before) / 1048576;
      console.log(JSON.stringify({ parsed, rssMB }));
      `
    );
    const result = Bun.spawnSync([process.execPath, script]);
    expect(result.stderr.toString()).toBe("");
    const { parsed, rssMB } = JSON.parse(result.stdout.toString());
    expect(parsed).toEqual([]);
    expect(rssMB).toBeLessThan(200);
  });
});

describe("generated encodings", () => {
  // Rerunning scripts/generate-encodings.ts changes nothing.
  for (const name of ["cl100k_base", "o200k_base", "p50k_base", "claude"]) {
    test(`${name}.ts holds what its generator builds from ${name}.json`, async () => {
      const source = JSON.parse(
        readFileSync(join(ENCODING_DIR, `${name}.json`), "utf-8")
      );
      const expected = lazyBpeTables(
        JSON.stringify(bpeData(tiktokenBytesByRank(source.bpe_ranks)).data)
      );
      const actual = await import(`./encoding/${name}`);

      expect(actual.name).toBe(name);
      expect(actual.pat_str).toBe(source.pat_str);
      expect(actual.special_tokens).toEqual(source.special_tokens);
      expect(resolve(actual.stringEncoder)).toEqual(
        resolve(expected.stringEncoder)
      );
      expect(resolve(actual.binaryEncoder)).toEqual(
        resolve(expected.binaryEncoder)
      );
      expect(resolve(actual.decoder)).toEqual(resolve(expected.decoder));
    });
  }
});
