import { streamText, type ModelMessage } from "ai";
import { type ModelName, models, type Model } from "../src"
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import Tokenizer from "../src/tokenizer";
import { createHash } from "crypto";
import { count } from "../src/sdk";
import * as encodings from "../src/encoding";
import { buildConversation, seeded, tools } from "./accuracy-workload";
import { countMessagesTokens } from "./anthropic";
import { claudeApiId, isMeasurableClaude } from "./calibrate-anthropic";

// --provider gateway (default): the actual count is the token usage the AI
// Gateway reports. --provider anthropic: only the Claude models, with the
// actual count from Anthropic's free count_tokens, so no gateway key is
// needed. --model <id> limits the run to the ids that contain it.
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined
const provider = flag("provider") ?? "gateway"
const only = flag("model")
if (provider !== "gateway" && provider !== "anthropic") {
    throw new Error(`Unknown --provider ${provider}: use gateway or anthropic`)
}

if (provider === "gateway" && !process.env.AI_GATEWAY_API_KEY) {
    throw new Error("No AI_GATEWAY_API_KEY")
}

// Models to test. The -batch and -fast Claude ids count like their base model,
// and the retired ones are not known to count_tokens.
const MODELS_TO_TEST: ModelName[] = (Object.keys(models) as ModelName[]).filter(model => {
    if (only !== undefined && !model.includes(only)) return false
    return provider === "gateway" || (model.startsWith("anthropic/claude-") && isMeasurableClaude(model))
})

interface AccuracyResult {
    model: string;
    configHash: string;
    small: { predicted: number; actual: number; error: number; accuracy: string } | null;
    medium: { predicted: number; actual: number; error: number; accuracy: string } | null;
    large: { predicted: number; actual: number; error: number; accuracy: string } | null;
}

interface AccuracyCache {
    [model: string]: AccuracyResult;
}

function hashModelConfig(model: ModelName): string {
    const config = models[model] as Model;
    if (!config) return "";
    // Hash only the token config parameters that affect counting
    const relevantConfig = JSON.stringify(config.tokens);
    return createHash("md5").update(relevantConfig).digest("hex").substring(0, 8);
}

function loadAccuracyCache(): AccuracyCache {
    const cachePath = join(process.cwd(), "accuracy.json");
    if (existsSync(cachePath)) {
        try {
            const data = readFileSync(cachePath, "utf-8");
            return JSON.parse(data);
        } catch (error) {
            console.log("⚠️  Could not load accuracy cache, starting fresh");
            return {};
        }
    }
    return {};
}

function saveAccuracyCache(cache: AccuracyCache) {
    const cachePath = join(process.cwd(), "accuracy.json");
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}

async function testModelAtScale(modelName: ModelName, targetTokens: number): Promise<{ predicted: number; actual: number } | null> {
    // Check if target tokens exceeds model's context window
    const modelConfig = models[modelName] as Model;
    if (modelConfig && modelConfig.contextWindow < targetTokens) {
        console.log(`  Skipping (context window ${modelConfig.contextWindow} < ${targetTokens})`);
        return null;
    }

    const tokenizer = new Tokenizer(encodings[modelConfig.encoding]);
    const countMessages = (messages: ModelMessage[]) => count({ tokenizer, messages, tools, model: modelConfig }).total;
    // Gemini 3 Pro Preview requies thought signatures for tool calls :/
    const messages = buildConversation(countMessages, targetTokens, seeded(targetTokens), modelName !== "google/gemini-3-pro-preview");
    const predicted = countMessages(messages);

    if (provider === "anthropic") {
        return { predicted, actual: await countMessagesTokens(claudeApiId(modelName), messages, tools) };
    }

    // The system prompt is `instructions` in AI SDK v7, which refuses a system message.
    const result = streamText({
        model: modelName,
        instructions: messages.filter(message => message.role === "system").map(message => message.content).join(""),
        messages: messages.filter(message => message.role !== "system"),
        tools,
        maxOutputTokens: 16,
    });
    await result.consumeStream();
    const usage = await result.usage;
    const actual = usage.inputTokens!;

    return { predicted, actual };
}

function formatAccuracy(predicted: number, actual: number): string {
    const error = Math.abs(actual - predicted);
    const accuracy = ((1 - error / actual) * 100).toFixed(2);
    return `${accuracy}%`;
}

async function generateAccuracyMetrics(cache: AccuracyCache): Promise<AccuracyCache> {
    console.log("🔍 Generating accuracy metrics...\n");

    const updatedCache = { ...cache };

    for (const model of MODELS_TO_TEST) {
        const configHash = hashModelConfig(model);

        // Check if we already have cached results with the same config
        const cached = cache[model];
        if (cached && cached.configHash === configHash) {
            console.log(`✓ ${model} (cached, config unchanged)`);
            continue;
        }

        if (cached) {
            console.log(`Testing ${model} (config changed: ${cached.configHash} → ${configHash})...`);
        } else {
            console.log(`Testing ${model}...`);
        }

        // Small: ~500 tokens
        const small = await testModelAtScale(model, 500);
        if (small) {
            console.log(`  Small (~500t): pred=${small.predicted}, actual=${small.actual}, ${formatAccuracy(small.predicted, small.actual)}`);
        }

        // Medium: ~5,000 tokens  
        const medium = await testModelAtScale(model, 5000);
        if (medium) {
            console.log(`  Medium (~5kt): pred=${medium.predicted}, actual=${medium.actual}, ${formatAccuracy(medium.predicted, medium.actual)}`);
        }

        // Large: ~50,000 tokens
        const large = await testModelAtScale(model, 50000);
        if (large) {
            console.log(`  Large (~50kt): pred=${large.predicted}, actual=${large.actual}, ${formatAccuracy(large.predicted, large.actual)}\n`);
        } else {
            console.log();
        }

        updatedCache[model] = {
            model,
            configHash,
            small: small ? {
                predicted: small.predicted,
                actual: small.actual,
                error: Math.abs(small.actual - small.predicted),
                accuracy: formatAccuracy(small.predicted, small.actual),
            } : null,
            medium: medium ? {
                predicted: medium.predicted,
                actual: medium.actual,
                error: Math.abs(medium.actual - medium.predicted),
                accuracy: formatAccuracy(medium.predicted, medium.actual),
            } : null,
            large: large ? {
                predicted: large.predicted,
                actual: large.actual,
                error: Math.abs(large.actual - large.predicted),
                accuracy: formatAccuracy(large.predicted, large.actual),
            } : null,
        };

        // Save immediately after each successful test
        saveAccuracyCache(updatedCache);
    }

    return updatedCache;
}

