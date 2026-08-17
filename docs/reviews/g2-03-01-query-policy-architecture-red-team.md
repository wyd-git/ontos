# G2-03-01 Query / Policy 架构红队审查

- 日期：2026-08-18
- 方法：先钢人化架构主张，再按影响 × 可能性 × 最低验证成本攻击承重假设
- 结论：**PASS**
- 边界：只证明 G2-03-01 的架构可行性；不代表正式 Identity、Policy、Query API、Web 或生产安全已完成

## 1. 最强可辩护主张

G2-02 已提供可原子切换的 Current Projection 和真实 100k Object / 1m Link 数据。如果 G2-03 在编码前先冻结身份信任链、Policy-in-SQL、Execution Context/Lease、OpenAPI 生成与 Web 依赖方向，那么后续可以在不重写数据层或前端合同的情况下逐步实现 Get/Search/Count/Link。

这个主张最强的支持是：通用 Compiler 已对当前 Shared Projection 生成全参数化 SQL；真 PostgreSQL Gate 会在 G2-02 clean-room 的当前 Generation 上执行四类读并保留 Explain；最小 OpenAPI 已能生成客户端并驱动无领域分支的 React Consumer；Identity/Delegation 不需信任客户自报属性。

## 2. Top Kill Assumptions

### 2.1 “受信委托”可能只是换名的客户端 Header

- **Steelman：** Token Exchange 使用已验签 actor/subject 和服务器 Principal 事实，应可以表达 service-on-behalf-of-user。
- **Fails if：** `principalId`、type、effective user 或 delegation chain 有任一字段能从普通 Header/Body 进入，或不验证 audience/PoP/replay。
- **当前证据：** `trust-boundary.ts` 拒绝四类客户端身份断言，要求 server Principal、短 TTL、PoP、replay port、service allowlist 和权限交集；wrong issuer/audience/expiry/disabled 有负测。
- **Kill 结果：CLOSED for architecture。** 生产 Token Exchange/JWT 仍由 03-03/04 验证。
- **最便宜下一步：** 真 OIDC 集成中注入同名 Header，确认在 Policy/SQL 前拒绝。

### 2.2 Service 委托可能把两方权限做成并集

- **Steelman：** Service 需要自身 Capability 和终端用户权限才能工作。
- **Fails if：** 计算使用 union、service-only allow，或忽略委托链中任一 Principal。
- **当前证据：** 类型固定 `permissionMode: "intersection"`，服务扩权向量失败，未登记 Service Capability 失败。
- **Kill 结果：CLOSED for architecture。**
- **最便宜下一步：** 03-04 用 human/service/delegated 三组真 Token 跑同一 Policy Corpus。

### 2.3 Policy 可能只在列表后过滤，Count 仍泄露

- **Steelman：** Policy IR 和 Query AST 有单一 Compiler，理论上可合并为一条 SQL。
- **Fails if：** row predicate 位于 `LIMIT` 之后、Count 另走无 Policy SQL，或 Link 先返回边再在应用层删目标。
- **当前证据：** Compiler 对 Get/List/Count/one-hop 都生成同一 WHERE 阶段的 Policy Predicate；单测故意把 Policy 放到 Limit 后会失败；真 PG Gate 执行四条 SQL。
- **Kill 结果：CLOSED for Spike。** 正式 Compiler/Executor 由 03-07/09/10 关闭。
- **最便宜下一步：** 增加移除 Count Predicate 和 Target Predicate 的 mutation gate。

### 2.4 “通用 Query”可能暗中依赖 Commerce Fixture

- **Steelman：** 类型、Property、Link 和 Generation 都通过 Metadata/Serving Context 传入。
- **Fails if：** Compiler 或 Web 出现 Customer/Order/Worker/WorkItem 分支，或为某 Link 手写 SQL/BFF。
- **当前证据：** 证据 Gate 扫描通用源码中的 Fixture API Name；Compiler 输入只是 member key/capability；Web 仅使用 Metadata 字段。Fixture 名只出现在 clean-room 调用数据中。
- **Kill 结果：CLOSED。**
- **最便宜下一步：** 03-02 Golden 加入 Work Management，使同一 Client/Compiler 跑两领域。

