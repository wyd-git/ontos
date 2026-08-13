import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { queryJson } from "../src/db/psql.js";

const timestamp = new Date().toISOString().replaceAll(":", "");
const evidenceDirectory = join("evidence", "raw", `${timestamp}-environment`);
await mkdir(evidenceDirectory, { recursive: true });

const containerId = command(["docker", "compose", "ps", "-q", "postgres"]);
const container = containerId ? JSON.parse(command(["docker", "inspect", containerId]))[0] : null;
const image = container?.Image ? JSON.parse(command(["docker", "image", "inspect", container.Image]))[0] : null;
const database = queryJson(`
  SELECT json_build_array(json_build_object(
    'serverVersion', current_setting('server_version'),
    'serverVersionNum', current_setting('server_version_num'),
    'databaseSizeBytes', pg_database_size(current_database()),
    'settings', json_build_object(
      'shared_buffers', current_setting('shared_buffers'),
      'work_mem', current_setting('work_mem'),
      'maintenance_work_mem', current_setting('maintenance_work_mem'),
      'effective_cache_size', current_setting('effective_cache_size'),
      'max_connections', current_setting('max_connections'),
      'random_page_cost', current_setting('random_page_cost'),
      'effective_io_concurrency', current_setting('effective_io_concurrency'),
      'jit', current_setting('jit'),
      'max_parallel_workers', current_setting('max_parallel_workers'),
      'max_worker_processes', current_setting('max_worker_processes')
    )
  ));
`)[0];
const gitRevision = existsSync(join(process.cwd(), ".git"))
  ? optionalCommand(["git", "rev-parse", "HEAD"])
  : null;
const contentFingerprint = JSON.parse(command([process.execPath, "scripts/content-fingerprint.js"]));
const disk = JSON.parse(command([process.execPath, "-e", [
  "const {statfsSync}=require('node:fs');",
  "const s=statfsSync('.');",
  "process.stdout.write(JSON.stringify({blockSize:s.bsize,blocks:Number(s.blocks),freeBlocks:Number(s.bfree),availableBlocks:Number(s.bavail)}));",
].join("") ]));

const report = {
  timestamp,
  host: {
    hostname: hostname(),
    platform: platform(),
    osRelease: release(),
    cpuModel: cpus()[0]?.model,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    disk,
    nodeVersion: process.version,
  },
  database,
  container: container ? {
    id: container.Id,
    name: container.Name,
    state: container.State?.Status,
    imageId: container.Image,
  } : null,
  image: image ? {
    id: image.Id,
    repoTags: image.RepoTags,
    architecture: image.Architecture,
    os: image.Os,
    sizeBytes: image.Size,
  } : null,
  gitRevision,
  contentFingerprint,
};

await writeFile(join(evidenceDirectory, "command.txt"), "npm run evidence:environment\n", "utf8");
await writeFile(join(evidenceDirectory, "environment.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ evidenceDirectory, ...report }, null, 2)}\n`);

function command([program, ...args]) {
  return execFileSync(program, args, { cwd: process.cwd(), encoding: "utf8" }).trim();
}

function optionalCommand(parts) {
  try {
    return command(parts);
  } catch {
    return null;
  }
}
