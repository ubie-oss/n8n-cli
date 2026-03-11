/**
 * generate-schemas.ts
 *
 * Reads INodeTypeDescription from n8n packages' dist/types/nodes.json
 * and generates src/generated/node-schemas.json with param schemas.
 *
 * Usage: bun run scripts/generate-schemas.ts
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types matching the subset of INodeTypeDescription we need
// ---------------------------------------------------------------------------

interface NodePropertyOption {
	name?: string;
	value: string | number | boolean;
}

interface DisplayOptions {
	show?: Record<string, Array<string | number | boolean>>;
	hide?: Record<string, Array<string | number | boolean>>;
}

interface NodeProperty {
	name: string;
	displayName?: string;
	type: string;
	description?: string;
	required?: boolean;
	default?: unknown;
	options?: NodePropertyOption[];
	displayOptions?: DisplayOptions;
}

interface CredentialEntry {
	name: string;
	required?: boolean;
}

interface NodeTypeDescription {
	name: string;
	displayName?: string;
	description?: string;
	version: number | number[];
	group?: string[];
	inputs?: string[];
	outputs?: string[];
	usableAsTool?: boolean;
	properties: NodeProperty[];
	credentials?: CredentialEntry[];
}

// ---------------------------------------------------------------------------
// Output types (matches ParamSchema / NodeTypeSchema in node-params-schema.ts)
// ---------------------------------------------------------------------------

type ParamType = "string" | "number" | "boolean" | "object" | "array" | "any";

interface GeneratedParamSchema {
	required?: boolean;
	type?: ParamType;
	allowedValues?: string[];
	nestedRequired?: string[];
}

interface GeneratedNodeTypeSchema {
	nodeType: string;
	versions: number[];
	requiresCredentials?: boolean;
	params: Record<string, GeneratedParamSchema>;
	conditionParam?: string;
	conditionValue?: string;
}

interface GeneratedOutput {
	paramSchemas: Record<string, GeneratedNodeTypeSchema[]>;
}

// ---------------------------------------------------------------------------
// Mapping from n8n property types to our ParamType
// ---------------------------------------------------------------------------

function mapType(n8nType: string): ParamType {
	switch (n8nType) {
		case "string":
		case "dateTime":
		case "color":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "options":
		case "multiOptions":
		case "credentialsSelect":
			return "string";
		case "resourceLocator":
		case "resourceMapper":
		case "workflowSelector":
		case "filter":
		case "fixedCollection":
		case "collection":
		case "assignmentCollection":
		case "json":
			return "object";
		default:
			return "any";
	}
}

// n8n property types that are UI-only / non-data
const UI_ONLY_TYPES = new Set([
	"notice",
	"callout",
	"button",
	"curlImport",
	"hidden",
	"credentials",
]);

// ---------------------------------------------------------------------------
// Package prefix detection
// ---------------------------------------------------------------------------

function getPackagePrefix(pkgPath: string): string {
	if (pkgPath.includes("n8n-nodes-langchain")) return "@n8n/n8n-nodes-langchain";
	return "n8n-nodes-base";
}

// ---------------------------------------------------------------------------
// Main generation logic
// ---------------------------------------------------------------------------

function normalizeVersions(version: number | number[]): number[] {
	if (Array.isArray(version)) return version;
	return [version];
}

function processProperty(
	prop: NodeProperty,
): { name: string; schema: GeneratedParamSchema; condition?: { param: string; value: string } } | null {
	if (UI_ONLY_TYPES.has(prop.type)) return null;

	const schema: GeneratedParamSchema = {};
	const mappedType = mapType(prop.type);
	if (mappedType !== "any") {
		schema.type = mappedType;
	}

	if (prop.required === true) {
		schema.required = true;
	}

	// Extract allowed values for options type
	if (prop.type === "options" && prop.options) {
		const values = prop.options
			.map((o) => o.value)
			.filter((v): v is string => typeof v === "string");
		if (values.length > 0) {
			schema.allowedValues = values;
		}
	}

	// resourceLocator → nestedRequired: ["value"]
	if (prop.type === "resourceLocator") {
		schema.nestedRequired = ["value"];
	}

	// Extract simple condition from displayOptions.show (single key, single value)
	let condition: { param: string; value: string } | undefined;
	if (prop.displayOptions?.show) {
		const showKeys = Object.keys(prop.displayOptions.show).filter(
			(k) => !k.startsWith("@"),
		);
		if (showKeys.length === 1) {
			const key = showKeys[0]!;
			const values = prop.displayOptions.show[key]!;
			if (values.length === 1 && typeof values[0] === "string") {
				condition = { param: key, value: values[0] };
			}
		}
	}

	return { name: prop.name, schema, condition };
}

function processNode(
	desc: NodeTypeDescription,
	prefix: string,
): GeneratedNodeTypeSchema[] {
	const nodeType = `${prefix}.${desc.name}`;
	const versions = normalizeVersions(desc.version);
	const hasCredentials =
		desc.credentials !== undefined && desc.credentials.length > 0;

	// Group properties: unconditional vs conditional
	// For properties with conditions, group by condition
	const unconditionalParams: Record<string, GeneratedParamSchema> = {};
	const conditionalGroups = new Map<
		string,
		{ conditionParam: string; conditionValue: string; params: Record<string, GeneratedParamSchema> }
	>();

	for (const prop of desc.properties) {
		const result = processProperty(prop);
		if (!result) continue;

		if (result.condition) {
			const key = `${result.condition.param}=${result.condition.value}`;
			let group = conditionalGroups.get(key);
			if (!group) {
				group = {
					conditionParam: result.condition.param,
					conditionValue: result.condition.value,
					params: {},
				};
				conditionalGroups.set(key, group);
			}
			// Only add if not already present (first definition wins)
			if (!(result.name in group.params)) {
				group.params[result.name] = result.schema;
			}
		} else {
			// Only add if not already present (first definition wins)
			if (!(result.name in unconditionalParams)) {
				unconditionalParams[result.name] = result.schema;
			}
		}
	}

	const schemas: GeneratedNodeTypeSchema[] = [];

	// Create unconditional schema entry
	const unconditionalSchema: GeneratedNodeTypeSchema = {
		nodeType,
		versions,
		params: unconditionalParams,
	};
	if (hasCredentials) {
		unconditionalSchema.requiresCredentials = true;
	}
	schemas.push(unconditionalSchema);

	// Create conditional schema entries
	for (const group of conditionalGroups.values()) {
		const conditionalSchema: GeneratedNodeTypeSchema = {
			nodeType,
			versions,
			conditionParam: group.conditionParam,
			conditionValue: group.conditionValue,
			params: group.params,
		};
		if (hasCredentials) {
			conditionalSchema.requiresCredentials = true;
		}
		schemas.push(conditionalSchema);
	}

	return schemas;
}

async function loadNodesJson(packagePath: string): Promise<NodeTypeDescription[]> {
	const fullPath = resolve(packagePath);
	if (!existsSync(fullPath)) {
		console.warn(`Warning: ${fullPath} not found, skipping`);
		return [];
	}
	return await Bun.file(fullPath).json() as NodeTypeDescription[];
}

// ---------------------------------------------------------------------------
// Full node description extraction (for node-schema command)
// ---------------------------------------------------------------------------

interface FullPropertyOutput {
	name: string;
	type: string;
	description?: string;
	required?: boolean;
	default?: unknown;
	options?: Array<{ name: string; value: string | number | boolean }>;
	displayOptions?: DisplayOptions;
}

interface FullNodeDescription {
	nodeType: string;
	displayName: string;
	description: string;
	versions: number[];
	group: string[];
	inputs: string[];
	outputs: string[];
	usableAsTool?: boolean;
	credentials?: Array<{ name: string; required?: boolean }>;
	properties: FullPropertyOutput[];
}

function extractFullProperty(prop: NodeProperty): FullPropertyOutput | null {
	if (UI_ONLY_TYPES.has(prop.type)) return null;

	const out: FullPropertyOutput = {
		name: prop.name,
		type: prop.type,
	};

	if (prop.description) out.description = prop.description;
	if (prop.required === true) out.required = true;
	if (prop.default !== undefined) out.default = prop.default;

	if (prop.options && prop.options.length > 0) {
		out.options = prop.options
			.filter((o): o is { name: string; value: string | number | boolean } => o.name != null)
			.map((o) => ({ name: o.name!, value: o.value }));
		if (out.options.length === 0) delete out.options;
	}

	if (prop.displayOptions) out.displayOptions = prop.displayOptions;

	return out;
}

function extractFullNode(desc: NodeTypeDescription, prefix: string): FullNodeDescription {
	const properties: FullPropertyOutput[] = [];
	for (const prop of desc.properties) {
		const extracted = extractFullProperty(prop);
		if (extracted) properties.push(extracted);
	}

	const result: FullNodeDescription = {
		nodeType: `${prefix}.${desc.name}`,
		displayName: desc.displayName ?? desc.name,
		description: desc.description ?? "",
		versions: normalizeVersions(desc.version),
		group: desc.group ?? [],
		inputs: desc.inputs ?? ["main"],
		outputs: desc.outputs ?? ["main"],
		properties,
	};

	if (desc.usableAsTool) result.usableAsTool = true;

	if (desc.credentials && desc.credentials.length > 0) {
		result.credentials = desc.credentials.map((c) => {
			const entry: { name: string; required?: boolean } = { name: c.name };
			if (c.required) entry.required = true;
			return entry;
		});
	}

	return result;
}

// ---------------------------------------------------------------------------

const packages = [
	{
		path: "node_modules/n8n-nodes-base/dist/types/nodes.json",
		prefix: "n8n-nodes-base",
	},
	{
		path: "node_modules/@n8n/n8n-nodes-langchain/dist/types/nodes.json",
		prefix: "@n8n/n8n-nodes-langchain",
	},
];

async function generate(): Promise<void> {
	const output: GeneratedOutput = { paramSchemas: {} };
	const fullDescriptions: FullNodeDescription[] = [];

	for (const pkg of packages) {
		const nodes = await loadNodesJson(pkg.path);
		const prefix = pkg.prefix;

		for (const node of nodes) {
			const schemas = processNode(node, prefix);
			const nodeType = `${prefix}.${node.name}`;
			// Merge with existing entries (multiple descriptions for same node type with different versions)
			const existing = output.paramSchemas[nodeType];
			if (existing) {
				existing.push(...schemas);
			} else {
				output.paramSchemas[nodeType] = schemas;
			}

			fullDescriptions.push(extractFullNode(node, prefix));
		}
	}

	const outputDir = resolve("src/generated");
	if (!existsSync(outputDir)) {
		mkdirSync(outputDir, { recursive: true });
	}

	// Condensed schemas (for linter)
	const outputPath = resolve(outputDir, "node-schemas.json");
	writeFileSync(outputPath, JSON.stringify(output, null, 2));

	const nodeCount = Object.keys(output.paramSchemas).length;
	console.log(`Generated ${outputPath} with ${nodeCount} node schemas`);

	// Full node descriptions (for node-schema command)
	const descriptionsPath = resolve(outputDir, "node-descriptions.json");
	writeFileSync(descriptionsPath, JSON.stringify(fullDescriptions));

	console.log(`Generated ${descriptionsPath} with ${fullDescriptions.length} node descriptions`);
}

await generate();
