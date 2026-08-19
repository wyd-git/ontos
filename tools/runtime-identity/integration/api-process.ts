import { RuntimeIdentityApplicationService } from "@ontos/identity-application";
import {
  nodeIdentityCryptography,
  PostgresRuntimeIdentityRepository,
} from "@ontos/identity-postgres";
import pg from "pg";

import { RuntimeOidcAuthenticator } from "../../../apps/api/src/runtime-oidc.ts";

interface ApiProcessRequest {
  readonly database: pg.PoolConfig;
  readonly oidc: {
    readonly issuer: string;
    readonly audience: string;
  };
  readonly projectId: string;
  readonly authorization: string;
  readonly dpop: string;
  readonly method: string;
  readonly url: string;
}

interface ApiProcessResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

process.once("message", (candidate: unknown) => {
  void handle(candidate)
    .then(send)
    .catch(() =>
      send({
        ok: false,
        error: {
          code: "AUTHENTICATION_FAILED",
          message: "Runtime identity could not be established.",
        },
      }),
    );
});

async function handle(candidate: unknown): Promise<ApiProcessResponse> {
  const input = candidate as ApiProcessRequest;
  const pool = new pg.Pool(input.database);
  try {
    const authenticator = await RuntimeOidcAuthenticator.discover({
      issuer: input.oidc.issuer,
      audience: input.oidc.audience,
      requiredScope: "ontos.runtime",
      algorithms: ["RS256"],
    });
    const credential = await authenticator.authenticateRequest({
      headers: { authorization: input.authorization, dpop: input.dpop },
      method: input.method,
      url: input.url,
    });
    const service = new RuntimeIdentityApplicationService({
      repository: new PostgresRuntimeIdentityRepository(pool),
      cryptography: nodeIdentityCryptography,
      humanClientIds: ["human-web"],
    });
    const context = await service.establish({ projectId: input.projectId, credential });
    return { ok: true, result: context };
  } catch {
    return {
      ok: false,
      error: {
        code: "AUTHENTICATION_FAILED",
        message: "Runtime identity could not be established.",
      },
    };
  } finally {
    await pool.end();
  }
}

function send(response: ApiProcessResponse): void {
  if (process.send !== undefined) process.send(response, () => process.disconnect());
}
