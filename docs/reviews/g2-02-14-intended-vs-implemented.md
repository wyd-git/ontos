# G2-02-14 Intended-vs-Implemented 复审

- 日期：2026-08-17
- 方法：从 PRD、蓝图和 G2-02 任务包的产品意图反向跟踪到真实 HTTP、Worker、PostgreSQL、S3、OIDC、DDL、恢复和机器 Manifest
- 结论：**PASS**（未发现未记录偏差或 P1/P2 范围偷渡；G2-03/G2-04 义务仍明确保留）

## 意图与实现对照

| 产品意图                         | 实际实现                                                        | 可执行证据                                   | 偏差 |
| -------------------------------- | --------------------------------------------------------------- | -------------------------------------------- | ---- |
| 全新环境能完成上传到激活         | 独立 clean checkout + 空 PG/S3 卷启动 OIDC/API/Worker/DDL       | G2-02-14 单命令正式资格运行                  | 无   |
| 首成员不能回写历史 R1/A0         | R1/A0 保留；R2 才携带三成员 Runtime Plan                        | 生命周期状态与 Migration Guard               | 无   |
| 受管输入而非任意文件/Endpoint    | HTTP Session + S3 Version + 服务端 Hash/CSV Finalize            | 路径穿越与任意输入负测                       | 无   |
| 长任务失败可恢复且不暴露半成品   | PG Job/Lease/Fencing/Checkpoint + Attempt-owned Staging         | 每阶段 PID Kill/Resume 与不可见 Staging Gate | 无   |
| 坏版本不影响旧代                 | 坏 v2 进入 dead letter，Serving Head 不变                       | 正式全量生命周期断言                         | 无   |
| 好 Refresh 必须全旧或全新        | 不可变 Head Set + O(1) Pointer CAS                              | 并发轮询只见两个完整 Activation              | 无   |
| 动态 DDL 必须隔离                | Worker 只请求已持久 Plan；NOINHERIT DDL Login 执行              | DDL 角色反向权限测试与重启后 Catalog 核对    | 无   |
| 容量必须用完整库存并 fail closed | Source Forecast 与实时实测取大；硬上限不可审批                  | 5.67 GB 实测准入、12 GiB 超限拒绝            | 无   |
| 只允许一个 data-bearing Project  | 第二 Work Management Project 可配置/上传，但启动物化稳定拒绝    | `MATERIALIZATION_PROJECT_LIMIT_EXCEEDED`     | 无   |
| GC 只能删除完整负面证明          | Root/Inventory/Digest 绑定；瞬态 503 重试、stale 409 重扫       | 真实上传清理竞态与最终 COMMITTED             | 无   |
| 整体重启不依赖手工修库           | 重启后重解析 PG Port、Migration no-op、索引和状态 Manifest 相同 | 正式 Restart Evidence                        | 无   |
| 100k/1m 和 Cutover 达到包络      | 冷/热均 <30 分钟；20 次 P95/max 低于阈值                        | 原始机器报告及规范摘要                       | 无   |
| G2-02 不偷实现下游               | Scope 白名单 + Query/Policy/Action/Overlay/UI/SDK 黑名单        | Mutation Guard 与 Changed Path 审计          | 无   |
| Overlay 边界必须诚实             | 生产只接受受信 zero；W0/W1 仍为对抗 Port                        | 报告固定 `DEFERRED_G2_04`                    | 无   |

## 实现中发现并关闭的偏差

1. **容量证据不是实时库存。** 原实现可读取陈旧 Generation 测量；Migration 0021 改为从受信活库存计算并重新绑定准入。
2. **GC 与上传后台清理存在真实并发。** Root 在扫描/持久化中变化时返回可重试 503 并沿用幂等键；Plan 形成后变化时返回 409，必须创建新 Plan，禁止重试旧删除决定。
3. **整体重启假设 Docker Host Port 不变。** 命名容器重启后随机发布端口会变化；Runner 现在重新解析端口并重建所有数据库连接配置。
4. **重启后用写路径验证索引违反状态机。** GC 物理变化会使 Capacity Measurement 按设计 incomplete；验收改为只读验证计划、Inventory、Catalog 和签名注释，不绕过准入重发 DDL。
5. **浮点性能值破坏规范报告。** Cutover 样本改为整数微秒；清单同步按微秒校验阈值，并增加刚好越界的失败向量。
6. **验收清单标签落后一关。** Materialization Acceptance 从 G2-02-13 更正为 G2-02-14，防止总 Manifest 在语义上仍指向中间 Gate。

## 保留差距不是偏差

- 生产 Query Resolver、业务身份、Policy Compiler/Gateway 和 Cursor 尚未实现，归 G2-03。
- W0/W1 算法已由对抗 Port 证明，但真实 PostgreSQL Overlay Store、Conflict/Action 与 AC-03 归 G2-04。
- 当前 Work Management 用于第二领域通用性和单数据项目拒绝，不等于第二个完整业务应用已经上线。
- HA、PITR、对象存储灾备、生产告警、运行值班和 Internal Alpha 发布验收不属于 G2-02。

本复审没有用类、接口或单测存在代替可执行生产路径，也没有把后续 Gate 的义务提前标记为完成。
