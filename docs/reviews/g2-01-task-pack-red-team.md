# Red-Team：G2-01 Metadata 可执行任务包

- 日期：2026-08-14
- 审查对象：[G2-01 Metadata 可执行任务包](../delivery/g2-01-metadata-task-pack.md)
- 方法：Steelman → Fails if → 本周证据 → Kill Criterion → Cheapest Test
- 结论：**Go for G2-01-01**；五项 Required Revision 已写回任务包，仍不允许跳过 G2-01-01 直接编码 DB-01

## Top Kill-Assumptions（按影响 × 错误可能性 × 测试便宜度排序）

### 1. 零成员 Activation 能在 DB-02 原样扩展

**Claim**

G2-01 可以发布一个零 Generation Member 的真实 Activation；G2-02 只新增 Member/Generation，不需要修改 Release、Channel 或 Serving Head 身份。

**Steelman**

ADR-007 已把 Release Pin 与 Activation 分开，Activation 本身是不可变可服务状态；零成员只是合法成员集合的最小值。先证明 Release/Pointer 原子性，可以避免 G2-01 伪造 Snapshot 或空 Generation。

**Fails if**

DB-02 的第一个 Object Type Generation 无法通过创建“新的同 Release Activation”加入，而必须原地修改 G2-01 Activation、重写 Release Binding、移动历史 Serving Head 语义或让 Release Publish 等待 Materializer。

**Evidence to get this week**

在 G2-01-01 状态模型中固定执行：发布 R1/空 Activation A0；为 R1 构造 G1 Member 后创建 A1；Channel 切到 A1；显式 R1 Serving Head 按同一规则切到 A1；A0 与原 Release Pin 保持不可变。再并发一个 R2 Publish，检查锁域和期望旧 Activation。

**Kill criterion**

只要加入首个 Member 需要 UPDATE A0、改变 R1 Manifest Digest，或 Release Publish 事务需要等待 DB-02 Worker，就停止 DB-01 表设计并修订 ADR-007/任务边界。

**Cheapest test**

扩展现有 Runtime Activation 纯状态 Harness，加入 `zero-member publish → same-release data refresh → concurrent new release` 三个固定场景，不创建数据库表。

**Decision**

风险真实且便宜可测。任务包必须把该 seam proof 提升为 G2-01-01 的首个退出条件，而不是等 G2-01-08 才发现。

### 2. Package Installation 的“当前版本”能与 Release 原子一致

**Claim**

Package Install/Upgrade 可以先创建 Package Revision、Resources 和 Release Draft，随后通过 Release Publish 安全完成激活；失败不会部分替换 Package。

**Steelman**

Package 不直接拥有 Runtime Pointer，所有定义激活都经过 Release，因此使用同一 Publish 事务是最小且正确的协调点。

**Fails if**

`package_installations.current_package_revision_id` 在 Release Draft 创建时就更新，导致 API 显示新 Package 已安装，但 Channel 仍服务旧 Release；或 Publish 只切 Release Pointer，不同步 Installation Active Pointer。

**Evidence to get this week**

把 Installation 区分为不可变 Attempt/Revision 与 Active Pointer，列出 Install、Upgrade、Breaking Reject、Publish Failure、Rollback 五个时序的可见状态。证明 Active Package Revision 和 Published Release 在同一事务切换。

**Kill criterion**

如果存在任何已提交状态能让“当前 Package Revision”和 Channel Published Release 的 Pin 集合不一致，停止 Package API；不得用最终一致或后台修复掩盖。

**Cheapest test**

纯状态测试在 `Release Publish` 的每个步骤注入异常，并断言 Active Installation Pointer、Release Channel 和 Pin Manifest 三者全部旧或全部新。

**Decision**

初稿存在真实表达缺口。任务包必须明确 Pending Installation/Upgrade 不等于 Active，并把 Active Pointer 切换纳入 Release Publish 短事务。

### 3. 渐进冻结不会让未拥有资源族混入 Published Release

**Claim**

G2-01 只严格发布 Object/Property/Link；Policy、Action、View 等可以出现在 Package 预检中但不会提前冻结或发布。

**Steelman**

两层合同治理已经在 G2-00 通过；按拥有 Gate 激活 Validator 可以同时保留 Package 形状和字段冻结纪律。

**Fails if**

通用 `content jsonb` 或 Package 展开器允许未知字段/Resource Family 以 opaque 内容进入 VALIDATED/READY，后续 G2-03～05 的 Validator 发现历史 Published Revision 不合法；或 G2-01 为通过两个完整 Fixture 而偷偷冻结 Action/Policy/View 字段。

**Evidence to get this week**

用两个完整 G1 Package 做预检：Object/Link 部分生成可发布 metadata-only Projection；Action/Policy/View 均产生稳定 `CAPABILITY_NOT_ACTIVE` Issue；直接绕过 Package API 创建同类 Resource 也必须被同一 Registry 拒绝。

**Kill criterion**

任何未注册 Validator 的 Family 能进入 READY/PUBLISHED，或 metadata-only Projection 无法记录到原 Package Manifest 的 Provenance/Digest 时，停止 Package Store 实现。

**Cheapest test**

先实现只含 Registry、Parser 和两个 Fixture 的纯函数 Prototype；对每个 Resource Family 输出 `active/deferred/rejected`，不写数据库。

**Decision**

方案成立，但 Registry 必须是 Release Validate 的服务器事实来源，不能只存在于 Package Adapter。

### 4. 最小管理授权可以与 G2-03 Policy 清晰分离

**Claim**

