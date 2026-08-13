# ADR-007：Runtime Activation 与 Release Serving Head

- 状态：Accepted for G2-00-03
- 日期：2026-08-13
- Owner：Runtime / Tech Lead
- 决策范围：跨模块运行时引用语义；不包含数据库表、Repository、业务 API 或 Materializer 实现
- 可执行模型：`tools/runtime-activation/model.ts`

## 1. 决策结论

一次可服务状态只能由一个不可变 `Runtime Activation` 表示。Activation 同时绑定：

- 一个不可变 Release Manifest；
- Release 的完整 Member Pins；
- 每个 Object/Link Member 对应的 Generation 与 Snapshot；
- 同一 Snapshot Group 的统一 Group Version。

Channel 与每个受支持 Release 的 Serving Head 都只指向 Activation，不能分别保存 Release Pointer 和 Generation Pointer。Query 在请求开始解析一次 Activation，此后只使用该 Activation；Preflight Token 也绑定解析到的 Activation。

该决策保留 PRD 的“Published Release API/SDK 至少支持 90 天”，但明确不承诺保留 90 天内每一次历史数据 Generation。受支持 Release 的 Serving Head 可以在 Release Pins 不变的前提下随数据刷新前移到新的兼容 Generation。

## 2. 为什么这套语义可落地

后续数据库实现只需要两类并发序号，而不是分布式共识：

1. `control_revision` 保护 Publish、Refresh、Rollback Publish 和 Retire 的指针切换；
2. `state_revision` 保护 GC 计划与引用变化之间的竞态。

定义/数据构建在不可见 Staging 中完成。最终 Cutover 是一个短 PostgreSQL 事务：锁定项目控制行，比较期望 `control_revision`，重新验证 Release、Activation、Generation 和 Snapshot Group，更新 Serving Head/Channel，递增控制序号并写审计。Query 的开始/结束不递增控制序号，因此不会让发布因正常流量饥饿。

状态模型把上述语义做成纯内存可执行合同；DB-01、DB-02 和 DB-04 后续分别把相同不变量映射到约束、事务和 GC Worker，而不是重新发明引用关系。

## 3. 核心记录与不变量

| 记录                                   | 是否可变                 | 作用                                                                        |
| -------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| Release Pin                            | 否                       | 固定 Member、Resource Revision、Schema Hash、Mapping Hash 与 Snapshot Group |
| Release                                | 发布后否；只迁移生命周期 | 保存 Manifest、Pins、发布时间、支持截止和可选 `rollbackOf`                  |
| Snapshot                               | 否；只迁移生命周期       | 表示一次输入数据版本及 Snapshot Group Version                               |
| Generation                             | 否；只迁移生命周期       | 表示某 Member 的物化结果及其 Release Pin 兼容证明                           |
| Activation                             | 否；只迁移生命周期       | 将一个 Release 与全部 Generation/Snapshot Members 封成单一可服务状态        |
| Channel                                | 是                       | 人类可读别名，例如 `stable`，只指向 Activation                              |
| Serving Head                           | 是                       | 每个仍受支持 Release 的当前 Activation；显式 Release 请求从这里解析         |
| Query/Token/Job/Hold/History Reference | 是                       | 阻止仍在使用的内容被 GC                                                     |

必须始终成立：

1. Activation 的 Release ID、Manifest Hash 和项目一致。
2. Activation Member 集合与 Release Pin 集合完全相等，不能缺 Member 或多 Member。
3. 每个 Generation 必须携带目标 Pin Fingerprint 的兼容证明；Fingerprint 同时包含 Member、Resource Revision、Schema、Mapping 和 Snapshot Group。
4. 同一 Snapshot Group 的所有 Activation Members 使用同一 Group Version。
5. Channel 和 Serving Head 只能引用 READY Activation；Serving Head 的 Release 必须与 Activation Release 相同。
6. 一次 Query 的 `resolutionCount` 必须恒等于 1。
7. 任一有效引用根可达的 Release、Activation、Generation 或 Snapshot 都不能进入 GC 结果。

### 3.1 Compatibility Certificate 的信任边界

“Schema 兼容”本身不足以允许 Generation 复用。跨 Release 复用必须由 Release Staging 的受信 Compatibility Verifier 产生证书，至少绑定：

- Generation/物化输出摘要；
- 目标 Release Pin Fingerprint；
- Verifier 与 Materializer 版本；
- `EXACT_PIN` 或 `PROJECTION_EQUIVALENT` 判定；
- 验证证据摘要。

`PROJECTION_EQUIVALENT` 只允许目标 Release 可观察的身份、字段值、Link、冲突和索引语义等价；单纯字段可解析、Schema 可赋值或抽样成功不能作为证明。普通调用方不能自行声明兼容。G2-00-03 模型把证书当作受信输入并验证其绑定关系；它不声称已经实现 Compatibility Verifier，该实现属于 Release Staging 的拥有 Gate。

