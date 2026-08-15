# G2-02-07 Staging Current、Quality 与 Provenance Evidence

- 日期：2026-08-16
- 结论：**PASS**（只代表 G2-02-07；不代表独立 Worker Kill/Resume、Index/容量、Certificate、Cutover/Serving、GC、HTTP 或整个 G2-02 已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-07](../delivery/g2-02-materialization-task-pack.md#g2-02-07实现-staging-current质量报告与最小血缘)
- 架构决策：[ADR-016](../architecture/adr/016-quality-current-provenance-confirmation.md)
- 专项红队：[G2-02-07 Red Team](../reviews/g2-02-07-quality-current-red-team.md)

## 1. 实际交付

| 组件                                       | 责任                                                                                                                                                        | 明确不做                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `MaterializationQualityService`            | zero-overlay 先行门禁、Current/Provenance 准备、质量判定、有界样本、两遍流式 Rejected Artifact、Report/Generation/Binding Digest                            | Worker 进程、调度、切换 Serving Head          |
| `RowCountConfirmationService`              | 统一 `release.publish` 授权、Owner 身份解析、绑定不可变事实的接受/拒绝决定                                                                                  | 不让请求方覆盖阈值或伪造 Report               |
| `PostgresMaterializationQualityRepository` | 只调用固定受控函数，提供稳定错误面；候选读取绑定精确 Project/Generation/Revision                                                                            | 不获得 Raw Current/Report/Confirmation 写权限 |
| Migration `0012`                           | late Report binding、Quality Observation/Preparation/Binding/Confirmation、Head Candidate、多来源 Provenance、Current/Report 守卫、候选 Reader 和最小 Grant | 不改写 0001～0011，不标 READY 或激活          |
| 版本化 Object Storage                      | 只接受固定 Key 与 `application/vnd.ontos.rejected-rows+json`，保存精确 Object Version                                                                       | 不存原始坏值、PK、列名或任意路径              |

## 2. Acceptance 对照

| 要求                                                            | 实现与可执行证据                                                                                                                                                 | 结论 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Current 使用共享键，READY 前不可服务                            | Object/Link Current 绑定 Project + Generation + Target Resource/Revision；候选 Reader 只允许 Quality-qualified `building` Generation；旧 Activation 前后摘要不变 | PASS |
| zero-overlay 未知/非零 fail closed                              | Application 在任何 Current 准备之前读取库存；单测证明 unknown/non-zero 时 Repository 无写调用                                                                    | PASS |
| required 零容忍，optional 默认 0.1% 且整行拒绝                  | 1,000 Object 行中 1 个 optional 错误恰好 0.1%：Report passed，999 Current/Provenance；超过阈值或任一 fatal 稳定 failed                                           | PASS |
| optional 错误不变业务 null；被拒 Object 引发 required Link 失败 | optional Property 行整行不进 Current；永久 Identity 仍存在时，Link 依然以 Object Current 判定 `REQUIRED_LINK_DANGLING`，Link Current=0                           | PASS |
| 行数异常只待 Owner 确认，旧输入失效                             | 999→500 进入 awaiting；提交前 Publication Sequence 推进时旧请求被拒；确认与发布共用 Project 行锁关闭并发窗口；Owner 接受后可通过当前质量守卫                     | PASS |
| Report/Digest/样本重放一致且有界                                | DB 重算 Observation/Current/Provenance/Report Digest、行数和原因聚合；一行只有一个稳定主 Reason；样本上限 50，Artifact 上限 256 MiB                              | PASS |
| 每个 Object Current Property 有最小血缘                         | 血缘绑定 Snapshot/File/Row、Mapping Revision、Algorithm Version、Value Digest；concat 保留多列，constant 显式为零列来源；错列或缺失血缘阻断                      | PASS |
| 失败/拒绝/中断不影响旧代                                        | 质量失败只改新 Generation/Binding；500→1 Owner 拒绝后新 Generation failed；原有 ready Generation 和 Activation Digest 不变                                       | PASS |
| 候选读取不跨 Project/Generation 且有索引路径                    | 真实 LOGIN 跨 Project 调用被拒；完整四维谓词 + keyset cursor；`EXPLAIN` 在禁用 Seq Scan 时选择 Index Scan，证明无被迫全表路径                                    | PASS |

## 3. Rejected Artifact 与脱敏边界

Rejected Artifact 是稳定排序 NDJSON，每行只包含 `schemaVersion/fileId/rowNumber/reasonCode/fingerprint/columnClassification`。Application 用 keyset 分页执行两遍：第一遍精确计数、计算 SHA-256 并检查字节上限，第二遍流式上传。两遍之间事实变化会以 Digest/字节数冲突失败，不会绑定一份不完整 Artifact。

真实 S3-compatible Storage 测试已验证版本化 Bucket、精确 Version 读回、字节/媒体类型一致，并拒绝同 Key 规则下的错误 Media Type。普通 Report 和 Error 不保存原值、完整 PK、列名、SQL、Object Token 或任意 Object Key。

## 4. Intended-vs-Implemented 复审与实际返工

1. 旧 Generation 强制在创建时绑 Report，会伪造 `passed/0 rows`；0012 改为 `building` 可空，Quality Finalize 只能一次 late bind。
2. 旧 Provenance 一个 Property 只有一列，无法表示 concat/constant；0012 改为有序来源项，区分 `column|constant`。
3. Current Property 实际位于 `properties.values`，首版完整性检查读了错路径；真实 PostgreSQL 测试发现并修正。
4. 小数据手工 Base Fixture 曾漏掉 Primary Key Property，使当时的 Provenance 模板只覆盖普通 Property；10k/100k 真实 Mapping→Base 路径将 `orderId` 正确保留后触发完整性失败。最终修正为 Primary Key 也从编译 Plan 生成血缘，DB 向已发布 Object Type 核对其 Property，没有删字段或放宽守卫。
5. 首版 READY 守卫只验 Binding，没有硬比对 Report accepted rows 与实际 Current；已改为数据库时重算。
6. 多个 PL/pgSQL `RETURNS TABLE` 列名与表列产生歧义，varchar/text 返回类型不精确；通过真库逐一加 Alias/Cast，没有绕过类型检查。
7. 确认时先读 Scope、后锁行会与 Release Publish 竞态；最终改为先锁 `meta.projects` 同一控制行再重读，真库 `lock_timeout` 负测证明确认不能跨过并发发布。
8. PostgreSQL Adapter 需要保留底层 Cause 供内部诊断，但公开 Code/Message 不能泄露 SQL；最终使用固定公开错误和内部 `cause`，不将 Cause 进入 Report/Artifact/API 合同。

这些修正都在 G2-02-07 边界内，没有增加 Query、Action、UI、Index 或 Cutover。

## 5. 验证结果

```text
npm run test:materialization-quality
PASS — 7 application quality/confirmation/provenance/artifact tests

npm run test:unit  (Node 24.18.0)
PASS — 366 tests

real PostgreSQL 16 integration on isolated Ubuntu 24 / 8C16G
PASS — DB-00/DB-02 full upgrade, least privilege, Current/Quality/Provenance,
       0.1% boundary, required Link dangling, candidate isolation/index path,
       stale/racing confirmation, accept/reject and unchanged old Activation

real versioned S3-compatible integration
PASS — exact rejected JSONL version/media/read-back and wrong-media rejection

npm run verify  (isolated Ubuntu 24 / 8C16G staged worktree)
PASS — 25/25 gates, 385 tests, 0 failures, 272500 ms
       including 100k Object / 1m Link streaming Mapping under a 128 MiB heap,
       10k Object / 100k Link PostgreSQL Base/Current capacity,
       real PostgreSQL/S3/OIDC and production-boundary up/smoke/down
```

上述统一 Gate 是隔离机器上的 staged worktree 结果，不冒充 clean-room 或最终 Commit 证据。最终 PR Head 仍必须由 GitHub Required Check 绑定同一 Commit；本文不用工作树内的单项测试代替合并 Gate。

## 6. 非结论与下一项

G2-02-07 已证明“不可见 Base 可以被确定性地筛成 Quality-qualified Current，并附有不可变报告、脱敏坏行集和最小血缘”。它还不是可服务的完整产品：

- 目前仍由 Integration Harness 组合长流程；真实独立 Worker、Lease、Checkpoint 和跨进程 Kill/Resume 属于 G2-02-08；
- Current 还没有 Published Index/Measurement/容量准入，属于 G2-02-09；
- 没有 Compatibility Certificate、READY 完整条件、Group Cutover 或 Serving Head 切换，属于 G2-02-10/11；
- 上传成功但 DB Finalize 失败的 Orphan Artifact 会保留，Root/Grace/GC 属于 G2-02-12；
- OIDC + HTTP + Worker + S3 + PostgreSQL 闭环和 100k Object/1m Link 最终容量属于 G2-02-13/14。

因此下一唯一允许的工作项是 **G2-02-08：PostgreSQL Job/Lease Worker 与 Kill/Resume**。
