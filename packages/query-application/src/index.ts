import type { PolicyGatewayContext } from "@ontos/policy-application";
import {
  compileLinkCandidate,
  compileObjectCount,
  compileObjectGet,
  compileObjectSearch,
  type LinkCandidateLogicalPlan,
  type ObjectCountLogicalPlan,
  type ObjectGetCompileRequest,
  type ObjectGetLogicalPlan,
  type ObjectSearchLogicalPlan,
  type QueryCompilerContext,
  type QueryLogicalPlan,
  type QueryPolicyContext,
} from "@ontos/query-domain";

export interface QueryExecutionResult<Row extends Readonly<Record<string, unknown>>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
  readonly byteCount: number;
}

export interface QueryExecutorPort {
  execute<Row extends Readonly<Record<string, unknown>>>(
    plan: QueryLogicalPlan,
    options?: { readonly signal?: AbortSignal },
  ): Promise<QueryExecutionResult<Row>>;
}

export class QueryApplicationError extends Error {
  readonly code: "QUERY_EXECUTION_FAILED";

  constructor(options?: ErrorOptions) {
    super("Query execution failed closed.", options);
    this.name = "QueryApplicationError";
    this.code = "QUERY_EXECUTION_FAILED";
  }
}

export class QueryPlanApplicationService {
  readonly #context: QueryCompilerContext;

  constructor(context: QueryCompilerContext) {
    this.#context = context;
  }

  objectGet(input: {
    readonly objectTypeApiName: string;
    readonly request: ObjectGetCompileRequest;
    readonly policy: PolicyGatewayContext;
  }): ObjectGetLogicalPlan {
    return compileObjectGet({
      context: this.#context,
      objectTypeApiName: input.objectTypeApiName,
      request: input.request,
      policy: policyContext(input.policy),
    });
  }

  objectSearch(input: {
    readonly objectTypeApiName: string;
    readonly request: unknown;
    readonly policy: PolicyGatewayContext;
  }): ObjectSearchLogicalPlan {
    return compileObjectSearch({
      context: this.#context,
      objectTypeApiName: input.objectTypeApiName,
      request: input.request,
      policy: policyContext(input.policy),
    });
  }

  objectCount(input: {
    readonly objectTypeApiName: string;
    readonly request: unknown;
    readonly policy: PolicyGatewayContext;
  }): ObjectCountLogicalPlan {
    return compileObjectCount({
      context: this.#context,
      objectTypeApiName: input.objectTypeApiName,
      request: input.request,
      policy: policyContext(input.policy),
    });
  }

  linkCandidate(input: {
    readonly sourceObjectTypeApiName: string;
    readonly linkTypeApiName: string;
    readonly sourcePrimaryKey: unknown;
    readonly request: unknown;
    readonly sourcePolicy: PolicyGatewayContext;
    readonly linkPolicy: PolicyGatewayContext;
    readonly targetPolicy: PolicyGatewayContext;
  }): LinkCandidateLogicalPlan {
    return compileLinkCandidate({
      context: this.#context,
      sourceObjectTypeApiName: input.sourceObjectTypeApiName,
      linkTypeApiName: input.linkTypeApiName,
      sourcePrimaryKey: input.sourcePrimaryKey,
      request: input.request,
      sourcePolicy: policyContext(input.sourcePolicy),
      linkPolicy: policyContext(input.linkPolicy),
      targetPolicy: policyContext(input.targetPolicy),
    });
  }
}

function policyContext(context: PolicyGatewayContext): QueryPolicyContext {
  return context;
}
