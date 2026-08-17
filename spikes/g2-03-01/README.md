# G2-03-01 Query / Policy / Consumer Spike

This directory is a compile-and-evidence Spike, not a production application or published SDK.

It contains one minimal OpenAPI 3.1 Runtime Read candidate, its reproducibly generated Fetch client, and a generic React consumer that derives list/detail fields from runtime Metadata. The consumer imports no `@ontos/*` workspace package and contains no domain-specific object fields.

The authoritative decision, threat model, red-team result and machine Gate live outside this directory. Regeneration and the three breaking contract mutations are executed by `tools/query-policy-architecture/web-spike.ts`.
