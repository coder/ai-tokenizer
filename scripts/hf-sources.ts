import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const CACHE_DIR = path.join(
  import.meta.dirname,
  "../.cache/hf-tokenizers"
);

export interface Source {
  repo: string;
  revision: string;
  sha256: string;
}

export const SOURCES: Record<string, Source> = {
  llama4: {
    repo: "unsloth/Llama-4-Scout-17B-16E-Instruct",
    revision: "afd8e498c87bda51c7ea8ec68ea2f7c066e6340b",
    sha256: "172c9eb4beafc72601690da3ccfcede5c2e6806a8d5ec1fca33e22acea8023a4",
  },
  gemma4: {
    repo: "google/gemma-4-E4B-it",
    revision: "ee0ef6023621cff504d758262d4e04895a5af4a2",
    sha256: "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f",
  },
};

/**
 * Path of the pinned tokenizer.json. It is downloaded on first use, and its
 * SHA-256 must match the pin.
 */
export async function tokenizerJsonPath(name: string): Promise<string> {
  const source = SOURCES[name];
  if (source === undefined) throw new Error(`Unknown encoding: ${name}`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${name}-${source.revision}.json`);
  if (!fs.existsSync(file)) {
    const url = `https://huggingface.co/${source.repo}/resolve/${source.revision}/tokenizer.json`;
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  const sha256 = createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
  if (sha256 !== source.sha256) {
    throw new Error(`${file} has sha256 ${sha256}, expected ${source.sha256}`);
  }
  return file;
}

export async function downloadTokenizerJson(name: string): Promise<Buffer> {
  return fs.readFileSync(await tokenizerJsonPath(name));
}
