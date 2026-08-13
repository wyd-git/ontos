import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

import { HandlerBoundaryError } from "./context.ts";

const deniedNetworkMethodNames = [
  "connect",
  "createConnection",
  "createServer",
  "createSocket",
  "get",
  "lookup",
  "lookupService",
  "request",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
] as const;

export function installNetworkDeny(): void {
  for (const target of [http, http2, https, net, tls, dgram, dns, dns.promises]) {
    for (const method of deniedNetworkMethodNames) {
      if (typeof Reflect.get(target, method) === "function")
        Reflect.set(target, method, denyNetwork);
    }
  }
  Reflect.set(net.Socket.prototype, "connect", denyNetwork);
  Reflect.set(tls.TLSSocket.prototype, "connect", denyNetwork);
  Reflect.set(dgram.Socket.prototype, "connect", denyNetwork);
  Reflect.set(dgram.Socket.prototype, "send", denyNetwork);
  Reflect.set(globalThis, "fetch", denyNetworkAsync);
  Reflect.set(globalThis, "WebSocket", DeniedNetworkConstructor);
  Reflect.set(globalThis, "EventSource", DeniedNetworkConstructor);
  syncBuiltinESMExports();
}

function denyNetwork(): never {
  throw networkDeniedError();
}

function denyNetworkAsync(): Promise<never> {
  return Promise.reject(networkDeniedError());
}

function networkDeniedError(): HandlerBoundaryError {
  return new HandlerBoundaryError(
    "NETWORK_ACCESS_DENIED",
    "Handler Host network access is disabled.",
  );
}

class DeniedNetworkConstructor {
  constructor() {
    denyNetwork();
  }
}
