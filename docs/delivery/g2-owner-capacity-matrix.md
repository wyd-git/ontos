# G2 Owner、容量与顺序矩阵

- 状态：Frozen for G2-00 exit
- Accountable Owner：`wyd-git`
- 实际有效并行度：1 条工程通道
- 实现支持：Codex，在 Repository Owner 的范围与合并批准下工作

## 1. 实际责任覆盖

| 责任域                                | Accountable Owner | 当前执行方式                  | 第二视角                                          |
| ------------------------------------- | ----------------- | ----------------------------- | ------------------------------------------------- |
| 产品范围、架构、仓库与发布批准        | `wyd-git`         | Repository Owner + Codex 支持 | 每个 Gate 的独立验收/红队记录                     |
| Backend、Runtime、Data、Policy        | `wyd-git`         | 单通道顺序实现                | 对应 ADR、负面测试与 Intended-vs-Implemented 审查 |
| Platform、Quality、Security、Recovery | `wyd-git`         | 单通道顺序实现                | 强制 CI；安全/恢复 Gate 上线前增加领域审查人      |
| Web、SDK、Portability                 | `wyd-git`         | 到 G2-05 才开始               | 两 Package 真实集成与独立验收                     |

`Codex` 是执行支持，不替代最终责任人。G2-00-13 的独立 Reviewer 是与实现过程分离的 clean checkout、Intended-vs-Implemented 和 adversarial red-team 审查角色；最终合并仍由 `wyd-git` 负责。当前没有把“一个人加 AI”包装成 4–6 人团队。G2-06 Recovery、G2-08 Security 和 Internal Alpha 前仍必须补充相应领域的第二审查人。

## 2. 重算后的 G2-01～05 日历

原蓝图“4–6 人、至少 4 条并行责任线、6 周完成 G2-01～05”的情景已经撤销。当前只有 1 条有效工程通道，Gate 不并行，前一 Gate 未 PASS 时不开始后一 Gate。

| 顺序 | Gate                  |   单通道规划范围 | 主要不确定性                                  |
| ---: | --------------------- | ---------------: | --------------------------------------------- |
|    1 | G2-01 Metadata        |       2–4 工程周 | Revision/Release 事务、兼容性和 Package Store |
|    2 | G2-02 Materialization |       4–6 工程周 | 100k/1m、Staging/Cutover、Overlay、容量实测   |
|    3 | G2-03 Query + Policy  |       3–4 工程周 | HTTP/SDK/Harness 同策略、Cursor 与遍历        |
|    4 | G2-04 Action          |       3–4 工程周 | Preflight、锁、原子事务、Outbox 故障注入      |
|    5 | G2-05 Portability     |       2–4 工程周 | 两 Package、最小 UI、Function、SDK、回归      |
|      | **合计**              | **14–22 工程周** | 不含等待外部审查、需求变更或基础设施采购      |

这是容量情景，不是交付承诺。每个 Gate 入口重新估算一次；若范围、Owner 或可用时间变化，先更新本矩阵，不删除安全、事务、恢复或性能退出条件来维持日期。

## 3. 顺序与停止规则

1. G2-00 合并后只允许先建立 G2-01 任务包，不直接开始 DB-02、页面或 Action。
2. 每次只允许一个业务 Gate 处于实现中；评审和证据整理可以跟随当前 Gate，但不能伪装成第二条开发线。
3. Security、Recovery 或容量 Kill Criterion 触发时停止下游 Gate，先修正模型或缩小承诺。
4. 未指定领域第二审查人的功能不能进入 Internal Alpha；可以保留已通过的技术证据，但不能宣称生产可用。
