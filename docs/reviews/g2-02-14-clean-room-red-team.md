# G2-02-14 Clean-room Materialization Red Team

- 日期：2026-08-17
- 方法：先钢人化“G2-02 已形成可生产化数据运行面”的主张，再按影响 × 可能性 × 最低验证成本攻击承重假设
- 结论：**PASS**（G2-02-14 未发现未关闭 P1/P2；当时只放行 G2-03 任务包与红队，不放行直接编码 Query 或宣称完整产品可用）
- 后续状态：G2-03 任务包现已冻结；当前只放行 G2-03-01

## Top Kill-Assumptions

### 1. clean-room 可能只是换目录运行，仍依赖开发机状态

- **Claim：** 一个全新 Runner 能从空状态复现。
- **Fails if：** 使用已有数据库、Bucket、容器卷、未提交文件、缓存生成物或开发机固定端口。
- **Evidence：** 正式运行绑定 clean commit；创建唯一 PG/S3 命名卷、数据库、Bucket、OIDC Key 和临时角色；空库应用 21 个 Migration；Teardown 后无依赖残留。
- **状态：CLOSED。**

### 2. 100k/1m 可能只跑数据库脚本，没有穿过产品入口

- **Claim：** 性能数字来自 HTTP/S3/生产 Worker/DDL/PG 同一条路径。
- **Fails if：** 直接 COPY 最终表、跳过服务端 Finalize、测试 Adapter 代替生产 Worker，或预建 READY Generation。
- **Evidence：** 31.9 MB CSV 经 Admin HTTP 受管上传和服务端 Finalize；正式组合根跑八阶段、隔离 DDL、Owner Activate/Publish；首轮和 Refresh 都形成三个 Generation。
- **状态：CLOSED。**

### 3. 平均性能掩盖尾延迟或长事务

- **Claim：** Cutover 是短事务，固定规模下尾部仍安全。
- **Fails if：** 只报一次或平均值，P95/最大值依赖扩大锁超时。
- **Evidence：** 20 个样本全部保留为整数微秒；P95 109.582 ms、max 110.406 ms，远低于 1 秒/5 秒阈值；未改变阈值。
- **状态：CLOSED。**

### 4. 坏刷新或并发观察可能看到混合 Group

- **Claim：** 用户只见旧完整 Group 或新完整 Group。
- **Fails if：** 坏 v2 移动 Pointer，或 v3 Cutover 逐成员更新导致新 Object + 旧 Link。
- **Evidence：** 坏 v2 dead letter 且旧 Activation 不变；v3 切换期间高频轮询集合只有旧/新两个完整 Activation；Prepared 状态无残留。
- **状态：CLOSED。**

### 5. GC 与后台清理竞态可能删除当前 Root

- **Claim：** Root 变化时 GC 保守失败，不继续旧计划。
- **Fails if：** 503 使用新幂等键制造双计划，或 409 后重试旧 Plan，或 `affectedRows=0` 被当成无需核对的成功。
- **Evidence：** 正式运行实际触发一次扫描阶段 503，使用同键重试；代码对 Plan 后 409 创建新 Dry-run/新 Digest；最终明确核对孤儿对象不存在、Candidate=0、Serving Root 不变。
- **状态：CLOSED（实际触发并验证）。**

### 6. “重启恢复”可能只重启进程，未重启数据依赖

- **Claim：** 整个依赖组停止/启动后无需修库。
- **Fails if：** PG/S3 容器未停、Migration 重放写入、随机 Host Port 变化导致假失败，或索引在 Catalog 中丢失。
- **Evidence：** PG 与 S3 都 stop/start，OIDC/API/Worker 重建；Host Port 33357→33358 后重新解析；Migration no-op；四索引 READY/存在；状态 Hash 前后一致。
- **状态：CLOSED（发现端口假设并返工）。**

### 7. 容量 PASS 可能来自低估或审批绕过

- **Claim：** 准入使用完整真实库存，12 GiB 不能审批突破。
- **Fails if：** 只用 256 MB Source Forecast，忽略 5.67 GB 实测；GC 后沿用陈旧测量；审批可越过 hard peak。
- **Evidence：** 最终选择 5,672,337,408 bytes；实时 Generation Inventory Migration；超硬上限拒绝且审批不能改变硬拒绝。
- **状态：CLOSED。**

