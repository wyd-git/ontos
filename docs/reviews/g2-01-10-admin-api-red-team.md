# Red-Team：G2-01-10 受认证 Admin HTTP API

- 日期：2026-08-15
- 审查对象：OIDC、HTTP Parser、身份闭合、RBAC、ETag/Cursor、错误映射、Composition Root 和 PostgreSQL 身份
- 方法：Intended → Enforcement Point → Negative Test → Residual Risk
- 结论：**Go for G2-01-11**；入口身份伪造、Path 身份忽略、未知字段/超限输入、并发覆盖、错误泄漏、资源存在性泄漏、Owner 数据库身份和内存恢复假象已关闭。

## 1. 审查中发现并关闭的偏差

### 1.1 Package Upgrade URL 中的 Installation ID 可能被忽略

原 Application Upgrade 只按 Body 的 Project/Manifest 找 Installation；若 HTTP Adapter 直接复用，Path `{id}` 只是装饰。新增 `upgradePackageInstallation` Use Case 和 Store 精确校验，Path ID 必须与 Candidate 的 Project/Package Identity 同时匹配。**CLOSED**。

### 1.2 Endpoint 清单需要读取 Project/Release/Role，但 Application 没有安全读取 Port

直接在 Handler 组合 Repository 会违反边界。新增三个 Application Use Case，分别要求 `metadata.read` 或 `role.manage`，Handler 不读取 SQL、不直接构造 Repository。**CLOSED**。

### 1.3 将 `after: null` 传给严格 Parser 会使第一页真实 HTTP 返回 400

首次 PostgreSQL/HTTP Integration 发现 Router 把“没有 Cursor”编码成显式 `null`，而 Application 合同要求字段缺省。Router 改为只在 Cursor 存在时加入 `after`；第一页、第二页、跨 Project 重放均再次通过。**CLOSED**。

### 1.4 只校验 JWT 签名仍可接受错误租户或错误用途 Token

OIDC Adapter 同时固定算法、Issuer、Audience、时间和管理 Scope。四个有效签名但语义错误的 Token 均在 Principal Store 前失败。**CLOSED**。

### 1.5 错误直接返回 Application/PG message 会泄漏 SQL、约束或 Token

Error Mapper 不使用异常正文，只按受控类型生成 Foundation Envelope；未知异常为通用 500，Storage 为通用可重试 503。Correlation ID 经 Foundation Parser 校验，非法客户端值不反射。**CLOSED**。

### 1.6 API 使用数据库 Owner 会让所有应用授权成为可绕过装饰

Composition Root 在监听端口前验证 `current_user=session_user=api_runtime`、无 `migration_owner` Membership、无迁移 Schema Usage。以 `postgres` 启动、`SET ROLE migration_owner` 和读取迁移账本均失败。**CLOSED**。

## 2. Intended-vs-Implemented 矩阵

| Intended Claim            | 精确执行点                                         | 反例测试                                         | 结果 |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------ | ---- |
| 无效 OIDC 在 Store 前拒绝 | OIDC Discovery/JWKS + `jwtVerify` + Scope          | issuer/aud/exp/scope，Principal count=0          | PASS |
| Token/Claims 不穿透入口   | OIDC 输出闭合 Identity；Handler Source Gate        | 禁止 rawClaims/Bearer/JWT Parser 下沉            | PASS |
| 统一管理授权              | Application `ManagementAuthorizer`                 | Editor Publish、Viewer Write、Editor Role 均拒绝 | PASS |
| Handler 无 SQL/状态机     | Router 只依赖 Application Pick                     | SQL/Repository/JWT Source 负面 Gate              | PASS |
| 写入有边界且严格          | Streaming Body Budget + strict DTO + Domain Parser | unknown/depth/array/string/bytes                 | PASS |
| 并发写不能覆盖            | 强 ETag → bigint CAS                               | missing/stale If-Match                           | PASS |
| Cursor 不透明且不可重放   | HMAC + kind/scope binding                          | tamper/context replay                            | PASS |
| 不泄漏 Resource 存在性    | FORBIDDEN/NOT_FOUND 同 Envelope                    | invisible vs random UUID                         | PASS |
| DB 最小权限               | startup identity assertion + grants                | Owner startup/SET ROLE/schema read               | PASS |
| 重启不丢状态              | stateless Composition Root                         | close pool/server + rebuild + GET                | PASS |

## 3. 尚未关闭的边界

- G2-01-11 尚未把 API/OIDC 和故意失败 Fixture 纳入统一 Metadata Evidence Manifest；
- G2-01-12 尚未从 clean checkout 串起两个 Package 的 Install/Upgrade/Breaking/Rollback HTTP 总场景；
- JWKS Provider 可用性目前 fail closed，尚未定义生产多实例缓存、告警和故障预算；
- Role Binding 目标 Principal 需要已知稳定 UUID，当前没有管理员搜索/邀请 UI；这不改变授权正确性，但会影响后续可用性；
- 当前进程不宣称自行终止 TLS、提供 WAF/Rate Limit、生产 Secret Manager 或 HA。

因此结论是 **Go for G2-01-11**，不是 G2-01 总 PASS，也不是公网生产发布声明。
