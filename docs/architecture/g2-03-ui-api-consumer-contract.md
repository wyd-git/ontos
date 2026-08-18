# G2-03 UI/API 早期消费者合同

- 状态：Frozen for G2-03 task planning；机器字段合同由 G2-03-02 冻结
- 日期：2026-08-17
- Owner：Runtime / Policy / Web（accountable: `wyd-git`）
- 上游：[Ontology Kernel PRD](../product/ontology-kernel-prd.md)、[G2 生产实现蓝图](../product/ontology-kernel-implementation-blueprint.md)
- 实施入口：[G2-03 Query + Policy 任务包](../delivery/g2-03-query-policy-task-pack.md)

## 1. 结论

G2-03 不等后端全部完成后才第一次对接页面。它在 Query + Policy 的正式 HTTP 边界后加入一个**只读、通用、可替换的 Web 消费者**，用真实 OIDC、PostgreSQL、Runtime API 和生成类型验证前后端接缝。

这个调整不增加 PRD 产品范围，只改变验证顺序：

- G2-03 完成只读 Object Explorer 的消费者接缝；
- G2-04 在同一接缝上增加 Action Form、Preflight、Apply 和冲突处理；
- G2-05 仍负责完整产品 UI、Object View/Application Config、Function、可发布 SDK、双 Package 完整闭环和可用性产品化。

因此，G2-03 的 Web 产物是**真实消费者和防返工 Gate**，不是页面 Demo，也不是已完成的产品 UI。

## 2. Gate 责任分界

| 能力                                       | G2-03                            | G2-04              | G2-05                                     |
| ------------------------------------------ | -------------------------------- | ------------------ | ----------------------------------------- |
| OIDC / Project / Release 上下文            | 真实可用                         | 复用               | 产品化                                    |
| Object Type 导航                           | 基于 Published Metadata 生成     | 复用               | 接入 Object View / Application Config     |
| List / Search / Filter / Sort / Cursor     | 真实只读闭环                     | 回归               | 完整交互与可用性                          |
| Detail / 一跳 Link                         | 真实只读闭环                     | 增加动作后刷新     | 增加 View、Activity、Provenance、Conflict |
| Action Form / Preflight / Apply            | 不实现                           | 真实闭环           | 产品化                                    |
| SDK                                        | 仅仓内生成的 Runtime Read Client | 扩展 Action Client | 冻结、发布并承担支持窗口                  |
| Builder / Object View / Application Config | 不实现                           | 不实现             | 实现                                      |
| 视觉系统、中英文、全面可访问性             | 只做核心状态的最低正确性         | 表单核心状态       | G2-05/P0-B 产品化                         |

`Object View` 仍是 G2-05 的 Deferred Resource Family。G2-03 的通用页面只能使用已发布 `object_type` / `link_type` 中的 Display Name、Title Property、Default Search、Default Sort 和 Property 查询能力；不得提前发明一套私有 View Schema。

## 3. 唯一允许的调用路径

```text
Browser
  → Public Runtime HTTP (/api/v1/...)
  → generated in-repo read client
  → Runtime HTTP adapter
  → Query Application Port
  → Policy Gateway
  → typed Query Compiler
  → one request-bound Activation / Current Generation
  → PostgreSQL
```

以下路径在 G2-03 总 Gate 中直接失败：

- Web 直连 PostgreSQL、S3、Admin Repository 或 Materialization 内部端口；
- 为 List/Detail 增加页面专用 SQL、领域专用 Endpoint 或隐藏 BFF DTO；
- Web 手写一份与 OpenAPI/Contract 平行的 Request/Response 类型；
- Web 自行判断 Object/Property/Link 权限，或将已读全量数据在浏览器中过滤；
- 验收只连 Mock Server，不连真实 OIDC / HTTP / PostgreSQL；
- 按 `WorkItem`、`Order` 或其他 Fixture API Name 在 Kernel/Web 中写分支。

同源反向代理可用于部署和本地开发，OIDC 回调适配也可以独立存在；它们不得承载业务查询、权限补丁或页面专用聚合。

