/**
 * AI SDK compatibility tests.
 *
 * These run against whichever `ai` and `zod` are installed. CI installs
 * ai@5, ai@6 and ai@7 with zod 3 and zod 4 (see scripts/test-sdk-matrix.sh).
 * Message fixtures are plain objects, so every fixture runs in every cell:
 * `since` only records the first AI SDK major that accepts the shape.
 */

import { describe, test, expect } from "bun:test";
import { createRequire } from "node:module";
import { jsonSchema, type ModelMessage, type ToolSet } from "ai";
import * as z3 from "zod/v3";
import * as z4 from "zod/v4";
import { count } from "./sdk";
import { Tokenizer, type Model, type ModelTokens } from "./index";
import * as o200k from "./encoding/o200k_base";

const aiMajor = Number(
  (
    createRequire(import.meta.url)("ai/package.json") as { version: string }
  ).version.split(".")[0]
);

// Every overhead field has its own value, so a total can only
// match when each field was applied to the right thing.
const tokens: ModelTokens = {
  contentMultiplier: 1.5,
  baseOverhead: 7,
  perMessage: 3,
  toolsExist: 311,
  perTool: 53,
  perDesc: 5,
  perFirstProp: 13,
  perAdditionalProp: 17,
  perPropDesc: 19,
  perEnum: 23,
  perNestedObject: 29,
  perArrayOfObjects: 31,
};
const model = { tokens } as Model;
const tokenizer = new Tokenizer(o200k);
const enc = (text: string) => tokenizer.count(text);

function countTools(tools: Record<string, unknown>) {
  return count({
    tokenizer,
    model,
    messages: [],
    tools: tools as unknown as ToolSet,
  }).tools;
}

function schemaTokens(inputSchema: unknown): number {
  return countTools({ t: { inputSchema } }).definitions.t!.inputSchema;
}