## 4. 状态转换

### 4.1 Publish

前置条件：Release 为 STAGED，候选 Activation READY，全部 Pins/Generation 证明与 Snapshot Group 通过，并且容量检查通过。

同一控制事务执行：

1. 比较期望 `control_revision`；
2. 将 Release 置为 PUBLISHED，写入 `publishedAt` 和不少于 90 天的 `supportUntil`；
3. 创建或切换该 Release 的 Serving Head；
4. 将目标 Channel 切到同一个 Activation；
5. 递增控制序号并写 Audit。

任一检查失败时没有指针变化。R1 Serving Head 在 R2 发布后继续存在，直到 R1 合法退休。

### 4.2 纯数据 Refresh

Refresh 不修改 Release Pins。调度器按仍受支持 Release 的 Pin 枚举目标：

- 有受信兼容证明时，不同 Release 的新 Activation 可以引用同一 Generation；
- 不兼容时，必须按各自 Pin 独立物化；
- 同一 Snapshot Group 的所有 Members 一起替换；
- 某个旧 Release 构建失败时，保留其旧 Serving Head，并在 Health 标记数据落后，不能污染其他 Release。

一个 Cutover 可以原子替换同一项目的多个 Serving Heads。当前仍指向被替换 Release 的 Channel 一起前移；已经由并发 Publish 切到其他 Release 的 Channel 不能被 Refresh 拉回。

### 4.3 Publish 与 Refresh 并发

两者读取同一 `control_revision` 制订 Cutover。先提交者递增序号；后提交者收到 `CONCURRENT_MODIFICATION`，重新读取当前指针、重验候选内容后再计划。

不采用“最后写入者获胜”，也不允许 Refresh 只更新 Generation Pointer。这个保守的项目级 CAS 会串行化少量控制面 Cutover，但不会串行化 Query、Staging 构建或普通 Action，符合 Release Metadata 切换低频、短事务的负载特征。

### 4.4 Rollback

Rollback 复制历史 Pins 创建新的 Release，例如 R3 `rollbackOf=R1`。R3 重新完成兼容、就绪、容量和发布检查，然后以新 Activation 切换 Channel。

禁止把 Channel 直接移回 R1，也禁止修改 R1/R2。历史 Action/ChangeSet 继续引用原 Revision；Rollback 不撤销已经提交的业务动作。

### 4.5 Release Retire

Release 只有同时满足以下条件才能退休：

- 当前时间不早于 `supportUntil`；
- 没有 Channel 指向该 Release；
- 操作持有最新 `control_revision`。

Retire 删除其 Serving Head，但不立即删除 Release 或运行时内容。新的显式请求返回 `410 RELEASE_RETIRED`。已开始的 Query、有效 Token、Job、Hold 与历史引用仍按各自规则保护内容；随后由 GC 判断可回收性。

提前退休不能作为容量降级手段。若支持窗与硬容量冲突，新的 Publish 必须失败并触发容量或 PRD 决策。

## 5. 请求与 Preflight 语义

### Query

请求开始按显式 Release 或 Channel 解析一次 Activation，并把 `activationId` 放入请求上下文。所有 Object、Link、Function 和分页编译都从该上下文读取 Members，不再次查询 Channel/Serving Head。

默认 Query Lease 最长 5 分钟，超时后请求必须被取消；续租不重新解析 Activation。生产实现不要求为每个短 Query 写数据库行：默认 7 天的非活动保留窗远大于 5 分钟，请求进程存活时保留本地引用，进程崩溃时请求也随之终止。状态模型仍显式表示在途引用，以验证语义和长任务适配器。

### Preflight

Preflight Token 最长有效 15 分钟并绑定 Selector、Activation 和计划摘要。Apply 重新解析相同 Selector：

- Activation 相同才可继续其余锁定和重验；
- Channel/Serving Head 已变化、Release 已退休或目标不可解析时返回 `PREFLIGHT_STALE`；
- 过期返回 `PREFLIGHT_TOKEN_EXPIRED`；
- USED、STALE Token 均不可复用。

## 6. 容量与退休上界

G2-00-03 先冻结控制面数量上界；ADR-008 必须再把它换算成行数、索引和字节预算，并可以在进入 G2-01 前收紧，不能无依据放宽。

| 项目级指标                                             | 正常上限 | 硬上限 | 统计口径                                |
| ------------------------------------------------------ | -------: | -----: | --------------------------------------- |
| 同时存在 Serving Head 的 Release                       |       32 |     64 | 每个 PUBLISHED、未退休 Release 计 1     |
| 每个 Member 同时被 Serving Heads 引用的不同 Generation |        8 |     16 | 兼容 Release 复用同一 Generation 只计 1 |

