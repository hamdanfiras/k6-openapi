# k6-openapi

Generate thin TypeScript k6 operation wrappers from Spring Boot 3 OpenAPI JSON.

## Usage

Generate multiple services from a JSON file:

```bash
npm install
npm run build
node dist/cli.js --input services.json --out ./generated
```

Generate one service directly:

```bash
npm run build
node dist/cli.js --service accounts --url https://accounts.example.com/v3/api-docs --out ./generated
```

When installed as a package, the same CLI is exposed as `k6-openapi`.

If your OpenAPI endpoint is behind a proxy that uses local certificates, disable
TLS certificate validation for the OpenAPI fetch:

```bash
node dist/cli.js --input services.json --out ./generated --insecure
```

`--ignore-certs` is also accepted as an alias.

The input file is an array of unique service names and OpenAPI JSON URLs:

```json
[
  { "serviceName": "accounts", "url": "https://accounts.example.com/v3/api-docs" },
  { "serviceName": "cards", "url": "https://cards.example.com/v3/api-docs" }
]
```

## Generated layout

```text
generated/
  services/
    _runtime.ts
    accounts/
      index.ts
      get-users-listUsers.ts
      schemas/
        Account.ts
        index.ts
    cards/
      index.ts
      post-cards-createCard.ts
      schemas/
        Card.ts
        index.ts
```

Each operation file is named from its relative OpenAPI path with slashes replaced by hyphens, followed by the `operationId`.

Generated functions return the k6 `Response` directly. They do not perform checks.

```ts
const response = listUsers(
  {
    baseUrl: "https://accounts.example.com",
    query: { page: 1 }
  },
  "login-flow"
);
```

Each request is tagged with:

- `name`: `serviceName/operationId`
- `method`: OpenAPI HTTP verb
- `path`: OpenAPI relative path
- `flow`: the `flow` argument passed to the operation