### 2.5 Query 可能绕过 Serving Head 读 Base 或“最新代”

- **Steelman：** G2-02 已提供 Release Serving Head、Runtime Plan 和 Current Generation。
- **Fails if：** SQL 用 `max(generation)`、直读 Base，或同一请求分别解析不同 Activation/Generation。
- **当前证据：** PG Spike 在一个 read-only Repeatable Read 内通过 `release_serving_heads` + `runtime_activation_members` 一次解析三个 Member；每条 SQL 绑定精确 Revision/Generation/Lifecycle。
- **Kill 结果：CLOSED for Spike。**
- **最便宜下一步：** 03-08 在 Get 中并发 Cutover/Retire，只允许完整旧 Context 或明确失败。

### 2.6 Query Lease 可能与 GC 存在窗口，或被 Cursor 无限续命

- **Steelman：** 业务读前提交 Lease，GC 把它作为 Generation Root。
- **Fails if：** 读在 Lease commit 前开始，planned/released/expired Lease 仍保护，Cursor 自身成为 Root，或进程死亡永不过期。
- **当前证据：** Lease Harness 要求 committed+unexpired 后才返回 read permission；`generationRootsFromLeases` 忽略其他状态和 Cursor；Context 一次绑定全部 Generation。
- **Kill 结果：CLOSED for protocol，OPEN implementation risk。** 已登记到 03-03，不影响架构 PASS。
- **最便宜下一步：** 03-03 持久 Lease 后在 commit/read/GC 边界杀进程。

### 2.7 参数化 SQL 可能仍允许 Identifier/Operator 注入

- **Steelman：** 所有用户值都是 `$n` 参数。
- **Fails if：** Property API Name、JSON path、Sort direction 或 Operator 可从原始字符串拼入 SQL。
- **当前证据：** PropertyCapability 和 Operator 是服务端类型白名单，Property 访问使用参数化 JSON key；Injection 载荷只出现在 values。
- **Kill 结果：CLOSED for current operators。**
- **最便宜下一步：** 03-07 为每个 AST Operator 添加 SQL 形状 Golden 和未知值负测。

### 2.8 OpenAPI 生成可能只是摆设，Web 仍使用手写 DTO

- **Steelman：** 生成客户端可以把后端漂移转换为编译错误。
- **Fails if：** Consumer 导入手写 interface，重生成有 Diff 仍通过，或 required/enum/nullability 破坏后仍编译。
- **当前证据：** Web Spike 从 Candidate 生成 16 个文件，原始字节比较证明重生成零 Diff；Consumer 只导入 generated client；三个 mutation 都使 witness 编译失败；生产 Vite build 通过。
- **Kill 结果：CLOSED for Candidate。**
- **最便宜下一步：** 03-02 将 Query/Cursor/Policy 完整合同加入生成与兼容基线。

### 2.9 Web 可能不得不直连内部包或领域 BFF

- **Steelman：** Metadata-driven List/Detail 只需公开 Runtime Read 响应。
- **Fails if：** Web 需要 `@ontos/*`、SQL、Policy AST，或 Customer/Order 特例才能编译/构建。
- **当前证据：** Consumer 只包含通用 ObjectTypeMetadata/RuntimeObject；静态边界扫描要求 internal import=0、domain-specific field=0；TypeScript 与 Vite 构建均 PASS。
- **Kill 结果：CLOSED for compile-only consumer。**
- **最便宜下一步：** 03-13 用真 HTTP/OIDC 完成 List/Detail/Link 浏览器 Gate，保留依赖扫描。

### 2.10 “使用索引”可能只是小数据偶然计划

