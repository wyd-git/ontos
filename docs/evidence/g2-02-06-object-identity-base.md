# G2-02-06 永久 Object Identity 与不可变 Object/Link Base Evidence

- 日期：2026-08-15
- 结论：**PASS**（只代表 G2-02-06 Identity + Base Gate；不代表 Current、质量报告、Worker 进程、Index、Cutover/Serving、GC 或整个 G2-02 已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-06](../delivery/g2-02-materialization-task-pack.md#g2-02-06实现永久-object-identity-与不可变-objectlink-base)
- 架构决策：[ADR-015](../architecture/adr/015-permanent-object-identity-attempt-owned-base.md)
- 专项红队：[G2-02-06 Red Team](../reviews/g2-02-06-object-identity-base-red-team.md)

## 1. 实际交付

| 组件                                    | 责任                                                                                                                | 明确不做                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `MaterializationBaseService`            | 批内 PK/Link Collision、永久 Identity Resolve/Create、Dangling Candidate、类型化 Value/Batch/Stage Digest、提升请求 | 不做 SQL、Lease 判定、Current、质量阈值或 Activation |
| `PostgresMaterializationBaseRepository` | 仅调用固定受控函数，映射稳定错误，不保留原 SQL/原始 Cause                                                           | 不获得 Owner/DDL/直写 Base 权限                      |
| Migration `0011`                        | 类型化 Link Endpoint、Attempt-owned Staging、批次与 Stage Digest、Identity/Lookup/Stage/Promote 函数、最小 Grant    | 不改 0001～0010，不创建领域表，不切 Serving Pointer  |
| 真实 PostgreSQL 16 Integration          | 并发 Identity、过期 Attempt、失败重放、Object/Link Base、错 Type/Dangling、连接池重启、权限和迁移回滚               | 不使用内存 DB 代替数据库结论                         |

## 2. Acceptance 对照

| 要求                                                  | 实现与可执行证据                                                                                                                                                                                      | 结论 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 同 Project/Type/Canonical PK 永久同 RID，跨代不变     | 唯一约束 + `resolve_or_create_object_identities`；两个真实 Worker 在未提交唯一键上并发，返回同 RID 且权威表只有 1 行；单测另证 Project/Type 隔离                                                      | PASS |
| 批内 PK Collision 写库前拒绝                          | Application 在 Repository Resolve 调用前按 Type + Canonical PK 检查；负测确认 Repository 调用次数为 0                                                                                                 | PASS |
| Base 包含完整绑定且不可改删                           | Object/Link Base 持久 Generation、Target Revision、RID/Endpoints、Snapshot/File/Row、Mapping Revision 和 Value Digest；Trigger 与 API/Worker 真实 LOGIN 负测同时拒绝 UPDATE/DELETE                    | PASS |
| Link 端点必须同 Project 且类型正确，不创建假 Identity | Lookup 只读权威 Identity；错 Source Type 返回 `LINK_ENDPOINT_TYPE_INVALID`；缺 Target 只返回脱敏 Candidate，Identity 数不变                                                                           | PASS |
| 中断 Attempt 不会成为完整 Generation                  | 首个 Attempt 完成 Staging 后强制 Lease 过期，Base 仍为 0；新 Attempt 取得 Token 2，旧 Token 提升返回 `MATERIALIZATION_ATTEMPT_FENCED`；重放不产生第二套 RID                                           | PASS |
| 提升完整、原子、可幂等重放                            | DB 复算 Receipt 数、接收行数和 Stage Digest；整代 `INSERT ... SELECT` 与 Stage 状态在一事务；Worker 连接池重建后重放返回 `reused=true`                                                                | PASS |
| 两个领域不分叉 Kernel                                 | Customer-shaped 与 Order-shaped Object 使用同一 Service/Repository Port、相同类型化 Property Envelope 和提升算法；核心代码无 Package API Name/领域列分支                                              | PASS |
| 10k Object/100k Link 真实数据薄切片                   | Managed CSV 同一 Scanner → Mapping Compiler/Executor → 5,000 行背压批次 → PostgreSQL Identity/Staging/Base；包含 10k Object 失败 Attempt 完整重放、100k Link、Worker/API 连接池重启和内容 Digest 比较 | PASS |
| 根据实测重估                                          | 数据为 30 分钟基线保留足够余量，但 Current/Index/Cutover/GC 仍是主风险；剩余单通道规划从 6–10 调整为 **5–9 工程周**                                                                                   | PASS |

## 3. 真实容量数据

环境：Ubuntu 24.04 x86_64，8 CPU，15 GiB RAM，PostgreSQL `16.14`，Node `24.18.0`，Docker 数据与项目在独立 `/data/ontos-g2`。

```json
{
  "objectRows": 10000,
  "linkRows": 100000,
  "objectBatches": 2,
  "linkBatches": 20,
  "objectMilliseconds": 6636,
  "linkMilliseconds": 38678,
  "rowsPerSecond": 2428,
  "peakNodeRssBytes": 304934912,
  "walBytes": 237230496,
  "objectHeapBytes": 5120000,
  "objectIndexBytes": 5021696,
  "linkHeapBytes": 31514624,
  "linkIndexBytes": 50610176,
  "identityHeapBytes": 1163264,
  "identityIndexBytes": 4005888,
  "stagingTotalBytes": 84877312,
  "workerRestartDigestStable": true,
  "apiRestartDigestStable": true,
  "contentDigest": "sha256:3cbdef03dcd14622b80657e539d31882f8e2f430bed4af80360a61d215ad91ca"
}
```

解读：

- 两个主阶段合计 45.314 秒；整个容量 Suite 约 52.69 秒，包含容器、Migration、Fixture、故障/重启检查。
- Object 时间包含一份 10k 失败 Attempt 和一次完整 10k 重放；`rowsPerSecond` 仍只以 110k 逻辑产出行计算，因此不是乐观统计。
- Node 峰值 RSS 约 290.8 MiB；WAL 约 226.2 MiB。Staging 约 80.9 MiB，包含保留的失败 Object Attempt，这是对后续 GC 的保守输入。
- 按同机器、同宽度线性外推，100k Object + 1m Link 的当前 Scan/Mapping/Base 主阶段约 7 分 33 秒；即使用整个 Suite 保守外推也约 8 分 47 秒。这不包含未实现的 Current、Index、Quality、Cutover 和远程 S3/HTTP 延迟，所以不替代 G2-02-09/14 的 30 分钟正式验收。
- 本薄切片使用 5,000 行 JSONB-to-recordset 短事务，没有使用 `COPY`。当前吞吐未触发换路线；完整数据加入 Index 后若失去余量，G2-02-09 再评估 COPY/索引延后策略。

## 4. 上传边界的证据范围

G2-02-04 已用真实 S3-compatible Storage 证明了：上传会话、精确 Object Version、服务端 SHA-256/字节/行数重算、CSV 物理检查和不可变 Snapshot/File 注册。G2-02-06 容量路径从同一 Managed CSV 字节流接口开始，实际执行同一 Scanner、Mapping 和 Base Sink，没有手工构造 Mapped Row。

两者的组合证据足以判断当前数据模型和吞吐可继续，但本 Gate 没有在一个进程中把远程 S3 PUT/GET 网络时间与 100k Link PostgreSQL 时间相加。真实 OIDC + HTTP + S3 + Worker + PostgreSQL 的单场景总时间归 G2-02-13/14，Evidence 不把本测试说成已完成的产品闭环。

## 5. Intended-vs-Implemented 复审与实际返工

逐条对照任务包、ADR-008/009/010/014、G2-02-04/05 输出和真实 PostgreSQL 行为后，关闭了以下差距：

1. 旧 Link Base 只存 RID，无法证明端点属于正确 Object Type；0011 前向回填 Type Resource 并改为复合 FK。
2. 旧 Staged Batch Digest 在 Job 级唯一，会拒绝新 Attempt 重现同一确定批次；唯一范围改为 Attempt，同 Attempt 仍严格幂等。
3. 不可变的 Statement Trigger 会拦截即使是 0 行的历史回填；0011 只在同一 Migration 事务内短暂停用/重启指定 Trigger，并用逐版本故障注入验证回滚。
4. 初始容量 Harness 直接构造 Mapping Accepted Event，不足以支撑“上传字节到 Base”；改为真实 CSV Scanner + Mapping Compiler/Executor + 背压 Sink。
5. 容量 Fixture 曾将 PK 当普通 Property 重复映射，冻结 Compiler 立即拒绝；改为独立 `displayName` 业务属性，并统一 PK 的大小写 Descriptor。
6. 初始普通 Repository 错误虽然文本脱敏，但底层 Cause 仍可被深度日志器查看；公开 Base Error 现在不保存原 Cause，负测直接检查 `error.cause === undefined`。
7. 权限测试最初没有逐张覆盖新 Staging/Base；现在 API、Worker、Ops 分别检查允许路径和 Raw Table/Function 越权路径。并发测试还曾用 Worker 直读 Identity 计数而被 `42501` 拒绝，改为只由测试 Admin Observer 读取，不放宽生产权限。

这些返工均在 G2-02-06 内关闭，没有引入 Current、Query、Action、UI 或修改产品目标。

## 6. 验证结果

```text
npm run test:materialization-base
PASS — 6 Object Identity/Base application tests

npm run test:database
PASS — 6 PostgreSQL 16 integration suites
       包含 0011 full-chain/rollback、两 Worker 并发 Identity、Fencing、
       Object/Link Base、Dangling/wrong type、重启幂等与真实 Role Matrix

npm run test:materialization-base:capacity
PASS — 10,000 Object + 100,000 Link、22 batches、失败 Object Attempt 完整重放

npm run verify
PASS — 专用机连续执行 25 of 25 gates、376 tests、247.177 秒
```

`materialization-base-capacity` 已加入统一 `npm run verify`，因此后续修改不能只跑小数据测试绕过本薄切片。本地工作树和专用机结果仍须在 PR 最终 Head 上由 GitHub Required Check 再证明一次。

## 7. 非结论与下一项

G2-02-06 已证明“确定的 Object/Link 候选可获得永久身份，在失败/重试后仍只产生一份完整不可变 Base”。它还不能被业务查询直接使用：

- Dangling/Rejected 的 required/optional 阈值和 Artifact 尚未落库；
- Object/Link Current、Object Heads Candidate、Property Provenance 和 Materialization Report 尚未构建；
- Generation 尚未经完整质量门变为可激活产物；
- 失败 Staging 仍保留，它的 Root/Grace/GC 规则属于 G2-02-12；
- 没有 Serving Head/Cutover，更没有 Query API 或 UI。

因此下一唯一允许的工作项是 **G2-02-07：Staging Current、质量报告与最小血缘**。
