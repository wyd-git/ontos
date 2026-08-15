# G2 Owner、容量与顺序矩阵

- 状态：Active for G2-02 planning
- Accountable Owner：`wyd-git`
- 实际有效并行度：1 条工程通道
- 实现支持：Codex，在 Repository Owner 的范围与合并批准下工作

## 1. 实际责任覆盖

| 责任域                                | Accountable Owner | 当前执行方式                  | 第二视角                                          |
| ------------------------------------- | ----------------- | ----------------------------- | ------------------------------------------------- |
| 产品范围、架构、仓库与发布批准        | `wyd-git`         | Repository Owner + Codex 支持 | 每个 Gate 的独立验收/红队记录                     |
| Backend、Runtime、Data、Policy        | `wyd-git`         | 单通道顺序实现                | 对应 ADR、负面测试与 Intended-vs-Implemented 审查 |
| Platform、Quality、Security、Recovery | `wyd-git`         | 单通道顺序实现                | 强制 CI；安全/恢复 Gate 上线前增加领域审查人      |
| Web、SDK、Portability                 | `wyd-git`         | 到 G2-05 才开始               | 两 Package 真实集成与独立验收                     |

`Codex` 是执行支持，不替代最终责任人。G2-00-13 的独立 Reviewer 是与实现过程分离的 clean checkout、Intended-vs-Implemented 和 adversarial red-team 审查角色；最终合并仍由 `wyd-git` 负责。当前没有把“一个人加 AI”包装成 4–6 人团队。G2-06 Recovery、G2-08 Security 和 Internal Alpha 前仍必须补充相应领域的第二审查人。

## 2. 重算后的 G2-01～05 日历

原蓝图“4–6 人、至少 4 条并行责任线、6 周完成 G2-01～05”的情景已经撤销。当前只有 1 条有效工程通道，Gate 不并行，前一 Gate 未 PASS 时不开始后一 Gate。

| 顺序 | Gate                  |   单通道规划范围 | 主要不确定性                                            |
| ---: | --------------------- | ---------------: | ------------------------------------------------------- |
|    1 | G2-01 Metadata        |       4–7 工程周 | Revision/Release 事务、兼容性、Package 与真实 Admin API |
|    2 | G2-02 Materialization |      7–11 工程周 | DDL 隔离、Kill/Resume、100k/1m、Cutover、容量实测       |
|    3 | G2-03 Query + Policy  |       3–4 工程周 | HTTP/SDK/Harness 同策略、Cursor 与遍历                  |
|    4 | G2-04 Action          |       3–4 工程周 | Preflight、锁、原子事务、Outbox 故障注入                |
|    5 | G2-05 Portability     |       2–4 工程周 | 两 Package、最小 UI、Function、SDK、回归                |
|      | **合计**              | **19–30 工程周** | 不含等待外部审查、需求变更或基础设施采购                |

这是容量情景，不是交付承诺。G2-01 的 4–7 周来自 [任务包红队](../reviews/g2-01-task-pack-red-team.md)，并要求在 G2-01-03 完成真实 PostgreSQL 薄切片后再次校准。每个 Gate 入口重新估算一次；若范围、Owner 或可用时间变化，先更新本矩阵，不删除安全、事务、恢复或性能退出条件来维持日期。

### G2-01-03 后校准（2026-08-14）

- G2-01-01～03 已经过设计、合同和真实 PostgreSQL 三道 Gate，进度为 3/12；DB-01 没有触发 ADR/PRD 重写，18 张表、状态 Trigger 和三类 Runtime Grant 可在 PostgreSQL 16 从空库一次升级。
- 原定 G2-01 **4–7 工程周整体范围不变**；按当前单通道，G2-01-04～12 剩余工作仍以 **3–6 工程周** 作为容量情景，不是日期承诺。
- 数据库可行性风险已下降，但最大剩余不确定性仍是 Project/RBAC 原子创建、Revision/Dependency/Compatibility Repository、Publish 行锁/故障注入和真实 Admin HTTP/OIDC；因此不因 Migration Gate 通过就缩短安全或事务步骤。

### G2-01-04 后检查点（2026-08-14）

- G2-01-01～04 进度为 4/12；Project、Principal、Project/Resource Role Binding 与 Authorization Epoch 已进入正式 Domain/Application/PostgreSQL 包，并用非 Owner `api_runtime` 登录完成真实事务负测。
- Project/RBAC 原子创建风险已经关闭；剩余 8 个工作项仍包含 Revision/Dependency/Compatibility、Release Publish、Package、Admin HTTP/OIDC 和最终 Gate，整体 **4–7 工程周**与剩余 **3–6 工程周**容量情景暂不缩短。
- 当前最大不确定性转为 Draft 并发/父链、Dependency Graph 与兼容性、Publish 行锁和入口 OIDC；G2-01-05 继续按原顺序，不提前创建 `apps/api`。

### G2-01-06 后检查点（2026-08-14）

- G2-01-01～06 进度为 6/12；Resource/Draft 并发、服务器 Definition Validator、Dependency Extractor、闭包、确定性拓扑与不可变 Validation Report 已进入正式实现。
- 第一次失败后依赖状态变化无法重试的报告身份缺口，已通过 `validation_context_digest` 向前迁移关闭；跨 Project 引用按 Missing 同形失败，不读取或锁定外部 Project 的图。
- Compatibility 的下游 Pin 影响与条件阻断已由 G2-01-07 关闭；剩余 5 个工作项的主要风险收敛到 Release 原子 Publish、Package 展开事务、真实 Admin HTTP/OIDC 与最终 clean-room Gate；整体 **4–7 工程周**容量情景仍不转换为日期承诺。