### 8. 最小权限可能为跑通全量而放宽

- **Claim：** API、Worker、DDL 仍是三条独立信任边界。
- **Fails if：** API 直写事实表、Worker 读取授权表、DDL 读取 Metadata 或任一角色持有 Migration Owner。
- **Evidence：** 三项反向 SQL 均拒绝；OIDC/跨项目/上传/错误脱敏负测同场景通过；凭据不进入报告。
- **状态：CLOSED。**

### 9. 两领域可能靠硬编码分支，第二项目限制可能失效

- **Claim：** Commerce 与 Work Management 使用同一 Kernel，且 Alpha 只允许一个 data-bearing Project。
- **Fails if：** 领域名进入核心分支，或第二 Project 可先构建再靠文档约束。
- **Evidence：** 两领域从同一 Fixture/Definition/Mapping 路径建立；第二项目完成 Metadata、Index 与上传后，在 Job 入口由数据库事实稳定拒绝；Scope/Dependency 未出现领域包。
- **状态：CLOSED。**

### 10. G2-02 PASS 可能被夸大为完整 Palantir 产品

- **Claim：** 结论只覆盖 Materialization Kernel。
- **Fails if：** 报告声称 Query、Policy、真实 Overlay、Action、UI、SDK、HA 或生产上线已完成。
- **Evidence：** 机器报告和 Evidence 都固定列出 `G2-03 Query/Policy`、`G2-04 PostgreSQL Overlay/AC-03`、UI、SDK 为 deferred；范围黑名单机器拒绝新增路径。
- **状态：CLOSED。**

### 11. GitHub Required Check 可能在正确结果产生前超时

- **Claim：** 最终 PR Head 能在远端执行与专用 Runner 相同的 32 Gate。
- **Fails if：** Workflow 仍使用 30 分钟 Job 超时，而单次正式 clean-room 已约 39 分钟。
- **Evidence：** Workflow 超时调整为 90 分钟；源码 Guard 要求超时不得低于 90 分钟、只允许一个 `run:` 且精确为 `npm run verify`；Artifact 仍使用 `always()` 上传，未拆分或跳过性能/恢复 Gate。
- **状态：CLOSED（实际发现并返工）。**

## 风险排序

| 风险                   | 影响 | 可能性（验证前） | 最低验证成本 | 处理结果                          |
| ---------------------- | ---: | ---------------: | -----------: | --------------------------------- |
| GC 竞态错误删除        |    5 |                4 |            3 | 真实竞态 + fail-closed 重试，关闭 |
| 重启后状态/索引丢失    |    5 |                3 |            3 | 整体重启 + Hash/Catalog，关闭     |
| 100k/1m 不走正式路径   |    5 |                3 |            4 | 同场景 HTTP/S3/Worker/DDL，关闭   |
| Cutover 长尾或混合成员 |    5 |                3 |            4 | 20 样本 + 并发观察，关闭          |
| 容量低估突破硬上限     |    5 |                3 |            3 | 实时库存取大 + 超限反例，关闭     |
| 权限为跑通被放宽       |    5 |                2 |            2 | 三角色反向 SQL，关闭              |
| 范围被夸大             |    4 |                4 |            1 | Deferred + Scope Guard，关闭      |

## 仍未评估（明确属于后续 Gate）

- G2-03：真实 Query HTTP、业务 OIDC、Policy Compiler/Gateway、Get/Search/Traversal/Count/Cursor。
- G2-04：真实 PostgreSQL Overlay Store、W0/W1 集成复跑、Conflict/Action 与完整 AC-03。
- 后续 Operations：HA、PITR、对象存储灾备、告警、SLO 运行和发布值班。

## 决策

所有 G2-02-14 承重假设都已有真实依赖、故障注入、规模数据或机器 Manifest 支撑；验收中发现的问题均在原范围内修正，没有降低停止条件。G2-02 可标记 **PASS（14/14）**。

本审查结案时的下一步是创建并红队审查 **G2-03 Query + Policy 任务包**；该步骤现已完成。现行规划只放行 [G2-03-01](../delivery/g2-03-query-policy-task-pack.md)，其未 PASS 前不得直接添加正式 Query Endpoint；G2-04 前不得移除 zero-overlay 生产限制。
