# G2 生产实现蓝图红队审查

- 日期：2026-08-13
- 审查对象：[G2 生产实现蓝图](../product/ontology-kernel-implementation-blueprint.md)
- 证据基线：[G1 可行性报告](../../spikes/g1/docs/g1-feasibility-report.md)、[G1 架构决策](../../spikes/g1/docs/architecture-decisions.md)
- 方法：先强化原主张，再攻击承重假设；按“错误影响 × 错误可能性 × 验证便宜程度”排序
- 结论：**Conditional Go — 允许执行 G2-00，G2-01 仍被 Gate 阻断**
- 后续状态：本结论是 2026-08-13 的历史入口审查；G2-00～02 已后续 PASS，当前放行结论见本文第 7 节

## 1. 一句话结论

“先冻结完整架构边界，再做正式纵向切片”的路线成立；真正危险的不是方向，而是把 Foundation 做成缩小版业务内核、过早冻结未经实现验证的合同，以及让 Release/Generation 保留、Handler Host 和环境权限边界拖到后续才被证伪。

本次审查授权的下一步只有 [G2-00 Foundation 任务包](../delivery/g2-00-foundation-task-pack.md)。在其退出条件全部满足前，不创建 Resource/Release Store、Materializer、Query API、Action Runtime 或产品页面。

## 2. Top Kill-Assumptions（按优先级）

评分范围为 1–5；`总分 = 影响 × 可能性 × 便宜程度`。便宜程度越高，越应该立即验证。

| 排名 | 承重假设 | 影响 | 可能性 | 便宜程度 | 总分 |
|---:|---|---:|---:|---:|---:|
| 1 | G2-00 可以一次性冻结完整 P0 合同并同时承载 DB-01 | 5 | 5 | 5 | 125 |
| 2 | Runtime Activation、90 天 Release 支持与 Generation 保留可以有界共存 | 5 | 4 | 4 | 80 |
| 3 | Trusted Handler 可用独立进程、受限 Context 和硬超时形成可靠边界 | 5 | 4 | 4 | 80 |
| 4 | 本地/CI 环境和数据库角色能真实执行而不是纸面模拟生产边界 | 5 | 3 | 5 | 75 |
| 5 | 4–6 人可以在六周形成架构集成证据 | 3 | 5 | 5 | 75 |

### 2.1 Foundation 边界与合同冻结粒度

**Claim**

先冻结完整合同能减少后续模块各自定义 DTO、错误和事务语义的漂移；同时建立 DB-00/DB-01 可以让所有模块从真实持久化合同起步。

**Steelman**

这一主张抓住了平台项目常见的失败原因：先写模块、后补合同会产生多个身份、版本、Policy 和错误模型。统一 ID、值编码、错误、Correlation、版本兼容规则确实必须先于业务实现。

**Fails if**

- 在 Materialization、Action 或 Policy 尚未实现时，G2-00 就把它们的完整字段级 Schema 宣布为稳定公共合同；
- 为证明 Foundation 完成，必须提前创建 Resource/Release Store、DB-01 业务表或 Admin Endpoint；
- 两个 Fixture Package 只能通过例外字段、领域分支或频繁破坏性改动装入合同。

蓝图原第 15 节要求 G2-00 实现 DB-00/DB-01，但第 10.1 节又把 Metadata 和 DB-01 放在 G2-01。这不是普通措辞问题，而是会直接使 Foundation 范围膨胀的冲突。

**Evidence to get this week**

- 把合同分成 `foundation-frozen` 和 `module-owned` 两层；
- 为 ID、值 Codec、Error Envelope、Correlation、Release Binding 和兼容规则建立 Golden Fixture；
- 为 Query、Snapshot、Action、Event 只登记 Owner、语义不变量和最晚冻结 Gate，不提前承诺全部字段；
- 对一个兼容增加和一个破坏性变更运行自动 Diff。

**Kill criterion**

- G2-00 需要任何 DB-01 业务表、Metadata Store 或业务 Endpoint 才能通过；
- 基础合同无法表示两个 Fixture 的核心引用而不引入领域字段；
- 兼容性工具不能稳定区分允许的增加与禁止的破坏。

