export function toTypeName(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const name = words.map(capitalize).join("");
  return ensureIdentifier(name || "GeneratedType");
}

export function toFileStem(path: string, operationId: string): string {
  const normalizedPath = path
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "")
    .replace(/\{([^}]+)\}/g, "$1")
    .replace(/\//g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const pathStem = normalizedPath || "root";
  return `${pathStem}-${operationId}`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function assertFunctionName(value: string): void {
  if (!/^[$A-Z_a-z][$\w]*$/.test(value)) {
    throw new Error(
      `operationId "${value}" is not a valid TypeScript function name.`
    );
  }
}

export function quotePropertyName(value: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(value) ? value : JSON.stringify(value);
}

export function sanitizeServiceName(value: string): string {
  const serviceName = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(serviceName)) {
    throw new Error(
      `serviceName "${value}" must contain only letters, numbers, dots, underscores, or hyphens.`
    );
  }
  return serviceName;
}

function ensureIdentifier(value: string): string {
  return /^[$A-Z_a-z]/.test(value) ? value : `_${value}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
