import { defineConfig, type UserConfig } from "tsdown";

const baseConfig = (config: UserConfig): UserConfig => ({
  dts: true,
  format: ["esm", "cjs"],
  target: "es2020",
  sourcemap: true,
  deps: {
    neverBundle: [/\/tokenizer(\.ts)?$/]
  },
  outExtensions: (info) => {
    if (info.format === "cjs") {
      return { js: ".cjs" };
    }
    return { js: ".js" };
  },
  outputOptions: (_options, format) => ({
    paths: (id: string) => {
      if (/\/src\/tokenizer(\.ts)?$/.test(id)) {
        return `./tokenizer${format === "cjs" ? ".cjs" : ".js"}`;
      }
      return id;
    }
  }),
  ...config
})

export default defineConfig([
  baseConfig({
    entry: "./src/index.ts",
    outDir: "./dist",
  }), 
  baseConfig({
    entry: "./src/sdk.ts",
    outDir: "./dist",
  }), 
  baseConfig({
    entry: "./src/tokenizer.ts",
    outDir: "./dist",
  }), 
  baseConfig({
    entry: "./src/encoding/*",
    outDir: "./dist/encoding/",
    sourcemap: false,
    minify: false,
  })
]);
