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
  _runtime.ts
  index.ts
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

Generated functions return the raw k6 `Response` together with a typed `body`.
They do not perform checks.

```ts
const result = listUsers(
  {
    baseUrl: "https://accounts.example.com",
    query: { page: 1 }
  },
  "login-flow",
  "jwt-token"
);

console.log(result.response.status);
console.log(result.body);
```

When an operation has a JSON response schema, `body` is parsed with
`response.json()` and cast to the generated schema type. When an operation has
only a non-JSON response schema, such as `text/html` or `image/png`, `body` is
the raw `response.body` cast to the generated schema type. Operations without a
response schema return `body: undefined`.

Generated functions also accept an optional bearer token as the third argument.
When passed, it is sent as `Authorization: Bearer <token>` and merged with any
headers on the request.

Each request is tagged with:

- `name`: `serviceName/operationId`
- `method`: OpenAPI HTTP verb
- `path`: OpenAPI relative path
- `flow`: the `flow` argument passed to the operation
