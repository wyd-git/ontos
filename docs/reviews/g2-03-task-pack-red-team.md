# Red-Team：G2-03 Query + Policy 可执行任务包

- 日期：2026-08-17
- 审查对象：[G2-03 Query + Policy 可执行任务包](../delivery/g2-03-query-policy-task-pack.md)
- 配套评审：[可行性复审](g2-03-task-pack-feasibility.md)、[UI/API 消费者合同](../architecture/g2-03-ui-api-consumer-contract.md)
- 方法：Claim → Steelman → Fails if → Evidence to get first → Kill criterion → Cheapest test
- 结论：**Go for G2-03-01 only**；不允许跳过 ADR/Spike 直接建 Migration、Query Endpoint 或 Web 产品页

## 1. 排序方法

评分范围 1–5；`Total = Impact × Likelihood × Cheapness`。Cheapness 越高表示越应当在第一个工作项中验证，而不是越不重要。

| Rank | 承重假设                                                                     | Impact | Likelihood | Cheapness | Total |
| ---: | ---------------------------------------------------------------------------- | -----: | ---------: | --------: | ----: |
|    1 | Human/Service/Delegation 能从真 OIDC 构建受信交集，不信客户端自报            |      5 |          4 |         5 |   100 |
|    2 | Object/Property/Link Policy 能在 SQL 前统一执行且不破坏正式 G2 计划          |      5 |          5 |         4 |   100 |
|    3 | Query Execution Context/Lease/Cursor 能与 Cutover/GC/Revocation 并发且不混代 |      5 |          4 |         4 |    80 |
|    4 | OpenAPI Candidate + Generated Client + 真 Web 能真正前移对接风险             |      4 |          4 |         5 |    80 |
|    5 | 15 个顺序项可在规划容量内完成而不删 Gate                                     |      3 |          5 |         5 |    75 |
|    6 | 只读 Web 壳可通用又不偷渡 G2-04/05 范围                                      |      4 |          4 |         4 |    64 |

## 2. Top Kill-Assumptions

### 2.1 Runtime Identity/Delegation 不需要信任客户端自报上下文

**Claim**

Kernel 可以从真实 OIDC Token、Kernel Principal/Claim Mapping 和受信 Delegation 证明构建 Human/Service/On-behalf-of Identity Context，最终权限是整条链交集。

**Steelman**

现有 OIDC Adapter 已验证 Issuer、Audience、Algorithm、Scope 和时间，并且 Foundation Contract 已冻结 `human|service`、有界 Delegation Chain 和 `authorizationMode=intersection`。`authz.principals`/Binding/Epoch 也已有真 PostgreSQL 事务。因此不是从零建身份系统。

**Fails if**

- Service/Human Type 来自 Token 中可自由提交的 Claim 或普通 HTTP Header；
- Delegation 只是 `X-On-Behalf-Of: principal-id`，没有受信签发、Audience、Expiry、Nonce/重放或允许的 Service Capability；
- Raw Claims Map 直接进入 Policy，不经版本化白名单 Mapping；
- Service 在交集失败时回退自身权限；
- Browser 需要 Service Credential 才能调 Runtime。

**Evidence to get first**

G2-03-01 先形成 Threat Model 和两条最小协议：Human OIDC 解析与 Service→Human Delegation。用伪造 Header/Claim/Type、错 Audience、过期、重放、未授权 Service 和链中 Deny 攻击，验证只有服务端构建的 Context 能进入 Policy Port。

**Kill criterion**

任一实用方案需要信任普通客户端自报 Principal/Identity Type/Claim/Delegation，或无法防止 Service 权限扩大，就停止 G2-03-02/03。

**Cheapest test**

ADR 级威胁矩阵 + 一个最小签名 Delegation/Token Exchange 验证器 + 一个交集决策 Port；不需要 Query Endpoint。

**Decision**

这是最高优先级安全假设。任务包已将它从“OIDC 已有”拆成 01/03/04 的独立产物和停止条件，未证实前不允许建公共 Query Endpoint。

### 2.2 Policy 可以在数据库读取前统一执行且不破坏查询计划

**Claim**

