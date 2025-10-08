import { defineConfig } from "tsdown";

export default defineConfig([{
  entry: "./src/index.ts",
  outDir: "./dist",
  dts: true,
  format: ["esm", "cjs"],
  target: "es2020",
  sourcemap: true,
}, {
  entry: "./src/sdk.ts",
  outDir: "./dist",
  dts: true,
  format: ["esm", "cjs"],
  target: "es2020",
  sourcemap: true,
}, {
  entry: "./src/encoding/*",
  outDir: "./dist/encoding/",
  format: ["esm", "cjs"],
  target: "es2020",
  dts: true,
  sourcemap: false,
  minify: false,
}]);
