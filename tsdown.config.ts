import { defineConfig } from "tsdown";

export default defineConfig([
  {
    // One build for both entries, so code they share (the Tokenizer class and
    // its declaration) lands in one chunk instead of a copy in each entry.
    entry: {
      index: "./src/index.ts",
      sdk: "./src/sdk.ts",
    },
    outDir: "./dist",
    dts: true,
    format: ["esm", "cjs"],
    target: "es2020",
    sourcemap: true,
  },
  {
    entry: "./src/encoding/*",
    outDir: "./dist/encoding/",
    format: ["esm", "cjs"],
    target: "es2020",
    dts: true,
    sourcemap: false,
    minify: false,
  },
]);
