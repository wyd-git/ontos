# Red-Team：G2-01-04 Project、Principal、Role Binding 与 Epoch

- 日期：2026-08-14
- 审查对象：`@ontos/metadata-domain`、`@ontos/metadata-application`、`@ontos/metadata-postgres` 与 PostgreSQL Integration
- 方法：Intended → Enforcement Point → Negative Test → Residual Risk
- 结论：**Go for G2-01-05**；G2-01-04 范围内的身份、管理授权和事务偏差已关闭。

## 1. 审查中发现并修正的偏差

### 1.1 只检查 Project Binding 会错误接受其他 Project 的 Resource ID

最初 Authorization Reader 在 Resource ID 不属于请求 Project 时读不到 Resource Binding，并按“没有收窄 Binding”退回 Project 权限。这会把非法的跨 Project Resource 引用误判为允许。现在同一快照查询显式验证 `(project_id, resource_id)`；不属于该 Project 的 Resource 直接产生空角色并 Deny。Integration 建立第二个 Project/Resource 后执行跨 Project 读取负测。**CLOSED**。

### 1.2 Disabled Principal 仍可走无既有 Project 的创建路径

Project 创建不需要已有 Project 权限，因此初版在 Principal 解析后直接创建 Owner Binding，漏掉 Principal 状态检查。现在所有创建和管理路径都先构造 Active `ResolvedFoundationIdentity`；Disabled Principal 返回稳定 `FORBIDDEN`，不会创建 Project、Binding 或 Epoch。**CLOSED**。

### 1.3 事务获取连接失败没有稳定应用错误

初版只映射已经取得连接后的 PostgreSQL 错误；Pool 获取连接失败可能越过稳定错误边界。现在连接获取、事务 SQL 和 Authorization Reader 均映射为有限错误码；Rollback 自身失败时以错误方式释放连接，避免把未知连接放回 Pool。**CLOSED**。

### 1.4 Application 曾完全信任 Principal Directory 的返回关联

PostgreSQL Adapter 按 issuer/subject 正确查询，但 Port 的其他实现若返回另一外部身份的 Principal，Application 原本只检查 Active 状态。现在 Application 同时核对返回 Principal 的 issuer/subject 与已验证身份完全一致；替换身份的 Fake Directory 返回稳定 `STORAGE_FAILURE`，Project Repository 不执行。**CLOSED**。

## 2. Intended-vs-Implemented 矩阵

| Intended Claim                                                      | 精确执行点                                                                                                                   | 反例测试                                                                                                          | 结果            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------- |
| 同一 issuer/subject 稳定映射同一 Principal，Actor ID 不由客户端提供 | `resolveVerifiedIdentity` 使用内部 UUID 与数据库 `(oidc_issuer, oidc_subject)` UQ；Application Command 无 Actor Principal ID | 12 个并发解析只产生一个 Principal；Identity 的 `principalId`/Claims/Bearer 扩展字段被拒绝                         | PASS            |
| Use Case 只接收有界已验证身份和统一 Authorizer                      | `VerifiedFoundationIdentity` 是闭合接口；Service 方法类型只接受该身份；管理操作只调用 `ManagementAuthorizer`                 | 任意 Claims Map、Bearer Token 和伪造 Actor ID 不能进入身份结构；Authorizer Deny 时 Repository 未被调用            | PASS            |
| Project、Owner Binding、初始 Epoch 全有或全无                       | `createProjectWithOwner` 的三个 INSERT 位于同一 `BEGIN/COMMIT`                                                               | 第二个 INSERT 故意制造 Binding PK 冲突；Project/Binding/Epoch 三类行均为 0                                        | PASS            |
| Owner/Editor/Viewer 矩阵精确；Executor/Auditor 无隐式权限           | Domain `grants` 是唯一角色矩阵；Application 不复制角色判断                                                                   | 五个角色 × 五个权限同时做纯领域和真实 PostgreSQL 正反测试                                                         | PASS            |
| Resource Binding 只能收窄 Project Permission                        | `isManagementPermissionAllowed` 先要求 Project Grant，再检查可选 Resource Grant；Reader 验证 Resource 属于 Project           | Editor→Viewer 禁止 Edit；Viewer→Owner 仍禁止 Edit；Executor→Owner 仍禁止；跨 Project Resource Deny                | PASS            |
| Binding 变化与 Epoch `+1` 同事务；相同替换幂等                      | Epoch 行先 `FOR UPDATE` + CAS；旧 Binding Revoke、新行 Insert、Epoch Update 同事务                                           | 相同角色返回 `changed=false` 且 Epoch 不变；陈旧 Epoch 冲突；新 Binding PK 冲突后旧 Active Binding/Epoch 完整保留 | PASS            |
| 撤权缓存最迟五秒拒绝且依赖故障 Fail Closed                          | ADR-012 `PolicyDecisionProcess` 的 Epoch Floor、硬 TTL 和失败拒绝；本任务 Repository 每次授权变化同步递增真实 Epoch          | 通知丢失时 4,999ms 可命中旧值，5,000ms 强制重读 Deny；读取/Artifact/Clock 故障均 Deny                             | PASS（Harness） |
| Project Archive 不删除历史且不释放 API Name                         | Archive 与 Epoch `+1` 同事务；DB 全部 FK `ON DELETE RESTRICT`；Project API Name 保持 UQ 墓碑                                 | Archive 后 Resource/Release 行仍存在；相同 API Name 新建返回 `ALREADY_EXISTS`；Archived Project 授权 Deny         | PASS            |

## 3. What I Couldn't Assess

- 本任务信任 `VerifiedFoundationIdentity` 已由入口完成 OIDC 签名、Issuer、Audience、时间和 Scope 校验；真实 Token 验证与 HTTP Composition Root 属于 G2-01-10，当前不宣称互联网入口已安全。
- ADR-012 的五秒撤权结论仍是同步 Policy Harness；G2-01-04 证明真实 Repository 与 Epoch 同事务，但不把异步 PostgreSQL Reader 偷接进尚未实现的 G2-03 Policy Gateway。
- 本次只验证 PostgreSQL 16 本地容器中的事务、行锁和非 Owner Runtime 登录；不宣称生产 TLS、HA、连接代理、备份恢复或跨区域行为。
- 最后一个 Owner 是否允许被撤销未在 G2-01 任务包或 ADR-013 中定义；本任务不擅自增加“至少一个 Owner”产品规则。进入多人管理体验前必须由产品规则明确。
