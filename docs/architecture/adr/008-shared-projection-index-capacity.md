# ADR-008：Shared Projection、Index Plan 与容量上界

- 状态：Accepted for G2-00-04
- 日期：2026-08-13
- Owner：Runtime / Database
- 决策范围：共享 Current Projection、Property Index Plan、Generation 容量准入与 GC 合同；不创建 DB-02 业务表
- 可执行模型：`tools/projection-capacity/`
- 实现推进：G2-02-03 已把 Shared Object/Link PK、Canonical PK/Endpoint Unique、Generation/Revision/Project 复合 FK 与 Plan/Inventory 表落入 0007～0009；全部动态 Recipe、真实字节/WAL/VACUUM 与 100k/1m 容量仍未证明

## 1. 决策结论

P0 只使用两个跨 Project、Object/Link Type、Revision 和 Generation 的共享物理投影表：`runtime.object_current` 与 `runtime.link_current`。Release 和 Channel 先按 ADR-007 解析为不可变 Activation/Generation，不能成为投影行的物理键，也不为 Package、类型、Release 或 Generation 单独建表。

每个 Published Release 必须携带一个可编译的 Index Plan。索引只来自 Property 明确声明的 `filterable`、`sortable`、`searchable`、`unique` 能力与对应查询/约束证据；禁止“为全部 Property 自动建索引”。同一不可变 Object Type Revision 的相同物理索引签名可以跨 Release 复用。

所有 Publish、Rollback Publish、数据 Refresh、调查 Hold 和 Staging Build 必须先把候选内容加入完整物理库存，再同时通过：

1. Index Plan 的 Object Type、Release、Project 预算；
2. Generation 的 Release、Project steady、Project peak 与物理硬上限；
3. ADR-007 的 Release/Generation 数量上限。

正常上限可以通过最长 30 天、带合法退休计划的容量审批临时提高；硬上限不能审批突破。库存、引用或测量不完整时 fail closed。若后续 DB-02 实测无法维持本 ADR 的有限上界，ADR 保持非 Accepted，DB-02 不得以放宽为无限继续。

## 2. 为什么该方案可以落地

该决策把三个容易互相掩盖的问题分开计量：

- **逻辑服务数量**：ADR-007 控制同时服务多少 Release、每个 Member 有多少不同 Generation；
- **索引复杂度**：Index Plan 控制单类型写放大、单 Release 能力面和 Project 实际保留的物理索引集合；
- **真实字节占用**：容量模型计算全部 Serving、Recent、Protected、Staging 和 Orphan 内容，不把“未被当前 Channel 使用”误当作“已经不存在”。

Release 可以共享同一 Revision 索引，也可以共享同一 Generation，因此 32 个 Serving Heads 不等于 32 份物理数据。反过来，已离开 Serving 但被 Hold、Job、历史引用或最近成功代规则保护的内容仍占物理容量和索引预算，不能从账面省略。

G2-00-04 交付纯 TypeScript 合同和测试，不提前创建数据库业务表。DB-02 后续把相同键、签名、准入顺序和 GC 规则翻译为 PostgreSQL Migration、Repository 与 Worker；不能重新定义一套不同语义。

## 3. 不可篡改的 G1 基线

容量模型直接引用 G1 已提交证据，不回写或重算原始结果：

| 输入                             |         G1 证据值 |
| -------------------------------- | ----------------: |
| 物理 Object rows                 |           200,000 |
| Object Heap                      | 113,131,520 bytes |
| Object Indexes                   | 151,117,824 bytes |
| 物理 Link rows                   |         2,000,000 |
| Link Heap                        | 233,906,176 bytes |
| Link Indexes                     | 544,129,024 bytes |
| Identity-only 100k 写入中位数    |        387.298 ms |
| Metadata-indexed 100k 写入中位数 |      1,384.235 ms |
| 写入时间比                       |            3.574× |

G1 物理库存包含两个 100k Object / 1m Link 规模的数据代。因此按行数线性归一后，一份完整 P0 基准投影是：

