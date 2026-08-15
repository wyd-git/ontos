# G2-02-03 DB-02 Migration Red Team

- 日期：2026-08-15
- 方法：先按 ADR-007/008/009/014 和任务包钢人化，再攻击历史兼容、复合身份、权限、恢复与可运营性主张
- 结论：**G2-02-03 可 PASS；只放行 G2-02-04。真实性能、完整 Worker 恢复、DDL Inventory、Cutover 和 GC 仍保持 OPEN**

## 1. 历史 A0 被“兼容升级”偷偷改写

**攻击**：放宽 `member_count=0` 旧 Check 最容易顺手回填 Project/Plan/Digest，导致 R1/A0 的物理事实或外部摘要变化。

**证据**：测试在只应用 0001～0006 后发布真实 R1/A0，保存 `to_jsonb`、列顺序、`pg_column_size` 和 Ledger 前六行；升级及 R2/A1 发布后两次逐值比较完全相等。0007 只替换 Check，不 UPDATE 历史行。

**结论**：CLOSED。任何未来 Migration 改写 A0 重新触发停止条件。

## 2. 每张表都有 FK，但可拼成跨 Project/Revision 的假事实

**攻击**：单列 UUID FK 不能证明 Generation、Release、Snapshot、Revision 和 Project 属于同一上下文；“每列都存在”仍可能得到不存在的业务组合。

**证据**：Plan、Snapshot、Generation、Certificate、Activation Member 和 Shared Projection 使用复合 Unique/FK；额外 Trigger 校验 Resource Family、Member Kind、Building Generation、Snapshot 与 Mapping。跨 Project Member/Generation 负测命中 `23503`，错误族/摘要命中 `23514`。

**结论**：CLOSED for Schema。G2-02-11 的真实 Cutover 仍须在锁内重验状态与 Revision。

## 3. SECURITY DEFINER 变成 Worker 的 Owner 后门

**攻击**：Fencing 函数若接受 SQL/表名、继承可控 `search_path` 或把 Owner Grant 给 Worker，就等价于远程 DDL/任意写。

**证据**：三条 Worker 函数参数均为固定 Scalar，SQL 目标固定，`search_path=pg_catalog`，默认/显式 EXECUTE 从 PUBLIC/API/Ops 撤销；Worker 不是 Owner 成员，不能直写 Batch/Checkpoint、DDL、Ledger 或切 Role。Certificate 函数同样从既有 Generation/Plan/Report 派生字段并在数据库重算 Digest。

**结论**：CLOSED for G2-02-03。G2-02-08 仍须补 Heartbeat、Retry/Dead Letter、Cancel 与完整 Kill 矩阵。

## 4. 候选 Activation 可插入后会被 Query 看见

**攻击**：为支持事务外准备而放宽旧 orphan guard，可能让 READY 但未 Cutover 的 Activation 通过 Channel/Serving Head 泄露。

**证据**：候选 Activation 可以存在，但没有 Serving Head；Published Release 的 Head/Channel 完整性仍由 Deferred Constraint 强制。API/Worker 没有 Current 原始查询权限，未来 Query 只能从一次解析的 Serving Activation 进入。

**结论**：CLOSED at storage boundary。真实 Query 解析属于 G2-03，真实 Cutover 锁/CAS 属于 G2-02-11。

## 5. Checkpoint 前后 Kill 把半批当完成

**攻击**：Batch INSERT 和 Job Progress 分开提交时，重启方可能把存在的 Batch 行当作完成输出；旧 Worker 还可能在接管后继续写。

**证据**：Staged Batch 只有被同事务 Checkpoint 标记后才完成；W1 未 Checkpoint 的批次保持 NULL，Lease 过期后 W2 Token 增加，W1 Token 稳定被拒，W2 重连后只看到自己的完成批次。

**结论**：CLOSED for one-batch smoke；多阶段、重试上限和进程级恢复留给 G2-02-08。

## 6. 一个大 Migration 失败留下半套权限或半张表

**攻击**：DDL、Trigger、Grant 混在一个文件时，中途错误可能留下可写表或 Ledger 已前移。

**证据**：分别给 0007、0008、0009 注入末尾故障；每次代表表不存在且 Ledger 停在前一版本。两个 Runner 并发只产生一套 9 行历史；ahead/gap/hash drift 继续 fail closed。

**结论**：CLOSED。已提交语义错误只允许更高版本 Forward Fix。

## 7. 空 Generation 通过被误写成性能与生产闭环通过

**攻击**：0 行 Generation 很容易通过 FK/事务，却没有证明 100k Object/1m Link、COPY、WAL、索引放大、Vacuum 或 30 分钟目标。

**证据**：Evidence 明确把本项限定为 Schema/权限/恢复薄切片；容量矩阵不因 5–6 秒测试耗时缩短 Materialization 数据路径估算。

**结论**：OPEN，Owner 为 G2-02-05/06/09/14。G2-02-06 必须以 10k/100k 薄切片首次重估，最终 100k/1m 只能在 G2-02-14 验收。

## 8. 排序后的失败模式

| 排名 | 失败模式                                | 影响 | 可能性 | 当前处理                                               |
| ---: | --------------------------------------- | ---: | -----: | ------------------------------------------------------ |
|    1 | Runtime 身份获得 Owner/DDL/Fencing 旁路 |    5 |      2 | 真实 LOGIN + Definer 固定 SQL + 直写负测，CLOSED       |
|    2 | 复合 FK 允许跨 Project/Revision 假事实  |    5 |      2 | 复合键与 Trigger，CLOSED                               |
|    3 | A0/历史 Ledger 被改写                   |    5 |      1 | 升级前后字节/列/Hash 对比，CLOSED                      |
|    4 | 半批被恢复逻辑当完成                    |    5 |      3 | 单批 Smoke CLOSED；完整恢复 OPEN to 02-08              |
|    5 | 候选 Activation 提前可见                |    5 |      2 | Head/Channel 完整性 CLOSED；真实 Cutover OPEN to 02-11 |
|    6 | 最终数据量使设计不可运营                |    5 |      4 | 无性能宣称；OPEN to 02-06/09/14                        |

## 9. 放行结论

没有触发修改历史、Worker Owner、Raw SQL、按类型建表或 Staging 可见的 Kill Criterion。G2-02-03 可以 PASS，下一项只能是 G2-02-04 Managed CSV Ingress。不得从本结论跳到 Query、Action、页面或“完整生产闭环”。
