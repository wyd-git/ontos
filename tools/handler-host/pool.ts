import { performance } from "node:perf_hooks";
import type { ChildProcess } from "node:child_process";

import { ArtifactContractError, validateArtifactInvocation } from "./catalog.ts";
import { launchHandlerHost } from "./launch.ts";
import {
  HANDLER_PROTOCOL,
  HANDLER_PROTOCOL_VERSION,
  ProtocolValidationError,
  parseHostEnvelope,
  parseInvokeEnvelope,
  type HandlerErrorCode,
  type InvocationRequest,
  type InvokeEnvelope,
  type JsonValue,
} from "./protocol.ts";

export interface HandlerHostPoolOptions {
  readonly size?: number;
  readonly startupTimeoutMs?: number;
  readonly terminationGraceMs?: number;
}

export interface HandlerInvocationResult {
  readonly result: JsonValue;
  readonly durationMs: number;
  readonly hostPid: number;
}

interface PendingInvocation {
  readonly envelope: InvokeEnvelope;
  readonly resolve: (result: HandlerInvocationResult) => void;
  readonly reject: (error: HandlerHostError) => void;
}

interface ActiveInvocation extends PendingInvocation {
  readonly startedAt: number;
  timeoutHandle: NodeJS.Timeout | undefined;
  timedOut: boolean;
}

export class HandlerHostError extends Error {
  readonly code: HandlerErrorCode;
  readonly hostPid: number | null;
  readonly durationMs: number | null;

  constructor(
    code: HandlerErrorCode,
    message: string,
    options: { readonly hostPid?: number | null; readonly durationMs?: number | null } = {},
  ) {
    super(message);
    this.name = "HandlerHostError";
    this.code = code;
    this.hostPid = options.hostPid ?? null;
    this.durationMs = options.durationMs ?? null;
  }
}

export class HandlerHostPool {
  readonly #size: number;
  readonly #startupTimeoutMs: number;
  readonly #terminationGraceMs: number;
  readonly #workers = new Set<HostWorker>();
  readonly #queue: PendingInvocation[] = [];
  readonly #healthWaiters = new Set<() => void>();
  #requestSequence = 0;
  #started = false;
  #stopping = false;
  #fatalError: HandlerHostError | undefined;

