# G2-03-05 Intended-vs-Implemented 复审

- 日期：2026-08-19
- 方法：从 G2-03-05 八条 Acceptance 和 ADR-023 反向追踪到实际强制点、信任边界与破坏性向量
- 结论：**PASS**
- 限定：证明 Policy 可被可复现地编译、测试和发布；不宣称 Gateway、Query SQL、Runtime HTTP、UI 或生产调度已完成

## 1. 逐条对照

| 原始意图                                                                          | 实际强制点                                                                                                      | 可执行证据                                                                              | 结果 |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---- |
| Direct Resource 与 Package 只走同一 Parser/Registry                               | `resource-family-registry` 激活 `policy`；Metadata Direct/Package 都调用同一 Parser 和 Extractor                | 正向 Package Policy；Raw SQL、未知字段和延后 Family 负测                                | 一致 |
| Target 必须是同 Project/Release Closure 的精确 Revision                           | Rule、Vector、Link Predicate 均带 Resource/Revision UUID 与 JSON Pointer；DB 比对完整依赖集                     | 跨 Project、错 Family/Resource、缺 Closure、错 Path 均失败                              | 一致 |
| Compiler 只接受有界 AST，输出确定 IR                                              | Domain 纯函数无 DB/网络/时钟；Rules/Vectors/Facts/深度/集合/Artifact 均有上限；规范 JSON + SHA-256              | Locale/Timezone/独立进程逐字节一致；过大/递归/未知节点负测                              | 一致 |
| Predicate 只读可索引 Property、受信 Actor Attribute 和一跳 Link                   | Compiler 解析精确 Object/Link Definition；Actor Schema 来自 Active Claim Mapping；Link 不允许递归               | 非索引 Property、未知 Attribute、错 Link Endpoint、递归 Link 负测                       | 一致 |
| Property/Link/Action 语义显式 default deny                                        | Evaluator 固定 Deny > Mask > Allow；无匹配 Deny；Missing/Null 三值逻辑；未激活 Action Revision 无法进入 Closure | Object/Property/Link、Mask/Deny、Missing/Null 和 `not(missing)` 向量                    | 一致 |
| 必需 Test Vector 和 Artifact 错误不得发布                                         | Contract 强制 Allow/Deny/Missing/Null 及适用扩展；Compilation 绑定向量数、结果、摘要、Compiler 版本和 Release   | 缺 Compilation Stage 失败；错数量/错 Content Digest/伪 Validation/修改 Compilation 负测 | 一致 |
| Published Revision/Artifact 不原地替换，兼容性区分放宽/收紧                       | 既有 Revision/Artifact/Compilation Immutable Guard；Policy Comparator 对 Allow/Mask/Deny Rule 变化分类          | tightening/widening/ambiguous/unchanged 向量与 Published UPDATE 55000                   | 一致 |
| 伪造 compiled 布尔值、SQL、Identifier、网络、递归、非确定时间和无界集合必须被拒绝 | 客户合同不含 Compilation 字段；`api_runtime` 无 Recorder EXECUTE；Worker/Compiler 先验证并存 S3 再写不可变事实  | API 直调返回 42501；Raw SQL/Identifier/递归/过大输入不产生 Passed Artifact              | 一致 |

## 2. 承重不变量

| 不变量                            | 强制位置                                                                       | 故意破坏的结果                                                |
| --------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Policy 不按 API Name 查“最新”     | Target 精确 UUID + Dependency Context Digest + Release Pins                    | 替换 Resource/Revision/Family/Closure 即 `TARGET_UNAVAILABLE` |
| 依赖不能少一条或合并多个引用      | `(source,target,type,source_path)` 唯一性 + Validation 集合差                  | 旧“空壳 Policy”测试夹具被拒绝，修正后才可回归                 |
| Compiler 不能因主机环境改变字节   | 规范化顺序、显式 Request Time、无 Locale/系统时钟                              | 多 Locale/Timezone/进程产物仍相同                             |
| Missing 不能通过逻辑反转扩权      | 独立 Symbol + Kleene 三值逻辑                                                  | 字符串 `"missing"` 是普通值；真 Missing 始终未知/默认 Deny    |
| Test Report 不能只靠客户声称通过  | API 无写权；Compiler 用正式 Evaluator 生成逐向量 Report；DB 校验数量/摘要/状态 | API 42501；错摘要或向量数事务整体回滚                         |
| Artifact 写失败不得留下可发布事实 | Application 顺序固定为 IR → Test → Compilation                                 | 任一 S3 失败时 Recorder 零调用                                |
| 不能绕过 Application 直改 Release | 0026 `BEFORE UPDATE OF state` Trigger                                          | 伪造 Valid Report 后仍因缺 Compilation 返回 55000             |
| 发布后不能换 Compilation          | Immutable Trigger + Stage/Publish 编译身份复验                                 | UPDATE 失败；只能创建新 Revision/Release                      |
| 0026 不得留下部分 Schema          | 单事务 Migration + Hash Ledger                                                 | 末尾故障后 Ledger 25、Resolver 不存在                         |