function generateMarkdownTable(cache: AccuracyCache): { popularTable: string; fullTable: string } {
    // Popular models to highlight
    const popularModels: ModelName[] = [
        "openai/gpt-5",
        "anthropic/claude-opus-4.5",
        "google/gemini-3-pro-preview",
    ];

    // Generate popular models table
    let popularTable = "| Model | ~500 tokens | ~5k tokens | ~50k tokens |\n";
    popularTable += "|-------|-------------|------------|-------------|\n";

    for (const modelKey of popularModels) {
        if (cache[modelKey]) {
            const result = cache[modelKey]!;
            const modelName = result.model;

            const small = result.small ? result.small.accuracy : "N/A";
            const medium = result.medium ? result.medium.accuracy : "N/A";
            const large = result.large ? result.large.accuracy : "N/A";

            popularTable += `| ${modelName} | ${small} | ${medium} | ${large} |\n`;
        }
    }

    // Generate full table (all models sorted alphabetically)
    let fullTable = "| Model | ~500 tokens | ~5k tokens | ~50k tokens |\n";
    fullTable += "|-------|-------------|------------|-------------|\n";

    const sortedModels = Object.keys(cache).sort();

    for (const modelKey of sortedModels) {
        const result = cache[modelKey]!;
        const modelName = result.model;

        const small = result.small ? result.small.accuracy : "N/A";
        const medium = result.medium ? result.medium.accuracy : "N/A";
        const large = result.large ? result.large.accuracy : "N/A";

        fullTable += `| ${modelName} | ${small} | ${medium} | ${large} |\n`;
    }

    return { popularTable, fullTable };
}

function updateReadme(popularTable: string, fullTable: string) {
    const readmePath = join(process.cwd(), "README.md");
    let readme = readFileSync(readmePath, "utf-8");

    // Replace the popular models table section
    const popularStartMarker = "<!-- POPULAR_MODELS_TABLE_START -->";
    const popularEndMarker = "<!-- POPULAR_MODELS_TABLE_END -->";

    const popularStartIndex = readme.indexOf(popularStartMarker);
    const popularEndIndex = readme.indexOf(popularEndMarker);

    if (popularStartIndex !== -1 && popularEndIndex !== -1) {
        const before = readme.substring(0, popularStartIndex + popularStartMarker.length);
        const after = readme.substring(popularEndIndex);
        readme = `${before}\n${popularTable}\n${after}`;
    }

    // Replace the full accuracy table section
    const fullStartMarker = "<!-- ACCURACY_TABLE_START -->";
    const fullEndMarker = "<!-- ACCURACY_TABLE_END -->";

    const fullStartIndex = readme.indexOf(fullStartMarker);
    const fullEndIndex = readme.indexOf(fullEndMarker);

    if (fullStartIndex === -1 || fullEndIndex === -1) {
        console.log("⚠️  Markers not found in README.md. Adding section at the end...");
        readme += `\n\n## Token Counting Accuracy\n\n${fullStartMarker}\n${fullTable}\n${fullEndMarker}\n`;
    } else {
        const before = readme.substring(0, fullStartIndex + fullStartMarker.length);
        const after = readme.substring(fullEndIndex);
        readme = `${before}\n${fullTable}\n${after}`;
    }

    writeFileSync(readmePath, readme, "utf-8");
    console.log("\n✅ Updated README.md with accuracy tables");
}

// Main execution
console.log("🚀 Generating Token Counting Accuracy Metrics\n");
console.log("This will test models at 3 different scales and update README.md\n");

// Load existing cache
const cache = loadAccuracyCache();
console.log(`📦 Loaded ${Object.keys(cache).length} cached results\n`);

if (provider === "anthropic") {
    // Their config changed, and there is nothing to compare it with.
    for (const model of Object.keys(cache)) {
        if (model.startsWith("anthropic/claude-") && !isMeasurableClaude(model) && !/-(batch|fast)$/.test(model)) {
            console.log(`✗ ${model} (dropped: count_tokens does not take it)`);
            delete cache[model];
        }
    }
}

// Generate/update accuracy metrics
const updatedCache = await generateAccuracyMetrics(cache);

// Save updated cache
saveAccuracyCache(updatedCache);
console.log(`\n💾 Saved ${Object.keys(updatedCache).length} results to accuracy.json`);

// Generate tables from all cached results
console.log("\n📊 Full Results Summary:\n");
const { popularTable, fullTable } = generateMarkdownTable(updatedCache);
console.log("Popular Models:");
console.log(popularTable);
console.log("\nAll Models:");
console.log(fullTable);

updateReadme(popularTable, fullTable);

console.log("\n✅ Done! Run 'bun run scripts/generate-accuracy.ts' to update accuracy metrics.");

