# Managed UTF-8 CSV Ingress Boundary

- Status: implementation contract for G2-02-04
- Owner: Data / Security
- Scope: upload session, managed object version, physical CSV scan, immutable Snapshot registration, orphan cleanup

## 1. Trust boundary

The public request may identify a Project, a Runtime-plan-bearing Release in `ready` or `published`
state, Runtime Member, Snapshot Group version, expected byte count, and a bounded source label. It
never supplies an object-store endpoint, Bucket, Key, filesystem path, credential, server-side
digest, or schema-inference switch. Draft, staging, failed and superseded Releases cannot create new
upload sessions.

The API creates a random managed object Key below its configured ingress prefix. Large data uses a
dedicated streaming `PUT`; it never enters the ordinary JSON-body reader. Object storage must have
versioning enabled. A successful upload records the returned Version ID, but Finalize still reads the
latest object metadata, requires that it names the recorded Version ID, and scans that exact version.

The client digest is optional comparison evidence. SHA-256, byte count, row count, header agreement,
and scan status are server facts produced from the exact object version read during Finalize.

## 2. Session and retry state

```text
created -> uploaded -> finalizing -> finalized
   |          |            |
   +----------+------------+-> failed
   |          |
   +----------+-> expired -> cleaned
```

- Session lifetime: 15 minutes from creation.
- Finalize lease: 5 minutes, renewed while every exact-version stream is scanned. Heartbeat scheduling
  uses a process monotonic clock while PostgreSQL time remains the lease authority. An API crash stops
  renewal and leaves a reclaimable database lease, not an in-memory lock.
- Unfinalized/failed object retention: at most 24 hours after session expiry or failure.
- The session stores only a SHA-256 digest of the 256-bit Finalize token.
- A completed retry with the same Actor, session and token returns the same immutable Snapshot result.
- Concurrent Finalize has one database winner. A loser receives a stable version conflict and can
  retry to receive the winner's Snapshot after completion.
- A disconnected upload cannot register a Snapshot. A later full retry may create a newer version;
  cleanup deletes only unregistered versions of that session's random managed Key.
- Cleanup never deletes the exact `(managed artifact, object version)` referenced by Snapshot File.

## 3. Production envelope for G2-02

| Limit                 |           Value | Reason                                                                |
| --------------------- | --------------: | --------------------------------------------------------------------- |
| Upload bytes          |         512 MiB | bounded single-node ingress while retaining room for the 100k/1m gate |
| Data records per file |      10,000,000 | hard stop above the declared P0 acceptance fixture                    |
| Columns               |             512 | identical to the frozen Snapshot Schema v1 maximum                    |
| Physical field bytes  |           1 MiB | permits the largest v1 JSON value without unbounded buffering         |
| Physical record bytes |           8 MiB | bounds pathological wide rows independently of file size              |
| Header field bytes    |             128 | sufficient for the 63-character API-name contract                     |
| Source label          | 128 UTF-8 bytes | display-only; control characters and path separators are rejected     |

Deployments may lower the upload-byte limit, but cannot exceed these compiled hard limits in G2-02.
Creation requires an exact expected byte count. Upload requires `Content-Length` to match it and
rejects every `Content-Encoding`.

## 4. CSV physical semantics

- Media type is exactly `text/csv` with optional `charset=utf-8`; gzip, zip, Parquet, NDJSON media
  types and media-type spoofing are rejected.
- UTF-8 is validated incrementally with fatal decoding. One UTF-8 BOM is accepted only at byte zero
  and excluded from the first Header name; all NUL bytes are rejected.
- The first record is a required Header. Names must be unique and exactly equal the explicit ordered
  Snapshot Schema columns. Schema inference is never performed.
- Comma is the delimiter. LF and CRLF terminate records; bare CR outside a quoted field is rejected.
- RFC-style quoted fields, escaped `""`, commas and newlines inside quotes are accepted. A quote in an
  unquoted field, data after a closing quote, or EOF inside a quote is rejected.
- Every data record has exactly the Header column count. A final record without a newline is accepted;
  a trailing newline does not create an empty record.
- Row and column positions may appear as bounded error metadata. Cell values, Header samples, object
  Keys, URLs, tokens, Primary Keys and storage errors never appear in public errors or normal logs.

## 5. Stable public failure mapping

| Condition                                                                 | Public code                 |
| ------------------------------------------------------------------------- | --------------------------- |
| malformed session/finalize request or unsupported media                   | `ADMIN_REQUEST_INVALID`     |
| invalid UTF-8/CSV/Header or physical limit                                | `SNAPSHOT_SCHEMA_INVALID`   |
| length, client digest, recorded/latest version or server content mismatch | `SNAPSHOT_CONTENT_MISMATCH` |
| invisible session/object/project                                          | `OBJECT_NOT_ACCESSIBLE`     |
| upload/finalize race or active Finalize lease                             | `OBJECT_VERSION_CONFLICT`   |
| PostgreSQL/S3 unavailable or interrupted stream                           | `DEPENDENCY_UNAVAILABLE`    |

Internal dependency messages are preserved only as error causes. They are never reflected by the HTTP
adapter.

## 6. Registration boundary

Upload sessions bind immutable Runtime Plan context read from PostgreSQL. Finalize accepts all sessions
for one Snapshot Group version, verifies that their member keys exactly cover that Release's group
members, scans every exact object version, and commits Group Version, Dataset Snapshots, Snapshot Files,
Group Members, and finalized session pointers in one PostgreSQL transaction. A partial group cannot
become registered.

`runtime.snapshot_files` stores the managed artifact ID, exact object version, digest, size, row count,
`scan_status=complete`, and bounded source label. It stores no Bucket, Key, URL, credential, token, or
local path.
