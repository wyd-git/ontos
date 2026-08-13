# Spike B：Base + Overlay 与原子切换

## 假设

不可变 Base Snapshot、不可变 Overlay Operations 与可重建 Current Projection，可以在来源刷新期间保留业务写回，并明确处理冲突。

## 必测状态

1. Base v1，无 Overlay；
2. Overlay 修改 v1 的一个字段；
3. Base v2 修改不同字段；
4. Base v2 修改同一字段；
5. Base 删除有 Overlay 的对象；
6. Base 删除无 Overlay 的对象；
7. Overlay 创建对象后 Base 出现相同 Key；
8. Tombstone、Restore、Clear 和 Remove Override；
9. v2 构建期间产生新 Overlay；
10. Cutover 前、事务中和 Commit 后故障。

## 切换协议

```text
capture W0
→ build staged base/current/conflicts with overlays <= W0
→ acquire object-type cutover lock
→ capture W1
→ replay overlays (W0, W1]
→ validate counts/constraints
→ atomically switch snapshot + generation pointers
→ release lock
```

## 不变量

- Query 只见完整旧 Generation 或完整新 Generation；
- Overlay Operation 永不原地修改；
- Current Value、Conflict 和 Provenance 可重建；
- 同字段变化不会使用 Last-write-wins 静默覆盖；
- Action 在构建期间成功提交的 Operation 必须进入新 Generation；
- 失败切换不改变 Active Pointer；
- 实际状态未变化时不增加 Object Version。

## 通过条件

- 全部状态用例通过；
- 100k Objects / 1m Links 全量重建 < 30 分钟；
- Cutover Lock P95 < 1 秒，最大 < 5 秒；
- 0 条 Overlay 丢失；
- 0 个无来源 Current Value；
- 冲突数量与 Oracle Reference Model 完全一致。

## 交付物

- JavaScript Oracle Reference Model；
- PostgreSQL 表与 Staging/Cutover 流程；
- 故障注入集成测试；
- 并发 Catch-up 测试；
- Provenance 对账查询；
- PASS/FAIL 结论。

## 失败判定

- 需要暂停整个系统完成刷新；
- 新 Projection 丢失构建期间的 Action；
- 冲突只能靠人工比较日志发现；
- Current Projection 成为不可重建的唯一事实；
- Primary Key 漂移被当作普通更新。