describe("tool schemas", () => {
  // Shapes from the zod 4 `_def` walker that this release replaced. The
  // numbers were produced by that walker (src/sdk.ts at 107814b) with the
  // `tokens` above, so a change here is a change in calibrated totals.
  const unchanged = (z: any) => ({
    flat: [z.object({ a: z.string(), b: z.number(), c: z.boolean() }), 50],
    described: [
      z.object({
        city: z.string().describe("The city name"),
        days: z.number().describe("Number of days"),
        bare: z.boolean(),
      }),
      94,
    ],
    enumNoDesc: [z.object({ units: z.enum(["celsius", "fahrenheit"]) }), 41],
    enumDesc: [
      z.object({
        units: z.enum(["celsius", "fahrenheit", "kelvin"]).describe("Unit"),
      }),
      63,
    ],
    nested: [
      z.object({
        filters: z
          .object({
            category: z.string().describe("Category"),
            range: z
              .object({ start: z.string(), end: z.string().describe("End") })
              .describe("Range"),
          })
          .describe("Filters"),
        top: z.string(),
      }),
      234,
    ],
    nestedNoDesc: [
      z.object({ outer: z.object({ inner: z.object({ leaf: z.string() }) }) }),
      100,
    ],
    arrayOfStrings: [
      z.object({
        tags: z.array(z.string()).describe("Tags"),
        ids: z.array(z.number()),
      }),
      52,
    ],
    arrayOfObjects: [
      z.object({
        items: z
          .array(
            z.object({
              name: z.string().describe("Item name"),
              qty: z.number(),
            })
          )
          .describe("Items"),
      }),
      118,
    ],
    arrayInNested: [
      z.object({
        order: z.object({
          lines: z.array(
            z.object({ sku: z.string(), kind: z.enum(["a", "b"]) })
          ),
        }),
      }),
      145,
    ],
    arrayOfArrays: [
      z.object({ grid: z.array(z.array(z.object({ x: z.number() }))) }),
      14,
    ],
    arrayOfEnums: [
      z.object({ modes: z.array(z.enum(["r", "w"])).describe("Modes") }),
      35,
    ],
    emptyObject: [z.object({}), 0],
    strict: [z.object({ a: z.string().describe("A") }).strict(), 34],
    passthrough: [z.object({ a: z.string() }).passthrough(), 14],
    topLevelDescription: [
      z.object({ a: z.string() }).describe("Top level description"),
      14,
    ],
    literalUnionRecordAny: [
      z.object({
        lit: z.literal("x").describe("Lit"),
        uni: z.union([z.string(), z.number()]).describe("Uni"),
        rec: z.record(z.string(), z.string()),
        any: z.any(),
      }),
      108,
    ],
    unicodeKeys: [
      z.object({ größe: z.string().describe("Größe in cm"), 名前: z.string() }),
      55,
    ],
    defaultWithOuterDescription: [
      z.object({
        n: z.number().default(3).describe("N"),
        s: z.string().default("x"),
      }),
      52,
    ],
    optionalWithOuterDescription: [
      z.object({
        a: z.string().optional().describe("Desc on optional wrapper"),
      }),
      37,
    ],
    nullableWithOuterDescription: [
      z.object({
        a: z.string().nullable().describe("Desc on nullable wrapper"),
      }),
      37,
    ],
    unionOfObjects: [
      z.object({
        u: z
          .union([z.object({ a: z.string() }), z.object({ b: z.string() })])
          .describe("U"),
      }),
      34,
    ],
  });

  // Shapes the old walker skipped because a wrapper hid the inner type. The
  // provider sees the inner description, enum and properties, so they count.
  // `legacy` is what the old walker returned.
  const changed = (z: any) => ({
    optionalWithInnerDescription: [
      z.object({ a: z.string().describe("Desc inside").optional() }),
      35,
      14,
    ],
    nullableWithInnerDescription: [
      z.object({ a: z.string().describe("Desc inside").nullable() }),
      35,
      14,
    ],
    nullableEnum: [z.object({ u: z.enum(["a", "b"]).nullable() }), 39, 14],
    nullableObject: [
      z.object({ o: z.object({ x: z.string() }).nullable() }),
      57,
      14,
    ],
    nullableObjectWithOuterDescription: [
      z.object({
        o: z
          .object({ x: z.string().describe("X") })
          .describe("O")
          .nullable(),
      }),
      97,
      14,
    ],
    nullableArrayOfObjects: [
      z.object({ l: z.array(z.object({ x: z.string() })).nullable() }),
      59,
      14,
    ],
    nullableAndOptional: [
      z.object({
        q: z.string().describe("Q").nullable().optional(),
        r: z.number().nullish(),
      }),
      52,
      32,
    ],
    optionalEnum: [z.object({ u: z.enum(["a", "b"]).optional() }), 39, 14],
    optionalEnumWithOuterDescription: [
      z.object({ u: z.enum(["a", "b"]).optional().describe("U") }),
      59,
      34,
    ],
    optionalObject: [
      z.object({ o: z.object({ x: z.string().describe("X") }).optional() }),
      77,
      14,
    ],
    optionalArrayOfObjects: [
      z.object({ l: z.array(z.object({ x: z.string() })).optional() }),
      59,
      14,
    ],
    defaultObject: [
      z.object({ o: z.object({ x: z.string() }).default({ x: "" }) }),
      57,
      14,
    ],
    readonlyEnum: [z.object({ e: z.enum(["a", "b"]).readonly() }), 39, 14],
    mixedRealistic: [
      z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max results"),
        sort: z.enum(["asc", "desc"]).optional(),
        filters: z
          .object({
            since: z.string().optional(),
            tags: z.array(z.string()).optional(),
          })
          .optional(),
      }),
      196,
      110,
    ],
  });

  for (const [label, z] of [
    ["zod 3", z3],
    ["zod 4", z4],
  ] as const) {
    describe(label, () => {
      test.each(Object.entries(unchanged(z)))(
        "%s counts as the zod 4 walker did",
        (_name, [schema, expected]) => {
          expect(schemaTokens(schema)).toBe(expected as number);
        }
      );

      test.each(Object.entries(changed(z)))(
        "%s counts the inner type behind a wrapper",
        (_name, [schema, expected]) => {
          expect(schemaTokens(schema)).toBe(expected as number);
        }
      );
    });
  }

  test("numeric TypeScript enums count their values, not the reverse mapping", () => {
    enum Level {
      Low,
      High,
    }
    expect(schemaTokens(z4.object({ e: z4.enum(Level) }))).toBe(
      schemaTokens(z4.object({ e: z4.enum({ A: 1, B: 2 } as const) }))
    );
  });

  const sourceOfTruth = {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      units: { type: "string", enum: ["c", "f"] },
      filters: {
        type: "object",
        properties: { since: { type: "string" } },
      },
      items: {
        type: "array",
        items: { type: "object", properties: { id: { type: "number" } } },
      },
    },
  };
  const equivalent = (z: any) =>
    z.object({
      query: z.string().describe("Search query"),
      units: z.enum(["c", "f"]),
      filters: z.object({ since: z.string() }),
      items: z.array(z.object({ id: z.number() })),
    });

  test("zod 3, zod 4 and jsonSchema() tools give one total", () => {
    const expected = schemaTokens(jsonSchema(sourceOfTruth as never));
    expect(expected).toBeGreaterThan(0);
    expect(schemaTokens(equivalent(z3))).toBe(expected);
    expect(schemaTokens(equivalent(z4))).toBe(expected);
  });

  test("a jsonSchema() thunk is read once", () => {
    let reads = 0;
    const schema = jsonSchema((() => {
      reads++;
      return sourceOfTruth;
    }) as never);
    const first = schemaTokens(schema);
    expect(schemaTokens(schema)).toBe(first);
    expect(reads).toBe(1);
  });

  test("tools that are counted again are not converted again", () => {
    let conversions = 0;
    const lazy = () => {
      conversions++;
      return jsonSchema(sourceOfTruth as never);
    };
    const tools = { t: { inputSchema: lazy } };
    const first = countTools(tools).definitions.t!.inputSchema;
    expect(first).toBeGreaterThan(0);
    expect(countTools(tools).definitions.t!.inputSchema).toBe(first);
    expect(
      countTools({ other: { inputSchema: lazy } }).definitions.other!
        .inputSchema
    ).toBe(first);
    expect(conversions).toBe(1);
  });

  const standard = (convert: unknown) => ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      ...(convert ? { jsonSchema: { input: () => convert } } : {}),
    },
  });

  test.if(aiMajor >= 6)(
    "a Standard Schema with JSON Schema conversion counts (ai v6+)",
    () => {
      expect(schemaTokens(standard(sourceOfTruth))).toBe(
        schemaTokens(jsonSchema(sourceOfTruth as never))
      );
    }
  );

  test.if(aiMajor === 5)(
    "a Standard Schema is unresolved on ai v5, which only knows zod",
    () => {
      const tools = countTools({ t: { inputSchema: standard(sourceOfTruth) } });
      expect(tools.unresolved).toHaveLength(1);
      expect(tools.unresolved[0]).toMatchObject({
        tool: "t",
        part: "inputSchema",
        reason: "error",
      });
    }
  );

  describe("schemas count cannot read synchronously count 0 and are listed", () => {
    test("a Promise", async () => {
      const promise = Promise.resolve(sourceOfTruth);
      const tools = countTools({
        t: { inputSchema: jsonSchema(promise as never) },
      });
      expect(tools.definitions.t!.inputSchema).toBe(0);
      expect(tools.unresolved).toEqual([
        { tool: "t", part: "inputSchema", reason: "async" },
      ]);
      expect(tools.total).toBe(tokens.toolsExist + enc("t"));
      await promise;
    });

    test("a thunk that returns a Promise", () => {
      const tools = countTools({
        t: { inputSchema: jsonSchema((async () => sourceOfTruth) as never) },
      });
      expect(tools.unresolved).toEqual([
        { tool: "t", part: "inputSchema", reason: "async" },
      ]);
    });

    test("a rejecting Promise does not become an unhandled rejection", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const tools = countTools({
          t: {
            inputSchema: jsonSchema(Promise.reject(new Error("boom")) as never),
          },
        });
        expect(tools.unresolved[0]).toMatchObject({ reason: "async" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    test("a schema the AI SDK converts to nothing (arktype on ai v5)", () => {
      const tools = countTools({
        t: { inputSchema: jsonSchema(undefined as never) },
      });
      expect(tools.definitions.t!.inputSchema).toBe(0);
      expect(tools.unresolved).toMatchObject([
        { tool: "t", part: "inputSchema", reason: "error" },
      ]);
    });

    test("a thenable whose then() throws", () => {
      const thenable = {
        then() {
          throw new Error("boom");
        },
      };
      const tools = countTools({
        t: { inputSchema: jsonSchema(thenable as never) },
      });
      expect(tools.unresolved).toEqual([
        { tool: "t", part: "inputSchema", reason: "async" },
      ]);
    });

    test("a Standard Schema the AI SDK cannot convert to JSON Schema", () => {
      const tools = countTools({ t: { inputSchema: standard(undefined) } });
      expect(tools.unresolved).toHaveLength(1);
      expect(tools.unresolved[0]).toMatchObject({ reason: "error" });
      expect(tools.unresolved[0]!.error).toBeInstanceOf(Error);
    });

    test("one unreadable tool leaves the other tools exact", () => {
      const only = countTools({
        good: { inputSchema: z4.object({ a: z4.string() }) },
      });
      const both = countTools({
        bad: { inputSchema: standard(undefined) },
        good: { inputSchema: z4.object({ a: z4.string() }) },
      });
      expect(both.definitions.good).toEqual(only.definitions.good);
      expect(both.unresolved.map((u) => u.tool)).toEqual(["bad"]);
    });
  });

  describe("local $ref", () => {
    const address = z4
      .object({
        street: z4.string().describe("Street"),
        city: z4.string(),
      })
      .describe("Postal address");
    const inline = (schema: unknown) => schemaTokens(schema);

    test("a zod 4 schema registered with .meta({ id }) counts like the inline schema", () => {
      const registered = address.meta({ id: "Address" });
      expect(inline(z4.object({ home: registered, work: registered }))).toBe(
        inline(z4.object({ home: address, work: address }))
      );
      expect(inline(z4.object({ stops: z4.array(registered) }))).toBe(
        inline(z4.object({ stops: z4.array(address) }))
      );
    });

    test("a top-level $ref and a $ref inside nullable are followed", () => {
      const definitions = {
        Address: {
          type: "object",
          description: "Postal address",
          properties: { street: { type: "string", description: "Street" } },
        },
      };
      const direct = {
        type: "object",
        properties: { home: { $ref: "#/definitions/Address" } },
        definitions,
      };
      const nullable = {
        type: "object",
        properties: {
          home: {
            anyOf: [{ $ref: "#/definitions/Address" }, { type: "null" }],
          },
        },
        definitions,
      };
      const expected = inline(
        jsonSchema({
          type: "object",
          properties: { home: definitions.Address },
        } as never)
      );
      expect(inline(jsonSchema(direct as never))).toBe(expected);
      expect(inline(jsonSchema(nullable as never))).toBe(expected);
      const rootRef = {
        $ref: "#/$defs/Root",
        $defs: {
          Root: {
            type: "object",
            properties: { home: { $ref: "#/$defs/Address" } },
          },
          Address: definitions.Address,
        },
      };
      expect(inline(jsonSchema(rootRef as never))).toBe(expected);
    });

    test("a recursive $ref ends", () => {
      const tree = {
        type: "object",
        properties: { child: { $ref: "#" } },
      };
      expect(inline(jsonSchema(tree as never))).toBe(
        enc("child") + tokens.perFirstProp + tokens.perNestedObject
      );
    });

    test("an anchor is not resolved", () => {
      const anchored = {
        type: "object",
        properties: { a: { $ref: "#A" } },
        $defs: { A: { $anchor: "A", properties: { b: { type: "string" } } } },
      };
      expect(inline(jsonSchema(anchored as never))).toBe(
        enc("a") + tokens.perFirstProp
      );
    });

    test("a definition in a cycle counts once, with its back edge cut", () => {
      const first = tokens.perFirstProp + tokens.perNestedObject;
      const next = tokens.perAdditionalProp + tokens.perNestedObject;
      const mutual = {
        type: "object",
        properties: { a: { $ref: "#/$defs/A" }, b: { $ref: "#/$defs/B" } },
        $defs: {
          A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
          B: { type: "object", properties: { a: { $ref: "#/$defs/A" } } },
        },
      };
      // A is walked first and reaches B, whose edge back to A is cut. The
      // root's own `b` reuses that count of B.
      const b = enc("a") + first;
      const a = enc("b") + first + b;
      expect(inline(jsonSchema(mutual as never))).toBe(
        enc("a") + first + a + (enc("b") + next + b)
      );
    });

    test("definitions that all reference each other are bounded", () => {
      const size = 10;
      const $defs: Record<string, unknown> = {};
      for (let i = 0; i < size; i++) {
        const properties: Record<string, unknown> = { v: { type: "string" } };
        for (let j = 0; j < size; j++) {
          if (j !== i) properties[`k${j}`] = { $ref: `#/$defs/N${j}` };
        }
        $defs[`N${i}`] = { type: "object", properties };
      }
      const clique = {
        type: "object",
        properties: { n: { $ref: "#/$defs/N0" } },
        $defs,
      };

      const start = performance.now();
      expect(inline(jsonSchema(clique as never))).toBeGreaterThan(0);
      expect(performance.now() - start).toBeLessThan(500);
    });

    test("definitions that share definitions below a cycle are bounded", () => {
      const depth = 20;
      const $defs: Record<string, unknown> = {
        [`D${depth}`]: {
          type: "object",
          properties: { x: { type: "string" }, back: { $ref: "#" } },
        },
      };
      for (let level = depth - 1; level >= 0; level--) {
        const next = { $ref: `#/$defs/D${level + 1}` };
        $defs[`D${level}`] = {
          type: "object",
          properties: { l: next, r: next },
        };
      }
      const diamond = {
        type: "object",
        properties: { a: { $ref: "#/$defs/D0" } },
        $defs,
      };

      const start = performance.now();
      expect(inline(jsonSchema(diamond as never))).toBeGreaterThan(0);
      expect(performance.now() - start).toBeLessThan(500);
    });

    test("definitions that share definitions are walked once, not once per path", () => {
      const depth = 22;
      const $defs: Record<string, unknown> = {
        [`D${depth}`]: {
          type: "object",
          properties: { x: { type: "string" } },
        },
      };
      let expected = enc("x") + tokens.perFirstProp;
      for (let level = depth - 1; level >= 0; level--) {
        const next = { $ref: `#/$defs/D${level + 1}` };
        $defs[`D${level}`] = {
          type: "object",
          properties: { a: next, b: next },
        };
        expected =
          enc("a") +
          tokens.perFirstProp +
          tokens.perNestedObject +
          expected +
          (enc("b") +
            tokens.perAdditionalProp +
            tokens.perNestedObject +
            expected);
      }
      const dag = { $ref: "#/$defs/D0", $defs };

      const start = performance.now();
      const counted = inline(jsonSchema(dag as never));
      expect(performance.now() - start).toBeLessThan(500);
      expect(counted).toBe(expected);
    });

    test("keywords next to a $ref count with the target's", () => {
      const defs = { U: { type: "string" } };
      const withSiblings = {
        type: "object",
        properties: {
          u: { $ref: "#/$defs/U", enum: ["a", "b"], description: "Unit" },
        },
        $defs: defs,
      };
      const flat = {
        type: "object",
        properties: {
          u: { type: "string", enum: ["a", "b"], description: "Unit" },
        },
      };
      expect(inline(jsonSchema(withSiblings as never))).toBe(
        inline(jsonSchema(flat as never))
      );
    });

    test("a sibling keyword that is undefined does not hide the target's", () => {
      const withUndefined = {
        type: "object",
        properties: { u: { $ref: "#/$defs/U", description: undefined } },
        $defs: { U: { type: "string", description: "Unit" } },
      };
      const flat = {
        type: "object",
        properties: { u: { type: "string", description: "Unit" } },
      };
      expect(inline(jsonSchema(withUndefined as never))).toBe(
        inline(jsonSchema(flat as never))
      );
    });

    test("sibling properties are added to the target's, and win on a clash", () => {
      const withSiblings = {
        type: "object",
        properties: {
          base: {
            $ref: "#/$defs/Base",
            properties: {
              name: { type: "string", description: "Display name" },
              extra: { type: "number" },
            },
          },
        },
        $defs: {
          Base: {
            type: "object",
            properties: {
              id: { type: "string", description: "Id" },
              name: { type: "string" },
            },
          },
        },
      };
      const flat = {
        type: "object",
        properties: {
          base: {
            type: "object",
            properties: {
              id: { type: "string", description: "Id" },
              name: { type: "string", description: "Display name" },
              extra: { type: "number" },
            },
          },
        },
      };
      expect(inline(jsonSchema(withSiblings as never))).toBe(
        inline(jsonSchema(flat as never))
      );
    });

    test("a recursive $ref with sibling properties ends", () => {
      const first = tokens.perFirstProp + tokens.perNestedObject;
      const tree = {
        type: "object",
        properties: {
          child: { $ref: "#", properties: { note: { type: "string" } } },
        },
      };
      // `child` resolves to the root plus `note`. Inside that, `child` points
      // back at the same merged object, so it stops there.
      const merged =
        enc("child") + first + (enc("note") + tokens.perAdditionalProp);
      expect(inline(jsonSchema(tree as never))).toBe(
        enc("child") + first + merged
      );
    });

    test("a $ref to somewhere else counts nothing", () => {
      const remote = {
        type: "object",
        properties: { a: { $ref: "https://example.com/a.json" } },
      };
      expect(inline(jsonSchema(remote as never))).toBe(
        enc("a") + tokens.perFirstProp
      );
    });
  });

  describe("descriptions", () => {
    test("a v7 description function is called with an empty context", () => {
      const tools = countTools({
        t: {
          description: ({ context }: { context: object }) =>
            `ctx ${Object.keys(context).length}`,
        },
      });
      expect(tools.definitions.t!.description).toBe(
        tokens.perDesc + enc("ctx 0")
      );
      expect(tools.unresolved).toEqual([]);
    });

    test("a description function that throws is listed, not thrown", () => {
      const tools = countTools({
        t: {
          description: ({ context }: { context: { repo: { name: string } } }) =>
            context.repo.name,
        },
      });
      expect(tools.definitions.t!.description).toBe(0);
      expect(tools.unresolved).toMatchObject([
        { tool: "t", part: "description", reason: "error" },
      ]);
    });

    test.each(["provider", "provider-defined"])(
      "a %s tool counts its name, not the schema the provider ignores",
      (type) => {
        const tools = countTools({
          search: {
            type,
            id: "x.search",
            args: {},
            inputSchema: z4.object({ q: z4.string() }),
          },
        });
        expect(tools.definitions.search).toEqual({
          name: enc("search"),
          description: 0,
          inputSchema: 0,
        });
        expect(tools.unresolved).toEqual([]);
      }
    );
  });
});

type Role = "system" | "user" | "assistant" | "tool";

interface Fixture {
  name: string;
  /** First AI SDK major that accepts the shape. */
  since: 5 | 6 | 7;
  role: Role;
  /** String content, or the one part under test. */
  content: unknown;
  /** Texts the provider sees. Each is tokenized on its own. */
  text?: string[];
  /** Fixed media estimates, never multiplied. */
  media?: number;
}

const IMAGE = 85;
const FILE = 100;
const B64 = "iVBORw0KGgo=";
const toolResult = (output: unknown) => ({
  type: "tool-result",
  toolCallId: "call_1",
  toolName: "t",
  output,
});
const denied = (output: unknown) => ({ role: "tool" as const, output });

const fixtures: Fixture[] = [
  {
    name: "system string",
    since: 5,
    role: "system",
    content: "Be brief.",
    text: ["Be brief."],
  },
  {
    name: "user string",
    since: 5,
    role: "user",
    content: "Hello!",
    text: ["Hello!"],
  },
  {
    name: "text part",
    since: 5,
    role: "user",
    content: { type: "text", text: "Hello there" },
    text: ["Hello there"],
  },
  {
    name: "image part, base64",
    since: 5,
    role: "user",
    content: { type: "image", image: B64, mediaType: "image/png" },
    media: IMAGE,
  },
  {
    name: "image part, URL",
    since: 5,
    role: "user",
    content: { type: "image", image: new URL("https://example.com/a.png") },
    media: IMAGE,
  },
  {
    name: "file part, pdf",
    since: 5,
    role: "user",
    content: { type: "file", data: B64, mediaType: "application/pdf" },
    media: FILE,
  },
  {
    name: "file part with an image media type",
    since: 5,
    role: "user",
    content: { type: "file", data: B64, mediaType: "image/png" },
    media: IMAGE,
  },
  {
    name: "assistant reasoning is not counted",
    since: 5,
    role: "assistant",
    content: { type: "reasoning", text: "Let me think." },
  },
  {
    name: "assistant generated image",
    since: 5,
    role: "assistant",
    content: { type: "file", data: B64, mediaType: "image/webp" },
    media: IMAGE,
  },
  {
    name: "output text counts its wrapper",
    since: 5,
    role: "tool",
    content: toolResult({ type: "text", value: "sunny" }),
    text: ['{"type":"text","value":"sunny"}'],
  },
  {
    name: "output error-text",
    since: 5,
    role: "tool",
    content: toolResult({ type: "error-text", value: "not found" }),
    text: ['{"type":"error-text","value":"not found"}'],
  },
  {
    name: "output json counts its wrapper",
    since: 5,
    role: "tool",
    content: toolResult({ type: "json", value: { temp: 21 } }),
    text: ['{"type":"json","value":{"temp":21}}'],
  },
  {
    name: "output error-json",
    since: 5,
    role: "tool",
    content: toolResult({ type: "error-json", value: { code: 404 } }),
    text: ['{"type":"error-json","value":{"code":404}}'],
  },
  {
    name: "output json with a falsy value",
    since: 5,
    role: "tool",
    content: toolResult({ type: "json", value: 0 }),
    text: ['{"type":"json","value":0}'],
  },
  {
    name: "output content: text counts its wrapper, media is priced",
    since: 5,
    role: "tool",
    content: toolResult({
      type: "content",
      value: [
        { type: "text", text: "Here is the chart" },
        { type: "media", data: B64, mediaType: "image/png" },
        { type: "media", data: B64, mediaType: "application/pdf" },
      ],
    }),
    text: [
      '{"type":"content","value":[{"type":"text","text":"Here is the chart"}]}',
    ],
    media: IMAGE + FILE,
  },
  {
    name: "output as a bare string (legacy)",
    since: 5,
    role: "tool",
    content: toolResult("plain"),
    text: ["plain"],
  },
  {
    name: "unknown output shape falls back to JSON",
    since: 5,
    role: "tool",
    content: toolResult({ foo: 1 }),
    text: ['{"foo":1}'],
  },
  {
    name: "unknown message part is skipped",
    since: 5,
    role: "user",
    content: { type: "future-part", text: "ignored" },
  },

  {
    name: "output execution-denied with a reason",
    since: 6,
    role: "tool",
    content: toolResult({ type: "execution-denied", reason: "User said no" }),
    text: ['{"type":"execution-denied","reason":"User said no"}'],
  },
  {
    name: "output execution-denied without a reason",
    since: 6,
    role: "tool",
    content: toolResult({ type: "execution-denied" }),
    text: ['{"type":"execution-denied"}'],
  },
  {
    name: "output content: image-* items are images",
    since: 6,
    role: "tool",
    content: toolResult({
      type: "content",
      value: [
        { type: "image-data", data: B64, mediaType: "image/png" },
        { type: "image-url", url: "https://example.com/a.png" },
        { type: "image-file-id", fileId: "file_1" },
      ],
    }),
    text: ['{"type":"content","value":[]}'],
    media: 3 * IMAGE,
  },
  {
    name: "output content: file-* items are files unless the media type is an image",
    since: 6,
    role: "tool",
    content: toolResult({
      type: "content",
      value: [
        { type: "file-data", data: B64, mediaType: "application/pdf" },
        { type: "file-url", url: "https://example.com/a.pdf" },
        { type: "file-id", fileId: "file_2" },
        { type: "file-data", data: B64, mediaType: "image/jpeg" },
        { type: "custom", providerOptions: {} },
      ],
    }),
    text: [
      '{"type":"content","value":[{"type":"custom","providerOptions":{}}]}',
    ],
    media: 3 * FILE + IMAGE,
  },
  {
    name: "tool-approval-request is not sent to the provider",
    since: 6,
    role: "assistant",
    content: {
      type: "tool-approval-request",
      approvalId: "a",
      toolCallId: "call_1",
    },
  },
  {
    name: "tool-approval-response is not sent to the provider",
    since: 6,
    role: "tool",
    content: {
      type: "tool-approval-response",
      approvalId: "a",
      approved: true,
    },
  },

  {
    name: "file with media type 'image' and URL data",
    since: 7,
    role: "user",
    content: {
      type: "file",
      mediaType: "image",
      data: { type: "url", url: new URL("https://example.com/a.png") },
    },
    media: IMAGE,
  },
  {
    name: "file with image/* media type and tagged data",
    since: 7,
    role: "user",
    content: {
      type: "file",
      mediaType: "image/png",
      data: { type: "data", data: B64 },
    },
    media: IMAGE,
  },
  {
    name: "file with image media type and a provider reference",
    since: 7,
    role: "user",
    content: {
      type: "file",
      mediaType: "image",
      data: { type: "reference", reference: { openai: "file_1" } },
    },
    media: IMAGE,
  },
  {
    name: "file pdf with tagged data",
    since: 7,
    role: "user",
    content: {
      type: "file",
      mediaType: "application/pdf",
      data: { type: "data", data: new Uint8Array([1, 2, 3]) },
    },
    media: FILE,
  },
  {
    name: "file with inline text data is text, not a file",
    since: 7,
    role: "user",
    content: {
      type: "file",
      mediaType: "text/plain",
      data: { type: "text", text: "notes for the model" },
    },
    text: ["notes for the model"],
  },
  {
    name: "image part with a provider reference",
    since: 7,
    role: "user",
    content: { type: "image", image: { openai: "file_1" } },
    media: IMAGE,
  },
  {
    name: "reasoning-file image is not counted",
    since: 7,
    role: "assistant",
    content: {
      type: "reasoning-file",
      mediaType: "image/png",
      data: { type: "data", data: B64 },
    },
  },
  {
    name: "reasoning-file other is not counted",
    since: 7,
    role: "assistant",
    content: {
      type: "reasoning-file",
      mediaType: "application/octet-stream",
      data: B64,
    },
  },
  {
    name: "custom part",
    since: 7,
    role: "assistant",
    content: { type: "custom", kind: "openai.compaction" },
  },
  {
    name: "output content: file items with tagged data",
    since: 7,
    role: "tool",
    content: toolResult({
      type: "content",
      value: [
        {
          type: "file",
          mediaType: "image",
          data: { type: "url", url: new URL("https://example.com/a.png") },
        },
        {
          type: "file",
          mediaType: "application/pdf",
          data: { type: "data", data: B64 },
        },
        {
          type: "file",
          mediaType: "application/pdf",
          data: { type: "reference", reference: { anthropic: "file_3" } },
        },
        {
          type: "file",
          mediaType: "text/plain",
          data: { type: "text", text: "inline" },
        },
      ],
    }),
    text: [
      '{"type":"content","value":[{"type":"file","mediaType":"text/plain","data":{"type":"text","text":"inline"}}]}',
    ],
    media: IMAGE + 2 * FILE,
  },
];

describe("message parts", () => {
  test.each(fixtures)(
    "v$since: $name",
    ({ role, content, text = [], media = 0 }) => {
      const message = {
        role,
        content: typeof content === "string" ? content : [content],
      } as unknown as ModelMessage;
      const [counted] = count({
        tokenizer,
        model,
        messages: [message],
      }).messages;

      const textTokens = text.reduce((sum, t) => sum + enc(t), 0);
      const expected =
        Math.round(textTokens * tokens.contentMultiplier) + media;
      const [part] = counted!.content;
      if (!part) {
        expect(expected).toBe(0);
        expect(counted!.total).toBe(tokens.perMessage + enc(role));
        return;
      }
      expect(part.type === "tool-result" ? part.output : part.total).toBe(
        expected
      );
      expect(counted!.total).toBe(tokens.perMessage + enc(role) + part.total);
    }
  );

  test("a tool result total adds the call id to the output", () => {
    const [counted] = count({
      tokenizer,
      model,
      messages: [
        {
          role: "tool",
          content: [
            toolResult({
              type: "content",
              value: [
                { type: "text", text: "ok" },
                { type: "media", data: B64, mediaType: "image/png" },
              ],
            }),
          ],
        },
      ] as unknown as ModelMessage[],
    }).messages;
    const serialized =
      '{"type":"content","value":[{"type":"text","text":"ok"}]}';
    expect(counted!.content[0]).toEqual({
      type: "tool-result",
      total:
        Math.round(
          (enc("call_1") + enc(serialized)) * tokens.contentMultiplier
        ) + IMAGE,
      output: Math.round(enc(serialized) * tokens.contentMultiplier) + IMAGE,
    });
  });

  test("a tool call counts its name and input", () => {
    const input = { location: "Paris" };
    const [counted] = count({
      tokenizer,
      model,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "getWeather",
              input,
            },
          ],
        },
      ] as ModelMessage[],
    }).messages;
    expect(counted!.content[0]).toEqual({
      type: "tool-call",
      total: Math.round(
        (enc("getWeather") + enc(JSON.stringify(input))) *
          tokens.contentMultiplier
      ),
      input: Math.round(enc(JSON.stringify(input)) * tokens.contentMultiplier),
    });
  });
});
