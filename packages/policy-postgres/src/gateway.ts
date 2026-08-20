import {
  MANAGEMENT_ROLE_VALUES,
  parseArtifactDigest,
  parseCanonicalInstant,
  parseOntosId,
  type IdentityType,
  type ManagementRoleValue,
} from "@ontos/contracts";
import {
  MAX_POLICY_GATEWAY_EPOCH,
  type PolicyEpochNotification,
  type PolicyEpochNotificationHandler,
  type PolicyEpochNotificationSource,
  type PolicyGatewaySnapshot,
  type PolicyGatewaySnapshotPrincipal,
  type PolicyGatewaySnapshotRepository,
} from "@ontos/policy-application";
import type pg from "pg";

interface GatewaySnapshotRow extends pg.QueryResultRow {
  readonly observed_database_at: string;
  readonly authorization_epoch: string;
  readonly resource_revision_id: string;
  readonly policy_resource_id: string;
  readonly policy_compilation_id: string;
  readonly artifact_digest: string;
  readonly principal_ordinality: number;
  readonly principal_id: string;
  readonly identity_type: string | null;
  readonly principal_state: string | null;
  readonly project_role: string | null;
  readonly resource_role: string | null;
  readonly resource_binding_present: boolean;
  readonly service_profile_state: string | null;
  readonly service_capabilities: unknown;
}

export class PostgresPolicyGatewayRepository implements PolicyGatewaySnapshotRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async readPolicyGatewaySnapshot(input: {
    readonly projectId: string;
    readonly authorizationPrincipalIds: readonly string[];
    readonly resourceId: string;
    readonly permission: string;
    readonly releaseId: string;
    readonly policyRevisionId: string;
    readonly compilerVersion: string;
  }): Promise<PolicyGatewaySnapshot> {
    let client: pg.PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      throw new PolicyGatewayPostgresError({ cause: error });
    }
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await client.query<GatewaySnapshotRow>(
        `SELECT snapshot.observed_database_at,
                snapshot.authorization_epoch::text,
                snapshot.resource_revision_id::text,
                snapshot.policy_resource_id::text,
                snapshot.policy_compilation_id::text,
                snapshot.artifact_digest,
                snapshot.principal_ordinality,
                snapshot.principal_id::text,
                snapshot.identity_type,
                snapshot.principal_state,
                snapshot.project_role,
                snapshot.resource_role,
                snapshot.resource_binding_present,
                snapshot.service_profile_state,
                snapshot.service_capabilities
         FROM authz.resolve_policy_gateway_snapshot(
           $1::uuid, $2::uuid[], $3::uuid, $4::text,
           $5::uuid, $6::uuid, $7::text
         ) AS snapshot
         ORDER BY snapshot.principal_ordinality`,
        [
          input.projectId,
          input.authorizationPrincipalIds,
          input.resourceId,
          input.permission,
          input.releaseId,
          input.policyRevisionId,
          input.compilerVersion,
        ],
      );
      const snapshot = parseSnapshotRows(result.rows, input);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error("Policy rollback failed.");
      }
      if (error instanceof PolicyGatewayPostgresError) throw error;
      throw new PolicyGatewayPostgresError({ cause: error });
    } finally {
      client.release(releaseError);
    }
  }
}

export class PolicyGatewayPostgresError extends Error {
  constructor(options?: ErrorOptions) {
    super("Policy Gateway persistence is unavailable.", options);
    this.name = "PolicyGatewayPostgresError";
  }
}

export interface PostgresPolicyEpochListenerOptions {
  readonly pool: pg.Pool;
  readonly reconnectDelayMs?: number;
}

export class PostgresPolicyEpochListener implements PolicyEpochNotificationSource {
  readonly #pool: pg.Pool;
  readonly #reconnectDelayMs: number;
  readonly #handlers = new Set<PolicyEpochNotificationHandler>();
  #client: pg.PoolClient | null = null;
  #connecting: Promise<void> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #closed = false;

