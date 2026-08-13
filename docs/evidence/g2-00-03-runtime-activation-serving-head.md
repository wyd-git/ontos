# G2-00-03 Runtime Activation 与 Serving Head 验收记录

- 结论：**PASS（仅限 G2-00-03）**
- 执行日期：2026-08-13
- 分支：`agent/g2-00-03-runtime-activation-serving-head`
- 工具：Node.js 24.18.0 / npm 11.16.0 / fast-check 4.9.0

本记录对应 [G2-00-03 WWA](../delivery/g2-00-foundation-task-pack.md#g2-00-03adr-007-runtime-activation-与-serving-head)。最终实现 Commit 由 Draft PR head 记录，避免在被哈希的 Commit 中写入自身哈希。

## 1. 验收映射

| WWA 声明                                                  | 实现证据                                                                                  | 执行证据                                                 | 结果 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---- |
| Publish、Refresh、Rollback、Retire、GC 与并发控制         | [ADR-007](../architecture/adr/007-runtime-activation-serving-head.md)；`model.ts:508-844` | 固定场景覆盖控制 CAS、指针切换、退休和 GC                | PASS |
| R1/R2、S1/S2、兼容/不兼容 Mapping、并发、Query、Preflight | `scenarios.test.ts:24-410`                                                                | 13 个固定场景全部通过                                    | PASS |
| Query 只解析一次 Activation                               | `model.ts:632-689`；`properties.test.ts:27-74`                                            | 200 次、每次 1–30 次 Refresh，`resolutionCount` 始终为 1 | PASS |
| Release Pin 始终匹配 Generation Schema/Mapping            | `model.ts:946-1020`；`properties.test.ts:76-138,294-308`                                  | 200 组兼容矩阵 + 200 组随机状态序列；无证明组合全部拒绝  | PASS |
| 90 天支持不等于保留每个历史 Generation                    | ADR-007 §1、§4.5、§7；`model.ts:508-526,596-620`                                          | 90 天前退休失败；旧数据代越过根与保留规则后可 GC         | PASS |
| Release/Generation 上限、超额审批和退休                   | ADR-007 §6；`model.ts:454-507,1065-1145`                                                  | 正常上限拒绝、临时审批通过、硬上限拒绝、支持窗后退休     | PASS |
| Serving Head、有效 Token、Job、Hold 不可被 GC             | `model.ts:1147-1238`                                                                      | 固定场景同时建立五类根；旧 GC Plan 遇新增 Hold 必须失败  | PASS |

## 2. 冻结的运行时语义

本任务没有实现业务 Release Store，而是冻结后续模块共同依赖的引用语义：

```text
Channel ───────────────┐
                      ├─> immutable Activation
Release Serving Head ─┘      ├─ Release Manifest + Pins
                             └─ complete Generation + Snapshot members
```

- 定义 Publish 和纯数据 Refresh 都只切换 Activation；不存在可独立变化的 Release/Generation 双指针。
- 受支持的显式 Release 拥有独立 Serving Head。R2 发布不会删除 R1 的可服务视图。
- 兼容 Generation 复用需要绑定完整 Pin Fingerprint 的证书；无证书和 Snapshot Group 混代均被模型拒绝。
- Rollback 创建 R3 并复制历史 Pins；不会把 Channel 直接指回 R1，也不改变历史 Action 引用。
- Query 请求上下文固定一个 Activation；Preflight Token 在 Pointer 变化后返回 `PREFLIGHT_STALE`。
- 控制 Cutover 使用 `controlRevision`；Query/Token/Job/Hold 使用独立 `stateRevision`，不会让读流量使发布 CAS 饥饿。

## 3. 有界支持与容量行为

接受的初始控制面上限为：

| 指标                                                    | 正常 | 硬上限 |
| ------------------------------------------------------- | ---: | -----: |
| 同时服务 Release Heads / Project                        |   32 |     64 |
| Serving Heads 引用的不同 Generations / Project + Member |    8 |     16 |

超正常上限的审批最长 30 天，必须指定可在截止前合法退休的 Release；硬上限不能审批突破。审批过期后允许在已有占用内做不扩张的安全 Refresh，但新扩张失败。到达上限不能提前退休仍在 90 天支持窗内的 Release。

该数量边界不是字节容量结论。32/8 和 64/16 必须由 G2-00-04 ADR-008 用真实 Current/Link/Index 大小、WAL 和重建时间验证；若不成立，应在 G2-01 前收紧配置或正式修改产品要求。

## 4. GC 与在途安全

GC 先从 Channel、Serving Head、有效 Preflight Token、在途 Query、ACTIVE Job、ACTIVE Hold 和历史引用做图遍历，再应用“每项目每 Member 最近两个非活动 Generation + 离开 Serving 后 7 天”的保留规则。

GC Plan 绑定 `stateRevision`。测试先生成包含旧孤儿 Activation 的 Plan，再新增指向它的 Hold；旧 Plan Commit 必须返回 `CONCURRENT_MODIFICATION`，重新计划后该 Activation 不再是候选。

Intended-vs-Implemented 审查发现原模型用 `createdAt` 计算 7 天窗口：一个长期服务的旧 Generation 刚切走时可能立即进入候选。实现已加入 `lastServingAt`，由 Publish/Refresh/Retire 比较 Cutover 前后服务图并记录离开时间；新增固定场景证明一个创建 100 天的 Generation 在刚离开 Serving Head 后仍获得完整 7 天宽限。

## 5. Property-based 证据

`properties.test.ts` 使用固定种子 `20260813`，三项属性各执行 200 次：

1. 随机 1–30 次 Refresh 穿插 Member 读取，Query 始终读取首次解析的 Activation。
2. 随机 Release Schema/Mapping 组合、构建 Release 与目标 Release；只有携带目标完整 Pin 证明的 Generation 能创建 Activation。
3. 最长 80 步的 Refresh、Query、Token、Job、Hold、GC 和 stale control 事件序列；每一步独立核对 Pin/Generation 绑定并执行完整状态不变量。

fast-check 会在失败时收缩反例；固定种子保证本 Gate 的输入序列可复现。它补充固定场景，不替代后续真实 PostgreSQL 并发与故障注入。

## 6. Strategy Red-Team 与 Intended-vs-Implemented

[ADR-007 专项红队](../reviews/adr-007-runtime-activation-red-team.md)保留五个后续承重假设及停止条件。审查期间关闭两项实现偏差：

1. **非活动代计数偏差：** 原实现把当前活动 Generation 算入“最近 N 个非活动代”，并按 Member Key 全局分组。已改为先排除服务/引用根，再按“项目 + Member”保留最近 N 个非活动代。
2. **保留窗口起点偏差：** 原实现按创建时间而非离开 Serving Head 时间计算。已改为 Cutover 记录 `lastServingAt`，并加入长期活动代回归场景。

其余差异被分类为显式后续 Gate，而不是当前实现缺陷：

- 模型把 Compatibility Certificate 当受信输入；真实 Verifier 尚未实现，ADR 禁止普通调用方自行签发。
- 模型用保守的单一控制序号表达项目内串行化；数据库实现应按 Project 分行，跨项目独立性由 DB Gate 验证。
- Job/Hold/历史引用可能延长存储寿命；ADR-008 必须建立字节 Admission、Owner 和告警。
- 状态模型不证明 PostgreSQL 隔离、锁和崩溃恢复；DB-01/02/04 必须用相同不变量复验。

没有发现仍开放、会产生 Release/Generation 交叉版本、绕过 90 天支持或误删有效引用内容的 G2-00-03 偏差。

## 7. 可复现验证

从更新后的 lockfile 执行：

```text
npm ci: PASS（135 packages）
toolchain: PASS（Node 24.18.0 / npm 11.16.0）
format: PASS
lint: PASS
typecheck: PASS
unit: 35 passed, 0 failed
architecture: PASS
```

其中 Runtime Activation 为 13 个固定场景和 3 个 property tests；全仓单测还包含原有工具链、架构和本地环境测试。`package-lock.json` SHA-256：

```text
e8abc59d2179fe2015dc872e4e8f39ab3f96b94bc3c6fe984564304737c6bd60
```

新增直接依赖只有精确锁定的 `fast-check@4.9.0`，用于测试，不进入生产运行包。

## 8. 明确不宣称

- 本记录不是 G2-00 Foundation 总 Gate PASS；G2-00-04～13 仍未完成。
- 本任务没有创建数据库表、Migration、Repository、业务 Release/Snapshot Store 或 Endpoint。
- Compatibility Certificate 结构与 Verifier 算法尚未达到生产实现 Gate。
- 32/8 与 64/16 是待 ADR-008 验证的控制面硬边界，不是已证明的生产容量。
- 当前测试证明纯状态语义，不证明真实 PostgreSQL 锁、WAL、故障恢复或多进程性能。
- 正式产品功能仍未开始；下一项是 G2-00-04，而不是提前实现 Metadata。