| 构成           |                    字节 |
| -------------- | ----------------------: |
| Object Heap    |              56,565,760 |
| Object Indexes |              75,558,912 |
| Link Heap      |             116,953,088 |
| Link Indexes   |             272,064,512 |
| 合计           |   521,142,272 = 497 MiB |
| 150% 准入预留  | 781,713,408 = 745.5 MiB |

证据绑定：

| 文件/结果                               | SHA-256                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `spikes/g1/evidence/spike-a-summary.md` | `6e1259749f0d020237095d1cedb01e30069685e1b6d22acb2e205a68bbf2591b` |
| `spikes/g1/src/bench/run-index-cost.js` | `36e97ff607450b8234a93abcb75ef6ac276d0b46c7167f9526c0821cfd9fb55f` |
| `spikes/g1/sql/001_schema.sql`          | `897c86436696960dd04be9150118f31108ea76c3083c3a7c0152079c85b40cdc` |
| `spikes/g1/sql/020_indexes.sql`         | `34d1366e6b3a5ee6725f30b8c107a2c57b023d60181631caaf7a7d35738b31a6` |
| 未提交原始 Index Cost 结果              | `7b39f705e61d1b7d97bc0fb3d2acb5b546de61d4a473585007fc5eb452730201` |

这些数字是 G1 环境的基线，不是假装精确的生产容量预测。初始模型采用 150% 预留。Build 前必须从 Snapshot 文件统计或有界抽样产生 Source Forecast；Staging 完成后还必须读取物化测量。每次都以“G1 外推值、Source Forecast、Staging 测量值中的较大者”重新计算预留，不能用较小估算启动 Build 或完成 Cutover。

## 4. Shared Projection 合同

### 4.1 Object Current

`runtime.object_current` 的物理主键为：

```text
(project_id, generation_id, object_type_resource_id, object_rid)
```

同一 Generation 内的规范业务键唯一约束为：

```text
UNIQUE (project_id, generation_id, object_type_resource_id, canonical_primary_key)
```

`object_rid` 由永久 Object Identity 映射产生；`canonical_primary_key` 在 ADR-009 的公共 Codec 冻结后写入。相同 Object 可以跨 Generation 保持同一 `object_rid`，但每个 Generation 仍有独立 Current 行。

### 4.2 Link Current

`runtime.link_current` 的物理主键为：

```text
(project_id, generation_id, link_type_resource_id, link_rid)
```

P0 Link 没有动态业务属性，同一类型和 Generation 内不允许完全重复的 Source/Target 边：

```text
UNIQUE (
  project_id,
  generation_id,
  link_type_resource_id,
  source_object_rid,
  target_object_rid
)
```

若业务需要同一端点间多条可区分且带属性的关系，应按 PRD 建模为 Object，而不是绕过该唯一性。

### 4.3 Revision 与租户隔离

两张表都保存 Member Revision ID，并通过复合外键证明：

```text
(project_id, generation_id, member_resource_id, member_revision_id)
  -> runtime.generations
```

Revision ID 不加入行主键，因为 Generation 已不可变绑定一个 Member Revision；但它必须物化为列，使 PostgreSQL Partial Index 能直接使用 Revision Predicate，不能依赖索引条件中的跨表 Join。

所有主键、唯一键、外键和查询计划都显式包含或验证 `project_id`。Release ID、Channel ID、API/Display Name 不得出现在物理行身份中。RLS 只作为 Project 隔离的纵深防御，业务 Policy 仍由统一 Query Compiler 注入。

### 4.4 固定索引与动态索引的边界

以下属于表结构的固定索引，不由 Builder 选择：Object/Link 主键、Object 规范 Primary Key 唯一约束、Link Endpoint 唯一约束、Generation/Member 约束所需索引，以及 Link Source/Target 双向遍历索引。

Property 表达式、类型化排序、Search 和 Array 查询索引由 Index Plan 生成。固定索引与动态索引都必须计入 PostgreSQL 实测字节；“不进入 Builder Index Plan”不等于“不计容量”。

## 5. Index Plan Contract

### 5.1 输入与覆盖规则

每个 Object Type Revision 提供稳定 Resource/Revision ID、Property 类型、查询能力声明和显式 Index Declarations。编译器必须满足：

