# G2-00-08 Policy Epoch、缓存与 fail-closed 验收记录

- 结论：**PASS（仅限 G2-00-08 双进程决策 Harness）**
- 执行日期：2026-08-13
- 分支：`agent/g2-00-08-policy-epoch`
- 起始 Commit：`efe4c77de66e3ab177ac2876a64d97455e9a9088`
- 工具：Node.js 24.18.0 / npm 11.16.0 / fast-check 4.9.0
- 环境：macOS 26.5.2（Build 25F84）arm64

本记录对应 [G2-00-08 WWA](../delivery/g2-00-foundation-task-pack.md#g2-00-08adr-012-policy-epoch缓存和-fail-closed)。最终实现 Commit 由 Draft PR head 记录，避免在被提交文件中写入自身 Commit Hash。

## 1. 验收映射

| WWA 声明                                                                     | 实现证据                                                                                                      | 执行证据                                                                      | 结果                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------ |
| Authorization 变化与 Project Epoch 同事务                                    | `AuthorizationDraft` 隔离候选状态；成功时 Binding Set 与 `epoch + 1` 一次替换，之后才发布 Hint                | 成功、回调中途抛错、幂等 No-op 与通知数量反例                                 | PASS（状态合同）         |
| Cache Key 包含 Project、Actor/Delegation、Release、Policy、Compiler 和 Epoch | `PolicyDecisionCacheKey` 还包含 Resource/Permission；Actor/Delegation 使用长度分帧 SHA-256；完整键再次分帧    | 逐一改变 12 个语义维度全部产生不同键；delimiter 边界不碰撞                    | PASS                     |
| 通知只加速；丢失时硬 TTL 最长 5 秒                                           | Epoch Floor 只增不减、通知清 Project Cache；固定 `expiresAtMonotonic`，命中/故障不续期，`now >= expires` 失效 | 4,999ms 仍命中旧 Allow、5,000ms 强制重读并 Deny；全部 1..5,000ms TTL 性质测试 | PASS（Harness）          |
| 两个模拟 API 进程撤权都在 5 秒内拒绝且无 allow-on-error                      | 两个 `PolicyDecisionProcess` 各有独立 Cache/Clock/Subscription；Store 为共享事实                              | 正常通知时两个进程下一请求 Deny；一个丢通知仍在硬边界 Deny                    | PASS                     |
| Epoch/Compilation 无法确认时 fail closed 且错误不含敏感值                    | Store/Artifact/Adapter/Clock 错误统一稳定 Deny；Observation 仅含 Code 与 Project/Correlation Ref              | 注入 Password、Token、Stack 哨兵均未输出；Telemetry 自身失败不改变 Deny       | PASS                     |
| P0 Resource/Role 授权关系来源被冻结                                          | ADR-012 §2 冻结 PostgreSQL 关系事实与受控写入口；外部引擎变更必须新 ADR                                       | Harness 明确只建模已归约 Permission Binding，不冒充完整 Schema                | PASS（合同）/ OPEN（DB） |
| OIDC Group Token 与 Kernel 撤权延迟分开                                      | ADR-012 §8 将 Provider Token 陈旧和 Kernel 内 Mapping/Binding 5 秒上界分开                                    | 文档审查确认未把外部 Token Refresh 包入 5 秒声明                              | PASS（合同）             |

“同事务、PostgreSQL 关系表和 `LISTEN/NOTIFY`”在本任务中的 PASS 只表示状态与 Translation Contract 已冻结。真实 FK/Unique、数据库角色、写函数/Trigger、MVCC 并发和 Listener 重连必须在 G2-00-10 及 Runtime Adapter Gate 复验。

## 2. 冻结的状态合同

### 2.1 事实、Epoch 与通知

- 每个 Project 初始 Authorization Epoch 为 `1`，使用 PostgreSQL signed `bigint` 范围；
- Claim Mapping、Principal 状态、Project/Resource Binding、Role Permission 等有效变化必须在同一事务递增 Project Epoch；
- 失败事务不改变事实/Epoch，不产生 Audit 或可见通知；语义 No-op 不必递增；
- 决策刷新从一个数据库 Snapshot 同时取得 Epoch、Actor/Delegation 授权事实和数据库观察时间；
- 通知只携带 Version、Project 与提交后 Epoch，只能提高本地 Floor；重复/乱序通知不能回退；
- 通知超前于可确认数据库 Epoch 时 Deny，不猜测也不降低 Floor。

### 2.2 Cache 与版本绑定

- 完整键为 Project、Actor Fingerprint、Delegation Fingerprint、Resource、Permission、Release、Policy Revision、Compiler Version 和 Epoch；
- Actor Fingerprint 覆盖当前 Harness 的 Subject、Identity Type 和 Group Principal Set；Group 顺序不改变身份，Delegation 顺序保留；
- 缓存使用不含 Epoch 的 Base Index 定位候选条目，但条目保存完整 Epoch Key，并同时通过 TTL 与 Epoch Floor Gate；
- 编译产物必须精确匹配 Project/Release/Policy/Compiler；相同四维键不可覆盖另一 Digest；
- Gateway 二次复核 Adapter 返回 Snapshot 与 Artifact，不把 TypeScript Interface 当运行时证据。

### 2.3 TTL、时钟与故障

- 配置 TTL 必须为 1..5,000ms；缓存建立时一次计算 `confirmedAtMonotonic + ttl`；
- 到期判断使用进程单调时钟，数据库/主机墙上时间回拨不能延长缓存；
- 单调时钟回拨、抛错、非安全值或到期加法溢出会清空缓存并使当前进程永久 fail closed；
- 有效且未被 Epoch Floor 淘汰的缓存是已确认决策，可承受短暂依赖失败直到原到期点；
- 到期/未命中后，Epoch Store、Artifact Store、版本或 Adapter 结果任何一项无法确认都 Deny；
- 不存在 stale-while-revalidate、错误续期、旧 Artifact 回退或 `allowOnError`。

### 2.4 Identity 与可观测错误

- Actor 可通过自身或当前 Token 的 Group Principal 获得授权；Delegation Chain 中每个 Principal 必须同时授权，形成交集；
- 正常 Policy Deny 与系统 Fail-closed Deny 可区分，但二者都不会升级为 Allow；
- Failure Observation 只含稳定 Code、Process ID、不可逆 Project Ref 与 Correlation Ref；
- Subject、Group、Delegation、Resource、Permission、Token、Claim、原始 Error、Stack 和输入正文不进入普通错误事件。

## 3. Red-Team 与 Intended-vs-Implemented 结果

[专项审查](../reviews/adr-012-policy-epoch-red-team.md)在 Accepted 前实际修正了以下偏差：

- Gateway 最初信任 Adapter 的 TypeScript 返回类型，现复核 Snapshot Project、Epoch 范围、数据库时间、Delegation 长度与布尔结果；
- Gateway 最初没有复核 Artifact Reader 返回的四维版本字段，现拒绝错误 Project/Release/Policy/Compiler；
- 编译产物 Store 最初允许同键覆盖不同 Digest，现相同四维键不可变；
- 单调时钟数值回拨会永久关闭进程，但直接抛错最初可能在下一请求恢复，现二者统一永久 fail closed；
- Failure Observation 最初保留原始 Correlation ID，现与 Project 一样只输出不可逆 Ref；
- ADR 补充说明直接 Permission Binding 是关系授权归约 seam，不是完整 Role Schema。

修正后没有仍未关闭、且属于 G2-00-08 Harness 范围的 Intended-vs-Implemented 越权路径。真实数据库约束、异步通知竞态、统一 Gateway 接入、完整 Identity Context、OIDC 和 Object/Property/Link Policy Compiler 仍明确 OPEN。

## 4. 可复现执行

### 4.1 Clean install

```text
NODE_VERSION=24.18.0 /Users/wangyudong/.nvm/nvm-exec npm ci
toolchain: PASS (node 24.18.0, npm 11.16.0)
added 136 packages
```

执行前后 `package-lock.json` SHA-256 均为：

```text
596243cf1053ee28b22ba1f66307403d0627338bd56582dcfa1f4b88197bb45b
```

### 4.2 全仓 Gate

```text
NODE_VERSION=24.18.0 /Users/wangyudong/.nvm/nvm-exec npm run verify

check:toolchain     PASS
format:check        PASS
lint                PASS
typecheck           PASS
test:unit           PASS — 153/153
check:architecture  PASS — 1 package / 7 source files
```

G2-00-08 专项为 18/18 top-level tests。其中 2 个 fast-check Property 使用固定 Seed `20260813` 各执行 200 次，覆盖所有合法 TTL 的精确边界和任意撤权时刻下的通知丢失上界。

### 4.3 Harness Digest

对 `tools/policy-epoch/` 全部 4 个文件按路径排序后逐文件 SHA-256，再对清单 SHA-256：

```text
ed5a93f0b9e0543b7b0872c486f487b127927bf31a1a20e648b902c3e03e9f9d
```

后续任何 Epoch、Cache Key、TTL、Clock、Artifact、错误或测试边界变更都必须重新生成 Evidence，不得沿用本结论。

## 5. 明确不宣称

- 本记录不是 G2-00 Foundation 总 Gate PASS；G2-00-09～13 仍未完成。
- 当前没有真实 PostgreSQL Migration、关系 Role Schema、数据库角色、受控写函数、Trigger、审计表或 `LISTEN/NOTIFY` Connection。
- `InMemoryAuthorizationStore` 只证明事务状态合同，不证明 MVCC、锁竞争、连接池、Read Replica 或数据库故障行为。
- 两个 `PolicyDecisionProcess` 是独立进程状态模拟，不是两个真实 OS/Container API 实例或跨区域一致性测试。
- 当前没有完整 Identity/Delegation Foundation Contract；未来新增任何参与决策的可信 Attribute 必须进入 Fingerprint。
- 当前没有 OIDC Provider、Access Token/Session/Refresh/Revocation 测试，不能把外部 Group 变化宣传为 5 秒生效。
- 当前没有 Object/Link/Property Predicate Compiler、SQL 下推、Mask、Action Submission Criteria 或发布向量。
- 当前没有证明 API、UI、SDK、Function、Action、Harness 和运维入口全部经过统一 Policy Gateway。
- 当前不支持 Redis、外部授权引擎、多区域 Epoch 或跨区域五秒撤权声明。

这些限制不阻止 ADR-012 的 G2-00-08 状态合同 Accepted，但分别阻断 DB、Foundation Contract、Identity、Runtime、Security 与最终 Production Gate。
