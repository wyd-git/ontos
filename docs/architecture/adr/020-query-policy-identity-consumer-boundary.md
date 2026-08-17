# ADR-020：Query / Policy / Identity / Consumer 边界

- 状态：Accepted for G2-03-01
- 日期：2026-08-18
- Owner：Runtime / Security / Web
- 依赖：[ADR-007](007-runtime-activation-serving-head.md)、[ADR-012](012-policy-epoch-cache-fail-closed.md)、[ADR-018](018-immutable-head-set-snapshot-group-cutover.md)、[ADR-019](019-generation-index-mark-plan-commit-gc.md)
- 决策范围：G2-03 的 Runtime Identity、Policy Gateway、Query、Query Lease、OpenAPI 与只读 Web 消费边界

## 1. 决策结论

G2-03 采用一条不可绕过的读路径：

```text
verified OIDC / trusted service delegation
→ server-resolved RuntimeIdentity
→ Project + Resource authorization
→ Release / Activation / Generation resolve once
→ committed Query Lease
→ bounded Policy IR + typed Query AST
→ parameterized PostgreSQL SQL
→ Runtime HTTP / OpenAPI generated client
→ metadata-driven read-only Web consumer
```

身份类型、委托链和权限不信任浏览器自报字段；Policy 必须在 SQL 内、在 `ORDER BY` / `LIMIT` / `COUNT` 前组合；Query 只读一次解析的 Current Generation；Web 只通过 HTTP 与生成 Client 消费稳定合同，不导入仓内实现包。

G2-03-01 只冻结这些决策并提供真 PostgreSQL / 生成 Client Spike。它不创建正式 Query Endpoint、G2-03 数据表、产品页面或可发布 SDK。

## 2. 事实 Owner 与依赖方向

| 责任                                               | 正式 Owner（后续 Gate 创建）       | 允许依赖                                               | 禁止                                   |
| -------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ | -------------------------------------- |
| 公共 Query / Policy / Identity / Runtime Read 合同 | `@ontos/contracts`                 | 无业务 Adapter                                         | SQL、HTTP、React                       |
| Identity 与 Delegation 规则                        | `identity-domain`                  | contracts                                              | JWT 库、PostgreSQL、HTTP               |
| Identity 用例 / Port                               | `identity-application`             | identity-domain、contracts                             | 路由或 UI 逻辑                         |
| OIDC / Principal / Delegation Adapter              | `identity-postgres` 及 API Adapter | identity-application、外部验签库                       | 伪造服务器身份事实                     |
| Policy AST / IR                                    | `policy-domain`                    | contracts                                              | Raw SQL、Network、不确定函数           |
| Policy Gateway / Epoch / Artifact Port             | `policy-application`               | policy-domain、identity-application、contracts         | HTTP、直接业务 SQL                     |
| Policy Artifact / Epoch Adapter                    | `policy-postgres`                  | policy-application                                     | Query 路由复制 Policy                  |
| Query AST / Hash / Complexity                      | `query-domain`                     | contracts、value-codec                                 | SQL、HTTP、Policy 数据库               |
| Execution Context / Get / Search / Count / Link    | `query-application`                | query-domain、policy-application、identity-application | React、领域专用 BFF                    |
| Current / Lease / SQL Adapter                      | `query-postgres`                   | query-application、materialization 公共 Port           | Route 拼 SQL、Base 旁路                |
| Runtime HTTP                                       | `apps/api`                         | application ports、contracts                           | 领域 SQL、Policy 复制                  |
| 只读 Web                                           | `apps/web`                         | HTTP + generated read client                           | `@ontos/*`、`packages/*`、手写平行 DTO |

`query-application` 可依赖 `policy-application` 的唯一 Gateway Port；Policy 不反向依赖 Query。具体 PostgreSQL 、OIDC 和 HTTP 库只存在于 Adapter 层。第二领域通过 Metadata / Definition / Policy Artifact 扩展，不允许在 Compiler、Query 或 Web 中按 API Name 分支。

## 3. Runtime Identity 与 Delegation

### 3.1 受信事实

- Bearer 只在网络 Adapter 存在；验证 Issuer、Audience、Algorithm、时效和专用 Runtime Scope 后，才能解析 Principal。
- `principalId`、`human | service`、disabled 状态、Project 权限与 Service Capability 来自 Kernel 事实，不来自 `X-Principal-*`、`X-Identity-Type`、`X-Delegated-*` 或 Body。
- Claim Mapping 是版本化、白名单和有界的；Application 只接收精简 Attribute 与不可逆 Fingerprint，不接收 Bearer 或 Raw Claims。
- 管理 OIDC 和 Runtime OIDC 使用分离 Scope；Admin 身份不因角色自动获得业务数据读权。