- **Steelman：** G2-02 clean-room 已有 100k/1m 和 Published Index Plan，可直接用真分布检验。
- **Fails if：** 在空表/小样本 Explain，关闭 Seq Scan，只保留文本 `EXPLAIN`，或不运行真结果。
- **当前证据：** PG Spike 接入现有 clean-room 的完整 100k/1m 产物，先执行结果断言，再执行 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`，拒绝 Current 表 Seq Scan 且要求实际 Index Name。
- **Kill 结果：由远程 full Gate 最终判定。** 代码已接线，PR 不在机器 Artifact PASS 前合并。
- **最便宜下一步：** 在当前 PR Head 运行统一 35 Gate 并下载 Explain Artifact。

### 2.11 Policy Artifact 替换或撤权可能与 Query Context 漂移

- **Steelman：** Execution Context 绑定 Artifact Digest/Compiler Version/Epoch，同一请求不重新读“最新”。
- **Fails if：** Artifact Loader 按 Resource 取 latest，Epoch 和 Binding 不同事务，或缓存依赖错误时继续 stale allow。
- **当前证据：** ADR 要求精确 Release/Revision/Digest/Compiler 绑定和 fail closed；Lease Context 包含 auth epoch / policy digest；ADR-012 已验证 5 秒有界缓存语义。
- **Kill 结果：CLOSED for boundary，OPEN integration risk。** 由 03-05/06 真 Artifact/PG 关闭。
- **最便宜下一步：** 同事务替换 Policy + Epoch，在两 API 进程证明最迟 5 秒拒绝。

### 2.12 新 Gate 可能通过放宽历史范围规则偷渡下游

- **Steelman：** 每个 Gate 需向前接纳新路径，否则无法演进。
- **Fails if：** 全局忽略 `apps/`/Migration，删除旧黑名单，或重写旧 Manifest/Hash 使其看起来从未受限。
- **当前证据：** Foundation 只忽略当前 Spike；G2-02 只添加两个精确 Prefix 和当前记录；G2-03-01 自己仍禁止 `apps/web`、Migration 和正式 identity/policy/query/sdk 包。
- **Kill 结果：CLOSED。**
- **最便宜下一步：** 每个下游 Gate 继续做 changed-path mutation，不允许 wildcard 豁免。

## 3. 风险排序

分数 1～5；“便宜度”越高表示越容易用廉价实验打假。排序优先看影响 × 可能性，再看便宜度。

| 排名 | 承重风险                            | 影响 | 可能性（验证前） | 便宜度 | 本 Gate 结果                           |
| ---: | ----------------------------------- | ---: | ---------------: | -----: | -------------------------------------- |
|    1 | Policy 后过滤 / Count 泄露          |    5 |                4 |      5 | Compiler + 四类 PG 语句                |
|    2 | 委托信任客户自报                    |    5 |                4 |      5 | Header 拒绝 + 受信链 Harness           |
|    3 | Service 权限并集扩大                |    5 |                3 |      5 | intersection 与扩权负测                |
|    4 | Lease/GC 窗口删除在途代             |    5 |                3 |      3 | 协议关闭；真 Kill 保留到 03-03         |
|    5 | Artifact/Epoch 漂移继续 stale allow |    5 |                3 |      3 | 精确 Context 冻结；集成保留到 03-05/06 |
|    6 | 领域 SQL/BFF 伪通用                 |    4 |                4 |      5 | 源码扫描 + 通用 Compiler               |
|    7 | Web 直连内部包                      |    4 |                4 |      5 | 生成 Client-only 边界                  |
|    8 | OpenAPI 漂移不破坏编译              |    4 |                3 |      5 | 3 类 Mutation 均被拒绝                 |
|    9 | Current 代绕过/混合                 |    5 |                2 |      4 | Serving Context resolve once           |
|   10 | 小数据索引假阳性                    |    4 |                3 |      3 | 等待远程 100k/1m Explain 最终判定      |
|   11 | Identifier/Operator 注入            |    5 |                2 |      5 | 服务端白名单 + 参数向量                |
|   12 | 历史 Scope Gate 被放空              |    4 |                3 |      5 | 精确 forward allowlist + 当前黑名单    |

## 4. 决策

四个产品级 Kill Criterion（客户端自报委托、Policy 后过滤、领域 SQL/BFF、Web 直连内部包）均未触发。Query Lease 持久化、生产 Identity 验证和密码 Cursor 是已登记的下游实现风险，不被写成已完成。

本审查同意 G2-03-01 在同一 PR Head 的远程 35 Gate，尤其是真 PostgreSQL 16 100k/1m Explain Artifact，全部 PASS 后关闭，然后只放行 G2-03-02。