**Cheapest test**

只实现五类基础 Golden Fixture 和合同 Diff Harness，再模拟一次 additive 与一次 breaking change。无需先写业务 API。

**Decision**

采用渐进冻结：G2-00 只冻结跨模块基础合同和语义不变量；模块字段合同在 G2-01 至 G2-04 的拥有 Gate 冻结。G2-00 只做 DB-00，DB-01 明确归 G2-01。

### 2.2 Runtime Activation 与保留成本

**Claim**

不可变 Activation 同时绑定 Release 和 Generation，能够避免定义/数据交叉版本；显式 Release 在支持窗内通过独立 Serving Head 继续服务。

**Steelman**

单一 Activation Pointer 比分别切换 Release 和 Snapshot 更安全，也能让一次请求固定读取一致视图。兼容 Release 复用 Generation，可以避免为每个定义版本复制数据。

**Fails if**

- 兼容性判断错误，使旧 Release 读取到与其 Mapping/Policy 不匹配的 Generation；
- 每个不兼容 Release 都需要长期维护独立 Current/Index，存储和物化成本随 Release 数量无界增长；
- 90 天 API/SDK 兼容支持被误解为保留 90 天的每个历史数据 Generation；
- GC 无法证明 Activation、在途请求、Preflight、调查 Hold 和历史 Action 引用均不再需要目标 Artifact/Generation。

**Evidence to get this week**

建立可执行状态模型，至少覆盖 R1/R2、兼容/不兼容 Mapping、S1/S2 数据刷新、Rollback 新 Release、并发 Publish/Refresh、在途 Query、Preflight Stale 和 GC。另用 G1 实测表/索引大小计算支持窗容量上界。

**Kill criterion**

- 任一状态序列能产生 `release pin ≠ generation schema/mapping`；
- GC 可以删除仍被 Serving Head、有效 Preflight 或恢复 Hold 引用的内容；
- ADR 不能给出并发服务 Release 数、Generation 数、容量审批和退休规则的明确上限。

**Cheapest test**

先写纯状态机与 property-based invariants，不建业务表；用十个固定场景和随机事件序列尝试打破引用一致性。

**Decision**

PRD 的 90 天窗口仍是产品要求，但不等于保留 90 天内的每个历史数据 Generation。ADR-007/008 必须先证明这项要求具有有界的服务数量、Generation 复用/物化、容量审批和退休规则；若证明不了，应在 G2-01 前正式修改 PRD，不能静默降低语义。

### 2.3 Trusted Handler Host 边界

**Claim**

受信 Artifact 在独立 OS 进程运行，无数据库/对象存储凭据，通过版本化 Context RPC 读取，超时后终止 Worker；因此不会绕过 Query/Policy/Action Runtime。

**Steelman**

产品没有承诺恶意多租户沙箱，独立进程加凭据隔离足以显著降低可信扩展误用风险，复杂度也低于为 P0 建容器调度平台。

**Fails if**

- Host 继承 API 的数据库、S3 或管理 Token；
- 无限循环、内存失控或失联调用无法在硬超时后终止并恢复 Pool；
- RPC 接受请求携带的任意文件路径/代码，而不是已登记 Digest；
- Apply 重跑时 Context 可以读取锁定 Read Set 之外的新对象，破坏确认范围和锁顺序。

**Evidence to get this week**

做一个最小 seam prototype：内容寻址 Fixture、版本化 RPC、受限 Query Mock、环境变量检查、正常调用、无限循环、Host kill/restart 和扩大 Read Set 拒绝。

**Kill criterion**

- Host 能观察任一 DB/S3 Secret；
- 无限循环不能在 `hard timeout + 1 秒 grace` 内被终止；
- Host 崩溃会使 API 进程退出或后续请求永久不可用；
- Runtime 无法拒绝未登记 Digest 或超出 Read Set 的读取。

**Cheapest test**

