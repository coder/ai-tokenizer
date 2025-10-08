import { streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { type ModelName, models, type Model } from "../src"
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import Tokenizer from "../src/tokenizer";
import { createHash } from "crypto";
import { count } from "../src/sdk";
import * as encodings from "../src/encoding";

if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error("No AI_GATEWAY_API_KEY");
}

// Models to test
const MODELS_TO_TEST: ModelName[] = Object.keys(models) as ModelName[];

// Define tools for testing (with complex nested schemas)
const tools = {
    analyzeData: tool({
        description: "Analyze dataset with comprehensive statistical insights and trend detection",
        inputSchema: z.object({
            query: z.string().describe("Analysis query"),
            filters: z.object({
                category: z.string().describe("Category filter"),
                dateRange: z.object({
                    start: z.string().describe("Start date ISO format"),
                    end: z.string().describe("End date ISO format"),
                }).describe("Date range for filtering"),
                tags: z.array(z.string()).describe("Tag filters"),
            }).describe("Data filters"),
            aggregation: z.enum(["sum", "avg", "min", "max", "count"]).describe("Aggregation method"),
        }),
    }),
};

// Diverse message templates for realistic testing
const messageTemplates = [
    "Hello! I need help analyzing customer data from Q{Q} {YEAR}. Can you provide insights on revenue trends, retention rates, and growth patterns?",
    "Write a {LANG} function to calculate {METRIC} with error handling and validation. Include proper type annotations and documentation.",
    "你好！{TOPIC}についての情報を教えてください。한국어로도説명できますか？ Пожалуйста, объясните на русском языке. شكراً لك على المساعدة.",
    "Explain quantum {CONCEPT}: ψ(x) = Ae^(ikx), where ℏω = E_{n}. The Schrödinger equation shows how {PARTICLE} behave at quantum scales.",
    "Emojis test 🚀 {EMOJI1} {EMOJI2} {EMOJI3} ⭐ ✨ • ○ ● ▪ ■ ← → ↔ ≈ ≠ ≤ ≥ ± ∞ ∑ √ special characters tokenize differently!",
    "const {FUNC} = async () => {{ const response = await fetch('{URL}'); const data = await response.json(); return data.{FIELD}; }}; // Modern {LANG} with async/await",
    "Technical: {TECH1}, {TECH2}, {TECH3}, microservices, Docker, PostgreSQL, GraphQL, REST API, OAuth2, JWT, WebSocket, gRPC, serverless, edge computing.",
    "Numbers: {NUM1}, 0x{HEX}, {IP}, UUID: {UUID}, API_KEY_{YEAR}_v{VER}, user_id_{ID}, $price = {PRICE}, discount = {PCT}%, timestamp: {TIMESTAMP}",
    "Mixed content: The café serves {FOOD} 🍮, naïve résumé, Zürich coöperation. Quotes: \"{QUOTE}\". Math: ∀x ∈ ℝ, ∃y. Currency: ${DOLLAR} €{EURO} £{POUND}",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. {ACTION} tempor incididunt ut labore et dolore magna aliqua. {PHRASE} ad minim veniam.",
];

const replacements: Record<string, string[]> = {
    "{Q}": ["1", "2", "3", "4"],
    "{YEAR}": ["2023", "2024", "2025"],
    "{LANG}": ["Python", "JavaScript", "TypeScript", "Go", "Rust"],
    "{METRIC}": ["fibonacci", "factorial", "prime numbers", "sorting"],
    "{TOPIC}": ["機械学習", "人工知能", "データ分析"],
    "{CONCEPT}": ["entanglement", "superposition", "tunneling"],
    "{PARTICLE}": ["electrons", "photons", "quarks"],
    "{EMOJI1}": ["🎉", "🔥", "💯", "🌟"],
    "{EMOJI2}": ["🎨", "🎭", "🎪", "🎬"],
    "{EMOJI3}": ["⚡", "🌈", "🎯", "💡"],
    "{FUNC}": ["fetchData", "processData", "analyzeMetrics"],
    "{URL}": ["https://api.example.com/v1/data", "https://service.io/api/metrics"],
    "{FIELD}": ["results", "metrics", "analytics", "insights"],
    "{TECH1}": ["Kubernetes", "Redis", "Elasticsearch"],
    "{TECH2}": ["Kafka", "RabbitMQ", "NATS"],
    "{TECH3}": ["Terraform", "Ansible", "Jenkins"],
    "{NUM1}": ["1234567890", "9876543210"],
    "{HEX}": ["1A2B3C4D", "DEADBEEF"],
    "{IP}": ["192.168.1.1", "10.0.0.1"],
    "{UUID}": ["550e8400-e29b-41d4-a716-446655440000"],
    "{ID}": ["42", "1337", "9001"],
    "{VER}": ["2", "3", "4"],
    "{PRICE}": ["19.99", "29.99", "49.99"],
    "{PCT}": ["15", "20", "25"],
    "{TIMESTAMP}": ["2024-01-15T10:30:45Z", "2025-03-20T14:22:10Z"],
    "{FOOD}": ["crème brûlée", "café au lait", "pâté"],
    "{QUOTE}": ["Hello world", "Bonjour monde", "Hola mundo"],
    "{DOLLAR}": ["100", "250", "500"],
    "{EURO}": ["85", "200", "425"],
    "{POUND}": ["75", "175", "375"],
    "{ACTION}": ["Sed do eiusmod", "Duis aute irure", "Excepteur sint"],
    "{PHRASE}": ["Ut enim", "Quis nostrud", "Nisi ut"],
};