## 4. 渐进 Runtime 合同

### 4.1 冻结级别

G2-03 同时产生两层资产：

1. **Kernel 正式语义合同**：Query AST、Cursor、Policy Decision/Predicate/Mask、Identity Context、错误和 Release Binding，自 G2-03 起按兼容规则治理；
2. **Runtime Read OpenAPI Candidate**：用 OpenAPI 3.1 生成仓内 TypeScript Client，并被 Web 真实消费。它在 G2-05 前不宣称对外 SDK 发布、90 天客户端二进制支持或完整 P0 API 稳定。

Candidate 不等于可以随意破坏。每次变更仍必须运行 Golden Fixture、OpenAPI Diff、Generated Client Compile 和 Web Consumer Test，并在 PR 中说明是 additive 还是 breaking。

### 4.2 G2-03 读取端点

| 端点                                                                                           | G2-03 服务能力                                                 | G2-03 Web 使用                          |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------- |
| `GET /api/v1/ontologies/{ontology}/metadata`                                                   | 当前身份可发现的 Published Object/Link Metadata 与实际 Release | 登录后导航和通用控件                    |
| `GET /api/v1/ontologies/{ontology}/objects/{objectType}/{primaryKey}`                          | Activation-aware Get、Policy、Mask/Deny、版本元数据            | Detail                                  |
| `POST /api/v1/ontologies/{ontology}/objects/{objectType}/search`                               | Search/Filter/Sort/Keyset Cursor                               | List/Search                             |
| `POST /api/v1/ontologies/{ontology}/objects/{objectType}/aggregate`                            | G2-03 只激活 `count`                                           | 不作 List 首屏依赖；用于策略一致性 Gate |
| `POST /api/v1/ontologies/{ontology}/objects/{objectType}/{primaryKey}/links/{linkType}/search` | 一/二跳受限遍历                                                | 只打开一个 Link 区块时请求一跳          |

Function、Saved Object Set、非 `count` Aggregate、Action、Activity 和 Admin Builder 不会因为前端需要数据而提前。页面必须正确地不展示这些功能。

### 4.3 每个成功响应的不变量

每个读响应至少必须让消费者获得：

- 服务端实际解析的 `releaseId` / `releaseRevision`；
- `readTimestamp` 与服务端生成的 `correlationId`；
- 搜索/遍历的 opaque `nextCursor` 或明确无下页；
- 有上限、可程序判断、不含 Policy 细节的 `warnings`；
- Get 的稳定 Object Reference 和 `objectVersion`；
- Property 的真实值、受控脱敏表示或显示安全的“受限”状态，但不返回规则文本或拒绝原因。

`null`、Property 未存在、`mask` 和 `deny` 不得由 Web 猜测为同一状态。最终机器字段形状在 G2-03-02 用正反 Golden 冻结；Web 只消费 Runtime 显式、显示安全的结果，不接收 Policy AST、SQL Predicate 或内部决策 Trace。

### 4.4 错误到页面状态

| HTTP / Code                                        | Web 必须的动作                                           | 禁止行为                       |
| -------------------------------------------------- | -------------------------------------------------------- | ------------------------------ |
| `401 AUTHENTICATION_REQUIRED`                      | 清理内存会话并进入重新认证                               | 继续显示旧受限数据             |
| `403 RESOURCE_FORBIDDEN`                           | 显示 Project/Resource 无权页                             | 猜测隐藏资源列表               |
| `404 OBJECT_NOT_ACCESSIBLE`                        | 使用同一“不可用”页                                       | 区分不存在和无权               |
| `400 CURSOR_INVALID`                               | 保留搜索/筛选，丢弃 Cursor 并从第一页重查                | 循环重放无法验证的 Cursor      |
| `409 CURSOR_EXPIRED` / `CURSOR_CONTEXT_CHANGED`    | 保留搜索/筛选，清空 Cursor，从第一页重查并显示非阻断提示 | 循环重放失效 Cursor            |
| `410 RELEASE_RETIRED`                              | 阻断当前视图，引导返回可服务 Channel/Release             | 静默切到另一 Revision          |
| `400 INVALID_QUERY_AST` / `PROPERTY_NOT_QUERYABLE` | 保留页面状态并标记可修正条件                             | 将它当 5xx 自动重试            |
| `429 RATE_LIMITED`                                 | 遵守 `Retry-After`，禁用重复提交并显示倒计时             | 无界立即重试                   |
| 可重试 `503`                                       | 有界退避、手动 Retry、保留条件                           | 显示缓存中超过安全边界的旧数据 |

