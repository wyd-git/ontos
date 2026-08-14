# G2-01-10 受认证 Admin HTTP API 验收记录

- 结论：**PASS（仅限 G2-01-10 Admin HTTP API）**
- 执行日期：2026-08-15
- 分支：`agent/g2-01-10-admin-api`
- 起始 Commit：`cfa5c5b`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3 / PostgreSQL 16.14

本记录对应 [G2-01-10 WWA](../delivery/g2-01-metadata-task-pack.md#g2-01-10实现受认证-admin-http-api)。实现 Commit 与远端 Gate 由 PR Head/Check 绑定；本文件不自称 G2-01 总验收完成。

## 1. 交付内容

- 新增最小 `@ontos/api` Composition Root，使用原生 Node HTTP、`jose` OIDC 校验和 `pg` 连接池；没有引入 UI、SDK、公开 OpenAPI 或内存业务 Store；
- 实现任务包 3.8 节的 Project、Resource、Revision、Release、Package 和 Role Binding 路由；Handler 只映射 HTTP DTO、调用 Application Use Case 和映射安全响应；
- 补齐受统一 `ManagementAuthorizer` 保护的 Project、Role Binding 和 Release 读取 Use Case；Package Upgrade 的 Path Installation ID 被传到 Store 并校验 Project/Package 归属；
- 所有写入先经过 1 MiB Body、1,024 Array、32 Depth、65,536 String、20,000 Node 和危险 Key 限额，再由严格 Application Parser 拒绝未知字段；
- Draft Patch 与 Role Binding PUT 使用强 `If-Match`；列表 Cursor 使用 HMAC-SHA256，并绑定 Collection Kind 和 Project/Resource Context；
- 所有错误通过 Foundation Error Envelope 返回，含稳定 Status/Code/Category/Retryable/Correlation ID，不回显内部异常消息。

## 2. 身份与授权边界

OIDC Adapter 从 Provider Discovery 获取 JWKS，只接受 `RS256`/`ES256`，并同时验证签名、Issuer、Audience、`exp`、`iat`、`sub` 和 `ontos.admin` Scope。Bearer Token 与原始 Claims 不进入 Router 之后的 Application/Domain/Repository；下游只收到闭合的 `VerifiedFoundationIdentity`。

真实 HTTP 负面测试在任何 Principal 行出现前依次提交错误 Issuer、错误 Audience、过期 Token 和缺少管理 Scope 的 Token，四者均返回 `401 AUTHENTICATION_REQUIRED`，Store 行数仍为零。

Owner/Editor/Viewer 真实矩阵验证：

- Owner 管理 Role Binding、Publish 和所有 Metadata；
- Editor 可创建、修改、校验 Draft 和创建/Stage Release，但不能管理 Role 或 Publish；
- Viewer 可读 Metadata，但不能修改 Draft；
- 无权 Resource 与不存在 Resource 返回相同 `404 OBJECT_NOT_ACCESSIBLE` 形状，不暴露存在性或依赖。

## 3. PostgreSQL 与恢复边界

API 启动时查询数据库身份并 fail closed：`current_user` 和 `session_user` 必须同时为 `api_runtime`，该角色不能是 `migration_owner` 成员，也不能使用 `ontos_migration` Schema。真实 Integration 另外证明：

```text
SET ROLE migration_owner                              42501 blocked
SELECT * FROM ontos_migration.schema_migrations       42501 blocked
以 postgres 身份启动 Admin API                         startup rejected
```

HTTP 创建的 Project、Role、Resource、Revision、Validation、Release 和 Published Binding 全部来自 PostgreSQL。关闭 API 进程与连接池后，用同一配置重新组合并启动，Viewer 仍能读到相同 Project；没有进程内业务状态参与恢复。

## 4. 真实纵向场景

单个测试 OIDC Provider 使用运行时生成的 RSA Key 和真实签名 JWT，经真实回环 HTTP 进入 API，再由 `api_runtime` 访问 PostgreSQL 16：

```text
invalid token × 4 → create Project → bind Editor/Viewer
→ create/list Resources with opaque Cursor
→ Viewer read / Viewer write denied
→ Editor Draft CAS / stale CAS denied / validate
→ create + validate + stage Release
→ Editor publish denied / Owner publish succeeds
→ invisible Resource indistinguishable from missing
→ API restart → PostgreSQL state recovered
```

同时覆盖未知字段、超深 Body、缺少 `If-Match`、Cursor 跨 Project 重放、Stale ETag、错误文本脱敏和 Correlation Context。

## 5. 可复现命令

```text
npm run typecheck                    PASS
npm run lint                         PASS
npm run check:architecture           PASS — 7 packages / 42 source files
npm run test:admin-api               PASS — 6/6
npm run test:admin-api:postgres      PASS — 1/1 / PostgreSQL 16.14
```

### 全仓 Gate

```text
Foundation Gate: PASS — 16/16
unit:                  277/277
contract-golden-diff: PASS — 11 foundation / 12 metadata / 66 golden cases
architecture:          PASS — 7 packages / 42 source files
scope evidence:        PASS — 6 DB migrations / 23 evidence records / only apps/api / no UI
testkit provenance:    PASS — 47 G1 inputs / 6 migrated groups
supply chain:          PASS — 135 packages / 142 SBOM components / 0 vulnerabilities
postgres integration: PASS — 5/5 / PostgreSQL 16.14 / role escalation blocked
production boundary:  PASS — OIDC / S3 / PostgreSQL / OpenTelemetry
teardown:              PASS — containers and network removed
duration:              41,857 ms
```

完整 `npm run verify` 已在提交前通过；最终实现 Commit 与远端 Gate 由 PR Head/Check 绑定。G2-01-11 将 API/OIDC Gate、Metadata Evidence Manifest、故意失败 Fixture 和两 Package Provenance 统一成 G2-01 报告。

## 6. 明确未宣称内容

- 当前路由是 G2-01 内部管理合同，不冻结公开 OpenAPI，不生成 SDK；
- TLS、WAF、速率限制、生产 Secret 注入、HA、备份和告警不由本任务伪装完成；
- Role Binding 仍使用稳定 Principal UUID；面向管理员的 Principal 搜索/邀请体验属于后续身份产品面；
- G2-01-11 的统一 CI/Evidence 和 G2-01-12 clean-room 总验收尚未完成；当前进度为 **10/12**，还剩 **2 项**。
