import { isReference, type ReferenceObject, type SchemaObject } from "./openapi.js";
import { quotePropertyName, toTypeName } from "./names.js";

export interface SchemaContext {
  schemaNames: Map<string, string>;
  refPrefix: string;
}

export function createSchemaNameMap(
  schemas: Record<string, SchemaObject | ReferenceObject> | undefined
): Map<string, string> {
  const names = new Map<string, string>();
  for (const name of Object.keys(schemas ?? {})) {
    names.set(name, toTypeName(name));
  }
  return names;
}

export function renderSchemaFile(
  schemaName: string,
  schema: SchemaObject | ReferenceObject,
  schemaNames: Map<string, string>
): string {
  const typeName = schemaNames.get(schemaName) ?? toTypeName(schemaName);
  const typeBody = renderType(schema, {
    schemaNames,
    refPrefix: "."
  });
  return `export type ${typeName} = ${typeBody};\n`;
}

export function renderType(
  schema: SchemaObject | ReferenceObject | undefined,
  context: SchemaContext
): string {
  if (!schema) {
    return "unknown";
  }

  if (isReference(schema) || schema.$ref) {
    return renderReference(schema.$ref, context);
  }

  const parts: string[] = [];

  if (schema.const !== undefined) {
    parts.push(literalType(schema.const));
  } else if (schema.enum) {
    parts.push(schema.enum.length > 0 ? schema.enum.map(literalType).join(" | ") : "never");
  } else if (schema.allOf?.length) {
    parts.push(schema.allOf.map((item) => wrapIntersection(renderType(item, context))).join(" & "));
  } else if (schema.oneOf?.length) {
    parts.push(schema.oneOf.map((item) => renderType(item, context)).join(" | "));
  } else if (schema.anyOf?.length) {
    parts.push(schema.anyOf.map((item) => renderType(item, context)).join(" | "));
  } else {
    parts.push(renderSimpleType(schema, context));
  }

  if (schema.nullable && !parts.includes("null")) {
    parts.push("null");
  }

  return unique(parts).join(" | ");
}

function renderSimpleType(schema: SchemaObject, context: SchemaContext): string {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

  if (types.includes("array")) {
    return `Array<${renderType(schema.items, context)}>`;
  }

  if (types.includes("object") || schema.properties || schema.additionalProperties) {
    return renderObjectType(schema, context);
  }

  if (types.includes("integer") || types.includes("number")) {
    return "number";
  }

  if (types.includes("boolean")) {
    return "boolean";
  }

  if (types.includes("string")) {
    return "string";
  }

  if (types.includes("null")) {
    return "null";
  }

  return "unknown";
}

function renderObjectType(schema: SchemaObject, context: SchemaContext): string {
  const properties = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const additionalProperties = schema.additionalProperties;
  const lines = properties.map(([name, propertySchema]) => {
    const optional = required.has(name) ? "" : "?";
    return `  ${quotePropertyName(name)}${optional}: ${renderType(propertySchema, context)};`;
  });

  if (lines.length === 0) {
    if (additionalProperties === true) {
      return "Record<string, unknown>";
    }
    if (additionalProperties) {
      return `Record<string, ${renderType(additionalProperties, context)}>`;
    }
    return "Record<string, unknown>";
  }

  if (additionalProperties && additionalProperties !== true) {
    const objectType = `{\n${lines.join("\n")}\n}`;
    return `${objectType} & Record<string, ${renderType(additionalProperties, context)}>`;
  }

  return `{\n${lines.join("\n")}\n}`;
}

function renderReference(ref: string | undefined, context: SchemaContext): string {
  if (!ref) {
    return "unknown";
  }

  const schemaName = ref.match(/^#\/components\/schemas\/(.+)$/)?.[1];
  if (!schemaName) {
    return "unknown";
  }

  const typeName = context.schemaNames.get(schemaName) ?? toTypeName(schemaName);
  return `import("${context.refPrefix}/${typeName}.js").${typeName}`;
}

function literalType(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  return "unknown";
}

function wrapIntersection(value: string): string {
  return value.includes(" | ") ? `(${value})` : value;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