## 3. 攻击者—受害者—修复核验

1. **攻击者：能调用 Admin API 的浏览器；受害者：Project 数据读权。** Policy Resource 不接受 `compiled/status/artifactDigest/SQL`，API 数据库身份也无权写 Compilation。
2. **攻击者：提交错误精确绑定的 Editor；受害者：另一 Project/Revision。** Validator 与 Compiler 都核对 Project、Resource、Revision、Family、API Name 和 Release Closure，失败对外同形。
3. **攻击者：使用 Missing/Null 绕过 Predicate 的用户；受害者：不完整数据对象。** Missing/Null 不等于 False 并不能被 `not` 反转为 Allow，无显式 Allow 就 Deny。
4. **攻击者：获得普通 API DB Credential 的调用方；受害者：Release Gate。** 复审中发现旧 `record_policy_compilation` Grant 过宽，已在 0026 撤销 API EXECUTE，仅保留给 Worker/Compiler。
5. **攻击者：尝试利用 S3 重写或错误 Media Type 的主体；受害者：历史 Policy 语义。** 键由 Digest 派生，存量和读取均复算 Digest/Media Type；版本化 Bucket 是启动前置条件。

## 4. 复审中实际发现并关闭的偏差

- 旧 Materialization 回归仍构造无 Rules/Vectors/Dependencies 的“空壳 Policy”；没有放宽 Trigger，而是把历史测试改为合法 Policy 并在每个 Release 进入 Staging 前建立精确 Compilation。
- PostgreSQL Trigger 初版的 RLS/`search_path`/返回类型与旧 Validator 覆盖产生多个真实失败；已以 Security Definer、显式类型和前向替换修正。
- 首版 Missing 用字符串哨兵，会与真实业务值 `"missing"` 冲突；已改为不可伪造 Symbol。
- Actor `string_array` 合同有类型但 Test Fact 原本无法表达；已增加有界、唯一、排序的 `values` 并同步 Schema/Golden。
- S3 写入失败初版被误分类为输入错误；已分类为 `STORAGE_FAILURE` 且证明不写 Compilation。
- 复审最后发现 `api_runtime` 仍继承 0024 的 Recorder EXECUTE；已改为 API 只读、Worker/Compiler 独占写入，并用真非 Owner 登录证明 42501。

## 5. 未夸大的剩余边界

- Policy Compilation Application Service 已是可组合的生产分层，但本项不新建 HTTP Endpoint 或后台调度器；生产调度/重试/指标属部署组合和 G2-03-06。
- Stage/Publish 校验不可变 DB 绑定；Artifact 如在记录后被外部删除，当前数据库不访问 S3，G2-03-06 精确 Loader 必须 fail closed，不能回退旧 Artifact。
- Policy Evaluator 已固定语义，但还没有被 Query/Action/Function 入口统一调用；这是 G2-03-06 的唯一 Gateway 责任。
- Action Target 合同已冻结精确绑定，Action Resource Family 未激活时只会因缺同 Closure Revision 而拒绝，不是 Action 功能已完成。
- 本地 SeaweedFS 真实验证 S3 版本协议，不等于已完成云端 IAM/KMS/备份/恢复演练。

## 6. 结论

未发现需要信任客户编译结果、按最新 Revision 漂移、在发布后原地换 Artifact，或使用无界/非确定执行的停止条件。只有同一 Commit 的 `g2-03-05-evidence-manifest.json=CLEAN_ROOM_PASS` 才使本结论正式成立；随后只放行 G2-03-06。