`RELEASE_RETIRED` 已在 PRD/蓝图冻结语义，但尚未进入 Foundation Error Catalog；G2-03-02 必须先补齐合同与兼容基线，不得由 Web 使用字符串特判规避。

## 5. G2-03 只读 Web 表面

### 5.1 允许的流程

1. OIDC 登录，进入有权 Project / Ontology 上下文；
2. 从 Runtime Metadata 生成 Object Type 导航；
3. 通用 List 执行 Search、已声明 Property Filter、单业务字段 Sort 和 Cursor 翻页；
4. 通用 Detail 显示 Title、可读 Property、脱敏/受限状态和 Object Version；
5. 用户显式打开某个 Link 区块时，执行一跳遍历并进入目标 Detail；
6. URL 保存 Ontology、Release/Channel、Object Type 和安全编码的 Primary Key，不包含 Bearer Token、Policy Context 或敏感 Query 正文。

### 5.2 必须有的交互状态

每个 List、Detail 和 Link 区块都必须有可测试的：

- 初次 Loading（保留稳定布局，使用 `aria-busy` 或等价语义）；
- 空数据、当前筛选无结果、无权三种不同状态；
- 可重试依赖失败与不可重试请求错误；
- Property `allow` / `mask` / 显示安全的 `restricted`；
- Cursor Context 变化、会话过期、Release 退役和 Rate Limit；
- 进行中控件的 Disabled 状态及可理解原因；
- 键盘达到所有可操作元素、可见 Focus、表头/Label 语义与非纯颜色状态；
- 宽表格在容器内可水平滚动，不丢表头、主键或行操作语义。

G2-03 只对这些核心状态建立可访问性基线，不宣称全站 WCAG 认证、完整响应式产品或中英文完成。

## 6. 请求、数据与会话预算

为避免“页面做完才发现 API N+1”，G2-03 冻结以下消费预算：

| 用户动作                  | Runtime Data Request 上限（Metadata 已缓存后） |
| ------------------------- | ---------------------------------------------: |
| 打开/刷新 List            |                                    1 次 Search |
| 翻一页                    |                                    1 次 Search |
| 改一次 Search/Filter/Sort |                       取消旧请求后 1 次 Search |
| 打开 Detail               |                                       1 次 Get |
| 打开一个 Link 区块        |                               1 次 Link Search |

- 首页不为每行发 Get，Detail 不预加载所有 Link；
- Metadata 按实际 Release Revision 缓存，变更 Release 后不复用旧定义；
- `page.size` 默认 50、最大 500；Web 默认值不得超过 Runtime 合同；
- 搜索输入必须取消已过时请求，响应只能更新与当前 Query Hash 匹配的视图；
- Access Token 不进 URL、Log 或持久 `localStorage`；终端用户会话不使用 Service Credential；
- 请求超时、取消、连接池和响应大小上限由 Runtime 执行，Web 不能通过自由 `page.size` 规避。

如果真实页面无法在该预算下完成，先修订通用 Runtime 响应或声明式 Metadata；不允许加领域页面 Endpoint 快速绕过。

## 7. 消费者验收矩阵

G2-03 总 Gate 至少使用 Work Management 和 Commerce 两组结构不同的已有 Fixture。两者运行同一份 Web 代码、Generated Client 和 Query/Policy Application Port。