- 恰好一个 Primary Key；
- `filterable` / `sortable` 标量 Property 有可用 B-tree 首键；
- `searchable` string 有 Trigram GIN；
- `filterable` string array 有 Array GIN；
- `unique` 标量有单 Property Unique B-tree；
- JSON 只允许已注册、顶层、声明为 filterable 的路径；
- 每个动态索引至少有一个查询、Policy 或约束 Evidence Ref；
- 每个 Evidence Ref 必须能在受信 Release Staging 提供的 Evidence Catalog 中解析；
- 未声明查询能力的 Property 不能被直接加入索引；
- 声明了查询能力却没有被索引覆盖时，Release Validation 失败。

P0 支持的 Recipe 与计费单位：

| Recipe        | 限制                     | Unit Cost |
| ------------- | ------------------------ | --------: |
| B-tree        | 1–3 个显式 Key；方向固定 |  每 Key 1 |
| Unique B-tree | 单一 scalar Property     |         2 |
| Trigram GIN   | `searchable` string      |         4 |
| Array GIN     | `filterable` string[]    |         3 |

Unit 是由 G1 六个 Metadata Index 折算出的保守写放大权重，不是 PostgreSQL 页面大小。G1 Reference Plan 为每个 Object row 13 units；估计写入时间比使用：

```text
1 + (3.574 - 1) × units / 13
```

该式只用于准入比较，不能作为真实延迟 SLO。真实写入仍由 DB-02 负载测试验证。

### 5.2 物理签名与命名

物理签名固定包含：表名、Object Type Resource ID、Object Type Revision ID、Index Kind、Unique、Key/JSON Path/Direction、`lifecycle_state=active` Predicate 和规范 Primary Key Tie-breaker。

Revision 必须出现在 Partial Index Predicate 中；否则两个类型转换不兼容的 Revision 可能错误共用同一个表达式索引。相同签名跨 Release 只计一份物理索引。

索引名格式为：

```text
ok_oc_<kind>_<resource-hash-10>_<revision-hash-8>_<signature-hash-12>
```

名称只使用稳定 ID 的 SHA-256 摘要，不使用 Display/API Name，UTF-8 长度不得超过 PostgreSQL 的 63-byte 限制。命名冲突必须 fail closed。

### 5.3 默认预算

| 范围                             | 正常上限 | 硬上限 | 说明                                  |
| -------------------------------- | -------: | -----: | ------------------------------------- |
| 单 Object Type Secondary Units   |       13 |     13 | 不能审批突破 G1 Reference 写放大      |
| 单 Release Secondary Units       |       80 |    104 | 控制一个定义面的查询能力总量          |
| Project 保留物理索引 Union Units |      120 |    240 | 相同物理签名去重后计算                |
| Project 保留物理索引数量         |       80 |    160 | 控制 DDL、Catalog、Planner 和维护成本 |

Project 口径必须包含所有 Serving、Recent Successful、Protected 与 Staging Plan，不只包含当前 Channel 或 Serving Release。物理索引库存不完整时返回 `INDEX_INVENTORY_INCOMPLETE`。超过 Object Type 或任一硬上限不可审批；超过正常 Release/Project 上限分别在发布前返回结构化预算错误。

## 6. Generation 容量模型

### 6.1 库存输入

每个非 `COLLECTED` Generation 至少提供：Project、状态、创建时间、离开 Serving 时间、每个 Object Type 的行数与 Index Units、Link 行数、Source Forecast、物化测量字节（若已物化）、最近成功代标记，以及全部活动引用根。

`measurementComplete=true` 只能由受信 Inventory Scanner 产生，不能由普通发布调用方自行声明。已物化内容缺失统计、索引库存或引用扫描时不得准入。

容量分类：

| 分类             | 判定                                                     |
| ---------------- | -------------------------------------------------------- |
| `SERVING`        | Channel 或 Serving Head 可达                             |
| `RECENT_SUCCESS` | 无活动根，但属于每 Project + Member 最近两个成功非活动代 |
| `PROTECTED`      | Token、Query、Job、Hold 或 Historical Root 可达          |
| `STAGING`        | 正在构建或失败但尚未清理的 Staging                       |
| `ORPHAN`         | 不属于以上分类、仍占物理空间                             |

