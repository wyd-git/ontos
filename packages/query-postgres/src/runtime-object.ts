import type {
  RuntimeObjectGetRepository,
  RuntimeObjectProjectionRow,
} from "@ontos/query-application";
import type pg from "pg";

import { PostgresQueryExecutor } from "./executor.ts";
import { renderRuntimeObjectGet } from "./renderer.ts";

export class PostgresRuntimeObjectGetRepository implements RuntimeObjectGetRepository {
  readonly #executor: PostgresQueryExecutor;

  constructor(pool: pg.Pool) {
    this.#executor = new PostgresQueryExecutor(pool);
  }

  executeObjectGet(input: Parameters<RuntimeObjectGetRepository["executeObjectGet"]>[0]) {
    const statement = renderRuntimeObjectGet(input.plan, {
      projectId: input.lease.projectId,
      queryLeaseId: input.lease.queryLeaseId,
      releaseId: input.lease.releaseId,
      activationId: input.lease.activationId,
      identityContextHash: input.lease.identityContextHash,
      policyContextHash: input.lease.policyContextHash,
      queryHash: input.lease.queryHash,
    });
    return this.#executor.executeStatement<RuntimeObjectProjectionRow>(statement, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
}