| 场景                                    | HTTP | Generated Client | Web | 服务端/Harness 不变量                  |
| --------------------------------------- | :--: | :--------------: | :-: | -------------------------------------- |
| 可见全部 Actor 的 Get/Search/Count/Link |  ✓   |        ✓         |  ✓  | 结果与顺序一致                         |
| 区域 Object Predicate                   |  ✓   |        ✓         |  ✓  | 行在 SQL 中过滤，数量不泄露            |
| Property mask/deny                      |  ✓   |        ✓         |  ✓  | 不能过滤/排序/搜索，Web 不猜测 null    |
| Link 源/边/目标任一拒绝                 |  ✓   |        ✓         |  ✓  | 等同 Link 不存在                       |
| Service / delegated 交集                |  ✓   |        ✓         | N/A | 不能被 Service 权限扩大                |
| Cursor 绑定项变化                       |  ✓   |        ✓         |  ✓  | `CURSOR_CONTEXT_CHANGED`，Web 回到首页 |
| Release 退役                            |  ✓   |        ✓         |  ✓  | `RELEASE_RETIRED`，不静默换版          |
| Policy 依赖失败/编译产物丢失            |  ✓   |        ✓         |  ✓  | fail closed，不显示 stale allow        |
| Loading/empty/error/disabled/focus      | N/A  |       N/A        |  ✓  | 浏览器自动化 + 辅助技术语义断言        |
| 请求预算                                |  ✓   |        ✓         |  ✓  | 无行级 N+1，超额直接 Gate FAIL         |

这两个 Fixture 只是 G2-03 读取消费者证据，不能被宣称为 G2-05 的“第二 Package 独立安装 + Function + Action + SDK + 完整 UI”验收已通过。

## 8. 防止后续大规模返工的 Gate

G2-03 只能在以下条件全部成立时关闭：

1. Web 从 Runtime Read OpenAPI Candidate 生成类型，手写 DTO 差异会在 CI 失败；
2. 同一 Query Application Port 被 HTTP、Web Client、Function/Action/Export 协议 Harness 复用，不存在 UI 内部绕过；
3. 两个 Fixture 没有任何 API Name 分支或页面专用 Endpoint；
4. 真实浏览器流程连接真实 OIDC / HTTP / PostgreSQL，重启 API/Web 后仍可复现；
5. Policy 变更、Release 变更、Cursor 失效和失败依赖都在页面层有明确行为；
6. List/Detail/Link 在请求预算内，并用真实 100k Objects / 1m Links 数据验证返回大小和交互延迟；
7. G2-04 可以通过增加 Action 合同和页面状态扩展当前壳，不需要更换身份、Release、Policy、错误或生成客户端边界。

不可能承诺“后续零返工”。本合同的承诺是：上述任一问题如果存在，必须在 G2-03 关闭前被当成 Gate 失败，而不是留到 G2-05 做完页面后再大改。

## 9. 明确延后

G2-03 不实现或不宣称：

- 可供外部开发者下载的完整 TypeScript SDK；
- Object View、Application Config、自定义布局或 Definition Builder；
- Action Form、Preflight/Apply、Conflict、Activity、完整 Provenance；
- Function、Dynamic Saved Object Set、非 `count` Aggregate 和 GraphQL；
- 品牌视觉、主题市场、行业专用页、完整响应式或全站可访问性认证；
- 第二 Package 对 Kernel 可移植性的最终 AC-10 结论。

## 10. 变更规则

- 修改本合同的 Gate 责任分界、唯一调用路径、请求预算或总 Gate，必须同时更新蓝图、G2-03 任务包和红队结论；
- 机器字段在 G2-03-02 冻结后，breaking change 需要兼容评估、Generated Client 重生成和两 Fixture Web 回归；
- 如果只有增加 BFF、页面专用 Endpoint、前端 Policy 或领域分支才能完成页面，立即停止，先修 Query/Metadata/Public API 边界；
- 如果 G2-03 的只读页面开始吸收 G2-04/G2-05 能力，删除越界实现或正式重审蓝图，不以“顺手做了”默认扩范围。
