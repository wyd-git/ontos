# G2-02-14 Clean-room Materialization 总验收 Evidence

- 日期：2026-08-17
- 结论：**PASS**（代表 G2-02 Materialization 14/14 完成；不代表 Query、真实 Overlay、UI、SDK 或完整产品已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-14](../delivery/g2-02-materialization-task-pack.md#g2-02-14执行-clean-room-materialization-总验收)
- 原始报告：[G2-02-14 Clean-room Report](g2-02-14-clean-room-report.json)
- 一致性复审：[Intended-vs-Implemented](../reviews/g2-02-14-intended-vs-implemented.md)
- 专项红队：[G2-02-14 Red Team](../reviews/g2-02-14-clean-room-red-team.md)

## 1. 验收结论

在独立 Ubuntu 24 / x86_64 / 8 vCPU / 16 GB Runner 上，从 clean checkout、空 PostgreSQL 数据库和空版本化对象存储开始，真实启动 PostgreSQL、SeaweedFS S3、OIDC、Admin HTTP、生产 Worker 与隔离 DDL Executor，完成以下闭环：

```text
R1 / A0
  → 受管 CSV 上传与服务端 Finalize
  → R2 三成员 Runtime Plan（2 Object + 1 Link）
  → 100k Object / 1m Link 八阶段构建
  → Owner Activate / Publish
  → 坏 v2 死信且旧代继续服务
  → 好 v3 全量 Refresh 与原子切换
  → 容量、安全和 GC
  → PostgreSQL + S3 + OIDC + API + Worker 整体重启
  → Migration no-op、索引仍在、持久状态 Manifest 不变
```

正式资格运行绑定代码提交 `29024bab891d38f5128d0f423c38de6890c8fe00`，`cleanCheckout=true`。机器报告规范摘要为 `sha256:f1d23f619d91208371f439a666824ea318d0b15aefb9e7ce6368ca144a55fa5e`；仓库内格式化 JSON 副本的文件 SHA-256 为 `65211614524b11b9ef838313014bfe7ae88eeb04b3f291572f75d26eec2dfd23`。统一 `npm run verify` 会在最终提交上重新生成同提交绑定的总 Manifest，避免用手工文档替代机器判定。

## 2. 环境与可复现边界

| 项目            | 正式值                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Runner          | Ubuntu 24，x64，8 vCPU，16,768,651,264 bytes RAM                                                                             |
| CPU             | Intel Xeon E5-2673 v4 @ 2.30 GHz                                                                                             |
| Node / Docker   | Node 24.18.0 / Docker 29.7.2                                                                                                 |
| PostgreSQL      | 16.14 Bookworm，镜像与 Image ID 均绑定 SHA-256                                                                               |
| S3              | SeaweedFS 4.41，开启版本化，镜像与 Image ID 均绑定 SHA-256                                                                   |
| PostgreSQL 配置 | `shared_buffers=163848kB`、`work_mem=4096kB`、`maintenance_work_mem=65536kB`、`max_wal_size=1024MB`、`synchronous_commit=on` |
| 冷/热定义       | 冷：空命名卷；热：同一持久卷整体 stop/start 后继续                                                                           |
| Migration       | 空库应用 21 个；整体重启后二次运行 0 个、`noOp=true`                                                                         |

正式命令是：

```text
npm run test:materialization-clean-room
npm run verify
```

测试自行创建唯一容器、数据库、Bucket、OIDC Key、端口和临时凭据，结束时 Teardown；不读取开发机已有数据库、Bucket、缓存或业务数据。Docker 随机发布的 PostgreSQL Host Port 在重启后可能变化，Runner 会重新解析并重建 API/Worker/DDL 连接配置，不把旧端口误判为数据库恢复失败。

## 3. 规模、性能与容量

| 指标           |                                  实测 |                   Gate |
| -------------- | ------------------------------------: | ---------------------: |
| Object Rows    |                               100,000 |                100,000 |
| Link Rows      |                             1,000,000 |              1,000,000 |
| Source Bytes   |                            31,900,035 |                   记录 |
| 冷端到端构建   |          998,564 ms（约 16 分 39 秒） |         < 1,800,000 ms |
| 热全量 Refresh |          740,459 ms（约 12 分 20 秒） |         < 1,800,000 ms |
| Cutover        | 20 次；P95 109.582 ms；max 110.406 ms | P95 < 1 秒；max < 5 秒 |
| WAL            |                   5,333,764,768 bytes |                   记录 |
| Node Peak RSS  |                     688,840,704 bytes |                   记录 |
| 非预期错误率   |                                     0 |                      0 |
| 预期拒绝 Job   |                                     1 |         坏输入必须拒绝 |

容量准入先比较 Source Forecast 与实时库存，取较大值。正式运行中 Forecast 为 256,000,000 bytes，实测库存为 5,672,337,408 bytes，准入采用后者；正常构建通过，超过 12 GiB 硬上限的请求被拒绝，受限审批记录可创建但不能突破硬上限。第二个 data-bearing Project 使用 Work Management Fixture 走同一 Metadata、Index、上传与 HTTP 路径，并在启动物化时稳定返回 `MATERIALIZATION_PROJECT_LIMIT_EXCEEDED`，没有领域分支或第二项目旁路。

## 4. 生命周期、原子性与恢复

- 从不可变 R1/A0 开始，新 R2 才加入 Commerce 的 `Customer`、`Order` 和 `CustomerPlacedOrder` 三成员 Group；R1/A0 未被回写。
- 首次 Job 与完全相同的幂等重放返回同一 Job；八阶段均完成，三个 Generation 都为 READY。
- 主键冲突的坏 v2 进入 `dead_letter`，活动 Serving Head 保持旧 Activation；错误输入没有部分可见。
- 好 v3 完成同规模刷新；并发轮询只观察到旧 Activation 或新 Activation，没有混合成员；Refresh 重放返回同一响应。
- 20 次 Prepare/Commit 后不存在遗留 Prepared 状态，短事务延迟满足 SLO。
- 所有 Job 阶段的 PID Kill/Lease/Fencing 由 `materialization-worker-postgres` Gate 覆盖，Cutover/GC 的连接与 Backend Kill 由 `postgres-integration` Gate 覆盖；总 Gate 将这些 Gate 与本次全量结果绑定在同一 Manifest 中。
- 整体停止并启动 PostgreSQL、S3、OIDC、API 与 Worker 后，四个 Projection Index 都处于 READY 且真实 Catalog 存在；Catalog 摘要为 `sha256:0699448ae824310619512d97995de86b58c989de87aaa0beb3882f31a218ed87`。
- 重启前后持久状态 Manifest 均为 `sha256:396952d56751156c1938a684a9e7b4032dabd6a41b1d3b9bf46c49a30337e0d5`，不需要手工改库、改 Pointer 或重建索引。

## 5. 安全、GC 与信任边界

以下负向断言全部为真：无效 OIDC 拒绝、无成员 Project 隐藏、跨 Project 同形隐藏、上传路径穿越拒绝、API 直写业务表拒绝、Worker 读取授权表拒绝、DDL 身份读取 Metadata 表拒绝、错误响应敏感信息脱敏。

GC 正式路径形成规范 Plan 并到达 `COMMITTED`，同时确认孤儿对象版本已回收。本次 GC Dry-run 与受管上传后台清理发生一次真实竞态：第一次 Root 扫描返回可重试 `DEPENDENCY_UNAVAILABLE`，调用方使用同一幂等键重试；后台清理先回收孤儿，因此 GC Commit 的 `affectedRows=0`。这不是把空删除包装成成功：最终对象版本不存在、Plan 无剩余 Candidate、Serving/历史 Root 未受影响。若 Root 在 Plan 后变化，代码会以 `GC_PLAN_STALE` 拒绝旧 Plan，并以新 Plan/Digest 重扫，不重试旧删除决定。

生产 Overlay Provider 仍严格为 `certified-zero-overlay-only`。W0/W1 只由正式对抗 Port/Fixture 证明算法与排序锁，不声称 PostgreSQL Overlay Store 已实现；真实 Overlay 与 AC-03 复跑仍由 G2-04 拥有。

## 6. 逐条对照 G2-02-14 Acceptance

| 任务包要求                             | 机器证据                                                             | 状态 |
| -------------------------------------- | -------------------------------------------------------------------- | ---- |
| clean checkout、空卷、单命令、Teardown | `cleanCheckout=true`；空 PG/S3 命名卷；测试内全生命周期管理          | PASS |
| R1/A0、首成员、坏/好 Refresh、幂等     | `lifecycle.*` 全真；旧/新 Pointer 观察集只有两个值                   | PASS |
| Job/Cutover/GC Kill/Resume             | 总 Manifest 绑定 Worker 与 PG 故障 Gate；无双 Lease/Activation/Facts | PASS |
| 100k/1m 与 20 Cutover SLO              | 冷 998,564 ms、热 740,459 ms；P95 109.582 ms、max 110.406 ms         | PASS |
| 单数据项目、容量、审批、第二项目、GC   | 实测取大；12 GiB 拒绝；审批记录；第二项目拒绝；GC COMMITTED          | PASS |
| 最小权限与上传/错误安全                | 八项负向安全断言全真                                                 | PASS |
| 整体重启、Migration no-op、状态相同    | 21→0 Migration；Manifest 前后一致；四索引仍 READY/存在               | PASS |
| AC-02 非 Overlay 与 W0/W1 边界         | Base 原子切换为生产证据；Overlay 明确延后 G2-04                      | PASS |
| 独立意图审查与红队                     | 两份 G2-02-14 Review 无未关闭 P1/P2                                  | PASS |
| 总 Manifest 完整绑定                   | `npm run verify` 的 32 个顺序 Gate、输入/镜像/报告/风险摘要机器校验  | PASS |

## 7. 发现并关闭的问题

净室不是一次“跑绿”形成的。正式验收前实际发现并修正了：

1. GC Generation 字节曾来自陈旧测量，改为受信实时库存统计；
2. 上传后台清理与 GC 的 Root Epoch 竞态，补齐同幂等键重试与陈旧 Plan 重扫；
3. Docker 重启后随机 Host Port 改变，补齐端口重解析；
4. GC 删除后容量测量按设计变为 incomplete，重启验收改为只读核对索引 Catalog，而非违规重发 DDL；
5. Cutover 浮点毫秒不能进入规范 JSON Digest，报告改为整数微秒；
6. 总清单仍读取旧毫秒字段且标签停在 G2-02-13，改为微秒 SLO 校验和 G2-02-14 标签，并增加超限反例。

这些返工没有扩大 Query、Policy、Action、Overlay、UI 或 SDK 范围，也没有通过放宽权限、SLO、容量或恢复条件换取 PASS。

## 8. 本结论不包含什么

- G2-02 PASS 只说明系统可以安全、可恢复地把受管 CSV 变成原子激活的 Object/Link Generation。
- 最终用户还不能通过业务 Query API 使用这些数据；OIDC 业务身份、Policy、Get/Search/Traversal/Count/Cursor 属于 G2-03。
- PostgreSQL Overlay/Conflict/Action 和完整 AC-03 属于 G2-04。
- Web、SDK、第二领域完整业务应用、HA、PITR、灾难恢复、生产告警和最终上线验收均未完成。

因此 G2-02 关闭后，只放行 **G2-03 Query + Policy 任务包的编写、可行性复审和红队冻结**；任务包冻结前不直接编码 Query Endpoint。