  constructor(options: PostgresPolicyEpochListenerOptions) {
    const reconnectDelayMs = options.reconnectDelayMs ?? 250;
    if (
      !Number.isSafeInteger(reconnectDelayMs) ||
      reconnectDelayMs < 10 ||
      reconnectDelayMs > 60_000
    ) {
      throw new Error("Policy Epoch listener configuration is invalid.");
    }
    this.#pool = options.pool;
    this.#reconnectDelayMs = reconnectDelayMs;
  }

  subscribe(handler: PolicyEpochNotificationHandler): () => void {
    if (this.#closed) throw new Error("Policy Epoch listener is closed.");
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Policy Epoch listener is closed.");
    this.#started = true;
    await this.#ensureConnected();
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const client = this.#client;
    this.#client = null;
    if (client === null) return;
    this.#detachClient(client);
    try {
      await client.query("UNLISTEN ontos_authorization_epoch_v1");
      client.release();
    } catch {
      client.release(true);
    }
  }

  async close(): Promise<void> {
    await this.stop();
    this.#closed = true;
    this.#handlers.clear();
  }

  get connected(): boolean {
    return this.#client !== null;
  }

  async #ensureConnected(): Promise<void> {
    if (!this.#started || this.#closed || this.#client !== null) return;
    if (this.#connecting !== null) return this.#connecting;
    const connecting = this.#connect();
    this.#connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.#connecting === connecting) this.#connecting = null;
    }
  }

  async #connect(): Promise<void> {
    let client: pg.PoolClient | null = null;
    try {
      client = await this.#pool.connect();
      if (!this.#started || this.#closed) {
        client.release();
        return;
      }
      client.on("notification", this.#onNotification);
      client.on("error", this.#onClientError);
      await client.query("LISTEN ontos_authorization_epoch_v1");
      this.#client = client;
    } catch (error) {
      if (client !== null) {
        this.#detachClient(client);
        client.release(true);
      }
      this.#scheduleReconnect();
      throw new PolicyGatewayPostgresError({ cause: error });
    }
  }

  readonly #onNotification = (notification: pg.Notification): void => {
    if (notification.channel !== "ontos_authorization_epoch_v1") return;
    const parsed = parsePolicyEpochNotificationPayload(notification.payload);
    if (parsed === null) return;
    for (const handler of this.#handlers) {
      try {
        handler(parsed);
      } catch {
        // A broken consumer cannot terminate the shared best-effort listener.
      }
    }
  };

  readonly #onClientError = (): void => {
    const client = this.#client;
    if (client === null) return;
    this.#client = null;
    this.#detachClient(client);
    client.release(true);
    this.#scheduleReconnect();
  };

  #detachClient(client: pg.PoolClient): void {
    client.off("notification", this.#onNotification);
    client.off("error", this.#onClientError);
  }

  #scheduleReconnect(): void {
    if (!this.#started || this.#closed || this.#reconnectTimer !== null) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#ensureConnected().catch(() => undefined);
    }, this.#reconnectDelayMs);
    this.#reconnectTimer.unref();
  }
}

export function parsePolicyEpochNotificationPayload(
  payload: string | undefined,
): PolicyEpochNotification | null {
  if (payload === undefined || payload.length === 0 || payload.length > 512) return null;
  try {
    const candidate: unknown = JSON.parse(payload);
    if (!isRecord(candidate) || candidate["protocolVersion"] !== 1) return null;
    const projectId = parseOntosId(candidate["projectId"]);
    const epochInput = candidate["epoch"];
    let epoch: bigint;
    if (typeof epochInput === "number") {
      if (!Number.isSafeInteger(epochInput)) return null;
      epoch = BigInt(epochInput);
    } else if (typeof epochInput === "string" && /^[1-9][0-9]{0,18}$/u.test(epochInput)) {
      epoch = BigInt(epochInput);
    } else {
      return null;
    }
    if (epoch < 1n || epoch > MAX_POLICY_GATEWAY_EPOCH) return null;
    return Object.freeze({ protocolVersion: 1, projectId, epoch });
  } catch {
    return null;
  }
}

