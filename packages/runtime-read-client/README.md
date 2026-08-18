# `@ontos/runtime-read-client`

This private workspace package is generated from the G2-03 Runtime Read OpenAPI Candidate.

- `npm run generate:runtime-read` regenerates it from the formal Runtime Read JSON Schema.
- `npm run check:runtime-read-generation` proves source and distribution regeneration are deterministic, compiles the generated transport, and type-checks a strict Web-shaped consumer through the package root.
- It is an in-repository integration contract, not a published SDK or a binary support commitment.
- Generated transport source is compiled once with `exactOptionalPropertyTypes=false` because `@hey-api/openapi-ts@0.99.0` emits internal optional assignments that do not compile under that flag. Consumers cannot import that source through the package root: they receive deterministic JavaScript plus declarations from `dist/package`, while a Web-shaped witness compiles with `exactOptionalPropertyTypes=true` and performs an actual generated Search call.