Resource/Object/Property/Link Policy 可编译为有界 IR，Object Predicate 与 Client Predicate 在同一参数化 SQL 中、在 Count/Sort/Limit 前执行，同时继续使用 G2-02 Published Index Plan。

**Steelman**

G1 已在 100k Objects/1m Links 原型上证明有限 AST、Row Predicate、Property Mask/Deny、Link Policy 和类型索引的方向。G2-02 已把 Current Projection、Object/Link Revision、Generation 和正式 Index Plan 落库；ADR-012 也禁止 Artifact 版本回退。

**Fails if**

- Policy Author 能提交 Raw SQL/Identifier/任意 Function；
- Policy Predicate 只能读全量 Object 后在 Node/Web 过滤；
- Count/Link/Search 各自写不同 Policy SQL，结果漂移；
- mask/deny Property 仍可用于 Filter/Sort/Search/Count 探测；
- 真 G2 Schema 只有领域专用 SQL、移除 Policy 或未约束 Seq Scan 才能达到性能目标。

**Evidence to get first**

G2-03-01 在当前正式 G2 PostgreSQL 表上执行 typed Get、Object Predicate + List、Policy-aware Count 和一跳 Link，保留 SQL Shape/参数/Explain/Buffer。同时对取 Policy Resolver、将 Predicate 放 Limit 后、放开 deny Property Filter 做 Mutation Test。

**Kill criterion**

如果一个安全方案必须应用层后过滤、领域 SQL/BFF、默认 Link Allow、不受控 Seq Scan 或删除已冻结查询约束，就停止 Contracts/Migration。

**Cheapest test**

四个真 PostgreSQL 16 查询 + 三个故意 Policy Bypass Mutation，不需要完整 HTTP/UI。

**Decision**

方向有强上游证据，但正式 Schema 尚未证明。任务包已将 Explain 前移到 01、10k/100k 前移到 09，不等 14 才第一次实测。

### 2.3 一次 Query 可在 Cutover、GC 和 Policy Change 中保持单一 Execution Context

**Claim**

请求开始可以一次解析 Release/Activation/Generation/Policy/Authorization Snapshot，用 Query Lease 保护该 Generation；Cursor 只绑定下一页上下文，不会把旧 Allow 或 Generation 无界保留。

**Steelman**

G2-02 已有不可变 Activation/Head Set、O(1) Pointer CAS、历史 Serving Head、GC Root Provider Registry 和 fail-closed mark-plan-commit。任务包只需增加新 Root Provider/Lease，不需要重做 Cutover/GC。

**Fails if**

- Query 每次 Repository 调用重新读 Channel/Activation；
- Policy Change 中途让同一请求混用旧 Row Predicate 和新 Property Mask；
- GC 可在活跃 Query 时删除 Generation/Index，或 Provider 缺失被解释为空 Root；
- Query Lease 因 API Kill 永久保留，导致 GC 无界失效；
- Cursor 成为长期数据快照租约，或在 Policy Context 变化后继续翻页。

**Evidence to get first**

G2-03-03/08 用一个真实 Activation + Query Lease 运行中并发 Cutover、Policy Epoch Change、GC Plan/Commit 和 API Kill。检查结果完整旧/明确失败、GC 候选为空、孤儿 Lease 到期。

**Kill criterion**

任一序列产生交叉 Release/Generation/Policy，或 GC 删除活跃 Query 引用，停止 Search/Link。若 Lease 只能无界保留，先重做生命周期而不禁用 GC。

**Cheapest test**

一个延迟 Get + 一次 Pointer Cutover + 一次 GC Dry-run/Commit + 一次进程 Kill，不需要 100k/1m。

**Decision**

任务包已增加 Query Lease/GC Provider 为 03-03/08 必选项，并明确 Cursor 不是长期 Root。这是可行的只向前扩展，但在真并发证据前不是已关闭风险。

### 2.4 渐进 OpenAPI + Generated Client + Web 能在不过早冻结外部 SDK 的前提下防返工

**Claim**

G2-03 可以将 Runtime Read OpenAPI 作为 Candidate，生成仓内 Client 并被真实 Web 消费；这能捕获 DTO/错误/分页/权限接缝，又不提前承担 G2-05 的完整 SDK 支持面。

**Steelman**