分类只解释占用，不改变总账：除 `COLLECTED` 外全部计入物理字节。`steady` 排除 Staging；`peak = steady + Staging + Failed Staging`。

### 6.2 默认字节预算

所有预算使用 150% 预留后的字节，不直接使用 497 MiB 实测基线：

| 范围                           |   正常上限 |         硬上限 |
| ------------------------------ | ---------: | -------------: |
| 单 Release Serving Generations |      2 GiB |          3 GiB |
| Project Steady                 |      8 GiB |              — |
| Project Peak                   |     10 GiB |         12 GiB |
| 容量审批期限                   | 最长 30 天 | 不可越过硬上限 |
| 非活动 GC Grace                |  最少 7 天 |   不可审批缩短 |

`12 GiB` 是 Project 投影物理库存的有限硬上限，不是磁盘总量。Project 数量若无限，跨 Project 共享表的总字节和 Index Catalog 仍会无界；在 G2-07 用真实磁盘、多 Project Index 和 WAL/VACUUM 基准建立部署级 Admission 前，Kernel Alpha 参考部署最多允许 **1 个 data-bearing Project**。可以创建其他空/Draft Project，但其 Materialization 必须返回 `CAPACITY_DEPLOYMENT_PROJECT_LIMIT_EXCEEDED`。这不是长期产品限制，而是当前证据能支持的有限运行包络。

生产部署仍需为 PostgreSQL WAL、VACUUM、临时文件、备份、其他表和故障恢复保留独立磁盘水位；这些属于 G2-07 部署容量，不能消费本模型的 Project 投影额度。G2-07 只有在加入部署级总字节、总物理索引数和最低空闲磁盘 Gate 后才能提高 data-bearing Project 上限。

### 6.3 与 ADR-007 数量上限的对齐

固定场景以一份完整 G1 Shape 为 745.5 MiB 预留：

| 场景                                               | 物理 Cohorts |             预留 | 结果                       |
| -------------------------------------------------- | -----------: | ---------------: | -------------------------- |
| 32 个 Serving Releases 共享 8 份数据 + 2 个 Recent |           10 | 7.280 GiB steady | 正常通过                   |
| 上述场景再建 1 份 Staging                          |           11 |   8.008 GiB peak | 正常通过                   |
| 再由 3 份调查 Hold 阻止 GC，并保留 Staging         |           14 |  10.192 GiB peak | 超正常，需审批             |
| 16 份物理 Cohorts                                  |           16 |       11.648 GiB | 低于硬上限但几乎无构建余量 |
| 16 份再增加 1 份 Staging                           |           17 |       12.376 GiB | 硬拒绝                     |

因此 ADR-007 的 32/8 正常数量可以在基准 Shape 下运营；64/16 是不可自动承诺的控制面硬边界，是否能到达仍受本 ADR 字节上限约束。到达 16 份物理数据后无法再构建完整 Staging，不得把 64/16 解读成“系统保证始终可以继续 Refresh”。

## 7. 准入与 Cutover 顺序

### 7.1 Release Definition Staging

1. 从不可变 Release Pins 读取 Property 能力和 Evidence；
2. 编译 Candidate Index Plan；
3. 扫描完整保留物理 Index Inventory；
4. 计算 Candidate + Inventory Union；
5. 任一硬错误立即拒绝；正常超额只有合法审批才能继续。

### 7.2 Generation Staging

1. 使用预期行数、Candidate Index Units 和 Snapshot Source Forecast，把拟建 Generation 加入 Project Peak；
2. 容量不通过时不启动大规模 Build；
3. Build 完成后读取真实 Heap + Index 字节；
4. 以实际值和 G1 外推值的较大者重新执行 Index/Capacity Admission；
5. 只有二次检查通过，Generation 才能进入 READY。

### 7.3 Cutover