G2-01 只需 OIDC Token 验证、Project/Resource Role Binding 和 Epoch；Object/Property/Link/Action Policy 仍可在 G2-03 统一实现，不形成第二套长期授权引擎。

**Steelman**

管理 RBAC 与业务对象 Policy 的目标和数据粒度不同。PRD 已明确 Project/Resource Authorization 是第一层，之后才是 Object/Property/Link/Action Policy。

**Fails if**

G2-01 Handler 直接读取 JWT Group 或在每个 Endpoint 手写角色判断，导致 G2-03 Gateway 无法替换；Resource Binding 能扩大 Project 权限；或测试身份 Header/内存 Allowlist 留在正式 App。

**Evidence to get this week**

定义单一 `ManagementAuthorizer` Port 和角色矩阵，HTTP 只建立 Foundation Identity；同一 Use Case 分别由 HTTP、协议 Harness 调用，允许/拒绝结果一致。验证 Epoch 不可用时 fail closed。

**Kill criterion**

若任何生产 Use Case 必须读取原始 JWT Claims，或加入 Object Policy 后必须绕过/复制 ManagementAuthorizer，停止 Admin API 并重新划分 Port。

**Cheapest test**

用测试 OIDC Token 调用一个 Project Use Case：合法 Owner 允许、Viewer 写入拒绝、撤权后两个进程五秒内拒绝、Store 不可用时拒绝。

**Decision**

边界可行。任务包需明确业务 Use Case 只接收经过验证的 Identity 与 Authorizer Decision，不接收原始 Token/Claims。

### 5. 一条实现通道能在原 2–4 工程周完成全部 Gate

**Claim**

G2-01 在一条有效通道下可于 2–4 工程周完成 Contracts、DB-01、Domain、PostgreSQL Adapter、OIDC/RBAC、HTTP、Release、Package、故障注入和 clean-room Evidence。

**Steelman**

G2-00 已完成工具链、Migration Runner、OIDC 环境、Foundation Contracts、Fixtures 和统一 CI；G2-01 不从零建立这些基础设施。

**Fails if**

首个真实薄切片需要同时新建四个 Workspace、数据库权限、HTTP/OIDC Adapter 和 Gate 演进，导致两周内仍未得到一个可发布的 Metadata Release；为维持日期而删除 Package、权限负测或故障注入。

**Evidence to get this week**

记录 G2-01-01～03 的实际完成时间和返工次数；完成“空库 → Project → Object Draft → DB 持久化”后重新估算 Release/Package/API，不用 Foundation 的瞬时产出速度外推。

**Kill criterion**

若 G2-01-01～03 超过 10 个理想工程日，或首个端到端 Release 在第 4 工程周仍未通过故障注入，则更新总日历并收窄当期承诺；不能删除 Gate。

**Cheapest test**

现在按 12 个工作项和单通道依赖重新估算，并在 G2-01-03 后用实际吞吐校准。

**Decision**

2–4 周没有足够证据。规划范围调整为 4–7 工程周；这仍不是承诺，且不得反向扩大 G2-01 范围。

## What's Well-Reasoned

以下部分经攻击后仍成立：

1. **按 Gate 渐进冻结字段**：避免把 Action/Policy/SDK 的猜测变成永久兼容负担，且已有 Foundation Catalog 与 Gate 支撑。
2. **Release 是唯一激活协调点**：Package 不直接覆盖 Resource，Rollback 产生新 Release，符合 PRD 历史不变语义。
3. **条件兼容在 G2-01 阻断**：没有 Materialization/Index 证据时不把“理论兼容”包装成 READY，是对下游风险的正确收口。
4. **真实 HTTP + OIDC + PostgreSQL 验收**：避免内部函数测试给出虚假完成感，同时仍把 Object Policy 留给 G2-03。
5. **Foundation Gate 演进而非删除**：允许 DB-01 的同时保留 G2-00 回归，避免历史证据成为一次性文档。

## What I Couldn't Assess

- 尚无 DB-01 实际 Schema/查询计划，无法判断所有索引、锁等待和表膨胀；G2-01-03 必须用真实 PostgreSQL 补证。
- 尚未选择 HTTP Framework 和连接池配置，无法评估取消、超时与 Graceful Shutdown；G2-01-10 必须记录选型和负面测试。
- 未有完整生产 OIDC Claim/Scope 约定，只能验证测试 Provider；G2-03/Security Gate 仍需重新审查生产身份映射。
- 还没有 DB-02 Generation 表，零成员 Activation 只能通过状态 Harness 和未来兼容 Migration 证明，不能宣称数据运行时已完成。

## Required revisions resolution

1. **已写回**：任务包 §3.2/3.5/3.6 与 G2-01-09 把 Package Installation 分为 Pending Change 与 Active Pointer，并规定与 Release Channel 同事务切换。
2. **已写回**：G2-01-01 增加 `R1 + zero-member A0 → R1 + first-member A1 → concurrent R2 publish` seam proof。
3. **已写回**：G2-01-02 规定 Resource Family Registry 同时约束直接 Resource API 与 Package 展开器。
4. **已写回**：任务包 §3.7、G2-01-04/10 规定 Application Use Case 不接触原始 JWT Claims，只接收已验证 Identity 与 `ManagementAuthorizer`。
5. **已写回**：任务包与 Owner/容量矩阵将单通道 G2-01 调整为 4–7 工程周，并在 G2-01-03 后强制重新估算。

五项修订均已落地，因此结论升级为 **Go for G2-01-01**。该结论只放行 ADR-013 与 seam/state proof；DB-01 业务表仍必须等待 G2-01-01 PASS。