function parseSnapshotRows(
  rows: readonly GatewaySnapshotRow[],
  input: {
    readonly projectId: string;
    readonly authorizationPrincipalIds: readonly string[];
    readonly resourceId: string;
    readonly releaseId: string;
    readonly policyRevisionId: string;
    readonly compilerVersion: string;
  },
): PolicyGatewaySnapshot {
  if (rows.length !== input.authorizationPrincipalIds.length || rows.length === 0) {
    throw new PolicyGatewayPostgresError();
  }
  const first = requiredRow(rows[0]);
  const epoch = parseEpoch(first.authorization_epoch);
  const observedDatabaseAt = parseCanonicalInstant(first.observed_database_at);
  const resourceRevisionId = parseOntosId(first.resource_revision_id);
  const policyResourceId = parseOntosId(first.policy_resource_id);
  const policyCompilationId = parseOntosId(first.policy_compilation_id);
  const artifactDigest = parseArtifactDigest(first.artifact_digest);
  const principals: PolicyGatewaySnapshotPrincipal[] = [];

  for (const [index, row] of rows.entries()) {
    if (
      row.principal_ordinality !== index + 1 ||
      row.principal_id !== input.authorizationPrincipalIds[index] ||
      row.observed_database_at !== first.observed_database_at ||
      row.authorization_epoch !== first.authorization_epoch ||
      row.resource_revision_id !== first.resource_revision_id ||
      row.policy_resource_id !== first.policy_resource_id ||
      row.policy_compilation_id !== first.policy_compilation_id ||
      row.artifact_digest !== first.artifact_digest
    ) {
      throw new PolicyGatewayPostgresError();
    }
    const identityType = parseIdentityType(row.identity_type);
    const state = parsePrincipalState(row.principal_state);
    const projectRole = parseRole(row.project_role);
    const resourceRole = parseRole(row.resource_role);
    const serviceProfileState = parseServiceProfileState(row.service_profile_state);
    const serviceCapabilities = parseServiceCapabilities(row.service_capabilities);
    principals.push(
      Object.freeze({
        principalId: parseOntosId(row.principal_id),
        identityType,
        state,
        projectRole,
        resourceRole,
        resourceBindingPresent: row.resource_binding_present,
        serviceProfileState,
        serviceCapabilities,
      }),
    );
  }
  return Object.freeze({
    projectId: parseOntosId(input.projectId),
    resourceId: parseOntosId(input.resourceId),
    resourceRevisionId,
    releaseId: parseOntosId(input.releaseId),
    policyResourceId,
    policyRevisionId: parseOntosId(input.policyRevisionId),
    policyCompilationId,
    compilerVersion: input.compilerVersion,
    artifactDigest,
    epoch,
    observedDatabaseAt,
    principals: Object.freeze(principals),
  });
}

function requiredRow(row: GatewaySnapshotRow | undefined): GatewaySnapshotRow {
  if (row === undefined) throw new PolicyGatewayPostgresError();
  return row;
}

function parseEpoch(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/u.test(value)) throw new PolicyGatewayPostgresError();
  const epoch = BigInt(value);
  if (epoch > MAX_POLICY_GATEWAY_EPOCH) throw new PolicyGatewayPostgresError();
  return epoch;
}

function parseIdentityType(value: string | null): IdentityType {
  if (value !== "human" && value !== "service") throw new PolicyGatewayPostgresError();
  return value;
}

function parsePrincipalState(value: string | null): "active" | "disabled" {
  if (value !== "active" && value !== "disabled") throw new PolicyGatewayPostgresError();
  return value;
}

const roles: ReadonlySet<string> = new Set(MANAGEMENT_ROLE_VALUES);

function parseRole(value: string | null): ManagementRoleValue | null {
  if (value === null) return null;
  if (!roles.has(value)) throw new PolicyGatewayPostgresError();
  return value as ManagementRoleValue;
}

function parseServiceProfileState(value: string | null): "active" | "revoked" | null {
  if (value === null || value === "active" || value === "revoked") return value;
  throw new PolicyGatewayPostgresError();
}

function parseServiceCapabilities(value: unknown): readonly string[] | null {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16 ||
    !value.every((item: unknown) => typeof item === "string")
  ) {
    throw new PolicyGatewayPostgresError();
  }
  return Object.freeze([...value] as string[]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