PRD 和蓝图已冻结 Runtime 路径、Release Binding、Error Envelope 和“Web/SDK 使用公共 API”。当前合同治理已有 JSON Schema/Parser/Golden/Baseline/Diff 模式，可以延伸到 OpenAPI。将稳定级别标记为 Candidate 可保留 G2-05 的发布窗口。

**Fails if**

- OpenAPI、Runtime Parser 和 TypeScript Type 由三份手写字段源维护；
- Web 为了方便另写 DTO/BFF，生成 Client 只是摆设；
- Candidate 被误宣称为已发布 SDK/90 天支持，导致未验证字段不能修正；
- 只有 Mock Server 消费，真 HTTP/OIDC/Error/Abort 语义不在 Gate；
- 每次小变更都需要人工复制生成文件或手改页面。

**Evidence to get first**

G2-03-01 用最小 OpenAPI Fixture 生成 Client 并在候选 Web 栈编译；故意删除 Required/改 Enum/改 Nullability，确认 Spec→Client→Consumer 链同时失败。

**Kill criterion**

如果仓内只能长期维护平行 DTO，或真实 Web 必须绕过 Public Runtime API，停止 02/12，先修单一字段源和 Application Port。

**Cheapest test**

一个 3-endpoint 候选 Spec、一次 Client Generation、一个编译消费者和三个故意 Breaking Diff。

**Decision**

这是前移 UI 后的核心防返工机制。任务包已区分“正式 Query/Policy 语义”与“Runtime Read OpenAPI Candidate”，并要求 G2-05 再冻结可发布 SDK；方向成立。

### 2.5 11–18 周是与工作分解相容的容量，不会被当作压缩 Gate 的日期承诺

**Claim**

15 个顺序工作项在一条工程通道下需要 55–90 理想工程日，即 11–18 工程周；真实薄切片可以下调剩余区间，但不能先假定自动化会消除风险。

**Steelman**

仓库已有成熟的 Contract/Migration/Testkit/CI/Clean-room 模式，会明显加速常规搭建。G1/G2-00～02 又已关闭数据模型、索引、物化、OIDC 验签和环境底座，所以无需把 G2-03 当新项目重做。

**Fails if**

- 容量仍保留旧 3–4 周，但工作项定义自己就至少需要 55 理想工程日；
- 为赶日期删除 Delegation、Query Lease、浏览器、100k/1m、30 分钟或 clean-room Gate；
- 将 Codex 墙钟时间等同于独立工程通道数；
- 同时开始 03-03/07/13，用未冻结合同制造多条返工线。

**Evidence to get first**

保留每个任务的 M/L 和实际返工日志；03-03 后用 Schema/Identity 实测、03-09 后用 10k/100k 性能实测分别重估。

**Kill criterion**

如果任务只能通过删除安全/恢复/性能/真实消费者 Gate 才维持日期，撤销日期，不撤销 Gate。

**Cheapest test**

现在就将 5 个 L + 10 个 M 与单通道相加；不等开工后才发现矛盾。

**Decision**

旧 3–4 周已被驳回。可行性复审与任务包已改为 11–18 周，Owner/Capacity 矩阵与机器策略也已在本规划中同步更新。

### 2.6 只读 Web 消费者可以在不偷渡完整 UI 的前提下证明接缝

**Claim**

G2-03 只用已发布 Object/Link Metadata 生成 Login/Navigation/List/Detail/Link，可以验证真实 API 消费，同时不激活 Object View、Action、Builder、Function 或可发布 SDK。

**Steelman**

Object Type 已有 Title Property、Default Search/Sort、Display Metadata 和 Property Query Capability；Link Type 已有端点/Display/Cardinality。这些信息足以生成最小 List/Detail/Link。将 Link 懒加载、不显示总 Count，可以守住请求预算。

**Fails if**

- 页面为了可用提前创建私有 View Schema/Object View Family；
- 为 WorkItem/Order 等 Fixture 写条件组件或页面 Endpoint；
- List 每行 Get，Detail 预加载每个 Link，形成 N+1；
- 前端用 null/缺字段猜测 mask/deny，或用 CSS 隐藏已返回敏感值；
- 只用 Mock 通过，没有真 OIDC/HTTP/PostgreSQL 浏览器流程；
- 只读壳被文档包装成完整 Object Explorer/Internal Alpha。