一个 Artifact、两个 RPC 方法和三个故障 Fixture 即可；不建设 Artifact Registry、Function 产品面或真实 Action Store。

**Decision**

把 Handler Host seam proof 前移到 G2-00。它只是信任边界验证，不是提前实现 Function/Action Runtime。

### 2.4 生产等价环境与数据库权限

**Claim**

Docker 化的 PostgreSQL、S3-compatible Storage、外部于 Kernel 的 OIDC Provider 和 OTEL，加上分离数据库角色，可以让后续每个 Gate 都在真实边界上验证。

**Steelman**

这能避免内存 Repository、假身份和管理员数据库连接把错误推迟到上线前；依赖均可在单机/CI 内运行，不需要先建设 Kubernetes。

**Fails if**

- clean checkout 需要人工填入共享 Secret 或依赖某个开发者已登录的 SaaS；
- CI 只跑单元测试，真实 PostgreSQL/OIDC/S3 集成测试被标记为可选；
- API/Worker 使用 owner/superuser，或默认权限让未来 Fact/Audit 表可更新；
- Apple Silicon 与 CI amd64 使用不同、不兼容的依赖镜像。

**Evidence to get this week**

- 在 clean state 启动完整依赖、获取测试身份、读写临时 Object、验证 DB 角色并发出一条 Trace；
- 在 arm64 本地和 amd64 CI 运行同一 smoke suite；
- 运行角色负面测试，而不只测试“能连接”。

**Kill criterion**

- bootstrap 依赖人工生产凭据或宿主机隐藏状态；
- 任一 Runtime 角色可以创建 Schema、取得 Superuser 或越权修改测试用 append-only 表；
- Handler 环境中出现 DB/S3 Credential；
- Gate 测试必须退化到 SQLite/内存实现才能稳定通过。

**Cheapest test**

先建基础 Compose 与四个 smoke probes，不运行任何业务 Endpoint。

**Decision**

本地环境不是“开发便利项”，而是 G2-00 的验收产物。无法复现则 Foundation 不通过。

### 2.5 六周日历与团队并行度

**Claim**

4–6 人可以在六周依次集成 Metadata、Materialization、Query/Policy、Action 和两 Package 纵向链路。

**Steelman**

蓝图已经承认里程碑可重叠、六周只产生架构集成证据，不冒充内部可用产品；在明确 Owner 且有人专职 Runtime、Data、Web/SDK 和 Platform 的情况下并非不可能。

**Fails if**

- 实际只有一至两条有效工程并行线；
- 同一人同时承担设计、实现以及安全/恢复 Gate 的唯一审查；
- G2-02 至 G2-05 由于合同和数据库依赖完全串行；
- 日历被当作承诺，团队通过跳过恢复、Policy 或故障注入来追赶。

**Evidence to get this week**

记录真实 Owner、每周可用容量、第二审查人和关键路径；用完成后的 G2-00 实际吞吐重新估算 G2-01 至 G2-05。

**Kill criterion**

少于四条有效并行责任线，或关键安全/恢复 Gate 没有第二视角时，撤销“六周”日历承诺。撤销时间承诺不等于停止项目，Gate 和范围保持不变。

**Cheapest test**

完成一次 Owner/容量矩阵和依赖排程，不需要写代码。

**Decision**

六周只保留为 4–6 人团队情景值；在 G2-00 退出前不对当前项目设置固定日历日期。

## 3. What’s Well-Reasoned

以下主张经攻击后仍成立：

- **模块化单体优先。** 当前风险在事务、Policy 和投影语义，提前拆微服务只会增加分布式一致性问题。
- **Base/Overlay 是事实，Current 是投影。** G1 已覆盖关键冲突、删除、恢复和 Cutover；其证据边界也写得诚实。
- **Policy Gateway 是唯一入口。** Link Policy fail-closed、Property 双重防御和 Delegation 交集有可执行证据，不是页面级权限描述。
- **生产纵向切片不是 Demo。** 蓝图明确要求真实依赖、持久状态、故障恢复、两 Package 和性能回归，避免用 Happy Path 冒充平台成立。
- **P0/P1/P2 总体收敛。** Data Pipeline、Automation、AI、Marketplace、多租户和多区域被排除，没有偷偷进入 Kernel Gate。
- **停止条件有意义。** 第二领域污染核心、Policy 旁路、Overlay 丢失和 Action 非原子都被定义为平台论点失败，而不是可稍后修复的小缺陷。

