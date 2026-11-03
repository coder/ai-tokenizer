/**
 * Anthropic's count_tokens endpoint, which is free, for the scripts that
 * measure Claude models. Honors ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and
 * ANTHROPIC_API_KEY.
 *
 * Requests are built by the AI SDK's own Anthropic provider, so a probe is the
 * body a real call with the same messages and tools would send. A custom
 * `fetch` records that body and stops the call before it leaves the process.
 */
import { generateText, type ModelMessage, type ToolSet } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";

function headers(): Record<string, string> {
  const result: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    result.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    result["x-api-key"] = process.env.ANTHROPIC_API_KEY;
  }
  if (!result.authorization && !result["x-api-key"]) {
    throw new Error("set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN");
  }
  return result;
}

class CapturedRequest extends Error {
  constructor(readonly body: Record<string, unknown>) {
    super("request captured");
  }
}

const provider = createAnthropic({
  apiKey: "unused",
  fetch: (async (_url: unknown, init?: { body?: unknown }) => {
    throw new CapturedRequest(JSON.parse(String(init?.body)));
  }) as unknown as typeof fetch,
});

// The fields count_tokens accepts, of the ones a Messages request has.
const COUNTED_FIELDS = ["model", "system", "messages", "tools", "tool_choice"];

/** The request body the AI SDK builds for these messages and tools. */
export async function buildRequest(
  model: string,
  messages: ModelMessage[],
  tools?: ToolSet
): Promise<Record<string, unknown>> {
  // AI SDK v7 refuses `system` messages: the system prompt is `instructions`.
  const system = messages.filter((message) => message.role === "system");
  const rest = messages.filter((message) => message.role !== "system");
  try {
    await generateText({
      model: provider(model),
      messages: rest,
      ...(system.length > 0 && { instructions: system as never }),
      tools,
      maxRetries: 0,
    });
  } catch (error) {
    for (let e: any = error; e; e = e.cause ?? e.lastError ?? e.errors?.[0]) {
      if (e instanceof CapturedRequest) {
        return Object.fromEntries(
          Object.entries(e.body).filter(([key]) => COUNTED_FIELDS.includes(key))
        );
      }
    }
    throw error;
  }
  throw new Error("the AI SDK made no request");
}

/** `input_tokens` that count_tokens reports for a request body. */
export async function countTokens(
  body: Record<string, unknown>
): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (response.ok) {
      return ((await response.json()) as { input_tokens: number }).input_tokens;
    }
    if (response.status === 429 || response.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(
      `${body.model} ${response.status}: ${(await response.text()).slice(0, 300)}`
    );
  }
  throw new Error(`${body.model}: retries exhausted`);
}

/** The tokens count_tokens reports for messages and tools sent to `model`. */
export async function countMessagesTokens(
  model: string,
  messages: ModelMessage[],
  tools?: ToolSet
): Promise<number> {
  return countTokens(await buildRequest(model, messages, tools));
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!);
      }
    })
  );
  return results;
}
