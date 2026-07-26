import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  httpMethods,
  isReference,
  type HttpMethod,
  type OpenApiDocument,
  type OperationObject,
  type ParameterObject,
  type ReferenceObject,
  type RequestBodyObject,
  type SchemaObject,
  type ServiceConfig
} from "./openapi.js";
import {
  assertFunctionName,
  quotePropertyName,
  sanitizeServiceName,
  toFileStem,
  toTypeName
} from "./names.js";
import {
  createSchemaNameMap,
  renderSchemaFile,
  renderType
} from "./schema-writer.js";

export interface GenerateOptions {
  services: ServiceConfig[];
  outDir: string;
  insecure?: boolean;
}

interface OperationToRender {
  method: HttpMethod;
  openApiPath: string;
  operation: OperationObject;
  fileStem: string;
}

interface RequestShape {
  interfaceName: string;
  pathParams: ParameterObject[];
  queryParams: ParameterObject[];
  body?: {
    required: boolean;
    type: string;
  };
}

export async function readServicesConfig(fileName: string): Promise<ServiceConfig[]> {
  const raw = await readFile(fileName, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("The input JSON file must be an array of service configs.");
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Service config at index ${index} must be an object.`);
    }

    const serviceName = (entry as { serviceName?: unknown }).serviceName;
    const url = (entry as { url?: unknown }).url;
    if (typeof serviceName !== "string" || typeof url !== "string") {
      throw new Error(
        `Service config at index ${index} must have string serviceName and url fields.`
      );
    }

    return {
      serviceName: sanitizeServiceName(serviceName),
      url
    };
  });
}

export async function generate(options: GenerateOptions): Promise<void> {
  assertUniqueServiceNames(options.services);

  const servicesDir = path.join(options.outDir, "services");
  await mkdir(servicesDir, { recursive: true });
  await writeFile(path.join(servicesDir, "_runtime.ts"), renderRuntime(), "utf8");

  for (const service of options.services) {
    await generateService(service, servicesDir, {
      insecure: Boolean(options.insecure)
    });
  }

  await writeServicesIndex(servicesDir);
}

async function generateService(
  service: ServiceConfig,
  servicesDir: string,
  options: Pick<GenerateOptions, "insecure">
): Promise<void> {
  const serviceName = sanitizeServiceName(service.serviceName);
  const document = await fetchOpenApiJson(service.url, {
    insecure: Boolean(options.insecure)
  });
  const serviceDir = path.join(servicesDir, serviceName);
  const schemasDir = path.join(serviceDir, "schemas");
  const schemas = document.components?.schemas ?? {};
  const schemaNames = createSchemaNameMap(schemas);

  await rm(serviceDir, { recursive: true, force: true });
  await mkdir(schemasDir, { recursive: true });

  const schemaExports: string[] = [];
  for (const [schemaName, schema] of Object.entries(schemas)) {
    const typeName = schemaNames.get(schemaName) ?? toTypeName(schemaName);
    await writeFile(
      path.join(schemasDir, `${typeName}.ts`),
      renderSchemaFile(schemaName, schema, schemaNames),
      "utf8"
    );
    schemaExports.push(`export type { ${typeName} } from "./${typeName}.js";`);
  }
  await writeFile(path.join(schemasDir, "index.ts"), `${schemaExports.join("\n")}\n`, "utf8");

  const operationExports: string[] = [];
  for (const operationToRender of collectOperations(document)) {
    const operationId = operationToRender.operation.operationId;
    if (!operationId) {
      throw new Error(
        `${serviceName} ${operationToRender.method.toUpperCase()} ${operationToRender.openApiPath} is missing operationId.`
      );
    }

    assertFunctionName(operationId);
    const content = renderOperationFile({
      serviceName,
      operationToRender,
      document,
      schemaNames
    });
    await writeFile(
      path.join(serviceDir, `${operationToRender.fileStem}.ts`),
      content,
      "utf8"
    );
    operationExports.push(
      `export { ${operationId} } from "./${operationToRender.fileStem}.js";`
    );
    operationExports.push(
      `export type { ${toTypeName(operationId)}Request } from "./${operationToRender.fileStem}.js";`
    );
  }

  const indexContent = [
    `export * as schemas from "./schemas/index.js";`,
    ...operationExports
  ].join("\n");
  await writeFile(path.join(serviceDir, "index.ts"), `${indexContent}\n`, "utf8");
}

function collectOperations(document: OpenApiDocument): OperationToRender[] {
  const operations: OperationToRender[] = [];

  for (const [openApiPath, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of httpMethods) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }

      const operationId = operation.operationId;
      operations.push({
        method,
        openApiPath,
        operation,
        fileStem: toFileStem(openApiPath, operationId ?? method)
      });
    }
  }

  return operations;
}

function renderOperationFile(args: {
  serviceName: string;
  operationToRender: OperationToRender;
  document: OpenApiDocument;
  schemaNames: Map<string, string>;
}): string {
  const { serviceName, operationToRender, document, schemaNames } = args;
  const { method, openApiPath, operation } = operationToRender;
  const operationId = operation.operationId;
  if (!operationId) {
    throw new Error("Cannot render an operation without operationId.");
  }

  const requestShape = createRequestShape({
    operationId,
    openApiPath,
    operation,
    document,
    schemaNames
  });

  const requestInterface = renderRequestInterface(requestShape);
  const pathArg = requestShape.pathParams.length > 0 ? "request.path" : "undefined";
  const queryArg = requestShape.queryParams.length > 0 ? "request.query" : "undefined";
  const bodyInitializer = requestShape.body
    ? "  const body = request.body === undefined ? undefined : JSON.stringify(request.body);\n"
    : "  const body = undefined;\n";
  const headerInitializer = requestShape.body
    ? "    headers: withJsonHeaders(request.headers, body !== undefined),"
    : "    headers: request.headers,";
  const runtimeImports = requestShape.body
    ? "buildUrl, withJsonHeaders"
    : "buildUrl";

  return `import http, { type Response } from "k6/http";
import { ${runtimeImports} } from "../_runtime.js";

${requestInterface}

export function ${operationId}(request: ${requestShape.interfaceName}, flow: string): Response {
  const url = buildUrl(request.baseUrl, ${JSON.stringify(openApiPath)}, ${pathArg}, ${queryArg});
${bodyInitializer}  const params = {
${headerInitializer}
    tags: {
      name: ${JSON.stringify(`${serviceName}/${operationId}`)},
      method: ${JSON.stringify(method.toUpperCase())},
      path: ${JSON.stringify(openApiPath)},
      flow
    }
  };

  return http.request(${JSON.stringify(method.toUpperCase())}, url, body, params);
}
`;
}

function createRequestShape(args: {
  operationId: string;
  openApiPath: string;
  operation: OperationObject;
  document: OpenApiDocument;
  schemaNames: Map<string, string>;
}): RequestShape {
  const { operationId, openApiPath, operation, document, schemaNames } = args;
  const pathItem = document.paths?.[openApiPath];
  const parameters = [
    ...(pathItem?.parameters ?? []),
    ...(operation.parameters ?? [])
  ].map((parameter) => resolveParameter(parameter, document));

  const body = resolveRequestBody(operation.requestBody, document);
  const bodySchema = selectJsonSchema(body);

  return {
    interfaceName: `${toTypeName(operationId)}Request`,
    pathParams: parameters.filter((parameter) => parameter.in === "path"),
    queryParams: parameters.filter((parameter) => parameter.in === "query"),
    body: bodySchema
      ? {
          required: Boolean(body?.required),
          type: renderType(bodySchema, {
            schemaNames,
            refPrefix: "./schemas"
          })
        }
      : undefined
  };
}

function renderRequestInterface(shape: RequestShape): string {
  const lines = [`export interface ${shape.interfaceName} {`, "  baseUrl: string;"];

  if (shape.pathParams.length > 0) {
    lines.push("  path: {");
    for (const parameter of shape.pathParams) {
      lines.push(`    ${quotePropertyName(parameter.name)}: ${renderParameterType(parameter)};`);
    }
    lines.push("  };");
  }

  if (shape.queryParams.length > 0) {
    lines.push("  query?: {");
    for (const parameter of shape.queryParams) {
      const optional = parameter.required ? "" : "?";
      lines.push(`    ${quotePropertyName(parameter.name)}${optional}: ${renderParameterType(parameter)};`);
    }
    lines.push("  };");
  }

  lines.push("  headers?: Record<string, string>;");

  if (shape.body) {
    const optional = shape.body.required ? "" : "?";
    lines.push(`  body${optional}: ${shape.body.type};`);
  }

  lines.push("}");
  return lines.join("\n");
}

function renderParameterType(parameter: ParameterObject): string {
  if (parameter.schema) {
    return renderType(parameter.schema, {
      schemaNames: new Map(),
      refPrefix: "./schemas"
    });
  }

  const contentSchema = selectJsonSchema({
    content: parameter.content
  });

  return contentSchema
    ? renderType(contentSchema, {
        schemaNames: new Map(),
        refPrefix: "./schemas"
      })
    : "string";
}

function resolveParameter(
  parameter: ParameterObject | ReferenceObject,
  document: OpenApiDocument
): ParameterObject {
  if (!isReference(parameter)) {
    return parameter;
  }

  const parameterName = parameter.$ref.match(/^#\/components\/parameters\/(.+)$/)?.[1];
  const resolved = parameterName ? document.components?.parameters?.[parameterName] : undefined;
  if (!resolved || isReference(resolved)) {
    throw new Error(`Could not resolve parameter reference ${parameter.$ref}.`);
  }

  return resolved;
}

function resolveRequestBody(
  requestBody: RequestBodyObject | ReferenceObject | undefined,
  document: OpenApiDocument
): RequestBodyObject | undefined {
  if (!requestBody) {
    return undefined;
  }

  if (!isReference(requestBody)) {
    return requestBody;
  }

  const requestBodyName = requestBody.$ref.match(/^#\/components\/requestBodies\/(.+)$/)?.[1];
  const resolved = requestBodyName ? document.components?.requestBodies?.[requestBodyName] : undefined;
  if (!resolved || isReference(resolved)) {
    throw new Error(`Could not resolve requestBody reference ${requestBody.$ref}.`);
  }

  return resolved;
}

function selectJsonSchema(
  requestBody: Pick<RequestBodyObject, "content"> | undefined
): SchemaObject | ReferenceObject | undefined {
  const content = requestBody?.content;
  if (!content) {
    return undefined;
  }

  return (
    content["application/json"]?.schema ??
    Object.entries(content).find(([contentType]) => contentType.endsWith("+json"))?.[1].schema ??
    undefined
  );
}

async function fetchOpenApiJson(
  url: string,
  options: { insecure: boolean }
): Promise<OpenApiDocument> {
  let response: Response;
  try {
    response = await withOptionalInsecureTls(options.insecure, () =>
      fetch(url, {
        headers: {
          Accept: "application/json"
        }
      })
    );
  } catch (error) {
    throw new Error(
      `Failed to fetch OpenAPI JSON from ${url}.\n${formatErrorDetails(error)}`
    );
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  let document: OpenApiDocument;
  try {
    document = (await response.json()) as OpenApiDocument;
  } catch (error) {
    throw new Error(
      `Failed to parse OpenAPI JSON from ${url}.\n${formatErrorDetails(error)}`
    );
  }

  if (!document.paths) {
    throw new Error(`${url} did not return an OpenAPI JSON document with paths.`);
  }

  return document;
}

async function withOptionalInsecureTls<T>(
  insecure: boolean,
  action: () => Promise<T>
): Promise<T> {
  if (!insecure) {
    return action();
  }

  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    return await action();
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  }
}

function formatErrorDetails(error: unknown): string {
  const lines: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current && depth < 8) {
    const label = depth === 0 ? "error" : `cause ${depth}`;
    lines.push(`${label}: ${describeError(current)}`);
    current = getErrorCause(current);
    depth += 1;
  }

  return lines.join("\n");
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const details = collectErrorFields(error);
    return details.length > 0
      ? `${error.name}: ${error.message} (${details.join(", ")})`
      : `${error.name}: ${error.message}`;
  }

  return String(error);
}

function collectErrorFields(error: Error): string[] {
  const record = error as Error & Record<string, unknown>;
  const fields = ["code", "errno", "syscall", "address", "port"];
  return fields.flatMap((field) => {
    const value = record[field];
    return value === undefined ? [] : [`${field}=${String(value)}`];
  });
}

function getErrorCause(error: unknown): unknown {
  return error && typeof error === "object" && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
}

async function writeServicesIndex(servicesDir: string): Promise<void> {
  const entries = await readdir(servicesDir, { withFileTypes: true });
  const exports = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((serviceName) => `export * as ${toExportNamespace(serviceName)} from "./${serviceName}/index.js";`);

  await writeFile(path.join(servicesDir, "index.ts"), `${exports.join("\n")}\n`, "utf8");
}

function assertUniqueServiceNames(services: ServiceConfig[]): void {
  const seen = new Set<string>();
  for (const service of services) {
    const serviceName = sanitizeServiceName(service.serviceName);
    if (seen.has(serviceName)) {
      throw new Error(`Duplicate serviceName "${serviceName}" in input.`);
    }
    seen.add(serviceName);
  }
}

function toExportNamespace(serviceName: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(serviceName)
    ? serviceName
    : toTypeName(serviceName.charAt(0).toLowerCase() + serviceName.slice(1));
}

function renderRuntime(): string {
  return `export type PathValues = Record<string, string | number | boolean>;
export type QueryValue = string | number | boolean | null | undefined;
export type QueryValues = Record<string, QueryValue | QueryValue[]>;

export function buildUrl(
  baseUrl: string,
  pathTemplate: string,
  pathValues?: PathValues,
  queryValues?: QueryValues
): string {
  const path = pathTemplate.replace(/\\{([^}]+)\\}/g, (_match, key: string) => {
    const value = pathValues?.[key];
    return value === undefined || value === null ? "" : encodeURIComponent(String(value));
  });
  const query = buildQuery(queryValues);
  return \`\${baseUrl.replace(/\\/+$/, "")}\${path}\${query}\`;
}

export function withJsonHeaders(
  headers: Record<string, string> | undefined,
  hasBody: boolean
): Record<string, string> | undefined {
  if (!hasBody) {
    return headers;
  }

  return {
    "Content-Type": "application/json",
    ...(headers ?? {})
  };
}

function buildQuery(queryValues?: QueryValues): string {
  if (!queryValues) {
    return "";
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(queryValues)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        appendQuery(params, key, item);
      }
      continue;
    }

    appendQuery(params, key, value);
  }

  const query = params.toString();
  return query ? \`?\${query}\` : "";
}

function appendQuery(params: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined || value === null) {
    return;
  }

  params.append(key, String(value));
}
`;
}