### G2-01-08 后检查点（2026-08-15）

- G2-01-01～08 进度为 8/12；服务器 Release Gate、Manifest、Stage CAS、零成员 Activation、短事务 Publish、并发冲突、幂等重试和向前 Rollback 已进入正式实现。
- 七个真实 PostgreSQL SQL 边界故障全部回滚，旧 Channel/Serving Head、Project Sequence、Authorization Epoch 和 Revision 状态保持完整；Release 原子 Publish 风险在 metadata-only 范围内关闭。
- 剩余 4 个工作项的最大不确定性转为 Package 展开与三 Pointer 同事务切换、真实 Admin HTTP/OIDC、第二领域 Fixture 以及最终 clean-room Gate；不因 Release PASS 提前宣称 Package 或产品入口完成。

### G2-01-09 后检查点（2026-08-15）

- G2-01-01～09 进度为 9/12；Package 预检、安装输入、Revision/Installation/Pending Change、兼容升级、新 Release 回滚和最终 Publish 激活已进入正式实现。
- 五个 Package 准备故障点和八个 Release Publish 故障点在真实 PostgreSQL 16 中全部回滚；不同 Namespace 共存、资源归属冲突、版本复用和伪造已校验输入均有负测。
- 剩余 3 项的最大不确定性集中在真实 OIDC/HTTP 边界、统一 CI/Testkit Evidence 以及 clean-room 总验收；仍不提前引入 DB-02、UI、SDK 或业务 Runtime。

### G2-01 最终检查点（2026-08-15）

- G2-01-01～12 已全部完成；真实 OIDC/Admin HTTP、Metadata/Package PostgreSQL Store、Release/Package 原子事务、统一 22 Gate、进程重启与独立 clean-room 验收均 PASS。
- 该结果关闭了 Metadata 业务 Gate，但不把自动化执行速度外推为 G2-02 的生产工期；Materialization 新增 S3、独立 Worker、长 Job 恢复、动态 DDL、100k/1m 性能与 GC 风险。
- G2-01 的历史规划保留用于审计，不再作为待完成容量；当前唯一活动规划转为 G2-02。

### G2-02 入口重估（2026-08-15）

- [G2-02 任务包](g2-02-materialization-task-pack.md)拆为 14 个顺序工作项；[任务包红队](../reviews/g2-02-task-pack-red-team.md)识别 Dynamic DDL 最小权限、R1/A0 前向兼容、Job Fencing/Kill-Resume、100k/1m 正式约束成本和 Overlay 延后证据为承重风险。
- 原 4–6 工程周未计入独立 DDL Executor 与完整进程恢复矩阵，调整为 **7–11 工程周单通道规划范围**；这不是日期承诺，也不能用于删减安全、原子性或容量 Gate。
- G2-02-03 完成 `R1/A0 → R2/A1` Migration 与最小 Lease/Checkpoint Smoke、G2-02-06 完成 10k Object/100k Link 薄切片后，各用实测吞吐与返工重新估算一次。
- 当前只放行 G2-02-01 的 ADR/状态 Harness/PostgreSQL DDL Spike；若 DDL 必须给 API/Worker Owner 权限或首成员必须改写 A0，立即停止，不进入 DB-02 业务表。

### G2-02-01 后检查点（2026-08-15）

- G2-02-01 已完成 [ADR-014](../architecture/adr/014-materialization-transaction-ddl-overlay-boundary.md)、[Evidence](../evidence/g2-02-01-materialization-architecture.md)与[专项红队](../reviews/adr-014-materialization-architecture-red-team.md)；15 项状态/边界测试和真实 PostgreSQL 16 DDL Spike 已证明代表性 Index Recipe、API/Worker/Ops 非 Owner、Kill/Replay、A0 前向兼容和 zero-overlay fail-closed。
- Dynamic DDL 的可行性停止条件未触发，但正式 Plan 不可变、Inventory Scanner/Revision、全部 Recipe、真实 Cutover 行锁和生产 Secret/Network 隔离仍是后续非可选 Gate；不能用本 Spike 宣称 DB-02 已落库。
- G2-02 整体 **7–11 工程周单通道容量情景暂不缩短**。G2-02-02 可以开始；下一次正式重估仍按原计划在 G2-02-03 的真实 `R1/A0 → R2/A1` Migration 薄切片后执行。

## 3. 顺序与停止规则

1. G2-00、G2-01 与 G2-02-01 已 PASS；G2-02 只按 [Materialization 任务包](g2-02-materialization-task-pack.md) 顺序执行，当前只允许开始 G2-02-02，不得跳到 DB-02、Query、页面或 Action。
2. 每次只允许一个业务 Gate 处于实现中；评审和证据整理可以跟随当前 Gate，但不能伪装成第二条开发线。
3. Security、Recovery 或容量 Kill Criterion 触发时停止下游 Gate，先修正模型或缩小承诺。
4. 未指定领域第二审查人的功能不能进入 Internal Alpha；可以保留已通过的技术证据，但不能宣称生产可用。
