# G2-02-09 Index Plan、容量准入与受信 DDL Evidence

- 日期：2026-08-16
- 结论：**PASS**（只代表 G2-02-09；不代表 Compatibility Certificate、真实 Group Cutover、GC、Admin HTTP、Query/UI 或整个 G2-02 已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-09](../delivery/g2-02-materialization-task-pack.md#g2-02-09实现-index-plan容量准入与受信-ddl-执行)
- 架构决策：[ADR-008](../architecture/adr/008-shared-projection-index-capacity.md)、[ADR-014](../architecture/adr/014-materialization-transaction-ddl-overlay-boundary.md)
- 专项红队：[G2-02-09 Red Team](../reviews/g2-02-09-index-capacity-ddl-red-team.md)
- 原始基准：[100k Object / 1m Link JSON](g2-02-09-projection-capacity-benchmark.json)

## 1. 实际交付

| 组件                           | 责任                                                                                                                             | 明确不做                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Index/Capacity Domain          | Published Property 能力覆盖、11 个白名单 Recipe、稳定签名/名称、Release/Project 预算、G1/Forecast/实测较大值、硬上限、GC dry-run | 不提供 Query/UI，不把全部 Property 自动索引         |
| Application Services           | 编译、库存准入、不可变报告摘要、持久 Index Plan/容量准入                                                                         | 不接受 Raw SQL、表名或客户端“库存完整”布尔值        |
| Migration `0014`               | `pg_trgm`、生命周期 Predicate、Forecast/Measurement/Admission、DDL Request、受控函数、不可变事实与最小 Grant                     | 不修改 0001～0013，不提前删除 Index                 |
| PostgreSQL Adapters            | 真实 Release/Pin/Published Object Type 重验、保留 Index Inventory、完整 Project 容量快照、Catalog/物理字节扫描                   | 默认不臆造容量审批；缺预测、测量或 Index 状态即拒绝 |
| `apps/projection-ddl-executor` | 专用登录、单 Request ID、结构化 Plan 重算、Catalog 双向核验、`CREATE INDEX CONCURRENTLY`、Kill/Replay                            | 不复用 API/Worker Secret，不接受 SQL/Identifier     |
| 真实 Harness                   | 全 Recipe、权限、篡改、同名异定义、SIGKILL、复用、100k/1m、冷/热查询和缩量最终回归                                               | 不冒充 G2-02-14 HTTP/S3/OIDC clean-room             |

## 2. Acceptance 对照

| 要求                            | 实现与可执行证据                                                                                                                                                                               | 结论 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Published Property → 规范 Plan  | 编译器逐项校验能力、类型、Evidence、Predicate、名称和预算；生产 Repository 再读取真实 Release Pin、Published Revision 内容与 Digest，拒绝计划外 Property、类型、JSON Path 或遗漏能力           | PASS |
| 跨 Release 复用与不可变 Release | Admission 持久化真实 `release_id + release_plan_digest`；同签名复用同一 Plan/Index，第二 Release 全部 `reused=true`；原 Release 改方向被拒                                                     | PASS |
| Catalog/Inventory fail closed   | Planned/Building/Failed 任一存在即库存不完整；同名异定义、持久 Definition 篡改、未跟踪 Catalog Index 和签名 Comment 不符均拒绝                                                                 | PASS |
| 独立最小 DDL 边界               | API/Worker 真实 Login 不能 DDL、读 Request 或 `SET ROLE`；Executor 只读一个 UUID Request，DDL 登录无 CreateDB/CreateRole/Superuser                                                             | PASS |
| Concurrent DDL 与恢复           | 11 个 Recipe 在事务外逐一创建；进程阻塞后 SIGKILL，Request/Inventory 保持非成功，重放按 Catalog 收敛；Invalid 不会标 READY                                                                     | PASS |
| Build 前/后容量准入             | 生产 Loader 在 Repeatable Read 中读取全 Project Generation、Source Forecast、Serving Head/Channel、Index Units、Generation Measurement 与当前物理 Measurement；后建再次以 Catalog 实测作为下界 | PASS |
| 有限运行包络                    | 1 个 data-bearing Project、8 GiB steady、10 GiB normal peak、12 GiB hard peak、Index Unit/Count 与 30 天审批规则均有 Domain/Property Test；不完整测量和硬上限不可审批                          | PASS |
| 100k Object / 1m Link           | 空 PostgreSQL 16 数据层完成 Object/Link Base + Current + Quality + 3 动态 Index + 二次扫描；核心构建 1,265,885 ms，低于 30 分钟                                                                | PASS |
| 实测下界不小于 Catalog          | Project 实测 2,826,518,528 bytes；容量 measured lower bound 同值，150% reserved/peak 4,239,777,792 bytes，低于 12 GiB                                                                          | PASS |
| 不提前 Drop                     | 生产 Request Schema 冻结 CREATE/DROP，但 09 的执行入口对 DROP 返回 `DDL_DROP_NOT_AUTHORIZED`；必须等 12 的完整 Root/GC 证明后才生成可执行删除                                                  | PASS |

## 3. 正式 100k / 1m 首轮基准

环境为独立 Ubuntu 24 / x86_64 / 8 vCPU / 16 GiB，空 PostgreSQL 16.14 Container 与空数据层。`cold` 的准确含义是“首次空库构建”和“建索引后的首次查询”，没有声称宿主机 Page Cache 被清空。

| 指标                         |                                                                      结果 |
| ---------------------------- | ------------------------------------------------------------------------: |
| Object / Link 行数           |                                                       100,000 / 1,000,000 |
| Object / Link 批次           |                                                                  20 / 200 |
| Object / Link 主阶段         |                                                      643,360 / 618,011 ms |
| 完整核心构建                 |                                                 1,265,885 ms（约 21m06s） |
| Quality Current              |                                                                168,626 ms |
| WAL                          |                                                       5,138,035,216 bytes |
| Project Heap / Index / Toast |                             1,261,199,360 / 1,564,549,120 / 770,048 bytes |
| Project 实际总字节           |                                                       2,826,518,528 bytes |
| 容量 Reserved / Peak         |                                       4,239,777,792 / 4,239,777,792 bytes |
| 3 个动态 Index               |                                                          15,761,408 bytes |
| Node Peak RSS                |                                                         330,100,736 bytes |
| PostgreSQL 完成时内存        |                                                         275,565,773 bytes |
| 冷后首次 / 同 Index 热查询   |                                                          2.838 / 0.542 ms |
| 内容 Digest                  | `sha256:3fd5255a753fc9d6539d36801e0f1d059adc15b2d0a5fe644ba128ba3c6857fd` |
| 物理测量 Digest              | `sha256:4eb68985846989ce6deee76a9d7421df887659ac01f7c02a72bd348fd7c5f106` |

PostgreSQL 配置同时记录 `shared_buffers=128MB`、`work_mem=4MB`、`maintenance_work_mem=64MB`、`max_wal_size=1GB`、`synchronous_commit=on` 等值。S3 实现/镜像固定为 SeaweedFS 4.41，但本轮数据库容量路径没有访问 S3；DuckDB 不是 G2-02-09 生产依赖，因此记录为 N/A，不伪造版本或执行证据。真实 HTTP/S3/OIDC/API/Worker/DDL 串联仍由 G2-02-14 复跑。

正式基准之后增加的 Release/Published Property 重验和生产容量 Loader 不改变批量写、Current、DDL SQL 或查询路径；最终代码又以 1k Object / 10k Link 从空库完整复跑，24.48 秒通过，证明新绑定已接入同一真实链路。没有用缩量结果替换上述正式容量数字。

## 4. Intended-vs-Implemented 复审与实际返工

1. 首版 Admission 只持久 Object Plan，读取库存时用伪造的 `retained:<plan>` Release，无法兑现“不可变 Release”；0014 和 Repository 改为持久/重验真实 Release ID、Release Plan Digest 与 Pin。
2. 首版容量 Repository 必须由测试注入 Snapshot Loader，生产不能直接使用；现在默认 Loader 从数据库完整读取，并在同一 Repeatable Read 快照中 fail closed。
3. 可信调用方仍可能把与 Published Object Type 不一致的 Property 元数据传入编译器；生产持久化前现在重新解析 Published Revision，逐项核对类型、能力、JSON Path、Pin Digest 与覆盖。
4. Unique Property 初版只按 Property 表达式全表唯一，会让不同 Project/Generation 互相冲突；物理定义与签名都改为 `(project_id,generation_id,property-expression)`。
5. 物理扫描初版可能遗漏 ops Staging 或把 Pending Index 当完整；Scanner 已覆盖 Runtime 与 Object/Link Staging，并要求所有计划 Index 在 Catalog 中 Valid/Ready/签名一致。
6. 长构建曾因合法 300 秒 Lease 到期发生所有权丢失；使用正式 60 秒 Heartbeat 续租，没有放宽 Lease 上限或绕过 Fence。

这些修正没有增加 Certificate、Cutover、GC、Query、Action 或 UI 范围。

### 4.1 代码级审计映射

| 缺口                              | 原始意图                                                                                                                     | 实际实现与反例                                                                                                                                                                                                                                                                                                                                                      | 攻击者 / 受害者 / 修复                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Release 身份曾被伪造              | [任务合同 471–472](../delivery/g2-02-materialization-task-pack.md#L471-L472) 要求 Published Property 与跨 Release 不可变复用 | [Repository 227–379](../../packages/materialization-postgres/src/index-capacity.ts#L227-L379) 重验 Release/Pin 并持久真实 Release Digest；[0014 104–131](../../migrations/db-00/0014_projection_index_capacity_ddl.sql#L104-L131) 加 FK/唯一事实；[真库反例 89–151](../../tools/projection-ddl/integration/postgres.test.ts#L89-L151) 覆盖复用与原 Release 改向     | 攻击者：可信 Staging 调用方传伪 Release；受害者：不可变 Release 与预算；修复：真实 FK、Pin、Digest 和冲突重验                 |
| 容量快照曾只能测试注入            | [任务合同 475–478](../delivery/g2-02-materialization-task-pack.md#L475-L478) 要求完整库存、前后两次准入与 Catalog 下界       | [生产 Loader 518–739](../../packages/materialization-postgres/src/index-capacity.ts#L518-L739) 在 Repeatable Read 中读全 Project；[Scanner 748–905](../../packages/materialization-postgres/src/index-capacity.ts#L748-L905) 检查动态 Index、Runtime/ops Staging 和物理字节                                                                                         | 攻击者：缺 Forecast/Index/Generation 的不完整库存；受害者：12 GiB 硬上限；修复：任一缺项或 Pending/Failed 即 fail closed      |
| 调用参数可漂移 Published Property | [任务合同 471](../delivery/g2-02-materialization-task-pack.md#L471) 要求能力、类型、Evidence 与 Recipe 等价                  | [Published Content 重验 990–1089](../../packages/materialization-postgres/src/index-capacity.ts#L990-L1089) 核对类型、能力、JSON Path 与覆盖；入口在 [227–255](../../packages/materialization-postgres/src/index-capacity.ts#L227-L255)                                                                                                                             | 攻击者：可信调用方传错类型/能力/JSON Path；受害者：查询语义与 DDL；修复：持久化前重新解析已发布 Revision，任何漂移阻断        |
| Unique 曾跨代错误唯一             | [ADR-008 168–172](../architecture/adr/008-shared-projection-index-capacity.md#L168-L172) 要求 Project/Generation Scope       | [签名 916–944](../../packages/materialization-domain/src/index-plan.ts#L916-L944) 和 [DDL Key 552–580](../../packages/materialization-postgres/src/projection-ddl.ts#L552-L580) 同时绑定 Scope；[真库断言 207–217](../../tools/projection-ddl/integration/postgres.test.ts#L207-L217) 检查 Catalog                                                                  | 攻击者：另一个 Project/Generation 写相同业务键；受害者：合法物化；修复：`project_id,generation_id` 同时进入物理键与签名       |
| DDL/Inventory 曾可能假 READY      | [任务合同 472–474](../delivery/g2-02-materialization-task-pack.md#L472-L474) 要求最小权限、可重放和 Invalid 不 READY         | [Executor 172–220](../../packages/materialization-postgres/src/projection-ddl.ts#L172-L220) 只接 UUID、重算 Plan、拒绝业务 DROP；[Plan/Catalog 重验 343–438](../../packages/materialization-postgres/src/projection-ddl.ts#L343-L438)；[真库攻击 159–229](../../tools/projection-ddl/integration/postgres.test.ts#L159-L229) 覆盖 Pending、篡改、SIGKILL 与 Catalog | 攻击者：被杀进程或同名异定义 Index；受害者：Inventory/Release 准入；修复：Catalog 双向核验、签名、状态重放，失败保持非成功    |
| 长任务 Lease 曾到期               | [任务合同 477](../delivery/g2-02-materialization-task-pack.md#L477) 要求真实 100k/1m 在 30 分钟内完成                        | [容量 Harness 1674–1760](../../tools/database/materialization-postgres.integration.test.ts#L1674-L1760)、[3291–3400](../../tools/database/materialization-postgres.integration.test.ts#L3291-L3400) 使用 [60 秒 Heartbeat 3989–4039](../../tools/database/materialization-postgres.integration.test.ts#L3989-L4039)                                                 | 攻击者：合法 300 秒 Lease 的自然到期；受害者：长批次 Fence 所有权；修复：沿正式 Heartbeat 协议续租，不放宽 Lease 或绕过 Fence |

## 5. 可复现验证

```text
npm run test:projection-capacity
PASS — 39 tests：预算、审批、Property 能力、签名、容量、GC 与 Property Tests

npm run test:projection-ddl:production:postgres
PASS — Published Revision/Release 不可变、11 Recipe、权限、篡改、SIGKILL/Replay、Catalog

ONTOS_G2_02_09_CAPACITY=1 ONTOS_G2_02_09_CAPACITY_SMOKE=1 \
  node --test --test-concurrency=1 tools/database/materialization-postgres.integration.test.ts
PASS — 最终代码从空库跑通 Forecast → PREBUILD → Object/Link/Quality → DDL → Scan → POSTBUILD

ONTOS_G2_02_09_CAPACITY=1 \
  node --test --test-concurrency=1 tools/database/materialization-postgres.integration.test.ts
PASS — 正式 100k Object / 1m Link，核心构建 1,265,885 ms，Peak 4,239,777,792 bytes

npm run verify
DIAGNOSTIC PASS — 独立 Ubuntu 24 / 8C16G staged-worktree：28/28 Gates、408 tests、0 failures、339,093 ms；该 rsync 工作区排除了 `.git`，后续证明 `git ls-files` 没有看到新 App/Migration，因此不作为最终 Commit 绑定验收

GitHub Required Check on final PR Head
REQUIRED — 必须在包含新 Foundation 精确允许清单的真实 Git checkout 上通过后才能合并
```

最终 PR Head 仍必须通过统一 Gate 与 GitHub Required Check；本文中的独立机器 staged-worktree 结果只证明运行链路，不冒充 Commit 绑定的远端检查。以后新增 tracked scope 的任务必须以真实 Git checkout 复跑精确清单，不能只依赖排除 `.git` 的 rsync 镜像。

## 6. 非结论与下一项

- Index/容量事实还没有进入 Compatibility Certificate，属于 G2-02-10；
- 当前没有真实 Group Cutover、Serving Head 切换或支持窗 Refresh，属于 G2-02-11；
- GC/Root Provider 与经证明的 DROP 属于 G2-02-12，09 明确禁止提前删除；
- Admin HTTP、统一 Testkit 和完整 PostgreSQL/S3/OIDC/API/Worker/DDL clean-room 属于 13/14；
- 默认容量 Loader 不臆造运维审批；未来正式治理入口可通过现有 Repository Port 提供经验证的 Approval，硬上限仍不可绕过。

因此下一唯一允许的工作项是 **G2-02-10：Runtime Member Plan 与受信兼容证书**。
