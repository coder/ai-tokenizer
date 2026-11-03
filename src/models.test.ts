import { describe, expect, test } from "bun:test";
import { models, type ModelName } from "./index";
import * as encodings from "./encoding";

const names = Object.keys(models) as ModelName[];
const claude = names.filter((name) => name.startsWith("anthropic/claude-"));
const isCtok = (name: ModelName) =>
  (encodings[models[name].encoding] as { kind?: string }).kind === "ctok";

describe("models.json", () => {
  test("every model has an encoding", () => {
    for (const name of names) {
      expect(encodings).toHaveProperty(models[name].encoding);
    }
  });

  test("a model counts like count_tokens exactly when its encoding is a Claude one", () => {
    for (const name of names) {
      const exact = isCtok(name);
      expect([name, models[name].tokens.anthropic !== undefined]).toEqual([
        name,
        exact,
      ]);
    }
  });

  test("every Anthropic Claude model is on an exact encoding", () => {
    expect(claude.length).toBeGreaterThan(0);
    for (const name of claude) {
      expect([
        "claude_v3",
        "claude_v4_7",
        "claude_v4_8",
        "claude_v5",
      ]).toContain(models[name].encoding);
    }
  });

  test("an exact model has whole, non-negative costs and no multiplier", () => {
    for (const name of claude) {
      const { tokens } = models[name];
      expect([name, tokens.contentMultiplier]).toEqual([name, 1]);
      expect([name, tokens.perMessage]).toEqual([name, 0]);
      for (const [field, value] of Object.entries(tokens.anthropic!)) {
        expect([name, field, Number.isInteger(value) && value >= 0]).toEqual([
          name,
          field,
          true,
        ]);
      }
    }
  });

  test("-batch and -fast count like their base model", () => {
    const variants = claude.filter((name) => /-(batch|fast)$/.test(name));
    expect(variants.length).toBeGreaterThan(0);
    for (const name of variants) {
      const base = name.replace(/-(batch|fast)$/, "") as ModelName;
      expect([name, models[name].encoding, models[name].tokens]).toEqual([
        name,
        models[base].encoding,
        models[base].tokens,
      ]);
    }
  });

  test("the models on a Claude encoding are the Claude models", () => {
    const onClaude = names.filter(
      (name) => "kind" in encodings[models[name].encoding]
    );
    expect(onClaude.sort()).toEqual([...claude].sort());
  });
});
