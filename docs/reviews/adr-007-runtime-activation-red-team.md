# Red-Team：ADR-007 Runtime Activation 与 Serving Head

- 日期：2026-08-13
- 审查对象：[ADR-007](../architecture/adr/007-runtime-activation-serving-head.md)
- 方法：先强化主张，再按“错误影响 × 错误可能性 × 验证便宜程度”攻击承重假设
- 结论：**ADR-007 可接受；G2-01 仍被 ADR-008、数据库事务与 Compatibility Verifier 证据阻断**

## Top Kill-Assumptions（排序）

### 1. Compatibility Certificate 能代表真实投影等价（80）

- **Claim：** 一个 Generation 携带目标 Release Pin 的证书后，可以被该 Release 安全复用。
- **Steelman：** Fingerprint 同时绑定 Revision、Schema、Mapping 和 Snapshot Group；Activation 在创建与解析时再次核对证书，未认证的组合无法进入 Serving Head。
- **Fails if：** Verifier 只检查 Schema 可赋值或少量样本，却漏掉 Primary Key、默认值、Link、null/missing、冲突或索引语义变化。
- **Evidence to get this week：** 在 Release Staging 合同中列出精确与投影等价规则，并准备 additive、rename、type widen、default、identity、Link 和 breaking Mapping 的 Golden Corpus。
- **Kill criterion：** 任一被判兼容的 Mapping 在相同 Snapshot 上让旧 Release 的可观察结果变化。
- **Cheapest test：** 用 G1 两个 Package 的固定 Snapshot 对两版 Mapping 做全量规范化输出 Diff；只有目标 Release 可观察列完全等价才签证书。

### 2. 32/8 正常上限能在真实存储与索引成本下成立（80）

- **Claim：** 32 个 Serving Releases、每 Member 8 个服务中 Generation 是有界且可运营的默认值。
- **Steelman：** 兼容 Releases 共享 Generation；数据刷新替换 Serving Head 而不累积每个历史代；64/16 硬上限和 30 天扩容审批阻止无限增长。
- **Fails if：** 一个不兼容 Generation 的 Current/Link/Index 字节远高于 G1，或真实 Release 频率快于约 2.8 天一次，使 90 天窗稳定超过 32 个 Heads。
- **Evidence to get this week：** ADR-008 用 100k Objects/1m Links 基线测量每种行、索引、WAL 与重建时间，再代入 1/8/16 Generation 和 32/64 Release 场景。
- **Kill criterion：** 正常 32/8 场景超过目标环境磁盘/WAL/物化时间预算，或实际 90 天 Release 数稳定超过硬上限 64。
- **Cheapest test：** 用 G1 表与索引实测大小做参数化计算器；先证明数量级，再决定是否运行全量多代基准。

### 3. GC 的状态模型能无缝映射到真实并发事务（60）

- **Claim：** 引用根 + 保留窗 + `state_revision` + Commit 重验可防止误删。
- **Steelman：** GC 不是立即删除；所有持久根都使 Plan 失效，Commit 仍做锁定与反连接。5 分钟 Query 上限被 7 天保留窗覆盖，不需要每次读写数据库。
- **Fails if：** Token/Job/Hold 与引用对象不是同一事务落库，GC Worker 用应用层版本检查代替数据库锁/约束，或长 Query 绕过 Job/Hold 适配。
- **Evidence to get this week：** DB-04 前先写三类并发测试设计：GC Plan 后新增 Hold、Serving Head 切换与 GC 竞争、Worker 崩溃恢复后重复 Commit。
- **Kill criterion：** 故障注入能让任何新引用提交成功，同时其目标被 GC 标为已删除。
- **Cheapest test：** PostgreSQL 两连接测试：连接 A 计划并暂停，连接 B 新增 Hold，A Commit 必须因 epoch/反连接失败。

### 4. 90 天支持不会被用户理解成发布时数据快照（45）

- **Claim：** 支持旧 Release 的定义/API/SDK，同时让其 Serving Head随数据刷新前移，满足 PRD。
- **Steelman：** PRD 的核心是旧 SDK 和 Resource Revision 继续工作；当前业务数据本来会变化，固定发布当天 Snapshot 既昂贵也没有产品依据。
- **Fails if：** 目标用户把显式 Release 当作可复现的历史数据查询，或审计/监管要求按 Release 还原当时数据。
- **Evidence to get this week：** 在首个用户流程和 API 文案中明确“Release 固定定义，不固定业务数据”，让产品 Owner 与审计场景书面确认。
- **Kill criterion：** P0 验收必须用 Release ID 重放任意历史查询结果，而不是通过 Audit/ChangeSet/备份恢复。
- **Cheapest test：** 用 R1 发布后 S2 刷新的例子让产品 Owner选择“R1 看 S1”还是“R1 按 R1 定义看 S2”；若选择前者，立即触发 PRD 变更与容量重算。

### 5. 项目级 Control CAS 不会成为发布活锁（32）

- **Claim：** Publish/Refresh/Retire 低频且事务短，项目级串行化比细粒度 Pointer CAS 更可靠。
- **Steelman：** Query、Action 和 Staging 都不碰 `control_revision`；只有最终 Cutover 冲突，失败方可重新计划。
- **Fails if：** 高频 Source Refresh 持续抢占定义 Publish，或一个项目有大量互不相关 Snapshot Groups 需要并行 Cutover。
- **Evidence to get this week：** DB-02 记录并发 Cutover 的冲突率、重试次数与 P95；对 Refresh 设置有界退避和 Publish 优先级。
- **Kill criterion：** 在目标刷新频率下 Publish 连续三次重试仍不能在 PRD 的 5 秒 Metadata 切换目标内完成。
- **Cheapest test：** 用单项目 20 个并发 Refresh 加一个 Publish 的事务 Harness，观察冲突与尾延迟。

## 审查中已经关闭的问题

最初模型把“最近两个非活动 Generation”错误实现为“最近两个 Generation（含当前活动代）”，并且按 Member Key 全局分组，可能让不同项目互相挤占保留名额。审查后已改为按“项目 + Member”分组，先排除所有活动/引用根，再保留最近 N 个非活动代；固定 GC 场景同步增加一个明确可回收的旧孤儿代。

## What's Well-Reasoned

- 单一 Activation 同时固定 Release 和全部 Generation，比双 Pointer 从结构上更不容易产生交叉版本。
- 控制序号与引用/GC 序号分离，避免 Query 流量让 Publish CAS 饥饿。
- Rollback 创建新 Release，维持审计时间线并保留历史 Action 引用。
- 90 天 Release 支持与历史 Generation 保留被明确拆开，且达到容量硬上限时选择阻止 Publish，不会静默提前退休。
- 状态模型、13 个固定场景和随机事件序列形成了可执行反例搜索，不依赖尚未存在的数据库或业务 Endpoint。

## What I Couldn't Assess

- 实际 Mapping 语言足以做静态等价判断的程度；
- 目标环境的磁盘、WAL、索引和物化吞吐；
- 真实 Release 与 Snapshot 刷新频率；
- 法务、审计或用户是否要求历史数据时间旅行；
- PostgreSQL 表和约束尚未实现时的真实锁等待与故障恢复行为。

这些未知项不推翻 ADR-007 的引用模型，但分别阻止 Compatibility、容量、产品语义和数据库 Gate 被宣称完成。下一步应执行 ADR-008，而不是开始写 Resource/Release Store。