### 3.2 委托协议

服务委托使用 OAuth 2.0 Token Exchange 语义，保留 actor (`act`) 与 terminal subject，并强制：

- 受信 Issuer / Signer、精确 Audience、短 TTL、最大链长和服务 Capability 白名单；
- DPoP 或等价 Proof-of-Possession 指纹，以及服务端 Nonce / JTI 重放记录；
- Effective Permission = service ∩ terminal user ∩ chain principals；链中任一无权都使用同形 Deny；
- 浏览器 Header、Cookie 或 Body 不能创建委托；委托 Credential 不进入 Log、Trace、Error、Query Context 或 Cursor。

## 4. Policy IR 与 SQL 组合

Policy Compiler 输出版本化、可编译、有界 IR，只允许布尔组合、类型比较、受信 Actor Attribute 和受限一跳 Link Exists。IR 不表达 Raw SQL、原始 Identifier、Network、任意递归、非确定时间或无界集合。

唯一 SQL Compiler 按以下顺序合并决策：

1. Identity 有效且 Project / Resource 可访问；
2. Object Type 可发现；
3. Object row predicate；
4. Property read/filter/sort/search capability 与 allow/mask/deny；
5. Link visibility + edge predicate + source object predicate + target object predicate；
6. 所有客户值作为 PostgreSQL 类型参数，之后才能 `ORDER BY`、`LIMIT`、Cursor 或 `COUNT`。

Policy 不能在应用层读取全量后过滤。不可见和不存在的 Object 对外同形；deny / mask Property 不能用于 Filter、Sort、Search 或 Count 侧信道。参数化只解决值注入，Identifier 和 Operator 必须来自服务端 Metadata Registry 白名单。

## 5. Execution Context 与 Query Lease

每个请求只解析一次不可变 `ExecutionContext`，至少包含：

- Identity / Delegation Fingerprint 与 Authorization Epoch；
- Policy Artifact Digest / Compiler Version / Policy Context Hash；
- Project、实际 Release Revision、Serving Activation、Runtime Plan Members 与全部 Generation；
- 数据库 Read Timestamp、Query Hash、Correlation Ref 和 Query Lease ID。

持久 Query Lease 采用 `planned → committed → released | expired`协议。解析 Context 与创建/提交 Lease 在短 PostgreSQL 事务内完成；业务读只能在 Lease 已提交且未过期后，使用 `REPEATABLE READ READ ONLY` 开始。GC 只把未过期的 committed Lease 当成 Generation Root；planned、released、expired 以及单独 Cursor 都不是 Root。

正常完成、取消和超时主动 release；进程死亡依靠有界 Expiry 回收。任何不能确认 Lease 提交、续租、时钟或完整 Generation Set 的请求都 fail closed。G2-03-01 只实现状态协议 Harness；持久表、Grant、进程 Kill/Resume 和 GC Provider 在 G2-03-03 实现。

## 6. Cursor 与密钥边界

Cursor 使用服务端 AES-256-GCM 或等价的认证加密封装，Key Ring 只有一个 current encrypt key，旧 key 只保留到最长 Cursor TTL 用于 decrypt。Envelope 绑定：

- key version、issued/expiry；
- Project、Release Revision、Activation、Object/Link Revision 与 Generation Set；
- Query Hash、Policy Context Hash、Sort 和 last values。

Cursor 不携带 Bearer、Raw Claim、Policy AST/SQL 或可直接解析的业务值。篡改、过期、跨 Actor / Query / Release / Policy 复用都稳定拒绝。Cursor 不会延长 Release 支持窗或替代 Query Lease。

## 7. Runtime HTTP、OpenAPI 与 Web 决策

G2-03-01 以三个 Candidate Operation（Runtime Metadata、typed Get、Search）验证 `OpenAPI 3.1 → generated client → React consumer`。Required、Enum 和 Nullability 破坏性变化必须使 Consumer 编译失败，重新生成必须零 Diff。

