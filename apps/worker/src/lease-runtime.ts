import type { MaterializationLeaseRuntime } from "@ontos/materialization-application";

export class HeartbeatLeaseRuntime implements MaterializationLeaseRuntime {
  readonly #intervalMilliseconds: number;

  constructor(intervalMilliseconds: number) {
    if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 1) {
      throw new Error("Heartbeat interval is invalid.");
    }
    this.#intervalMilliseconds = intervalMilliseconds;
  }

  async run<T>(input: {
    readonly signal: AbortSignal;
    readonly heartbeat: () => Promise<void>;
    readonly operation: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", relayAbort, { once: true });
    if (input.signal.aborted) relayAbort();

    let stopped = false;
    let heartbeatFailure: Error | undefined;
    const heartbeatLoop = (async (): Promise<void> => {
      while (!stopped && !controller.signal.aborted) {
        const elapsed = await abortableDelay(this.#intervalMilliseconds, controller.signal);
        if (!elapsed || stopped || controller.signal.aborted) return;
        try {
          await input.heartbeat();
        } catch (error) {
          heartbeatFailure = error instanceof Error ? error : new Error("Worker heartbeat failed.");
          controller.abort(heartbeatFailure);
          return;
        }
      }
    })();

    try {
      let result: T;
      try {
        result = await input.operation(controller.signal);
      } catch (error) {
        if (heartbeatFailure !== undefined) throw heartbeatFailure;
        throw error instanceof Error ? error : new Error("Worker operation failed.");
      }
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
      return result;
    } finally {
      stopped = true;
      controller.abort();
      input.signal.removeEventListener("abort", relayAbort);
      await heartbeatLoop;
    }
  }
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolveDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay(true);
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolveDelay(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
