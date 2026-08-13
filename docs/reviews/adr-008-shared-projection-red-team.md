# Red-Team：ADR-008 Shared Projection、Index Plan 与容量上界

- 日期：2026-08-13
- 审查对象：[ADR-008](../architecture/adr/008-shared-projection-index-capacity.md)
- 方法：`strategy-red-team` 后接 `intended-vs-implemented`
- 结论：**G2-00-04 的 Project 级合同可接受；DB-02 仍被真实 PostgreSQL DDL/尺寸/写放大证据阻断，多 data-bearing Project 仍被 G2-07 部署容量 Gate 阻断**

## Top Kill-Assumptions（排序）

### 1. G1 行数外推不会低估宽 Property/JSON 的 Build 峰值（90）

- **Claim：** 100k Objects / 1m Links 的 G1 字节基线加 150% Reserve 足以提前阻止危险 Build。
- **Steelman：** G1 使用真实 Heap/Index 大小并包含 Metadata Index 写放大；模型还在 Staging 后取实测与估算的较大者。
- **Fails if：** 新 Snapshot 的平均 Object/Link 行宽远高于 G1，Build 在取得 Staging 实测前就消耗超过 12 GiB。
- **Evidence to get this week：** Snapshot Scan 输出行数、采样/全量未压缩值字节、预计 Index Recipe，并与物化结果做误差报告。
- **Kill criterion：** Source Forecast 在任一固定宽行、长字符串或 JSON Fixture 上低估物化 Heap + Index 超过 25%，或未在启动 COPY 前执行。
- **Cheapest test：** 用 100k 行宽字符串 Fixture 产生 9 GiB Forecast，确认 Build 在创建 Staging 前收到硬容量拒绝。
- **处理：** 已把 `forecastMeasuredBytes` 加入准入下界；模型取 G1、Source Forecast、Staging Measurement 三者最大值。DB-02 仍须实现 Forecast 校准。

### 2. Project 上界能够代表共享 PostgreSQL 部署上界（90）

- **Claim：** 每 Project 12 GiB 和 160 个 Property Index 的硬上限使共享投影可运营。
- **Steelman：** Project 是租户/容量隔离单位，Publish/Refresh 都在 Project 内准入，相同 Revision/Generation 跨 Release 复用。
- **Fails if：** 允许无限 data-bearing Projects；共享表总字节、Partial Index 数和每次写入需要判断的 Index Predicate 会随 Project 数无限增加。
- **Evidence to get this week：** 在 G2-07 记录 1/2/4 Project 的总 Index 数、INSERT P95、Catalog/Planner 时间、WAL 和磁盘最低水位。
- **Kill criterion：** 在没有部署级总字节、总 Index 数和最低空闲磁盘 Gate 时，把 data-bearing Project 上限提高到 2 或更多。
- **Cheapest test：** 当前先把 Foundation Reference Deployment 固定为 1 个 data-bearing Project；第二个 Project 的 Materialization 必须在分配空间前失败。
- **处理：** 已由 `assertFoundationDeploymentEnvelope` 执行。它是当前证据边界，不是假装完成了多 Project 容量。

### 3. 新共享键和 Revision Partial Index 仍落在 G1 安全余量内（80）

- **Claim：** 复合 Project Key、Link Endpoint Unique、Revision Predicate 和最多 160 个 Property Index 可以映射到共享表。
- **Steelman：** 这些键解决租户隔离、跨 Generation 身份和不兼容 Revision 的表达式类型问题；150% Reserve 与 post-Staging Measurement 能阻止超额 Cutover。
- **Fails if：** 新固定索引超过 50% 余量，很多 Partial Index 的 Predicate 判断使写入远高于 3.574×，或 Concurrent DDL 无法在运维窗口完成。
- **Evidence to get this week：** DB-02 用等价 100k/1m Fixture 建最终 Migration，测量 1/80/160 Property Index 下 Heap、Index、100k INSERT、Planner、WAL 和 DDL 时间。
- **Kill criterion：** 1 个正常 Project 在最终 Schema 上超过 8 GiB steady / 10 GiB peak，或正常 Index Plan 的写入/DDL 无法满足 G1/G2 SLO。
- **Cheapest test：** 先只对 G1 Schema 增加 Project/Revision/Endpoint 约束做 A/B；不需要先实现 Repository/API。
- **处理：** 未伪造结果。ADR 明确将这项保留为 DB-02 拥有 Gate；失败时收紧 Index/Generation 数，不放宽硬上限。

### 4. 临时审批真的能在 30 天内回到可回收状态（72）

- **Claim：** 一个带 Release 退休计划的审批可以安全临时突破正常预算。
- **Steelman：** 审批绑定 Project、最大值、到期时间，且不能跨硬上限或提前退休 90 天支持窗内 Release。
- **Fails if：** 审批引用不存在的 Release，`supportUntil` 到期后还有 7 天 GC Grace，或过期审批被继续用于新增 Staging/Index。
- **Evidence to get this week：** 对 ghost Release、过晚退休、过期后相同计划、过期后新增 Staging/Index 做固定反例。
- **Kill criterion：** 任一审批没有真实 Serving Release，或 `supportUntil + GC Grace > expiresAt` 仍可通过；过期后总字节或 Index Union 增长仍可通过。
- **Cheapest test：** 纯函数单测，无需数据库。
- **处理：** 已验证真实 Serving Inventory 与 7 天回收窗口；过期后只允许所有字节和 Index 指标均不增加的严格 non-expanding change。

