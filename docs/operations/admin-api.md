# Admin API 运行边界

`apps/api` 是 G2-01 的内部管理入口。它要求数据库迁移已完成、OIDC Provider 可发现，并以最小权限 `api_runtime` 登录 PostgreSQL。

## 必需配置

```text
ONTOS_DATABASE_URL=postgresql://api_runtime:<secret>@<host>:5432/<database>
ONTOS_OIDC_ISSUER=https://identity.example.com/realms/ontos
ONTOS_OIDC_AUDIENCE=ontos-admin
ONTOS_OIDC_ADMIN_SCOPE=ontos.admin
ONTOS_CURSOR_HMAC_SECRET=<at least 32 bytes from a secret manager>
ONTOS_ADMIN_API_HOST=127.0.0.1
ONTOS_ADMIN_API_PORT=3000
```

启动：

```bash
npm run api:start
```

启动检查若发现数据库不是 `api_runtime`、该角色可切换到 `migration_owner`、或可访问 `ontos_migration`，进程会在监听前退出。不要把迁移 Owner URL 作为临时替代。

## HTTP 约定

- 所有路由位于 `/api/v1/admin`，要求 `Authorization: Bearer <OIDC access token>`；
- Token 必须满足配置的 Issuer、Audience、时间和管理 Scope；
- JSON 写入必须使用 `Content-Type: application/json`；
- Draft Patch 与 Role Binding PUT 使用强 ETag，例如 `If-Match: "2"`；
- Package Install/Upgrade/Rollback 要求 `Idempotency-Key`；
- Release Publish/Rollback 的控制序列在 JSON 中使用十进制字符串；
- 错误只返回 Foundation Error Envelope；`X-Correlation-ID` 可传入符合 Foundation 格式的值，否则服务器生成新值。

G2-01 不冻结公开 OpenAPI，也不生成 SDK。入口应部署在 TLS/网关之后；本进程自身不宣称 WAF、速率限制或公网暴露能力。
