/**
 * count() reads a PDF once per message part, not once per call: an agent counts
 * the same conversation again after every turn.
 */
import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ModelMessage } from "ai";
import * as pdf from "./pdf";
import { models, Tokenizer, type Model } from "./index";
import * as claude_v3 from "./encoding/claude_v3";

// The exports as they are before the mock replaces them.
const real = { ...pdf };
let reads = 0;
mock.module("./pdf", () => ({
  ...real,
  readPdf: (bytes: Uint8Array) => {
    reads++;
    return real.readPdf(bytes);
  },
}));
const { count } = await import("./sdk");

const model = models["anthropic/claude-opus-4.6"] as Model;
const tokenizer = new Tokenizer(claude_v3);
const corpus = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`./fixtures/pdf/${name}`, import.meta.url))
  );
const total = (part: unknown) =>
  count({
    tokenizer,
    model,
    messages: [{ role: "user", content: [part] }] as ModelMessage[],
  }).total;

test("a PDF part is read once however often the conversation is counted", () => {
  const part = {
    type: "file",
    mediaType: "application/pdf",
    data: corpus("reportlab-table.pdf"),
  };
  reads = 0;
  const first = total(part);
  expect(total(part)).toBe(first);
  expect(total(part)).toBe(first);
  expect(reads).toBe(1);
});

test("a string of base64 is cached on its part too", () => {
  const part = {
    type: "file",
    mediaType: "application/pdf",
    data: Buffer.from(corpus("reportlab-table.pdf")).toString("base64"),
  };
  reads = 0;
  total(part);
  total(part);
  expect(reads).toBe(1);
});

test("another part with the same bytes, or the same part with new data, is read again", () => {
  const bytes = corpus("reportlab-table.pdf");
  const part = { type: "file", mediaType: "application/pdf", data: bytes };
  reads = 0;
  total(part);
  total({ ...part });
  expect(reads).toBe(2);
  const before = total(part);
  const other = corpus("pypdf-merged.pdf");
  (part as { data: Uint8Array }).data = other;
  expect(total(part)).not.toBe(before);
  expect(reads).toBe(3);
});

test("a PDF that cannot be read is cached as unreadable", () => {
  const part = {
    type: "file",
    mediaType: "application/pdf",
    data: new TextEncoder().encode("%PDF-1.4\nnot a PDF after all"),
  };
  reads = 0;
  total(part);
  total(part);
  expect(reads).toBe(1);
});
