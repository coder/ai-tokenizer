/**
 * The tool-definition probes behind the tool fields of `ModelTokens`. Each is
 * one request; the fields come from the difference between two of them, so
 * every probe sends the same user message.
 */
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";

export interface Probe {
  messages: ModelMessage[];
  tools: ToolSet;
}

const messages: ModelMessage[] = [{ role: "user", content: "Test" }];
const probe = (tools: ToolSet): Probe => ({ messages, tools });
const x = (inputSchema: z.ZodObject, description?: string) =>
  probe({ x: tool({ description, inputSchema }) });

export const toolProbes = {
  noTools: probe({}),
  emptyTool: x(z.object({})),
  twoTools: probe({
    x: tool({ inputSchema: z.object({}) }),
    y: tool({ inputSchema: z.object({}) }),
  }),
  withDesc: x(z.object({}), "Hi"),
  oneProp: x(z.object({ y: z.string() })),
  twoProp: x(z.object({ y: z.string(), z: z.string() })),
  propWithDesc: x(z.object({ y: z.string().describe("Hi") })),
  stringProp: x(z.object({ y: z.string() })),
  enumProp: x(z.object({ y: z.enum(["a", "b", "c"]) })),
  flatTwoProps: x(
    z.object({ y: z.string().describe("Hi"), z: z.string().describe("Hi") })
  ),
  nestedTwoProps: x(
    z.object({
      data: z
        .object({
          y: z.string().describe("Hi"),
          z: z.string().describe("Hi"),
        })
        .describe("Data"),
    })
  ),
  describedItems: x(z.object({ items: z.string().describe("Items") })),
  arrayOfStrings: x(z.object({ items: z.array(z.string()).describe("Items") })),
  arrayOfObjects: x(
    z.object({
      items: z
        .array(
          z.object({
            y: z.string().describe("Hi"),
            z: z.string().describe("Hi"),
          })
        )
        .describe("Items"),
    })
  ),
} satisfies Record<string, Probe>;

export type ToolProbeName = keyof typeof toolProbes;