**Evidence to get first**

G2-03-01 用最小 Metadata/OpenAPI Fixture 验证候选栈能生成一个不知道领域字段的表格/Detail 类型；03-13 再用 Work Management/Commerce 真数据、请求计数和浏览器断言关闭。

**Kill criterion**

如果基础 List/Detail/Link 只能通过领域分支、私有 BFF/View Schema、前端 Policy 或 N+1 实现，停止 13，先修 Public Metadata/Runtime API；不把这些旁路当进度。

**Cheapest test**

两个结构不同的 Metadata Fixture + 一个生成 Client + 页面 Request Counter；不需要视觉产品化。

**Decision**

前移消费者是正确的，但必须保持“真实只读验收壳”身份。任务包和独立消费者合同已冻结能力白名单、请求预算、页面状态和 G2-04/05 责任分界。

## 3. What’s Well-Reasoned

以下部分经攻击后仍成立：

1. **复用 Current Projection 与 Published Index Plan**：Query 不直连数据源、不动态合并 Base，不为领域建表。
2. **Policy Gateway 是唯一入口**：行 Predicate 进 SQL，Property 编译/序列化双重防御，Link 同时检查边和端点。
3. **先 Get/Search/Count/1–2 hop，不塞满 P0 Read**：非 count Aggregate、Saved Set 和 Function 不是证明核心读路径的必要条件。
4. **渐进合同冻结**：Query/Policy 语义在 G2-03 正式治理，OpenAPI Read 由真实消费者验证，完整 SDK 发布仍等 G2-05。
5. **不提前激活 Object View**：只读壳使用已有 Metadata，避免将 UI 接缝测试扩成 Builder 产品。
6. **真实边界分层声明**：真 HTTP/Web 与 Function/Action/Adapter Harness 明确分开，不用模拟入口宣称后续 Gate 完成。

## 4. What I Couldn’t Assess Yet

- 尚无 ADR-020/Policy IR 候选实现，无法确认一跳 Link Exists Policy 在 G2 正式表上的 SQL Shape；
- 尚无 Service/Delegation 真实部署协议，无法在文档审查中确认最终 Signer/Token Exchange 方式；
- 尚无 Query Lease Schema，无法评估在长查询、API Kill 和时钟异常下的最终 Lease 费用；
- 尚无前端/OpenAPI 工具链候选依赖，无法确认生成 Diff、Bundle、OIDC 和浏览器测试的具体成本；
- 11–18 周是风险容量而不是交付日期；只有 03-03/09 的真实工作量与性能数据能缩小剩余区间。

## 5. Required Revisions Resolution

1. **已写回**：G2-03-01 同时执行 Identity/Delegation Threat Model、真 PostgreSQL Policy/Query Explain、OpenAPI Generated Client Compile 和 Web 栈选型；任一失败阻断 02/03。
2. **已写回**：Policy 在 Release 中作为不可变 Resource/Artifact/Test 发布，不将 SQL 或客户端“已授权”布尔值作为事实。
3. **已写回**：Query Lease/GC Provider 进入 03-03/08，Cutover/Policy/GC 并发进入 08/14，Cursor 明确不是长期 GC Root。
4. **已写回**：Runtime Read OpenAPI 是 Candidate + 仓内 Generated Client；真 Web 必须消费，完整可发布 SDK 仍归 G2-05。
5. **已写回**：Web 只实现 Login/Object Navigation/List/Detail/懒加载一跳 Link，不激活 Object View/Action/Builder，并用请求预算和两 Fixture 禁止 N+1/领域分支。
6. **已写回**：单通道规划从旧 3–4 周改为 11–18 周（55–90 理想工程日），并在 03-03/09 强制重估。
7. **已写回**：生产蓝图、Owner/Capacity 矩阵、证据策略、README/文档索引和 G2-02 历史下一步声明已反映“G2-03 只读消费者前移、G2-05 仍保留完整 UI/SDK”。

七项修订已进入任务包、消费者合同与权威计划文档，结论为 **Go for G2-03-01 only**。它只批准 ADR-020、五个承重接缝 Spike 和对应 Evidence；不批准并行建 Query Endpoint、正式 Migration 或 Web 产品页。
