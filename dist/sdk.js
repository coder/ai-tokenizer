//#region src/tokenizer.ts
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

//#endregion
//#region src/sdk.ts
/**
* count returns a token estimation for a model given messages and tools.
*
* It returns a detailed breakdown per-message and per-tool.
* Users can filter out messages based on large tool results, for example.
*/
function count(options) {
	const config = options.model.tokens;
	let total = config.baseOverhead;
	const messages = [];
	for (const message of options.messages) {
		const messageResult = countMessageTokensDetailed(options.tokenizer, message, config);
		messages.push(messageResult);
		total += messageResult.total;
	}
	const toolsResult = countToolsTokensDetailed(options.tokenizer, options.tools, config);
	total += toolsResult.total;
	return {
		total,
		messages,
		tools: toolsResult
	};
}
/**
* Count tokens for tools with detailed breakdown
*/
function countToolsTokensDetailed(tokenizer, tools, config) {
	if (!config) throw new Error("config is required");
	const definitions = {};
	let total = 0;
	if (tools && Object.keys(tools).length > 0) {
		total += config.toolsExist;
		const toolEntries = Object.entries(tools);
		for (let i = 0; i < toolEntries.length; i++) {
			const [toolName, tool] = toolEntries[i];
			const nameTokens = tokenizer.encode(toolName).length;
			let descriptionTokens = 0;
			if (tool.description) descriptionTokens = config.perDesc + tokenizer.encode(tool.description).length;
			let inputSchemaTokens = 0;
			if (tool.inputSchema) inputSchemaTokens = countZodSchemaProperties(tool.inputSchema, tokenizer, config).tokens;
			definitions[toolName] = {
				name: nameTokens,
				description: descriptionTokens,
				inputSchema: inputSchemaTokens
			};
			total += nameTokens + descriptionTokens + inputSchemaTokens;
			if (i > 0) total += config.perTool;
		}
	}
	return {
		total,
		definitions
	};
}
/**
* Count tokens for a single message with detailed breakdown
*/
function countMessageTokensDetailed(tokenizer, message, config) {
	let total = config.perMessage;
	const content = [];
	total += tokenizer.encode(message.role).length;
	if (message.content) {
		const contentResult = countMessageContentTokensDetailed(tokenizer, message.content, config);
		content.push(...contentResult);
		total += contentResult.reduce((sum, c) => sum + c.total, 0);
	}
	return {
		total,
		content
	};
}
/**
* Count tokens for message content with detailed breakdown
*/
function countMessageContentTokensDetailed(tokenizer, content, config) {
	const multiplier = config.contentMultiplier;
	const results = [];
	if (typeof content === "string") {
		const tokens = tokenizer.encode(content).length;
		const total = Math.round(tokens * multiplier);
		results.push({
			type: "text",
			total
		});
		return results;
	}
	if (Array.isArray(content)) {
		for (const part of content) if (part.type === "text") {
			const tokens = tokenizer.encode(part.text).length;
			const total = Math.round(tokens * multiplier);
			results.push({
				type: "text",
				total
			});
		} else if (part.type === "tool-call") {
			let toolCallTokens = 0;
			let inputTokens = 0;
			if (part.toolName) toolCallTokens += tokenizer.encode(part.toolName).length;
			if (part.input) {
				inputTokens = tokenizer.encode(JSON.stringify(part.input)).length;
				toolCallTokens += inputTokens;
			}
			const total = Math.round(toolCallTokens * multiplier);
			results.push({
				type: "tool-call",
				total,
				input: Math.round(inputTokens * multiplier)
			});
		} else if (part.type === "tool-result") {
			let toolResultTokens = 0;
			let outputTokens = 0;
			if (part.toolCallId) toolResultTokens += tokenizer.encode(part.toolCallId).length;
			if (part.output) {
				if (typeof part.output === "string") outputTokens = tokenizer.encode(part.output).length;
				else outputTokens = tokenizer.encode(JSON.stringify(part.output)).length;
				toolResultTokens += outputTokens;
			}
			const total = Math.round(toolResultTokens * multiplier);
			results.push({
				type: "tool-result",
				total,
				output: Math.round(outputTokens * multiplier)
			});
		} else if (part.type === "image") results.push({
			type: "text",
			total: 85
		});
		else if (part.type === "file") results.push({
			type: "text",
			total: 100
		});
	}
	return results;
}
/**
* Count properties in a Zod schema by walking its structure
*/
function countZodSchemaProperties(schema, tokenizer, config) {
	let tokens = 0;
	let propCount = 0;
	if (!schema || !schema._def) return {
		tokens,
		propCount
	};
	const def = schema._def;
	if (def.type === "object") {
		const shape = typeof def.shape === "function" ? def.shape() : def.shape;
		if (!shape) return {
			tokens,
			propCount
		};
		for (const [key, value] of Object.entries(shape)) {
			const isFirstProp = propCount === 0;
			propCount++;
			const propSchema = value;
			tokens += tokenizer.encode(key).length;
			tokens += isFirstProp ? config.perFirstProp : config.perAdditionalProp;
			if (propSchema.description) {
				tokens += config.perPropDesc;
				tokens += tokenizer.encode(propSchema.description).length;
			}
			if (propSchema._def && propSchema._def.type === "enum") {
				const enumDef = propSchema._def;
				const enumValues = enumDef.values || Object.values(enumDef.entries || {});
				tokens += config.perEnum;
				for (const enumValue of enumValues) tokens += tokenizer.encode(String(enumValue)).length;
			}
			if (propSchema._def) {
				const innerDef = propSchema._def;
				if (innerDef.type === "object") {
					tokens += config.perNestedObject || 0;
					const nested = countZodSchemaProperties(propSchema, tokenizer, config);
					tokens += nested.tokens;
				} else if (innerDef.type === "array" && innerDef.element) {
					const elementDef = innerDef.element._def;
					if (elementDef && elementDef.type === "object") tokens += config.perArrayOfObjects || 0;
					const nested = countZodSchemaProperties(innerDef.element, tokenizer, config);
					tokens += nested.tokens;
				}
			}
		}
	}
	return {
		tokens,
		propCount
	};
}

//#endregion
export { count };
//# sourceMappingURL=sdk.js.map