## 4. 本次审查要求修改的蓝图

1. G2-00 只包含 DB-00；DB-01 Metadata 明确属于 G2-01。
2. 合同采用渐进冻结；G2-00 冻结跨模块基础语义，模块字段在拥有 Gate 冻结。
3. PRD 的 90 天 API/SDK 支持要求不自动等于历史 Generation 保留；ADR-007/008 必须证明有界规则，否则在 G2-01 前正式变更 PRD。
4. Handler Host seam proof 前移到 G2-00，但不提前实现 Function/Action 产品能力。
5. 六周只作为 4–6 人情景值；实际日历由 Owner/容量矩阵和 G2-00 实际吞吐重算。
6. 正式仓库名使用 `ontos`，不再把独立 `ontology-kernel` 仓库写成前提。

## 5. G2-00 → G2-01 放行条件

只有以下证据同时存在，才允许开始 Resource/Release Store：

- ADR-007 至 ADR-012 已接受，并有对应状态模型、容量模型或 seam test；
- Foundation Contract Golden、兼容性 Diff 和禁止未知写字段测试通过；
- DB-00 可从空库前向部署，数据库角色负面权限测试通过；
- 本地与 CI 的 PostgreSQL/OIDC/S3/OTEL smoke suite 通过；
- G1 Fixture/向量已进入独立 `testkit`，生产包不导入 `spikes/g1`；
- CI 强制 Contract、架构依赖、真实 PostgreSQL Integration 和秘密扫描；
- clean checkout 可以重复 bootstrap，证据记录 Commit、环境和 Artifact Digest；
- Owner/容量矩阵存在；若并行度不足，日历已经重算。

任一项缺失时，允许继续修 Foundation，不允许以“先写一点 Metadata”绕过 Gate。

## 6. What I Couldn’t Assess

- 当前实际团队人数、每周投入和独立审查人；
- 目标验收环境的 CPU、内存、磁盘/WAL 和对象存储容量预算；
- 最终采用的 OIDC、S3-compatible Storage 和 Artifact Registry 产品；
- 真实 Operator/Builder 对生成式页面的可用性；
- 法务或业务对 Audit、Artifact 和 Action 历史的保留要求。

这些信息不阻止 G2-00，但分别阻止六周日期承诺、容量承诺、供应链锁定、Usable Alpha 和最终保留策略。

## 7. 2026-08-17 后续顺序审查附注

本附注不改写 2026-08-13 对 G2-00 入口的历史结论。G2-00、G2-01 和 G2-02 现已 PASS；原四条并行责任线/六周情景已按实际单通道撤销，现行容量以 [G2 Owner 与容量矩阵](../delivery/g2-owner-capacity-matrix.md) 为准。

为避免到 G2-05 才首次发现前后端合同、受限属性、Cursor/错误恢复和 N+1 问题，实施顺序调整为：G2-03 使用 Public Runtime HTTP 和仓内 Generated Client 交付真实只读 Web 消费者；G2-04 在同一壳上扩展 Action；G2-05 仍负责完整 UI、Object View/Application Config、Function、可发布 SDK 和双 Package 完整闭环。该调整只改变风险验证顺序，不扩大 PRD 范围。

该方案不由本篇历史红队单独放行，而由 [G2-03 任务包](../delivery/g2-03-query-policy-task-pack.md)、[UI/API 早期消费者合同](../architecture/g2-03-ui-api-consumer-contract.md)、[可行性复审](g2-03-task-pack-feasibility.md)和 [G2-03 专项红队](g2-03-task-pack-red-team.md) 共同约束。当前结论为 **Go for G2-03-01 only**；未 PASS 前不准直接建正式 Query Endpoint、G2-03 事实表或产品页。