### 5. 引用根不会因字段滥用或过期治理被 GC 绕过（72）

- **Claim：** Serving Head、Token、Query、Job、Hold 和 Historical Root 能可靠阻止回收。
- **Steelman：** GC 使用完整引用扫描、7 天 Grace、dry-run、Inventory Revision 和 Commit 重验。
- **Fails if：** Hold 没有 Owner/Review，或给 Hold/Serving/Historical Root 填一个通用 `expiresAt` 后让它自动失效；`COLLECTED` 内容仍带有效引用。
- **Evidence to get this week：** 对七类 Root 做属性测试，并为缺失 Hold 治理、Review 逾期、非租约 Root 的 `expiresAt`、Collected + Hold 建固定反例。
- **Kill criterion：** 任一有效根可进入 GC Candidate，或 Review 逾期会自动删除而不是阻断并要求显式关闭。
- **Cheapest test：** 纯状态 dry-run 和 stale-plan 单测。
- **处理：** 已强制 Hold Owner/Reason/Review；只有 Query/Preflight 可时间过期；逾期 Hold 继续保护并使 GC dry-run `BLOCKED`。

## Intended vs. Implemented 审查

| 已记录意图                            | 审查前实际                                             | 成本/数据边界                        | 修正与证据                                                       | 状态                     |
| ------------------------------------- | ------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------- | ------------------------ |
| G1 输入不可漂移                       | Hash 只是常量，测试未读取原文件                        | 证据改变后容量结论仍可能绿灯         | 测试重新 Hash Summary、Benchmark、Schema、Indexes                | CLOSED                   |
| Index 必须引用真实证据                | 任意非空字符串都能通过                                 | Builder 可凭空制造高成本索引         | Release Evidence Catalog 必须解析每个 Ref                        | CLOSED                   |
| Project Index 统计全部保留物理内容    | 最初只接收 Serving Plans                               | Hold/Recent/Staging 索引从预算消失   | 完整 Retained Inventory；不完整返回 `INDEX_INVENTORY_INCOMPLETE` | CLOSED                   |
| 审批包含可执行退休计划                | 最初未验证 Release 存在或 7 天 Grace                   | 到期后仍无法释放容量                 | 真实 Serving Plan + `supportUntil + 7d <= expiresAt`             | CLOSED                   |
| 审批过期只允许非扩张 Refresh          | 最初绝对拒绝或审批后任意放行二选一                     | 可能破坏 ADR-007 或继续扩大债务      | 差量比较字节、Scope、Union 和 Index Count                        | CLOSED                   |
| Hold 需要 Owner/Review 且不能自动失效 | 最初 Root 只有 ID，可带通用 Expiry                     | 调查证据可能被错误回收               | Hold Governance + Root Expiry 类型限制 + blocked dry-run         | CLOSED                   |
| Shared Index 绑定不可变 Revision      | 最初 Signature 含 Revision，但 Predicate 未含 Revision | 不兼容类型转换可能共用错误表达式索引 | Compiled Predicate 同时绑定 Resource + Revision                  | CLOSED                   |
| Project 上界不能被 Project 数量相乘   | 最初没有部署包络                                       | 共享 DB 总字节/Index 无界            | Foundation 先限 1 个 data-bearing Project                        | CLOSED（G2-07 才可放宽） |

没有发现仍未修正、且位于 G2-00-04 纯合同范围内的 Intended-vs-Implemented 漂移。数据库约束、权限、DDL、实际测量和并发删除尚不存在，因此不能把“文档已定义”误报为“数据库已执行”。

## What's Well-Reasoned

- G1 文件 Hash、精确 497 MiB 归一值和 3.574× 写入比形成不可漂移的输入，而不是重新跑出有利数字。
- Shared Row Identity 不依赖 Release、Channel 或 Display Name，符合 ADR-007 的 immutable Activation/Generation 解析。
- Object Type 13 units、Project 12 GiB 与物理 Index 160 都是不能审批突破的硬边界。
- 32 个 Releases 共享 8 个物理 Cohorts 的场景明确验证了“逻辑支持数不等于物理复制数”。
- Capacity 把 Orphan 也计入总账，避免未被当前指针引用但尚未删除的内容凭空消失。
- GC 先证明可删，再 dry-run，再绑定 Revision Commit；不完整引用扫描从不生成候选。

## What I Couldn't Assess

- 最终 PostgreSQL Migration 的真实 Heap/Index/WAL/DDL 成本；
- Source Forecast 对真实 Property/JSON 分布的误差；
- 80/160 个 Partial Index 对共享表 INSERT 和 Planner 的影响；
- 多 data-bearing Project 的硬件总容量与最低空闲磁盘；
- DB-02/DB-04 事务和故障注入下的 Cutover/GC 原子性。

这些未知项不要求在 G2-00-04 偷跑 DB-02，但它们分别阻断最终 Migration、提高 Project 上限和生产容量宣称。下一步是在本项保存 Evidence 后进入 G2-00-05；不能跳过 Foundation 顺序直接建业务表。
