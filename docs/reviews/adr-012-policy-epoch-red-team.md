# Red-Team：ADR-012 Policy Epoch、缓存与 fail-closed

- 日期：2026-08-13
- 范围：`docs/architecture/adr/012-policy-epoch-cache-fail-closed.md` 与 `tools/policy-epoch/`
- 方法：Strategy Red-Team + Intended-vs-Implemented
- 结论：**G2-00-08 Harness 可接受；真实 PostgreSQL、统一 Gateway 接入与 OIDC 运维证据仍为后续 Gate**

## Top Kill-Assumptions（按 Impact × Likelihood × Cheapness 排序）

### 1. 丢失全部通知时，旧 Allow 也不可能存活超过 5 秒（100）

- **Claim：** 通知只是加速；进程内硬 TTL 独立保证 Kernel 撤权最多 5 秒收敛。
- **Steelman：** 缓存记录初次确认的单调时间和固定到期点；命中、依赖错误和后台行为都不续期；`now >= expiresAt` 即失效。
- **Fails if：** Cache Hit 重设 TTL，使用可回拨墙上时钟，错误时 stale-while-revalidate，或失效边界错误写成 `>`。
- **Evidence to get this week：** 对 1..5,000ms 全部 TTL 做固定 Seed 性质测试；模拟一个 API 进程完全收不到撤权通知。
- **Kill criterion：** 任意旧 Allow 在原始 `confirmedAt + ttl` 时或之后仍命中，G2-00-08 失败。
- **Cheapest test：** `properties.test.ts:16-140` 运行 400 个生成场景；`policy-epoch.test.ts:134-152` 固定验证 4,999ms Allow、5,000ms Deny。
- **处理：** CLOSED（Harness）；真实进程时钟与部署测量 OPEN（Runtime Translation Gate）。

### 2. 授权事实和 Epoch 永远来自同一事务与同一读取快照（96）

- **Claim：** 撤权不会产生“事实已变、Epoch 未变”，决策也不会拼接不同 MVCC Snapshot。
- **Steelman：** 状态模型先在隔离 Draft 修改，只有成功回调后才一次替换 Binding Set 与 Epoch；通知在提交状态可见后发布。
- **Fails if：** 生产中任何 API/脚本可直接写 Binding，Trigger/受控写函数未覆盖全部表，或 Repository 用两个事务分别读取 Epoch 和 Binding。
- **Evidence to get this week：** 当前用回调抛错证明无部分提交；G2-00-10 用真实 PostgreSQL Transaction、权限和并发测试复验。
- **Kill criterion：** 存在授权有效变化但 Epoch 不增，失败事务产生通知，或读取结果出现新 Epoch + 旧事实；Production Gate 失败。
- **Cheapest test：** `model.ts:213-264` 与 `policy-epoch.test.ts:20-65`；数据库落地时先写一个并发撤权事务测试，不先做完整 Policy Compiler。
- **处理：** CLOSED（状态合同）/ OPEN（真实 Migration 与数据库角色）。

### 3. 缓存键和编译产物绑定不会跨身份、目标或版本复用 Allow（95）

- **Claim：** Project、Actor、Delegation、Resource、Permission、Release、Policy Revision、Compiler Version 和 Epoch 任一变化都会形成不同决策键。
- **Steelman：** Identity/Delegation 先做长度分帧的 SHA-256；完整键再次长度分帧；同一四维编译键禁止覆盖另一 Digest；Gateway 复核 Adapter 返回 Artifact 的全部绑定字段。
- **Fails if：** 漏掉 Resource/Permission 造成横向越权，Group Claims 或 Delegation 未进入 Actor Context，字符串分隔符产生碰撞，或 Artifact Store 在原键覆盖新代码。
- **Evidence to get this week：** 对每个字段逐一变异并要求键全部不同；注入错误 Project Artifact 和同键不同 Digest。
- **Kill criterion：** 任一语义维度变化仍复用原 Allow，或相同版本键解析到不同 Digest；该 Cache/Catalog 不得接入 Runtime。
- **Cheapest test：** `policy-epoch.test.ts:67-111`、`:187-261`；生产 Catalog 后续复用同一不可变性测试。
- **处理：** CLOSED（Harness 当前身份字段）/ OPEN（G2-00-09 完整 Identity Context 扩展规则）。