这意味着在没有退休的 90 天窗内，正常定义 Release 平均不能快于约 2.8 天一次；若实际产品需要更高频率，必须在 ADR-008 用容量证据提高一个仍然有限的配置，或在 G2-01 前正式修改支持策略。不能等实现后再默认为无限。

超过正常上限的扩容审批必须：

- 最长 30 天；
- 指定项目、两个临时上限和审批有效期；
- 指定至少一个计划退休的 Release，且其 `supportUntil` 不晚于审批截止；
- 不能超过 64/16 硬上限；
- 只授权扩大占用，审批过期后允许在已有占用内做安全 Refresh，但禁止继续扩张，并在 Health 持续显示超额。

到达硬上限时 Publish/Refresh fail closed。不能自动退休仍在支持窗内的 Release，也不能以删除被引用内容来“腾容量”。Rollback 创建新 Release，同样计入容量。

Job、Hold 和历史引用可能延长非服务内容寿命；它们不改变 32/8 的 Serving 统计，也绝不能被 GC 绕过。ADR-008 必须为这类受保护字节建立 Admission、Owner、Review/Expiry 和容量告警；在其完成前，G2-01 仍被 Foundation Gate 阻断。

## 7. GC 决策

GC 使用 mark/plan/commit，不直接按“不是当前指针”删除。

### 7.1 引用根

以下内容及其传递依赖都是根：

- 所有 Channel 和 Serving Head；
- 未过期且 ACTIVE 的 Preflight Token；
- 未结束且未超出租约的 Query；
- ACTIVE Job；
- ACTIVE Hold；
- 历史 Action/ChangeSet/Artifact Reference。

Activation 向 Release、Generation、Snapshot 建边；Generation 向 Snapshot 建边。

### 7.2 保留规则

在引用根之外，每个“项目 + Member”默认仍保留最近两个成功的非活动 Generation，并保留所有进入非活动状态不足 7 天的 Release/Activation/Generation/Snapshot。当前活动 Generation 不占“最近两个非活动代”的名额。

90 天 Release 支持与该规则并不矛盾：受支持 Release 的 Serving Head 是根，并指向其当前兼容 Generation；过去的 S1、S2 数据代在不再被任何根使用并越过保留规则后可以回收。

### 7.3 并发安全

GC Plan 记录 `state_revision`。任何 Pointer、Token、Job、Hold、History Reference 或内容生命周期变化都会使旧 Plan 失效。Commit 必须在事务内再次锁定/检查候选项和引用反连接；版本号是快速拒绝，不替代数据库约束。

普通短 Query 不需要制造每请求数据库写入，因为 7 天保留窗覆盖 5 分钟最大请求寿命。长任务必须转换为持久 Job 或显式 Hold，不能只依赖进程内引用。

## 8. 已拒绝方案

| 方案                                    | 拒绝原因                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Channel 分别保存 Release 和 Generation  | 两次切换可产生定义/数据交叉版本                                           |
| 显式 Release 永远指向发布当天 Snapshot  | 把 90 天 API 兼容误变成 90 天数据版本保留，成本无界且语义未由 PRD 要求    |
| Rollback 直接把 Channel 指回旧 Release  | 破坏发布历史、审计和已提交 Action 的单调时间线                            |
| 只比较 Schema 可赋值性后复用 Generation | 不能证明 Mapping 值、身份、Link、冲突和索引语义一致                       |
| GC 只保留当前 Channel                   | 会删除显式 Serving Head、Token、Job、Hold、在途请求或历史引用仍需要的内容 |
| 每次 Query 都更新项目控制序号           | 正常读流量会让 Publish/Refresh CAS 饥饿                                   |
| 到达容量上限时自动提前退休              | 静默违反 90 天产品承诺                                                    |

## 9. 验证与尚未证明的内容

可执行证据位于：

- `tools/runtime-activation/scenarios.test.ts`：13 个固定场景；
- `tools/runtime-activation/properties.test.ts`：固定种子、每项 200 次的 property-based 验证；
- `tools/runtime-activation/model.ts`：无数据库、无 Endpoint 的纯状态模型。

已证明的是引用语义、状态转换、CAS 结果、Pin/Generation 绑定、Snapshot Group 原子性和 GC 根安全。尚未证明：

- Compatibility Verifier 能正确判断真实 Mapping 的投影等价；
- PostgreSQL 约束、隔离级别和故障注入下仍保持同样原子性；
- 32/8、64/16 对实际行数、索引和磁盘是否可承受；
- Job/Hold/历史引用造成的受保护字节如何做 Admission 与告警。

前三项分别由 Release Staging、DB-01/02/04 和 ADR-008 的拥有 Gate 验证。任一 Gate 无法维持本 ADR 不变量时，停止 G2-01 集成，修改 ADR/PRD，而不是在实现中静默降低语义。
