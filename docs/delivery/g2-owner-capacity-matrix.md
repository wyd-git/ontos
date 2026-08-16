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

### G2-02-03 后检查点（2026-08-15）

- G2-02-02 合同和 G2-02-03 逻辑 DB-02 Migration 已 PASS；连续账本现为 0001～0009，停在 0006 且预置 R1/A0 的真实 PostgreSQL 16 数据库已无损升级，R2 Plan → READY 空 Generation → A1 与双 Worker Lease/Fencing/Checkpoint Smoke 已完成。
- 实现中关闭 8 类返工：复合 FK/Unique、Snapshot/Mapping DB Validator、逐表事实冻结、Deferred Trigger Definer 权限、PL/pgSQL 名称歧义、候选 Activation 历史测试语义、Base/Current 内容绑定，以及旧证据门禁硬编码“总共 6 个 Migration”。没有修改 PRD/ADR、历史 Migration 或 A0，也没有把 Owner/DDL 交给 Runtime。
- 已完成的架构、合同和 Schema 降低了后续结构性返工，但 0 行 Generation 不提供吞吐依据；S3、CSV 流式、Mapping、10k/100k 首批数据、完整 Job 恢复、动态索引、Cutover/GC 和 100k/1m 总验收仍在关键路径。因此从当前检查点起，**剩余单通道容量情景为 6–10 工程周**，不是发布日期承诺。
- 下一次强制重估仍在 G2-02-06 的 10k Object/100k Link 数据薄切片；必须记录 COPY/批次吞吐、Node Heap、PostgreSQL Heap/Index/WAL、失败重放和实际返工。缺少这些数据不得继续缩短区间。
- 当前只放行 G2-02-04 Managed UTF-8 CSV Ingress；不得跳到 Mapping 后半段、Query、Action、UI 或把 DB Schema 宣称成生产闭环。

### G2-02-05 后检查点（2026-08-15）

- G2-02-04 已完成受管 UTF-8 CSV/S3 Ingress；G2-02-05 已完成确定性 Mapping Compiler、公共 Value Codec Row Evaluator、Object PK Candidate、Link Identity Lookup、背压和链式 Stream Digest。当前进度为 5/14。
- 固定 Seed Property Tests 和跨 Locale/Timezone 进程逐字节比较已关闭值与重放风险；128 MiB Heap 下 100k Object/1m Link 纯 Mapping 完整执行，专用 x86_64 机器峰值 93.78 MiB。
- 该结果只证明 Mapping 的确定性和内存形状，不包含永久 RID、PostgreSQL Base/COPY/WAL/Index、Dangling Link 或 Worker Kill/Resume；因此剩余 **6–10 工程周**容量情景不缩短。
- 当前只放行 G2-02-06 永久 Object Identity 与不可变 Object/Link Base。完成 10k Object/100k Link 真实 PostgreSQL 薄切片后，再按 COPY 吞吐、WAL、Heap、Index、重启重放和实际返工强制重估。

### G2-02-06 后检查点（2026-08-15）

- G2-02-06 已完成永久 Object Identity、批量 Resolve/Create、Attempt-owned Object/Link Base Staging、类型化 Link Endpoint、Fencing 和整代原子提升。当前进度为 **6/14**。
- 真实 Ubuntu 24 / x86_64 / 8C16G / PostgreSQL 16.14 薄切片处理 10k Object + 100k Link，使用 2 + 20 个 5,000 行批次；Object 路径另包含一次失败 Attempt 的完整 10k 重放。
- Scan/Mapping/Base 主阶段约 45.31 秒，逻辑吞吐 2,428 rows/s；Node 峰值 RSS 约 290.8 MiB，WAL 约 226.2 MiB，失败+成功 Staging 共约 80.9 MiB。Worker/API 连接池重启前后 Base Digest 一致。
- 按当前阶段线性外推 100k Object + 1m Link 约 7 分 33 秒，为 30 分钟基线保留了加入 Current/Quality/Index 的余量。这不是最终 SLO PASS；G2-02-09 和 14 仍必须跑完 100k/1m 与真实 HTTP/S3/Worker/Cutover。
- 本项的实际返工主要是 Link 端点类型绑定、Attempt 级 Digest 幂等、不可变 Trigger 下的前向回填、公开 Error Cause 脱敏和真实 CSV-to-Base 容量接缝；都已在本 Gate 关闭。
- 容量不再是当前最大未知，但剩余 8 项仍包含 Current/质量、真实 Worker、Index、Cutover、GC、HTTP/CI 和 clean-room；剩余单通道容量情景调整为 **5–9 工程周**，不是上线日期承诺。
- 当前只放行 G2-02-07 Staging Current、质量报告与最小血缘；不得跳到 Query/UI，也不得让 API 直读 Base 伪装成已可服务。