Cutover 使用 ADR-007 的最新 `control_revision`。事务前再次读取最新 Inventory Revision、Serving/Protected Roots 和审批状态；任何库存变化、审批过期、测量缺失或预算突破都取消切换，旧 Activation 继续服务。

Rollback 创建新 Release 和候选 Activation，因此执行同样准入。Refresh 不修改 Release Pins，但新 Staging/Generation 仍执行同样字节检查。创建 Hold 不增加已经存在的物理字节，却会取消未来回收；若它使 steady 超正常或阻断已批准退休计划，也必须先有新的容量审批。

## 8. 容量审批

Index 与 Projection 审批是两个独立的机器检查，可以由同一运维请求承载，但不能用其中一个替代另一个。审批必须：

- 绑定一个 Project 和明确审批 ID；
- `approvedAt <= now < expiresAt`，总时长不超过 30 天；
- 分别声明允许的 Release、Project Index/Byte 上限；
- 指定至少一个计划退休 Release；
- 计划退休项必须是库存中真实存在的 Serving Release，并满足 `supportUntil + 7 天 GC Grace <= expiresAt`；
- 不超过任何硬上限。

审批过期不删除现有内容。已有服务可以继续，GC 仍保护所有根。ADR-007 所说的“已有占用内安全 Refresh”在这里严格定义为：Candidate 的总字节、steady、peak、Index Union、物理索引数和每个既有超额 Scope 均不增加；复用完全相同 Generation/Index Plan 或收缩可以继续。任何新增 Staging 字节、新 Index Signature 或新超额 Release 都必须拒绝，直到占用回到正常区间或获得新审批。不得提前退休仍在 90 天支持窗内的 Release 来制造容量。

## 9. GC Contract

### 9.1 权威输入与不可回收引用

GC 输入是一个绑定 `inventory_revision` 的完整 Project 快照，包括 Generation/Index 库存、测量、生命周期和以下引用根：

- Channel；
- 每个仍支持 Release 的 Serving Head；
- 未过期 Active Preflight Token；
- 未结束且未超租约的 Query；
- Active Job；
- Active Investigation Hold；
- Historical Action、ChangeSet 或 Artifact Reference。

Hold 必须在其权威记录中具有 Owner、Reason 和下一次 Review；Review 到期或逾期不意味着可以跳过引用，只有显式关闭 Hold 才移除根。只有 Query Lease 和 Preflight Token 可以通过合同化 `expiresAt` 自动停止保护；Serving Head、Channel、Job、Hold 和 Historical Root 不接受通用过期字段。最近两个成功非活动代由 Materialization Inventory 按 Project + Member + 成功时间推导，不能由 GC 调用方随意把布尔值改为 false。

### 9.2 保留与 dry-run

无活动根的内容仍保留：

- 每 Project + Member 最近两个成功非活动 Generation；
- 从 `max(created_at, left_serving_at)` 起不足 7 天的 Generation；
- 上述 Generation 对应且仍被物理库存需要的 Revision Index Plan。

Dry-run 必须列出：Candidate、Retained、Protected、每项原因、每项预留字节、合计可回收字节、Inventory Revision 和阻断原因。引用或测量扫描不完整时返回 `BLOCKED`，Candidate 必须为空，不能降级为“尽力删除”。

### 9.3 Commit 安全

GC Commit 只接受同一 Project、同一 Inventory Revision 的 READY Plan，并在事务内重新检查候选反向引用和保留条件。新增 Hold、Job、Token、历史引用、Serving 切换或生命周期变化都会使旧 Plan stale。物理索引只有在所有 Serving、Recent、Protected、Staging Generation 都不再需要其签名后才能进入 DDL drop 计划。

删除顺序由 DB-02/DB-04 实现，但必须先移除不可见派生行，再在没有引用时迁移 Generation 生命周期；不得依赖 `CASCADE` 绕过引用检查。失败和重试必须幂等，部分删除不能让仍可服务 Activation 缺行或缺索引。

## 10. 错误与失败安全

发布接口必须保留机器可判定的错误族，至少包括：

