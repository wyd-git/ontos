# Admin API 运行边界

`apps/api` 是内部管理入口。它要求数据库迁移已完成、OIDC Provider 可发现，并以最小权限 `api_runtime` 登录 PostgreSQL。G2-02 起，进程还会在监听前验证受管 S3 Bucket 已启用 Versioning。

## 必需配置

```text
ONTOS_DATABASE_URL=postgresql://api_runtime:<secret>@<host>:5432/<database>
ONTOS_OIDC_ISSUER=https://identity.example.com/realms/ontos
ONTOS_OIDC_AUDIENCE=ontos-admin
ONTOS_OIDC_ADMIN_SCOPE=ontos.admin
ONTOS_CURSOR_HMAC_SECRET=<at least 32 bytes from a secret manager>
ONTOS_S3_ENDPOINT=https://s3.example.com
ONTOS_S3_REGION=us-east-1
ONTOS_S3_BUCKET=ontos-managed-ingress
ONTOS_S3_ACCESS_KEY_ID=<from a secret manager>
ONTOS_S3_SECRET_ACCESS_KEY=<from a secret manager>
ONTOS_S3_FORCE_PATH_STYLE=false
ONTOS_S3_MAX_ATTEMPTS=2
ONTOS_MANAGED_CSV_MAXIMUM_BYTES=536870912
ONTOS_ADMIN_API_HOST=127.0.0.1
ONTOS_ADMIN_API_PORT=3000
```

启动：

```bash
npm run api:start
```

启动检查若发现数据库不是 `api_runtime`、该角色可切换到 `migration_owner`、可访问 `ontos_migration`，或 Bucket 未启用 Versioning，进程会在监听前退出。不要把迁移 Owner URL 作为临时替代。`ONTOS_MANAGED_CSV_MAXIMUM_BYTES` 可以低于但不能高于 512 MiB。

## HTTP 约定

- 所有路由位于 `/api/v1/admin`，要求 `Authorization: Bearer <OIDC access token>`；
- Token 必须满足配置的 Issuer、Audience、时间和管理 Scope；
- JSON 写入必须使用 `Content-Type: application/json`；
- Draft Patch 与 Role Binding PUT 使用强 ETag，例如 `If-Match: "2"`；
- Package Install/Upgrade/Rollback 要求 `Idempotency-Key`；
- `POST /snapshot-upload-sessions` 创建受管 CSV 上传会话，响应只返回会话、上传路径和一次性 Finalize Token；
- `PUT /snapshot-upload-sessions/{id}/content` 必须使用精确 `Content-Length` 和 `text/csv`，请求体直接流入受管对象存储；
- `POST /snapshots` 必须提交完整 Snapshot Group 的会话集，服务端重读精确 Version、计算摘要、扫描 CSV 后再原子登记；
- Release Publish/Rollback 的控制序列在 JSON 中使用十进制字符串；
- 错误只返回 Foundation Error Envelope；`X-Correlation-ID` 可传入符合 Foundation 格式的值，否则服务器生成新值。

入口应部署在 TLS/网关之后；本进程自身不宣称 WAF、速率限制或公网暴露能力。客户端不得提供 Bucket、Key、URL、路径或存储凭据。
