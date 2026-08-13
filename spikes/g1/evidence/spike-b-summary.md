# Spike B 最终证据摘要

- 判定：PASS（经历一次真实 FAIL、修正后完整重跑）
- 状态模型：不可变 Base、不可变 Overlay Operations、可重建 Current Projection、Generation Pointer

## 正确性与恢复

覆盖同字段冲突、异字段合并、来源删除、无 Overlay 删除、身份碰撞、Clear、Remove Override、Tombstone、Restore、`W0..W1` Catch-up、Worker 重试和事务故障回滚。

- 初始 20k 物化：1.104 秒
- 故障后幂等重建：1.072 秒；Object/Conflict checksum 完全相同
- Catch-up + Cutover：96.654 ms
- 预期冲突：3；实际冲突：3
- 未提交原始路径：`raw/2026-08-13T053859.836Z-spike-b/result.json`
- SHA-256：`e684c9cdd1368a3b6eae825bb3779d917edb96e8ddfa8acfad87eb8bf3ed5041`

## 全规模物化

- 100k Objects + 1m Links 总耗时：19.769 秒（门槛 30 分钟）
- Link staging：13.017 秒
- 五 Object Types + 五 Link Types 联合原子切换：364.503 ms
- Staging/Active dangling Links：均为 0
- Active Object/Link Generation pointers：5/5
- 未提交原始路径：`raw/2026-08-13T053946.392Z-spike-b-scale/result.json`
- SHA-256：`ac9a5d4c82cdb3f69f2442f0fcf498194f01de03ca4502f74c56ec5e4e1a12b6`

## 切换分布与真实失败

第一次 20 次往返切换结果为 FAIL：P95 1,768.389 ms，高于 1,000 ms 门槛。没有降低阈值。定位为 `cutover_generation` 对未变化的 100k `object_heads` 仍执行更新。

- 未提交失败原始路径：`raw/2026-08-13T053702.280Z-spike-b-cutover/result.json`
- SHA-256：`16f6ca72135cbfd1b7aa6b3a9e2d22a62a5092b1fd06a5247fee9c4f2e121501`

修正为仅当 `object_version/lifecycle_state/conflict_state` 实际变化时更新 Head，随后重跑正确性、全规模和 20 次往返切换：

- P95：408.451 ms（门槛 1,000 ms）
- 最大：414.306 ms（门槛 5,000 ms）
- 20/20 完成；偶数次后恢复新 Generation；100k/1m 完整；dangling Links 0
- 未提交最终原始路径：`raw/2026-08-13T054016.798Z-spike-b-cutover/result.json`
- SHA-256：`1331d191ca8e3150c4e9b9bec7461fbc3909c6130cab63d840206e652d43a5f9`

结论：状态模型可行，但全量物化必须由可恢复 Worker 编排；数据库过程只负责小型 Catch-up，Cutover 不得无条件改写未变化的 Head。