  constructor(options: HandlerHostPoolOptions = {}) {
    this.#size = requireBoundedInteger(options.size ?? 1, "size", 1, 32);
    this.#startupTimeoutMs = requireBoundedInteger(
      options.startupTimeoutMs ?? 5_000,
      "startupTimeoutMs",
      100,
      30_000,
    );
    this.#terminationGraceMs = requireBoundedInteger(
      options.terminationGraceMs ?? 250,
      "terminationGraceMs",
      1,
      1_000,
    );
  }

  get workerPids(): readonly number[] {
    return [...this.#workers]
      .filter((worker) => worker.ready)
      .map((worker) => worker.pid)
      .sort((left, right) => left - right);
  }

  async start(): Promise<void> {
    if (this.#started || this.#stopping) {
      throw new HandlerHostError("INVALID_INVOCATION", "Handler Host Pool is already active.");
    }
    this.#fatalError = undefined;
    this.#started = true;
    try {
      await Promise.all(Array.from({ length: this.#size }, () => this.#spawnWorker()));
    } catch (error) {
      await this.stop();
      throw normalizeHostError(error, "HOST_EXITED");
    }
  }

  invoke(request: InvocationRequest): Promise<HandlerInvocationResult> {
    if (!this.#started || this.#stopping) {
      return Promise.reject(
        new HandlerHostError("HOST_EXITED", "Handler Host Pool is not running."),
      );
    }
    if (this.#fatalError !== undefined) return Promise.reject(this.#fatalError);
    let envelope: InvokeEnvelope;
    try {
      const requestId = `rpc-${String(process.pid)}-${String(++this.#requestSequence)}`;
      envelope = parseInvokeEnvelope({
        protocol: HANDLER_PROTOCOL,
        version: HANDLER_PROTOCOL_VERSION,
        type: "INVOKE",
        requestId,
        request,
      });
      validateArtifactInvocation(envelope.request);
    } catch (error) {
      return Promise.reject(normalizeHostError(error, "INVALID_INVOCATION"));
    }
    return new Promise<HandlerInvocationResult>((resolve, reject) => {
      this.#queue.push({ envelope, resolve, reject });
      this.#drain();
    });
  }

  async killOneForTest(): Promise<{
    readonly previousPid: number;
    readonly replacementPid: number;
  }> {
    if (!this.#started || this.#stopping) {
      throw new HandlerHostError("HOST_EXITED", "Handler Host Pool is not running.");
    }
    const worker = [...this.#workers].find((candidate) => candidate.ready);
    if (worker === undefined) {
      throw new HandlerHostError("HOST_EXITED", "No ready Handler Host is available.");
    }
    const previousPids = new Set(this.workerPids);
    const previousPid = worker.pid;
    worker.killForTest();
    await this.#waitForHealthy(previousPid);
    const replacementPid = this.workerPids.find((pid) => !previousPids.has(pid));
    if (replacementPid === undefined) {
      throw new HandlerHostError("HOST_EXITED", "Replacement Handler Host did not become ready.");
    }
    return { previousPid, replacementPid };
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    if (!this.#started && !this.#stopping) return;
    this.#stopping = true;
    this.#started = false;
    const error = new HandlerHostError("HOST_EXITED", "Handler Host Pool stopped.");
    for (const pending of this.#queue.splice(0)) pending.reject(error);
    const workers = [...this.#workers];
    await Promise.all(workers.map((worker) => worker.stop()));
    this.#workers.clear();
    this.#fatalError = undefined;
    this.#stopping = false;
    this.#notifyHealthWaiters();
  }

  async #spawnWorker(): Promise<void> {
    const worker = new HostWorker(
      this.#startupTimeoutMs,
      this.#terminationGraceMs,
      () => this.#drain(),
      () => this.#handleWorkerExit(worker),
    );
    this.#workers.add(worker);
    try {
      await worker.waitUntilReady();
      this.#notifyHealthWaiters();
      this.#drain();
    } catch (error) {
      this.#workers.delete(worker);
      this.#notifyHealthWaiters();
      throw error;
    }
  }

  #handleWorkerExit(worker: HostWorker): void {
    this.#workers.delete(worker);
    this.#notifyHealthWaiters();
    if (!this.#started || this.#stopping) return;
    void this.#spawnWorker().catch((error: unknown) => {
      const failure = normalizeHostError(error, "HOST_EXITED");
      this.#fatalError = failure;
      for (const pending of this.#queue.splice(0)) pending.reject(failure);
      this.#notifyHealthWaiters();
    });
  }

  #drain(): void {
    if (!this.#started || this.#stopping) return;
    for (const worker of this.#workers) {
      if (this.#queue.length === 0) return;
      if (!worker.available) continue;
      const pending = this.#queue.shift();
      if (pending !== undefined) worker.invoke(pending);
    }
  }

  #waitForHealthy(excludedPid?: number): Promise<void> {
    if (this.#isHealthy(excludedPid)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#healthWaiters.delete(check);
        reject(
          new HandlerHostError("HOST_EXITED", "Handler Host Pool did not recover before deadline."),
        );
      }, this.#startupTimeoutMs * 2);
      const check = (): void => {
        if (!this.#isHealthy(excludedPid)) return;
        clearTimeout(timeout);
        this.#healthWaiters.delete(check);
        resolve();
      };
      this.#healthWaiters.add(check);
      check();
    });
  }

  #isHealthy(excludedPid?: number): boolean {
    const pids = this.workerPids;
    return pids.length === this.#size && (excludedPid === undefined || !pids.includes(excludedPid));
  }

  #notifyHealthWaiters(): void {
    for (const waiter of [...this.#healthWaiters]) waiter();
  }
}

class HostWorker {
  readonly #child: ChildProcess;
  readonly #startupTimeoutMs: number;
  readonly #terminationGraceMs: number;
  readonly #onAvailable: () => void;
  readonly #onExit: () => void;
  readonly #readyPromise: Promise<void>;
  readonly #exitPromise: Promise<void>;
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((error: HandlerHostError) => void) | undefined;
  #resolveExit: (() => void) | undefined;
  #startupTimer: NodeJS.Timeout | undefined;
  #killTimer: NodeJS.Timeout | undefined;
  #active: ActiveInvocation | undefined;
  #ready = false;
  #exited = false;
  #stopping = false;

  constructor(
    startupTimeoutMs: number,
    terminationGraceMs: number,
    onAvailable: () => void,
    onExit: () => void,
  ) {
    this.#startupTimeoutMs = startupTimeoutMs;
    this.#terminationGraceMs = terminationGraceMs;
    this.#onAvailable = onAvailable;
    this.#onExit = onExit;
    this.#child = launchHandlerHost();
    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#child.on("message", (message: unknown) => this.#handleMessage(message));
    this.#child.once("error", () => this.#terminate("SIGKILL"));
    this.#child.once("exit", () => this.#handleExit());
    this.#startupTimer = setTimeout(() => {
      this.#rejectReadyOnce(
        new HandlerHostError("HOST_EXITED", "Handler Host did not become ready before deadline.", {
          hostPid: this.#safePid(),
        }),
      );
      this.#terminate("SIGKILL");
    }, this.#startupTimeoutMs);
  }

  get pid(): number {
    const pid = this.#child.pid;
    if (pid === undefined) {
      throw new HandlerHostError("HOST_EXITED", "Handler Host process has no PID.");
    }
    return pid;
  }

  get ready(): boolean {
    return this.#ready && !this.#exited;
  }

  get available(): boolean {
    return this.ready && this.#active === undefined && !this.#stopping;
  }

  waitUntilReady(): Promise<void> {
    return this.#readyPromise;
  }

  invoke(pending: PendingInvocation): void {
    if (!this.available) {
      pending.reject(new HandlerHostError("HOST_EXITED", "Handler Host is not available."));
      return;
    }
    const active: ActiveInvocation = {
      ...pending,
      startedAt: performance.now(),
      timeoutHandle: undefined,
      timedOut: false,
    };
    this.#active = active;
    active.timeoutHandle = setTimeout(
      () => this.#handleTimeout(active),
      active.envelope.request.timeoutMs,
    );
    this.#child.send(active.envelope, (error: Error | null) => {
      if (error === null) return;
      this.#terminate("SIGKILL");
    });
  }

  killForTest(): void {
    this.#terminate("SIGKILL");
  }

  async stop(): Promise<void> {
    if (this.#exited) return;
    this.#stopping = true;
    this.#terminate("SIGTERM");
    if (this.#killTimer === undefined) {
      this.#killTimer = setTimeout(() => this.#terminate("SIGKILL"), this.#terminationGraceMs);
    }
    await this.#exitPromise;
  }

  #handleMessage(message: unknown): void {
    let envelope;
    try {
      envelope = parseHostEnvelope(message);
    } catch {
      this.#failProtocol();
      return;
    }
    if (envelope.type === "READY") {
      if (this.#ready || envelope.pid !== this.#child.pid) {
        this.#failProtocol();
        return;
      }
      this.#ready = true;
      if (this.#startupTimer !== undefined) clearTimeout(this.#startupTimer);
      this.#startupTimer = undefined;
      this.#resolveReady?.();
      this.#resolveReady = undefined;
      this.#rejectReady = undefined;
      return;
    }
    const active = this.#active;
    if (active === undefined || active.envelope.requestId !== envelope.requestId) {
      this.#failProtocol();
      return;
    }
    if (active.timeoutHandle !== undefined) clearTimeout(active.timeoutHandle);
    this.#active = undefined;
    if (envelope.ok) {
      active.resolve({
        result: envelope.result,
        durationMs: envelope.durationMs,
        hostPid: this.pid,
      });
    } else {
      active.reject(
        new HandlerHostError(envelope.error.code, envelope.error.message, {
          hostPid: this.pid,
          durationMs: envelope.durationMs,
        }),
      );
    }
    this.#onAvailable();
  }

  #handleTimeout(active: ActiveInvocation): void {
    if (this.#active !== active) return;
    active.timedOut = true;
    this.#terminate("SIGTERM");
    this.#killTimer = setTimeout(() => this.#terminate("SIGKILL"), this.#terminationGraceMs);
  }

  #handleExit(): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#ready = false;
    if (this.#startupTimer !== undefined) clearTimeout(this.#startupTimer);
    if (this.#killTimer !== undefined) clearTimeout(this.#killTimer);
    this.#rejectReadyOnce(
      new HandlerHostError("HOST_EXITED", "Handler Host exited before startup completed.", {
        hostPid: this.#safePid(),
      }),
    );
    const active = this.#active;
    this.#active = undefined;
    if (active !== undefined) {
      if (active.timeoutHandle !== undefined) clearTimeout(active.timeoutHandle);
      const durationMs = Math.max(0, performance.now() - active.startedAt);
      active.reject(
        active.timedOut
          ? new HandlerHostError("HANDLER_TIMEOUT", "Artifact exceeded its hard timeout.", {
              hostPid: this.#safePid(),
              durationMs,
            })
          : new HandlerHostError("HOST_EXITED", "Handler Host exited during invocation.", {
              hostPid: this.#safePid(),
              durationMs,
            }),
      );
    }
    this.#resolveExit?.();
    this.#resolveExit = undefined;
    this.#onExit();
  }

  #failProtocol(): void {
    const active = this.#active;
    if (active !== undefined) {
      if (active.timeoutHandle !== undefined) clearTimeout(active.timeoutHandle);
      this.#active = undefined;
      active.reject(
        new HandlerHostError("PROTOCOL_MISMATCH", "Handler Host returned an invalid RPC message.", {
          hostPid: this.#safePid(),
          durationMs: Math.max(0, performance.now() - active.startedAt),
        }),
      );
    }
    this.#terminate("SIGKILL");
  }

  #terminate(signal: NodeJS.Signals): void {
    if (!this.#exited) this.#child.kill(signal);
  }

  #rejectReadyOnce(error: HandlerHostError): void {
    this.#rejectReady?.(error);
    this.#resolveReady = undefined;
    this.#rejectReady = undefined;
  }

  #safePid(): number | null {
    return this.#child.pid ?? null;
  }
}

function normalizeHostError(error: unknown, fallbackCode: HandlerErrorCode): HandlerHostError {
  if (error instanceof HandlerHostError) return error;
  if (error instanceof ArtifactContractError) {
    return new HandlerHostError(error.code, safeMessage(error.code));
  }
  if (error instanceof ProtocolValidationError) {
    return new HandlerHostError("INVALID_INVOCATION", safeMessage("INVALID_INVOCATION"));
  }
  return new HandlerHostError(fallbackCode, safeMessage(fallbackCode));
}

function safeMessage(code: HandlerErrorCode): string {
  if (code === "ARTIFACT_NOT_REGISTERED") return "Artifact Digest is not registered.";
  if (code === "INVALID_INVOCATION") return "Handler invocation is invalid.";
  return "Handler Host is unavailable.";
}

function requireBoundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new HandlerHostError(
      "INVALID_INVOCATION",
      `${label} must be a safe integer between ${String(minimum)} and ${String(maximum)}.`,
    );
  }
  return value;
}