| 错误族                                       | 行为                                       |
| -------------------------------------------- | ------------------------------------------ |
| `INDEX_*_BUDGET_EXCEEDED`                    | Candidate 不进入 Publish/Cutover           |
| `INDEX_HARD_LIMIT_EXCEEDED`                  | 不可用审批绕过                             |
| `INDEX_INVENTORY_INCOMPLETE`                 | 补全物理索引库存后重试                     |
| `CAPACITY_*_BUDGET_EXCEEDED`                 | 返回 Scope、Actual、Limit 与审批需求       |
| `CAPACITY_HARD_LIMIT_EXCEEDED`               | 不可用审批绕过                             |
| `CAPACITY_DEPLOYMENT_PROJECT_LIMIT_EXCEEDED` | Foundation 拒绝第二个 data-bearing Project |
| `CAPACITY_HOLD_REVIEW_OVERDUE`               | Hold 继续保护；Review 前阻止准入与 GC      |
| `CAPACITY_MEASUREMENT_INCOMPLETE`            | Staging/Publish fail closed                |
| `GC_REFERENCE_SCAN_INCOMPLETE`               | 不生成可提交删除计划                       |
| `GC_PLAN_STALE`                              | 重新扫描和 dry-run，不直接重试删除         |

Health 必须展示 steady/peak、分类字节、各 Release serving bytes、Index Union、物理索引数、审批 ID/到期时间和接近硬上限的不可构建状态。告警不能代替发布前拒绝。

## 11. 已拒绝方案

| 方案                                        | 拒绝原因                                                     |
| ------------------------------------------- | ------------------------------------------------------------ |
| 每个 Object Type 或 Release 一张 Current 表 | DDL/迁移/连接与运维成本随用户定义增长，破坏通用 Kernel       |
| Release/Channel 进入投影主键                | 可变指针污染不可变数据身份，Refresh/共享无法安全复用         |
| 给全部 JSONB/Property 建一个全局 GIN        | G1 已证明索引显著放大写入；也不能正确提供类型化排序和 Unique |
| 只按 Serving Release 计算 Index/容量        | 会漏掉 Recent、Staging、Hold、Job 和历史引用的真实占用       |
| 只在发布后告警                              | 此时旧支持窗与新内容都不能安全删除，已经没有可恢复决策点     |
| 用估算值覆盖更大的实测值                    | 表结构、数据分布和 Index Recipe 变化会系统性低估容量         |
| 超硬上限后自动退休或强制 GC                 | 违反 90 天支持与引用安全，可能删除正在使用的内容             |
| 引用扫描失败时“尽力回收”                    | 不完整负面证明不能证明对象未被引用                           |

## 12. 可执行证据与 DB-02 Gate

本 ADR 的可执行证据：

- `shared-projection.ts`：共享表键、逻辑唯一性和禁止 Selector；
- `g1-baseline.ts`：G1 Hash、497 MiB 归一基线、150% 预留和写放大外推；
- `index-plan.ts`：声明编译、Revision Scope、稳定命名、完整库存与预算；
- `capacity.ts`：分类、字节预算、审批、GC dry-run 与 stale commit；
- `*.test.ts`：固定场景和固定种子 property-based 测试。

G2-02-03 已证明正式 Migration 的共享键、Link Endpoint Unique、复合租户/Revision 约束和最小权限与本合同一致；仍未证明：

- 新 Link Endpoint 唯一约束、复合租户键和 Revision Predicate 的实际额外字节与 Planner 成本；
- `CREATE/DROP INDEX CONCURRENTLY`、VACUUM、WAL 和磁盘水位下的运维时间；
- 故障注入与并发 Cutover/GC 下仍保持同样不变量。

红队、Intended-vs-Implemented 审查和 G2-00-04 clean-room Evidence 已 PASS，因此本 ADR 为 Accepted。Accepted 只满足 DB-02 的这一项前置条件，不代表 DB-02 自动通过或可以绕过其他 G2-00 依赖；DB-02 必须用等价 100k/1m 数据重新测量新增固定约束与索引，并把真实值作为准入下界。若实测导致正常或硬场景不成立，先收紧数量/能力或正式修改 ADR/PRD，不能删除安全边界。