| 能力              | 锁定选择                                       | 决策理由                                             |
| ----------------- | ---------------------------------------------- | ---------------------------------------------------- |
| Runtime / TS      | Node 24.18.0 + 仓内 TypeScript                 | 与 G2 工具链一致，strict 编译                        |
| UI / Build        | React 19.2.8 + Vite 8.2.1 + plugin-react 6.0.5 | 小的 SPA 边界，适配现有 npm/TS 单仓                  |
| Routing           | react-router 8.3.0                             | 对 List / Detail / Link 只读路由足够                 |
| Server state      | TanStack React Query 5.101.4                   | 明确 Loading / Error / Retry / Cache 状态            |
| Table             | TanStack Table 8.21.3                          | 稳定的 metadata-driven headless table；v9 暂不采用   |
| OIDC              | oidc-client-ts 3.5.0                           | Authorization Code + PKCE 候选；Token 不进入业务状态 |
| Client generation | `@hey-api/openapi-ts` 0.99.0                   | 可重现生成 fetch client 和 TypeScript types          |
| Browser gate      | Playwright 1.62.1                              | 后续真浏览器、可访问性和错误态 Gate                  |

生成器依赖树强制 `js-yaml=4.3.1` 以关闭已知 YAML 资源消耗漏洞。`@hey-api/openapi-ts` 0.99.0 生成的 fetch 源码暂不能在 TypeScript 6 下启用 `exactOptionalPropertyTypes`；本例外只存在于 compile-only Spike，G2-03-02/13 创建正式合同/Web 前必须重新评估。

Web 必须是通用 Metadata-driven 消费者：不按 Customer/Order 等领域字段编码，不直连 PostgreSQL，不读 Policy Detail，不复制 Authorization 逻辑。

## 8. 事务与请求边界

1. HTTP Adapter 完成大小限制、OIDC 验证与 Abort 绑定。
2. Identity Application 得到精简 RuntimeIdentity，Policy Gateway 在同一请求中解析 Epoch/Artifact。
3. 短事务解析 Serving Context 并提交 Lease；不在网络等待期间持有行锁。
4. 只读 Repeatable Read 事务执行一个有界 Query，Policy Predicate 与 Client Predicate 在同一 SQL 中。
5. Serializer 对 Property Decision 二次防御，然后主动 release Lease。

同一请求不重新解析“最新” Release、Activation、Generation 或 Policy Artifact。依赖失败、Artifact 摘要不符、Epoch 不能确认、Lease 失效或 SQL 超时均不回退 stale allow。

## 9. 范围 Gate 向前演进

历史 Evidence Manifest 继续绑定原提交和当时 Hash，不重写历史结论。当新 Gate 增加合法包、Migration 或 `apps/web`时，必须在同一 PR 中：

- 显式扩展 Foundation 聚合范围和上一业务 Gate 的 forward allowlist；
- 添加当前 Gate 自己的 baseline commit、exact paths、prefixes、forbidden paths 和 mutation guard；
- 旧 Gate 的必需记录、Migration Hash、合同 Hash 和机器 Evidence 仍要通过；
- 不能通过全局 `ignore` 或移除黑名单使下游绕过历史范围。

G2-03-01 只为 `spikes/g2-03-01/` 和 `tools/query-policy-architecture/` 建立显式前向接纳，仍禁止正式 `apps/web`、`packages/query`、`packages/policy`、`packages/identity` 和 Migration。

## 10. 可行性停止条件

任一条成立，G2-03-01 必须 FAIL，不开始 G2-03-02/03：

1. Delegation 必须信任客户端自报 Principal、Identity Type 或权限；
2. Object / Link / Count Policy 无法在 SQL 内、分页与计数前执行；
3. 通用 Query 必须按领域生成 SQL/BFF 或绕过 Current Generation；
4. Web 必须直连仓内包、手写平行 DTO 或复制 Policy；
5. Query 与 GC 不能通过先提交的有界 Lease 共存；
6. Candidate OpenAPI 破坏性改动仍能让 Consumer 编译通过；
7. PostgreSQL 16 真实计划必须对无界 `object_current` / `link_current` 顺序扫描。

## 11. 后续责任

- G2-03-02 把 Candidate 升级为严格公共合同、Golden 与可重现 Client；
- G2-03-03 从 Migration 0022 开始实现 Identity / Policy / Query Lease 事实与最小权限；
- G2-03-04～12 实现正式 Identity、Policy、Query、HTTP 和性能/泄露 Gate；
- G2-03-13 才创建真实 `apps/web`；G2-04 负责 Action；G2-05 负责完整 UI / SDK / Portability。