### G2-02-08 后检查点（2026-08-16）

- G2-02-07 与 G2-02-08 已 PASS，当前进度为 **8/14**。连续账本到 0013，独立 `apps/worker`、数据库时间 Lease/Fence、八阶段 Checkpoint、Retry/Replay/Cancel/Terminal 和最小权限已进入正式实现。
- 真实 Ubuntu 24 / x86_64 / 8C16G / PostgreSQL 16 测试以两个真实 Worker PID 完成 16 个阶段前后 SIGKILL：16 个 Attempt、3 次人工 Replay、8 个唯一 Checkpoint，最终 Digest 与无故障运行一致；Graceful、临时依赖、永久错误、连接终止和安全取消均通过。
- 实际返工包括 Migration 不可变 Trigger 回填、旧终态 Fixture、API 列级 INSERT 残留、Priority 饥饿、Heartbeat Abort 分类、数据库连接断开时 `unref()` 导致 Node code 13、自身登录提权检查和 Error Sample 复合 FK。这些问题已在本 Gate 内关闭，没有移动到运维手工步骤。
- 该结果降低恢复协议不确定性，但 Dynamic Index 全 Recipe/Inventory、容量硬准入、Certificate、真实 Group Cutover、GC、Admin HTTP 和 clean-room 仍有 6 项。剩余单通道容量情景保持 **4–7 工程周**，不是上线日期承诺。
- 当前只放行 G2-02-09 Index Plan、容量准入与受信 DDL 执行；`worker:start` 在 09～11 的生产 Stage 组合完成前继续 fail closed，不得用测试 Adapter 启动生产调度。

### G2-02-09 后检查点（2026-08-16）

- G2-02-09 已 PASS，当前进度为 **9/14**；Published Object Type/Release Pin 绑定、Index Plan/Admission、生产容量 Loader/Scanner、隔离 DDL Executor 与连续 Migration 0014 已进入正式实现。
- 真实 Ubuntu 24 / x86_64 / 8C16G / PostgreSQL 16.14 以空数据层完成 100k Object + 1m Link；核心构建约 21m06s，Project 实测 2,826,518,528 bytes，150% Peak 4,239,777,792 bytes，未触发 30 分钟/12 GiB 停止条件。
- 可行性复审发现并关闭了伪 Retained Release、测试注入 Capacity Snapshot、Published Property 漂移、Unique 跨 Generation 冲突与 Pending Index 假完整等缺口；没有放宽租约、容量或权限上限。
- 剩余 5 项仍包含 Certificate、真实 Group Cutover/Refresh、GC/Drop、Admin HTTP/Testkit 和 clean-room；剩余单通道容量情景保持 **3～6 工程周**，不是上线日期承诺。
- 当前只放行 G2-02-10 Runtime Member Plan 与受信兼容证书；不得跳到 Cutover、GC、Query 或 UI。

### G2-02-10 后检查点（2026-08-16）