### 4. 依赖异常只产生可观察 Deny，不会泄密或悄悄继续 Allow（92）

- **Claim：** Epoch Store、Artifact Store、Adapter 数据、时钟和未知异常在缓存失效后全部 fail closed。
- **Steelman：** Dependency 调用分别捕获并映射稳定 Code；未命中/到期不读取旧条目；结果只能是 `DENY/FAIL_CLOSED`；Observation 仅含 Code 与不可逆 Ref。
- **Fails if：** 原始 Error/Stack 进入日志，Telemetry 抛错改变授权结果，未知异常默认 Allow，或依赖报错延长旧缓存。
- **Evidence to get this week：** 向数据库和编译异常中注入 Password/Token/Stack 哨兵；让 Observer 自身抛错；在 5 秒边界重复请求。
- **Kill criterion：** 任何错误路径返回 Allow、创建缓存、延长到期时间或输出 Secret 哨兵；立即停止接入。
- **Cheapest test：** `policy-epoch.test.ts:154-223` 与 `:421-440`。
- **处理：** CLOSED（Harness）/ OPEN（真实 OTEL Exporter 与 HTTP Error Mapping）。

### 5. 撤权发生在依赖读取期间也不能插入新的旧 Allow（88）

- **Claim：** Notification 提高的 Epoch Floor 在缓存写入前再次检查，所以并发撤权不会在通知清理之后重新插入旧快照。
- **Steelman：** Gateway 在读授权 Snapshot 后读取 Artifact，并在最终计算/缓存前重新比较 `snapshot.epoch` 与最新 Floor；超前通知也只会 Deny。
- **Fails if：** Production 异步实现只在读取前检查一次，通知回调与 Cache Insert 跨事件循环竞态，或重连后 Floor 被重置而旧 Cache 未清空。
- **Evidence to get this week：** 当前 Reader 在 Artifact 读取中触发撤权；Production Adapter 必须加入异步 Barrier、Listener 重连和进程启动窗口测试。
- **Kill criterion：** 通知已经观察到 Epoch N 后，任何小于 N 的 Snapshot 被缓存为 Allow；统一 Gateway 不得上线。
- **Cheapest test：** `policy-epoch.test.ts:285-307`；真实 Adapter 用两个数据库连接复刻同一时序。
- **处理：** CLOSED（同步 Harness）/ OPEN（异步 PostgreSQL Adapter）。

## Intended vs. Implemented

| Documented Intent                                                          | Implemented Reality                                                                                        | 边界风险                                       | 证据 / 修正                                                                                | 状态                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------- |
| Authorization 变化与 Project Epoch 同事务                                  | Draft 失败时不替换状态；成功时 Binding Set 与 `epoch + 1` 一次可见，之后才发布 Hint                        | 分离提交会让旧 Allow 无期限存活                | `model.ts:213-264`；事务失败/No-op/通知测试 `policy-epoch.test.ts:20-65`                   | CLOSED（Harness）/ OPEN（DB）    |
| 决策读取是同一 Epoch + Fact Snapshot                                       | Store 一次返回 Project、Epoch、Actor/Delegation 结果与 DB 观察时间；Gateway 复核 Project、范围和数组长度   | 错 Snapshot 或错误 Adapter 可跨 Project Allow  | `model.ts:266-297`；`process.ts:166-187`；恶意 Adapter 反例 `policy-epoch.test.ts:239-261` | CLOSED                           |
| Cache Key 包含 Project、Actor/Delegation、Release、Policy、Compiler、Epoch | 完整键还包含 Resource/Permission；Identity 与 Delegation 分别指纹化；长度分帧避免 delimiter collision      | 缺字段直接导致身份/资源/版本混用               | `process.ts:377-425`；逐字段变异 `policy-epoch.test.ts:67-111`                             | CLOSED（Harness Context）        |
| 编译产物精确绑定且不可静默回退                                             | Store 的四维键不可覆盖另一 Digest；Gateway 二次核对 Adapter 返回字段                                       | 错 Release/Compiler 产物可改变授权语义         | `model.ts:357-407`；`process.ts:189-216`；错误 Adapter/覆盖测试                            | CLOSED                           |
| 通知只加速，丢失时 TTL 仍 ≤5 秒                                            | 通知只提高 Floor/清 Project Cache；过期使用固定单调时钟且边界为 `>=`                                       | 通知断线不应成为持续旁路                       | `process.ts:149-164`、`:218-245`、`:254-270`；双进程与性质测试                             | CLOSED（Harness）                |
| Epoch/Compilation 无法确认时 fail closed                                   | 所有 Dependency、版本、Clock 和未知输出错误返回稳定 Deny；不缓存失败                                       | allow-on-error 会把故障变成权限扩大            | `process.ts:134-252`、`:310-374`；Secret/Observer/Clock 反例                               | CLOSED                           |
| P0 Resource/Role 授权保留 PostgreSQL 关系表                                | ADR 冻结关系事实；Harness 只建模已归约的有效 `(principal, resource, permission)`，没有伪装完整 Role Schema | 抽象测试不能证明 FK、写权限或关系查询          | ADR-012 §2；真实 Migration 明确留给 G2-00-10                                               | OPEN（计划内）                   |
| OIDC Group Token 延迟与 Kernel 撤权分开                                    | ADR 独立说明 Provider Token 陈旧和 Kernel 内 Mapping/Binding 5 秒上界                                      | 对外错误宣传会把外部 Token 陈旧藏在 5 秒承诺里 | ADR-012 §8；当前没有真实 Provider                                                          | CLOSED（合同）/ OPEN（部署证据） |

