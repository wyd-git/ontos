# ADR-018：不可变 Head Set 与 Snapshot Group 原子 Cutover

- 状态：Accepted for G2-02-11
- 日期：2026-08-16
- Owner：Runtime / Database
- 依赖：[ADR-007](007-runtime-activation-serving-head.md)、[ADR-014](014-materialization-transaction-ddl-overlay-boundary.md)、[ADR-016](016-quality-current-provenance-confirmation.md)
- 决策范围：Snapshot Group 准备、不可变 Activation/Member、Object Head 业务版本、Serving Head/Channel CAS、zero-overlay W0/W1 边界与失败恢复

## 1. 决策结论

Snapshot Group Cutover 拆成两个明确阶段：

1. **Prepare（长阶段）**：在最终提交之前完成 Certificate/Plan/Inventory 选择、Object/Link 语义 Digest、Head Version 判定、不可变 Activation 候选和完整 Head Set 构建。这个阶段允许长查询和大批写入，产物不可服务。
2. **Commit（短事务）**：按全局顺序加锁，重验所有承重事实，创建或复用不可变 Activation/Member，将 Project 的 Head Set 指针、Release Serving Head 和当前 Channel 在同一 PostgreSQL 事务中 CAS 移动。

活动 Object Head 不再以 100k 行原地 UPDATE 完成切换。每次 Prepare 构建完整、不可变的 `object_head_sets + object_head_versions`；最终事务只对 `project_object_head_pointers` 执行一次 Project 级 CAS。`runtime.object_heads` 是解析当前 Head Set 的 security-barrier View。

## 2. 原子性与锁顺序

Commit 只能按以下顺序获取控制锁：

```text
PROJECT_CONTROL
→ RELEASE_CHANNEL
→ RELEASE
→ SNAPSHOT_GROUP
→ OBJECT_TYPE_CUTOVER（UUID 字节序）
→ GENERATION_INVENTORY
→ SERVING_HEADS
```

锁内重验 Project `publication_sequence`、期望 Head Set、`state_revision`、`inventory_revision`、完整 Runtime Plan、当前 Compatibility Certificate、Capacity/Index/Approval 和期望 Serving/Channel 序号。任一变化都以稳定冲突结束，不允许覆盖胜者。

网络、对象存储、CSV 解析、Base/Current 大批写入、容量测量、动态索引 DDL 和 Head Set 构建都不得进入 Commit 事务。实测 100k Object / 1m Link 下最终 Commit 为 207.474 ms。

## 3. Object Head 版本语义

Head 保存两类 Digest：

- `base_value_digest`：绑定不可变 Current/Base 事实；
- `head_digest`：由业务值、生命周期和当前 Snapshot Group 内可见 Link 集合计算的语义 Digest。

只有语义 Digest 改变才增加 `head_version`。只改 Provenance、物理索引或重建了内容等价的 Generation 时，Head 仅重指向新 Generation，业务版本与语义 Digest 不变。

Head Set 表不向 API、Worker 或 Ops 开放直写。其成员只能由 `SECURITY DEFINER` Prepare 从当前 Head 和已受外键/证书约束的候选 Current 派生；Runtime 只能调用受控 Prepare/Commit 入口。

## 4. 幂等、失败与恢复

Prepare 使用 `(project, idempotency_key)` 稳定绑定请求。相同请求复用同一 Preparation/Head Set，同 Key 不同输入拒绝。Activation 再用规范 Content Digest 去重，因此 Commit 已成功但响应丢失后，重试返回同一 Activation，不创建第二份成员集。

在锁完成、Activation、Head Pointer、Serving Head、Channel、生命周期、Revision 和返回结果后分别注入故障；PostgreSQL 事务保证全部回到旧集合或全部提交。恢复只读受控幂等状态，禁止手工修改 Pointer。

## 5. Overlay 边界

G2-02 生产只接受注册的 `ontos.zero-overlay@1`，且 W0/W1 证据必须完整、稳定、`watermark=0`、`deltaCount=0`。Provider 未知、读取失败、非零或证据改变均保持旧代。

对抗 Port 会在 W0..W1 注入有序 Delta，验证无缺口、无重复、期望 Head 一致和稳定水位。这是未来 Overlay 的协议证据，不代表 G2-04 的 PostgreSQL Overlay/Conflict 已完成。

## 6. 后续所有权

- G2-02-12 只能在完整 Root 证明后回收退役 Head Set/Generation/Index，不得触及当前 Pointer 或任意 Activation 可解析数据。
- G2-02-13 负责真实 Admin HTTP、生产 Worker 阶段组合、Testkit 与统一 CI 入口；在完成前 `worker:start` 继续 fail closed。
- G2-02-14 从独立 Clone/空卷重跑真实 OIDC/S3/API/Worker/DDL/Cutover/GC 闭环。
- G2-03 Query 用真实 Resolver 复跑“只见全旧或全新”；G2-04 实现真实 Overlay/Action 后复跑 AC-03。
