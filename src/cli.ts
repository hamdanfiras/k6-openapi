#!/usr/bin/env node
import { generate, readServicesConfig } from "./generator.js";
import { sanitizeServiceName } from "./names.js";
import type { ServiceConfig } from "./openapi.js";

interface CliArgs {
  input?: string;
  outDir: string;
  serviceName?: string;
  url?: string;
  help: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const services = await resolveServices(args);
  await generate({
    services,
    outDir: args.outDir
  });
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    outDir: "generated",
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--input":
      case "-i":
        args.input = readValue(argv, index, arg);
        index += 1;
        break;
      case "--out":
      case "-o":
        args.outDir = readValue(argv, index, arg);
        index += 1;
        break;
      case "--service":
      case "-s":
        args.serviceName = readValue(argv, index, arg);
        index += 1;
        break;
      case "--url":
      case "-u":
        args.url = readValue(argv, index, arg);
        index += 1;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument ${arg}. Run k6-openapi --help.`);
    }
  }

  return args;
}

async function resolveServices(args: CliArgs): Promise<ServiceConfig[]> {
  const hasInput = Boolean(args.input);
  const hasSingleService = Boolean(args.serviceName || args.url);

  if (hasInput && hasSingleService) {
    throw new Error("Use either --input or --service/--url, not both.");
  }

  if (hasInput) {
    return readServicesConfig(args.input as string);
  }

  if (args.serviceName && args.url) {
    return [
      {
        serviceName: sanitizeServiceName(args.serviceName),
        url: args.url
      }
    ];
  }

  throw new Error("Provide --input, or provide both --service and --url.");
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp(): void {
  console.log(`k6-openapi

Generate k6 TypeScript operation wrappers from Spring Boot OpenAPI JSON.

Usage:
  k6-openapi --input services.json --out ./generated
  k6-openapi --service accounts --url https://accounts.example.com/v3/api-docs --out ./generated

Options:
  -i, --input     JSON file with [{ "serviceName": "...", "url": "..." }]
  -s, --service   Generate one service by name
  -u, --url       OpenAPI JSON URL for one service
  -o, --out       Target folder. Defaults to ./generated
  -h, --help      Show this help
`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