## 审查中实际修正

1. Gateway 增加对 Adapter 返回 Snapshot 的 Project、Epoch、数据库时间、Delegation 长度与布尔结果复核；
2. Gateway 增加对 Artifact 返回值的 Project、Release、Policy Revision、Compiler Version 与 Contract 复核；
3. 编译产物键改为不可变，拒绝同键覆盖不同 Digest；
4. 单调时钟直接抛错与数值回拨统一使当前进程永久 fail closed；
5. Project 和 Correlation 在 Failure Observation 中只输出不可逆短 Ref，不转发原始依赖错误；
6. 明确 Harness 的直接 Permission Binding 只是关系授权的归约 seam，不冒充完整 Resource/Role Schema。

## What's Well-Reasoned

- Epoch 是授权事实的顺序号，单调时钟是缓存寿命上界，数据库墙上时间只用于提交与审计；三者职责没有混用。
- 有效缓存可以承受短暂依赖故障，但其原始到期点不可续期；这在明确 5 秒安全上界内保留了可用性。
- Notification Floor 只增不减，并在 Dependency 读取后复查，覆盖了普通缓存设计容易遗漏的插入竞态。
- 正常 Policy Deny 与系统 Fail-closed Deny 在结果中可区分，但二者都不会向调用者变成 Allow。
- 没有引入 Redis、外部 Policy Engine 或完整 Compiler 来掩盖尚未冻结的产品合同。

## What I Couldn't Assess

- G2-00-10 前无法证明真实 PostgreSQL FK/Unique、数据库角色、写函数/Trigger、MVCC Query 和 `LISTEN/NOTIFY` 重连；
- G2-01 以后才能证明 API、UI、SDK、Function、Action、Harness 与运维入口全部经过同一 Policy Gateway；
- 完整 Identity Context 尚未在 G2-00-09 Foundation Contract 冻结；未来新增任何参与决策的 Actor Attribute 必须同时进入 Fingerprint；
- 没有真实 OIDC Provider，不能测量 Access Token、Session、Refresh 和 Group 变更的外部陈旧窗口；
- Harness 没有实现 Object/Link/Property SQL Policy、Mask、Action Submission Criteria 或查询计划下推，不能把本 Gate 宣称为完整授权系统。

## Gate 结论

ADR-012 的状态模型足以冻结 G2-00-08 的安全合同：在当前 Harness 范围内没有发现仍未修正的 Intended-vs-Implemented 越权路径。所有 OPEN 项都需要后续真实数据库、Foundation Contract、Runtime Adapter 或 OIDC 部署证据，不能在本 Evidence 中写成已完成。
