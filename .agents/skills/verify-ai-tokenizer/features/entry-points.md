# Package entry points

The package exports `.`, `./sdk`, `./encoding` and `./encoding/{cl100k_base,o200k_base,p50k_base,claude}`, each with ESM, CJS and type entries. A consumer can import every subpath from ESM, require it from CJS, and typecheck the README snippets with TypeScript.

## Sub-features

- `esm`: `import.meta.resolve` maps every subpath to `dist/*.js`. The default and named `Tokenizer` are the same class. `models` names only shipped encodings. Each encoding subpath equals the `encoding` namespace member.
- `cjs`: `require.resolve` maps every subpath to `dist/*.cjs`. `require("ai-tokenizer")` has `Tokenizer`, `models` and `default`. `count()` works.
- `types-nodenext`: `tsc` with `module`/`moduleResolution` `nodenext` accepts the README snippets in `types-esm.mts` and `types-cjs.cts`.
- `types-bundler`: the same with `module: preserve` and `moduleResolution: bundler`.

## How to get to it (user POV)

- `npm install ai-tokenizer`, then `import` or `require` the subpaths.
- TypeScript projects that copy the README examples.

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` exits 0.
- The checkout has `node_modules/typescript` (installed by `bun install`).

- **Run all four steps.** Run `verify.sh drive entry-points`. It prints `PASS` or `FAIL` for `esm`, `cjs`, `types-nodenext` and `types-bundler`.
- **ESM and CJS.** `evidence/entry-points/esm.stdout` and `cjs.stdout` list every resolved path and check.
- **TypeScript.** `evidence/entry-points/types-*.stdout` holds the tsc diagnostics. Exit code 0 in `types-*.exit` means the README snippets typecheck.

## Gotchas

- At commit 107814b, both type steps fail with `TS2322 ... Types have separate declarations of a private property 'name'`. `dist/index.d.ts` and `dist/sdk.d.ts` each declare their own `class Tokenizer`, so a `Tokenizer` from `ai-tokenizer` is not assignable to the one `count()` expects.
- `skipLibCheck` is on and `lib` includes `dom`, as in most consumer projects, so errors inside `ai`'s own types do not hide the real result.
- CI builds with `--dts=false`. Only a full `bun run build` (what `launch` runs) produces the `.d.ts` files a published package ships.
- `ai-tokenizer/package.json` is not in `exports`. Read the version through a file path, not `require("ai-tokenizer/package.json")`.
