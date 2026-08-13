# G2-00-04 Shared Projection、Index Plan 与容量上界验收记录

- 结论：**PASS（仅限 G2-00-04）**
- 执行日期：2026-08-13
- 分支：`agent/g2-00-04-projection-index-capacity`
- 起始 Commit：`976e8e5cabd52ce218acbd5938078cbb3fff7f24`
- 工具：Node.js 24.18.0 / npm 11.16.0 / fast-check 4.9.0
- 环境：macOS 26.5.2（Build 25F84）

本记录对应 [G2-00-04 WWA](../delivery/g2-00-foundation-task-pack.md#g2-00-04adr-008-shared-projectionindex-plan-与容量上界)。最终实现 Commit 由 Draft PR head 记录，避免在被提交文件中写入自身 Commit Hash。

## 1. 验收映射

| WWA 声明                                                   | 实现证据                                              | 执行证据                                                                                      | 结果 |
| ---------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---- |
| 共享表键、唯一性、命名、显式索引、禁止全 Property 自动索引 | `shared-projection.ts`；`index-plan.ts`；ADR-008 §4–5 | Generation-scoped Object/Link Key、Revision Predicate、稳定 63-byte Name、Auto-index-all 负例 | PASS |
| 使用 G1 100k/1m 表/索引和写放大，不篡改原证据              | `g1-baseline.ts`                                      | 精确 497 MiB、3.574×；四个已提交 G1 文件现场 SHA-256 校验                                     | PASS |
| 覆盖活动代、最近成功代、并发 Release、Hold 和 Staging Peak | `capacity.ts`；`fixtures.ts`                          | 32 Releases / 8 Cohorts + 2 Recent + Staging；3 Holds；宽行 Forecast                          | PASS |
| Release/Project 索引预算在发布前拒绝                       | `index-plan.ts`                                       | Object Type/Release/Project normal/hard、完整物理库存、审批与过期非扩张负例                   | PASS |
| GC 输入、不可回收引用、dry-run 和失败安全                  | `capacity.ts`                                         | 七类 Root property、Hold Governance、Incomplete Scan、Stale Plan、Reclaimable Bytes           | PASS |
| 给出有限上界，否则 ADR 不 Accepted                         | ADR-008 §6；`assertFoundationDeploymentEnvelope`      | Project 12 GiB hard；Foundation 最多 1 个 data-bearing Project；硬上限不可审批                | PASS |

## 2. 冻结的合同

### 2.1 Shared Projection

```text
runtime.object_current
  PK     (project, generation, object type resource, object rid)
  UNIQUE (project, generation, object type resource, canonical primary key)

runtime.link_current
  PK     (project, generation, link type resource, link rid)
  UNIQUE (project, generation, link type resource, source rid, target rid)
```

Release、Channel 和显示名称不进入物理身份。Object/Link Revision 是 Generation 的不可变成员约束，并直接进入 Property Partial Index Predicate，避免跨表 Join 或不兼容 Revision 错用表达式索引。

### 2.2 Index Plan

| 指标                              | Normal | Hard |
| --------------------------------- | -----: | ---: |
| 单 Object Type Secondary Units    |     13 |   13 |
| 单 Release Secondary Units        |     80 |  104 |
| Project 保留 Index Union Units    |    120 |  240 |
| Project 保留 Property Index Count |     80 |  160 |

每个动态索引必须引用受信 Release Evidence Catalog 中存在的证据。Project Union 输入覆盖 Serving、Recent Successful、Protected 和 Staging Plan；相同物理签名跨 Release 去重。超过 normal 需要最长 30 天的审批和真实可回收 Serving Release；超过 hard 不可审批。

### 2.3 Projection Capacity

G1 归一后一个 100k Object / 1m Link Cohort：

- Measured：`521,142,272 bytes = 497 MiB`；
- 150% Reserved：`781,713,408 bytes = 745.5 MiB`；
- Write-time Ratio at 13 units：`3.574×`。

准入使用 `max(G1 row/index estimate, Source Forecast, Staging Measurement) × 150%`。

| 指标                             | Normal |                Hard |
| -------------------------------- | -----: | ------------------: |
| 单 Release Serving Bytes         |  2 GiB |               3 GiB |
| Project Steady                   |  8 GiB |                   — |
| Project Peak                     | 10 GiB |              12 GiB |
| 非活动 GC Grace                  |   7 天 |            不可缩短 |
| Foundation data-bearing Projects |      1 | 1，G2-07 前不可提高 |

32 个 Serving Releases 共享 8 个物理 Cohorts，加 2 个 Recent 和 1 个 Staging 时 Peak 为 8.008 GiB；16 个 Cohorts 加一个 Staging 为 12.376 GiB，硬拒绝。

## 3. 红队与 Intended-vs-Implemented 结果

[专项审查](../reviews/adr-008-shared-projection-red-team.md)在 Accepted 前关闭了以下合同漂移：

- Project Index 最初漏计 Recent/Protected/Staging 实体；
- G1 Hash 常量最初没有现场读取文件复核；
- 宽 Property/JSON 在 Build 前只有行数外推；
- 审批可以引用 ghost Release，且没有为 7 天 GC Grace 留时间；
- 审批过期后的 non-expanding Refresh 没有差量定义；
- Hold 缺少 Owner/Reason/Review，非租约 Root 可以滥用通用 Expiry；
- 相同 Release ID 可以更换 Index Plan；
- Release Serving Set 没有绑定同一 Release 的 Serving Head；
- 单 Project 上界可被无限 Project 数量相乘；
- Index Evidence Ref 只检查非空，没有解析 Evidence Catalog。

修正后没有仍未关闭、且属于 G2-00-04 纯合同范围的 Intended-vs-Implemented 漂移。尚不存在的 PostgreSQL Migration、Repository、Worker 和业务 Endpoint 不被计为已实现。

## 4. 可复现执行

### 4.1 Clean install

```text
NODE_VERSION=24.18.0 /Users/wangyudong/.nvm/nvm-exec npm ci
toolchain: PASS (node 24.18.0, npm 11.16.0)
added 135 packages
```

### 4.2 全仓验证

```text
NODE_VERSION=24.18.0 /Users/wangyudong/.nvm/nvm-exec npm run verify

check:toolchain     PASS
format:check        PASS
lint                PASS
typecheck           PASS
test:unit           PASS — 70/70
check:architecture  PASS
```

其中 G2-00-04 专项为 35/35：固定场景、负例和固定种子 `20260813`、每项 200 次的 property-based tests 全部通过。`test:projection-capacity` 已接入仓库标准 `test:unit`，不是独立手工命令。

### 4.3 Artifact Digest

命令：

```text
shasum -a 256 tools/projection-capacity/*.ts | shasum -a 256
```

结果：

```text
f0f21cb76ecad78d86c82bd35a235e0b39de9068ab9bff80715392df2bb0046a
```

该 Digest 覆盖本次 clean-room 验收时的模型、Fixture 和测试；后续代码变更必须重新生成 Evidence，不得沿用本结论。

## 5. 未关闭但不冒充已完成的下游 Gate

G2-00-04 PASS 证明的是合同有限、可计算、可测试，不证明实际数据库已经满足：

- DB-02 最终复合键、Endpoint Unique 和 Revision Partial Index 的真实字节；
- 1/80/160 Property Index 下的 INSERT、Planner、WAL 和 Concurrent DDL 成本；
- Snapshot Source Forecast 对真实宽 Property/JSON 的误差；
- 多 data-bearing Project 的部署级总字节、总 Index 数和最低空闲磁盘；
- DB-02/DB-04 并发 Cutover、GC 与故障恢复原子性。

这些风险分别由 DB-02、G2-07 和 DB-04 拥有。在对应证据完成前，不得提高 1 个 data-bearing Project、12 GiB Project Hard、160 Property Index Hard 或把 Foundation 模型宣传为生产数据库实现。