- G2-02-10 已 PASS，当前进度为 **10/14**；Metadata Stage 服务器派生不可变 Runtime Plan，连续 Migration 到 0015，受信 Compatibility Certificate、动态失效 View、完整 Release READY Guard 和跨 Release Generation 复用已进入正式实现。
- 真实 Ubuntu 24 / x86_64 / 8C16G / PostgreSQL 16.14 已把 100k Object + 1m Link 容量链路升级为 Object + Base Link 两成员 Closure：完整构建约 21m25s，实测 2,827,124,736 bytes，150% Peak 4,240,687,104 bytes，两个证书齐全后才允许 Release READY。
- 可行性复审发现并关闭旧证书在新 Admission 下复活、失败 Job 伪造质量、跨 Release FK 过严、审批 Expiry 未持久和 Metadata Stage 四列最小读取权限等缺口；没有把 Certificate 或 Pointer 任意写权限授给 Runtime。
- 剩余 4 项包含真实 Group Cutover/Refresh、GC/Drop、Admin HTTP/Testkit 和 clean-room；Cutover 仍是当前最大事务风险，剩余单通道容量情景调整为 **2～5 工程周**，不是上线日期承诺。
- 当前只放行 G2-02-11 Snapshot Group 原子 Cutover 与数据 Refresh；不得跳到 GC、Query、页面或 Action。

### G2-02-11 后检查点（2026-08-16）

- G2-02-11 已 PASS，当前进度为 **11/14**；连续 Migration 到 0016，不可变 Head Set、Project Pointer CAS、完整 Activation/Member、Serving/Channel 并发控制和安全退役已进入正式实现。
- 真实 Ubuntu 24 / x86_64 / 8C16G / PostgreSQL 16.14 从空数据层完成 100k Object + 1m Link；完整构建约 21m05s，100k Head 的最终 Commit 为 207.474 ms，未触发 30 分钟/5 秒停止线。
- 可行性复审实际发现首版逐 Head 更新在 9 分钟后仍未完成，本关未放宽锁超时，而是改为 Prepare 构建完整 Head Set、Commit O(1) Pointer CAS。
- 剩余 3 项是 GC/Drop、Admin HTTP + 生产 Worker/Testkit 组合和 clean-room；剩余单通道容量情景为 **2～4 工程周**，不是上线日期承诺。
- 当前只放行 G2-02-12 Generation/Index mark-plan-commit GC；不得跳到 Query、页面或 Action。

### G2-02-12 后检查点（2026-08-17）

- G2-02-12 已 PASS，当前进度为 **12/14**；连续 Migration 到 0017，完整 Root Provider/Inventory、单调 Root Epoch、分层保留、分批关系回收、精确对象版本删除与 GC-bound Index Drop 已进入正式实现。
- 真库故障测试对每个产生变化的关系批次执行 Node SIGKILL + PostgreSQL Backend 终止并重试；首个 Index DROP 同样 Kill/Replay，最终旧历史 Activation 可读、零引用 Index 清零、容量测量强制重新扫描。
- 实际返工包括瞬态 Root 加删导致计划复活、历史 Activation 漏保护、伪空 Provider Scan、Generation/Attempt 字节归属、仅 Kill 客户端不足以证明事务回滚、DROP 后容量测量陈旧，以及容量 Lane 重复 GC 强杀导致统一 CI 超时；均已在本 Gate 关闭，容量与故障 Gate 已按目的拆开且分别 PASS。
- 剩余 2 项是 Admin HTTP + 生产 Worker/Testkit/统一 CI 组合和 clean-room 总验收；剩余单通道容量情景为 **1～3 工程周**，不是上线日期承诺。
- 当前只放行 G2-02-13 Admin API、Testkit 与统一 CI Gate；不得跳到 Query、页面或 Action。

## 3. 顺序与停止规则

1. G2-00、G2-01 与 G2-02-01～12 已 PASS；G2-02 只按 [Materialization 任务包](g2-02-materialization-task-pack.md) 顺序执行，当前只允许开始 G2-02-13，不得跳到 Query、页面或 Action。
2. 每次只允许一个业务 Gate 处于实现中；评审和证据整理可以跟随当前 Gate，但不能伪装成第二条开发线。
3. Security、Recovery 或容量 Kill Criterion 触发时停止下游 Gate，先修正模型或缩小承诺。
4. 未指定领域第二审查人的功能不能进入 Internal Alpha；可以保留已通过的技术证据，但不能宣称生产可用。
