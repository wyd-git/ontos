import { spawn } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { Worker } from "node:worker_threads";

import type { ArtifactHandler } from "../artifact-api.ts";

const sensitiveEnvironmentNames = [
  "DATABASE_URL",
  "PGPASSWORD",
  "ONTOS_POSTGRES_SUPERUSER_PASSWORD",
  "ONTOS_DB_RUNTIME_PASSWORD",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "ONTOS_S3_ACCESS_KEY_ID",
  "ONTOS_S3_SECRET_ACCESS_KEY",
  "ONTOS_OIDC_CLIENT_SECRET",
  "ONTOS_OIDC_ADMIN_PASSWORD",
  "REGISTRY_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "NODE_OPTIONS",
] as const;

export const invoke: ArtifactHandler = async (_context, parameters) => {
  switch (parameters.capability) {
    case "environment":
      return {
        present: sensitiveEnvironmentNames.filter((name) => process.env[name] !== undefined),
      };
    case "networkFetch":
      await fetch("http://127.0.0.1:9/handler-host-must-not-connect");
      return { reached: true };
    case "networkHttp":
      await new Promise<void>((resolve, reject) => {
        const request = http.get("http://127.0.0.1:9/handler-host-must-not-connect", (response) => {
          response.resume();
          resolve();
        });
        request.once("error", reject);
      });
      return { reached: true };
    case "networkHttp2":
      await new Promise<void>((resolve, reject) => {
        const session = http2.connect("http://127.0.0.1:9");
        session.once("connect", () => {
          session.close();
          resolve();
        });
        session.once("error", reject);
      });
      return { reached: true };
    case "networkTcp":
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port: 9 }, resolve);
        socket.once("error", reject);
      });
      return { reached: true };
    case "networkTls":
      await new Promise<void>((resolve, reject) => {
        const socket = tls.connect({ host: "127.0.0.1", port: 9 }, resolve);
        socket.once("error", reject);
      });
      return { reached: true };
    case "networkUdp": {
      const socket = dgram.createSocket("udp4");
      socket.close();
      return { reached: true };
    }
    case "networkDns":
      await dns.lookup("localhost");
      return { reached: true };
    case "filesystemRead":
      await readFile("/etc/hosts", "utf8");
      return { read: true };
    case "filesystemWrite":
      await writeFile("/private/tmp/ontos-handler-host-forbidden", "forbidden", "utf8");
      return { wrote: true };
    case "childProcess":
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--version"], { stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", (code) => resolve({ exitCode: code ?? -1 }));
      });
    case "worker": {
      const worker = new Worker("void 0", { eval: true });
      await worker.terminate();
      return { spawnedWorker: true };
    }
    default:
      throw new Error("validated capability is missing");
  }
};
