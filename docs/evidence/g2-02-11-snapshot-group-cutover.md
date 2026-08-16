# G2-02-11 Snapshot Group 原子 Cutover 与 Data Refresh Evidence

- 日期：2026-08-16
- 结论：**PASS**（只代表 G2-02-11 Cutover 能力；不代表 GC、Materialization Admin HTTP、生产 Worker 全阶段组合、Query Resolver、真实 Overlay 或整个 G2-02 已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-11](../delivery/g2-02-materialization-task-pack.md#g2-02-11实现-snapshot-group-原子-cutover-与数据-refresh)
- 架构决策：[ADR-018](../architecture/adr/018-immutable-head-set-snapshot-group-cutover.md)
- 专项红队：[G2-02-11 Red Team](../reviews/g2-02-11-snapshot-cutover-red-team.md)
- 原始容量报告：[100k Object / 1m Link JSON](g2-02-11-cutover-capacity-benchmark.json)

## 1. 实际交付

| 组件                | 责任                                                                                                                 | 明确不做                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Cutover Application | 严格解析 Project/Group/Version/Control Revision/Idempotency Key，验证 zero-overlay 证据，协调 Prepare/Commit         | 不接收 Member、Generation、Certificate、Activation、Head 列表或 SQL |
| Overlay Port        | 生产只放行稳定零 Overlay；对抗 Adapter 证明 W0..W1 Delta 缺口/重复/冲突均 fail closed                                | 不声称 G2-04 真实 Overlay/Conflict 已实现                           |
| Migration `0016`    | Prepare 候选、不可变 Head Set、Activation Content Binding、固定锁序、短事务 CAS、幂等结果与安全退役                  | 不修改 0001～0015，不执行网络/文件/大批构建/DDL/GC                  |
| PostgreSQL Adapter  | 仅调用受控 Prepare/Commit，稳定映射 stale/not-ready/idempotency/dependency 错误                                      | 不持有 Migration Owner，不直写 Pointer                              |
| 真库 Harness        | 八个故障边界、双 Refresh、Refresh/Publish、丢响应、业务/纯重建 Head Version、多 Release/Channel、20 次性能和 100k/1m | 不用内存状态机代替 PostgreSQL 事务                                  |

## 2. 生产切换流程

```text
READY Generation + Current Certificate + Capacity/Index Admission
  → Prepare：从服务器事实派生完整 Release/Member/Head 候选
  → 长阶段构建不可变完整 Head Set（不可服务）
  → Commit：固定顺序加锁并重验 Control/Plan/Certificate/Inventory/CAS
  → 创建或复用不可变 Activation + Members
  → 一次 Project Head Set Pointer CAS
  → 同事务移动已服务 Release Head 和真正持有者的 Channel
  → 激活新 Generation/Snapshot/Group，仅退役不再被 Serving Head 引用的旧代
```

Prepare 留下的 Candidate/Head Set 不会改变解析结果。任意观察者只从单条 Project Pointer 解析 Object Heads，并从单条 Serving Head/Channel 解析完整 Activation Member 集合，因此无法看到“新 Object + 旧 Link”。

## 3. Acceptance 对照

| 要求              | 实现与可执行证据                                                                                                           | 结论              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 短 Cutover        | 网络/文件/批量写/测量/DDL/Head Set 均在 Prepare 或更早完成；100k Head 最终 Commit 207.474 ms                               | PASS              |
| Group 全旧或全新  | Activation 成员数、Plan Member 和 Certificate 逐项重验；Head/Serving/Channel 均为单 Pointer CAS                            | PASS              |
| 所有 SQL 边界原子 | 八个 Fault Point 后对比 Activation、Member、Head、Serving、Channel、Lifecycle、Job、Control/Inventory 完整快照             | PASS              |
| 并发与 stale      | 双 Refresh 仅一个胜者；Prepare 后 Publish R3 使旧计划冲突；Head Set/Control/Inventory/Certificate/Serving/Channel 全部重验 | PASS              |
| W0/W1             | 生产未知/非零均拒绝；对抗 Provider 注入有序 Delta，证明不缺不重且期望 Head 匹配                                            | PASS（Port 证据） |
| Head 业务版本     | v3 纯 Provenance/Generation 重建只重指向，v4 业务值/生命周期变化才 Version+1；可见 Link 进入语义 Digest                    | PASS              |
| 幂等/丢响应       | 相同 Idempotency Key 和 Activation Content 返回同一 Preparation/Activation；成功后丢响应重试 `reused=true`                 | PASS              |
| 性能              | 缩量稳态 20 次 P95 83.991 ms、max 85.732 ms；正式 100k/1m Commit 207.474 ms                                                | PASS              |
| 最小权限          | API/Worker/Ops 无 Head View/Set/Version/Pointer/内部 Candidate 读写；API 只有公开 Prepare/Commit EXECUTE                   | PASS              |
| 证据不越界        | 明确区分 Base-only 生产原子性、Overlay 对抗 Port 与 G2-04 真实 Overlay 剩余义务                                            | PASS              |

## 4. Intended-vs-Implemented 复审与实际返工

1. **首版“短事务”其实逐行更新 100k Head。** 容量向量上运行 9 分钟仍未完成，触发明确停止条件。本关没有放宽超时，而是改为 Prepare 构建完整不可变 Head Set、Commit 仅一条 Project Pointer CAS，最终为 207.474 ms。
2. **多 Release 候选会重复移动同一 Channel。** 初版循环把每个受支持 Release 都当作 Channel Owner，后来的候选会和前一个自相冲突。现在只有 Prepare 快照中真正拥有 Channel 的 Release 可移动/重验，其他 Release 只创建完整 Activation。
3. **Generation 改变被误当作业务版本改变。** Head 现在分离 Current/Base Digest 和业务语义 Digest；纯 Provenance/Index 重建只重指向，可见 Link/生命周期/值改变才增版本。
4. **Head Set 成员的逐行外键使 Prepare 在容量下过慢。** 已受信 Prepare 只从拥有完整 FK/Certificate 证据的 Current/候选集派生成员；Head Set 表仅保留 Set FK、对 Runtime 全撤权，并用真实权限负测证明无任意写入面。
5. **接口实现不等于生产 Worker 已串联。** 本关已交付正式 Application/PostgreSQL Cutover Adapter，但 `worker:start` 仍 fail closed。这个剩余接缝已明确纳入 G2-02-13；若 13 未接通生产阶段组合，G2-02-14 不得 PASS。

这些修正没有加入 Query、Action、UI、真实 Overlay 或超出 G2-02 的调度能力。

## 5. 正式容量复跑

独立 Ubuntu 24 / x86_64 / 8 vCPU / 16 GiB / PostgreSQL 16.14，从空 PostgreSQL Container 与空数据层执行 100,000 Object + 1,000,000 Link：

| 指标                      |                                结果 |
| ------------------------- | ----------------------------------: |
| Object / Link             |                 100,000 / 1,000,000 |
| Object / Link 主阶段      |                638,956 / 621,632 ms |
| 完整 Projection 构建      |           1,265,067 ms（约 21m05s） |
| Quality Current           |                          170,356 ms |
| Head Set Preparation 行数 |                             100,000 |
| 最终 Commit               |                      **207.474 ms** |
| Project 实际物理字节      |                 2,830,483,456 bytes |
| Capacity Reserved / Peak  | 4,245,725,184 / 4,245,725,184 bytes |
| Node Peak RSS             |                   313,675,776 bytes |
| WAL                       |                 5,153,480,888 bytes |

整体测试 1,313,912 ms（约 21m54s）完成，无失败；构建低于 30 分钟停止线，Peak 低于 12 GiB 硬上限，Cutover 远低于 5 秒硬上限。

- Migration `0016` SHA-256：`46d9695176882fe36d2f3b4a8049ab247b30c80829aef9a904399a904d20b7c1`
- 原始容量 JSON SHA-256：`77addde998db8784b82b0210da514ded43505fb12b2207af3c99f1aa7b66ed50`

## 6. 可复现验证

```text
Node 24.18.0 / PostgreSQL 16.14

npm run test:materialization-control-plane
PASS — 20 tests，含 strict input、zero-overlay、对抗 W0/W1、锁序与状态冲突

node --test --test-concurrency=1 tools/database/materialization-postgres.integration.test.ts
PASS — 连续 Migration 0001～0016、八个 Fault Point、双 Refresh/Publish、权限与 20 次 Cutover
       P95=83.991389 ms, max=85.731624 ms

ONTOS_G2_02_09_CAPACITY=1 \
  node --test --test-concurrency=1 tools/database/materialization-postgres.integration.test.ts
PASS — 100k Object / 1m Link，Head preparation=100k，Commit=207.474 ms

npm run format:check
npm run lint
npm run typecheck
PASS
```

## 7. 交付与运行说明

- Migration 使用唯一 `ontos_migration.schema_migrations` 账本，连续到 `0016`；已发布 0001～0015 不变。
- API/Worker/Ops 不拥有 Head Set/Pointer/内部 Candidate/Fault Function 直接权限；API 只可执行公开 Prepare/Commit。
- 本关没有新增环境变量、密钥、外部 Provider 或客户端 Secret。
- 丢响应后以 Idempotency Key/Preparation/Activation Content 读取结果，不需要人工改 Pointer。
- `worker:start` 在 G2-02-13 完成生产阶段组合前继续 fail closed；本 Evidence 不把 Repository Harness 写成真实 Worker 端到端证据。

## 8. 非结论与下一项

- Generation/Head Set/Index/Artifact 回收仍为 G2-02-12；本关不删除任何历史事实。
- Materialization Admin HTTP、生产 Worker 全阶段组合、Testkit 和统一 CI 仍为 G2-02-13。
- 独立 Clone/空卷的 S3/OIDC/API/Worker/DDL/GC 端到端恢复仍为 G2-02-14。
- 真实 Query Resolver 与 PostgreSQL Overlay 分别属于 G2-03/G2-04。

因此下一唯一允许的工作项是 **G2-02-12：Generation/Index mark-plan-commit GC**。
