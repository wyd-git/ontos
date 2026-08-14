import assert from "node:assert/strict";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { ADMIN_BODY_LIMITS, RequestBodyError, readJsonBody } from "../../apps/api/src/body.ts";

void test("Admin JSON body reader accepts bounded plain JSON", async () => {
  assert.deepEqual(await readJsonBody(request(JSON.stringify({ value: [1, "two", true] }))), {
    value: [1, "two", true],
  });
});

void test("Admin JSON body reader rejects media type, depth, arrays, strings and bytes", async () => {
  await assert.rejects(
    readJsonBody(request("{}", { "content-type": "text/plain" })),
    RequestBodyError,
  );
  await assert.rejects(
    readJsonBody(request(JSON.stringify(nested(ADMIN_BODY_LIMITS.maximumDepth + 1)))),
    RequestBodyError,
  );
  await assert.rejects(
    readJsonBody(request(JSON.stringify(Array.from({ length: 1_025 }, () => 1)))),
    RequestBodyError,
  );
  await assert.rejects(
    readJsonBody(request(JSON.stringify({ value: "x".repeat(65_537) }))),
    RequestBodyError,
  );
  await assert.rejects(
    readJsonBody(request("{}", { "content-length": String(ADMIN_BODY_LIMITS.maximumBytes + 1) })),
    RequestBodyError,
  );
});

function request(
  body: string,
  headers: IncomingHttpHeaders = { "content-type": "application/json" },
): IncomingMessage {
  const readable = Readable.from([Buffer.from(body)]) as Readable & {
    headers: IncomingHttpHeaders;
  };
  readable.headers = { "content-length": String(Buffer.byteLength(body)), ...headers };
  return readable as unknown as IncomingMessage;
}

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}