function fillTemplate(template: string): string {
    let result = template;
    for (const [placeholder, options] of Object.entries(replacements)) {
        if (result.includes(placeholder)) {
            const randomOption = options[Math.floor(Math.random() * options.length)]!;
            result = result.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), randomOption);
        }
    }
    return result;
}

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

    const messages: ModelMessage[] = [];

    // Add system message for OpenAI, skip for Anthropic (they don't support it)
    messages.push({
        role: "system",
        content: fillTemplate("You are an expert AI assistant specializing in {TECH1} and {TECH2}. Help users with detailed analysis and technical guidance.")
    });

    // Build messages until we reach approximately the target token count
    let messageIdx = 0;

    // Always add at least one user message first
    messages.push({
        role: "user",
        content: fillTemplate(messageTemplates[0]!)
    });
    messageIdx++;

    while (true) {
        const tokenizer = new Tokenizer(encodings[modelConfig.encoding]);
        const currentTokens = count({ tokenizer, messages, tools, model: modelConfig });
        if (currentTokens.total >= targetTokens * 0.9 && messages.length >= 2) break; // Stop at 90% with at least 2 messages

        const role = messageIdx % 2 === 0 ? "user" : "assistant";
        const template = messageTemplates[messageIdx % messageTemplates.length]!;
        const content = fillTemplate(template);

        // Sometimes use array content with multiple text parts (more realistic)
        if (messageIdx % 7 === 0 && role === "user") {
            messages.push({
                role,
                content: [
                    { type: "text", text: content },
                    { type: "text", text: fillTemplate("Additionally, can you help with {TECH1}?") }
                ]
            });
        } else if (role === "assistant" && messageIdx % 13 === 3) {
            // Include tool calls in some assistant messages
            const toolCallId = `call${messageIdx.toString().padStart(5, '0')}`;
            messages.push({
                role,
                content: [
                    { type: "text", text: content },
                    {
                        type: "tool-call",
                        toolCallId,
                        toolName: "analyzeData",
                        input: {
                            query: fillTemplate("Q{Q} analysis"),
                            filters: {
                                category: fillTemplate("{TECH1}"),
                                dateRange: { start: "2024-01-01", end: "2024-12-31" },
                                tags: ["test"]
                            },
                            aggregation: "sum"
                        },
                    }
                ]
            });
            messageIdx++;

            // Add corresponding tool result
            messages.push({
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId,
                        toolName: "analyzeData",
                        output: {
                            type: "json",
                            value: {
                                status: "success",
                                message: fillTemplate("Analysis complete for {TECH1}. Found {NUM1} records."),
                                count: Math.floor(Math.random() * 10000)
                            }
                        }
                    }
                ]
            });
        } else {
            // Regular string content
            messages.push({ role, content });
        }

        messageIdx++;
    }

    const tokenizer = new Tokenizer(encodings[modelConfig.encoding]);
    const predicted = count({ tokenizer, messages, tools, model: modelConfig });

    const result = streamText({
        model: modelName,
        messages,
        tools,
        maxOutputTokens: 16,
    });
    await result.consumeStream();
    const usage = await result.usage;
    const actual = usage.inputTokens!;

    return { predicted: predicted.total, actual };
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
        "anthropic/claude-sonnet-4.5",
        "google/gemini-2.5-pro"
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

