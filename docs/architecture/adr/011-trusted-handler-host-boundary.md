# ADR-011：Trusted Handler Host 进程边界

- 状态：Accepted for G2-00-07
- 日期：2026-08-13
- Owner：Backend / Security
- 决策范围：已登记 Artifact、私有 RPC、受限 Context、进程凭据、硬超时、Worker Pool 恢复与网络默认拒绝
- 可执行合同：`tools/handler-host/`
- Production 落点：`apps/handler-host`、`packages/function-runtime`、`packages/action-runtime`

## 1. 决策结论

P0 的 `trusted_code` 使用独立 Handler Host OS 进程执行。API / Action Runtime 不在自身进程内加载 Artifact；Handler Host 没有数据库、S3、OIDC 管理或 Artifact Registry Credential，也没有直接提交业务事实的能力。

调用链固定为：

```text
API / Action Runtime
  → 校验 Release、Policy、Artifact Revision、输入 Schema 和执行预算
  → 固定调用者获授权的 Query 能力与 Read Set
  → 通过版本化私有 RPC 发送 Artifact Digest + 类型化数据
  → Handler Host 从本地已登记表解析 Digest 并再次校验
  → Artifact 只能调用 RestrictedContext.query()
  → Handler Host 返回类型化 Result / Mutation Plan 或稳定错误
  → Runtime 再次校验输出，且只有 Runtime 可以提交数据库事务
```

G2-00-07 只证明这条 seam 可执行，不实现用户上传代码、远程 Artifact Catalog、签名发布流水线、业务 Function / Action 或数据库写入。这里的边界是 **trusted deployment boundary**，不是恶意代码、多租户或通用 JavaScript 沙箱。

## 2. 威胁模型与信任边界

### 2.1 被信任的主体

- Artifact 源码由受信任 Developer 编写、评审并由 Platform Admin 部署；
- API / Runtime 负责认证、授权、Release 解析、参数类型化和 Read Set 固定；
- Host 二进制、静态 Registry 与部署配置由同一受控 Release 交付；
- 操作系统与单区域部署平台属于可信计算基。

### 2.2 本边界必须阻断的事故

- 客户端通过 RPC 提交代码、模块名、文件路径或未登记 Digest；
- Artifact 意外获得 API 进程的 DB、S3、OIDC 管理、Registry 或包管理凭据；
- Artifact 绕过声明的 Query 能力、调用者 Policy 结果或锁定的 Read Set；
- 无限循环占住 API 事件循环，或 Host 崩溃后使后续调用永久不可用；
- Artifact 通过默认网络能力直接调用外部服务；
- 原始异常、Stack、参数、Query Result 或 Secret 进入普通 RPC 错误与日志。

### 2.3 不在本决策能力范围内的攻击者

- 能修改 Host 二进制、静态 Registry、容器镜像或部署策略的攻击者；
- 以任意恶意 Native Addon、WASI、JIT / Runtime 漏洞逃逸为目标的 Artifact；
- 多租户互不信任团队自行上传并立即运行的代码；
- 依赖纯 Node 进程补丁抵抗主动绕过的恶意代码。

如果产品将来允许普通用户或互不信任租户上传代码，必须停止复用本边界，改用独立容器 / MicroVM、最小只读 RootFS、强制 CPU / Memory / PID / Egress Policy、Artifact 签名验证和租户级调度，并重新进行安全评审。

## 3. Artifact Registry 合同

### 3.1 只按 Digest 解析

私有 RPC 只接收 `artifactDigest`。Host 的只读 Registry 以 Digest 为唯一执行键，每个条目固定：

- Artifact ID、Revision 与 Kind；
- Artifact 文件的期望 SHA-256；
- 输入与输出 Schema ID；
- 允许的 Query 名称；
- 最大读取数与最大 Timeout；
- 由 Host 代码控制的本地 Loader。

请求不能携带代码、Source、文件路径、URL、包名、模块名、Export 名或 Loader 选项。未知 Digest 在加载任何 Artifact 前返回 `ARTIFACT_NOT_REGISTERED`。Host 加载前重新计算 Artifact 文件 SHA-256；文件与 Registry 不一致时 fail closed。

G2-00-07 使用仓库内 Fixture Artifact 和静态 Registry，证明“Digest 选择已部署 Artifact”的接口。Production Catalog、Artifact 签名、Admin 部署审计、回滚和镜像组装留给后续 Function / Action Gate，但不能改变 RPC 接受任意路径这一禁令。

### 3.2 类型化边界

协调进程与 Host 都执行运行时校验：

- RPC Envelope 只允许固定字段，协议版本不匹配返回 `PROTOCOL_MISMATCH`，出现额外字段即拒绝；
- `parameters` 必须通过登记 Artifact 的输入 Schema；
- Context 配置、Read Set 和 Query Result 必须是受限 JSON 值，不能传 Function、Prototype、Handle 或 Stream；
- Artifact 返回值必须通过登记输出 Schema；
- 单个 RPC 序列化后最大 256 KiB，Production Action Mutation Plan 仍受 PRD 的 1 MiB 独立上限；该限制在 Coordinator 发送前和 Host IPC Decode 后各执行一次，不宣称能防御拥有本地 IPC 写权限的恶意进程在 Decode 前制造内存压力；
  -错误只返回稳定 Code、Correlation ID 与安全说明，不返回 Stack、原始异常或输入输出。

协议 `v1` 只有 `READY`、`INVOKE` 和 `RESULT` 三类消息。破坏性字段变化必须提升版本；Host 与 Coordinator 版本不相等时不得降级猜测。

## 4. Restricted Context 与 Read Set

Artifact 只获得冻结对象，不获得 API Container、Repository、数据库连接、文件句柄、网络 Client、Action Dispatcher 或 Secret Resolver。G2-00-07 的唯一方法为：

```text
context.query({ queryName, objectRid, properties })
```

每次 Query 按以下顺序 fail closed：

1. `queryName` 必须同时存在于 Artifact Manifest 与本次调用的 `declaredQueries`；
2. `objectRid` 必须存在于本次调用固定的 Read Set；
3. 请求 Property 必须是 Read Set 中该对象的允许 Property 子集；
4. 累计读取数不得超过 Manifest 与调用预算的较小值；
5. 只能返回 Runtime 已按调用者 Policy 过滤并随调用传入的 Query Result；Host 不自行查询数据库；
6. 返回值按请求 Property 再投影，并深冻结，避免 Artifact 修改共享输入。

未声明 Query 返回 `QUERY_NOT_DECLARED`；越过对象或 Property 范围返回 `READ_SET_VIOLATION`；超限返回 `QUERY_LIMIT_EXCEEDED`。不存在与无权对象在未来真实 Query Port 中继续统一为 PRD 的 `OBJECT_NOT_ACCESSIBLE`；Fixture 不推断生产错误细节。

Action Apply 重跑时，调用中只放入已经稳定排序并锁定的 Preflight Read Set。Handler 请求新对象或扩大 Property / Write 范围时直接失败；Runtime 不在执行过程中补锁。

## 5. 进程、凭据与系统能力

### 5.1 环境变量

Coordinator 创建 Host 时使用严格白名单重新构造环境，而不是从父进程复制后按已知 Secret 名删除。G2-00-07 只传：

- 固定的 locale / timezone；
- 非敏感的 Host 协议标记。

不得传 `DATABASE_URL`、PostgreSQL Password、S3 / AWS Key、OIDC Client / Admin Secret、Registry Token、`NPM_TOKEN`、`NODE_AUTH_TOKEN`、`NODE_OPTIONS` 或未来新增的任意应用环境变量。Production 也必须为 Host 使用独立 Service Account，且不挂载 API Secret Volume。

### 5.2 文件、子进程与 Worker

Host 使用 Node Permission Model，只允许读取自身已部署 Artifact / Host 文件；默认拒绝文件写入、子进程、Worker、Native Addon 与 WASI。Permission Model 不是网络控制，也不被描述为完整沙箱。

Production 镜像应使用只读 RootFS、非 root UID、无 Shell / Package Manager、最小 Artifact 目录和不可写 Service Account。G2-00-07 只验证 Node 进程级最小能力，容器加固由部署 Gate 复验。

### 5.3 网络

Node 24 Permission Model 不提供网络拒绝。本原型在加载 Artifact 前替换 `fetch`、HTTP(S)、TCP/TLS、UDP 与 DNS 入口，并同步 Node Built-in ESM Export，用自动测试证明受信任 Fixture 的网络尝试被拒绝。

这只是防止受信任代码误用的应用级护栏。Production 必须再以容器 / Pod / 主机策略默认拒绝 Handler Host 出站网络；没有部署级 Egress Deny 的环境不得宣称满足 P0“默认禁止外部网络”。确需外部副作用的工作进入登记过的 Action Outbox Consumer，不向 Handler 临时开放通用网络。

## 6. Worker Pool、硬超时与恢复

- Coordinator 持有固定大小的 Host Process Pool；每个 Host 同时执行一个 Artifact；
- 默认 Function Timeout 3 秒，登记上限与全局硬上限均不得超过 10 秒；请求只能缩短，不能扩大 Registry 预算；
- Timeout 由 Coordinator 的独立事件循环计时，不能依赖 Artifact cooperative cancellation；
- 到达硬 Timeout 后向该 Host 发送 `SIGTERM`，最多等待 250ms；仍未退出则 `SIGKILL`；
- 该调用返回 `HANDLER_TIMEOUT`，整个 Host 代际作废，不能在同一进程继续执行；
- Host 意外退出时，in-flight 调用返回 `HOST_EXITED`；Pool 自动补齐新进程；
- 新调用只有在替代 Host 完成版本握手后才能分配；API / Coordinator 不随 Host 退出；
- 替代 Host 启动失败时 Pool 进入 fail-closed 状态，当前 Queue 与后续调用明确失败，直到显式 Restart；
- Queue 等待时间不计入 Handler 执行 Timeout，Production API 必须另外设置总请求 Deadline、Queue 上限和背压。

Host 不安装忽略 `SIGTERM` 的 Handler。250ms Grace 小于 WWA 允许的 1 秒；测试同时记录从 Timeout Deadline 到 Child Exit 的实际上界。Pool 停止、部署滚动和测试故障注入使用相同代际销毁路径。

## 7. 失败、日志与可观测字段

允许跨 RPC 的最小字段为：Protocol Version、Request ID、Artifact Digest、Artifact Revision、Release ID、Correlation ID、Timeout、结果状态、稳定错误 Code 与执行耗时。不得把 Parameters、Result、Query Fixture、对象 RID、Secret、Stack 或原始错误正文写入普通日志与 Metric Label。

Production Trace 可记录 API Span 与 Host Span 的关联，但敏感输入输出默认不采样。至少观测：Pool Ready / Busy、Queue Depth、Invocation Count / Duration、Timeout、Host Exit、Replacement Count、Protocol Rejection、Artifact Digest Mismatch 和 Context Denial。

错误分类：

| Code                                        | 含义                              | 是否重试                      |
| ------------------------------------------- | --------------------------------- | ----------------------------- |
| `ARTIFACT_NOT_REGISTERED`                   | Release / Deployment 不一致       | 先修复部署，不盲重试          |
| `INVALID_INVOCATION`                        | Envelope、参数或 Context 不合合同 | 否                            |
| `QUERY_NOT_DECLARED` / `READ_SET_VIOLATION` | Artifact 越过声明能力             | 否并告警                      |
| `HANDLER_EXECUTION_FAILED`                  | Artifact 未分类异常               | 由 Function / Action 策略决定 |
| `HANDLER_RESULT_INVALID`                    | Artifact 返回不符合登记 Schema    | 否并告警                      |
| `HANDLER_TIMEOUT`                           | 超过硬预算，Host 已销毁           | 由调用语义决定                |
| `HOST_EXITED`                               | Host 意外退出                     | 只有上层幂等语义允许时才重试  |
| `NETWORK_ACCESS_DENIED`                     | Artifact 尝试外部网络             | 否并告警                      |

Action Apply 不能仅因 Host 退出就自动重试整笔业务写入；必须先由 Action Idempotency / Transaction 状态证明没有 Commit。

## 8. 验证要求与后续 Translation Gate

`tools/handler-host/` 必须自动验证：

- 登记 Digest 正常调用、输入 / 输出 Schema 与未知 Digest 拒绝；
- RPC 额外代码、路径或模块字段被拒绝；
- Query 成功、未声明 Query、Read Set 外对象和 Property 越界；
- 父进程注入 DB / S3 / OIDC / Registry Secret 时，Host 内均不存在；
- `fetch`、HTTP/1、HTTP/2、TCP、TLS、UDP 与 DNS 入口被拒绝，目录外文件读取、文件写入、子进程和 Worker 被 Permission Model 拒绝；
- Artifact 抛错不会泄露原始消息或 Stack；
- 无限循环在 Timeout + 1 秒内退出，随后新 Host 正常调用；
- 空闲 Host kill、执行中 Host kill和 Pool 重启后均能再次调用。

后续 Function / Action Gate 必须把相同不变量翻译到 `apps/handler-host` 和 Runtime Ports，并补：真实签名 Artifact 发布、容器 Egress Deny、CPU / Memory 限额、Queue Backpressure、Telemetry Redaction、Rolling Upgrade、Action Plan 输出校验与故障注入。若真实部署不能执行 Egress Deny 或独立 Secret Identity，P0 Handler Gate 失败，不能退回同进程加载。

## 9. 被拒绝的方案

### 9.1 在 API 进程内 `import()` Trusted Artifact

拒绝。无限循环会阻塞 API 事件循环，Artifact 继承 API Credential，崩溃和资源失控无法只销毁一个执行代际。

### 9.2 RPC 接收文件路径、模块名或代码

拒绝。这会把部署期信任决策下放到每次调用，并使路径穿越、依赖替换和任意模块加载进入远程输入面。调用只能选择已经登记的 Digest。

### 9.3 只使用 cooperative Timeout / `Promise.race`

拒绝。同步无限循环不会让 Timer 运行，异步任务也可能在 Promise 失败后继续产生副作用。硬 Timeout 必须由父进程销毁 OS 进程。

### 9.4 Host 直连数据库，靠只读账号限制

拒绝。只读数据库身份仍能绕过 Object / Property Policy、Read Set、Release Pin、Query Limits 和统一 Audit。所有读取由 Runtime 先授权，再通过受限 Context 提供。

### 9.5 把 Node Permission Model 当作网络或恶意代码沙箱

拒绝。当前 Node Permission Model 不控制网络，也不覆盖所有 Runtime 漏洞。应用级网络拦截只服务于 trusted code 误用防护，Production 仍需要部署级 Egress Deny；恶意多租户代码需要新的隔离架构。

### 9.6 Timeout 后复用同一 Host

拒绝。无法证明被超时的异步任务和修改过的进程全局状态已经停止。Timeout 或非预期退出后必须销毁并替换整个 Host 代际。

## 10. 本任务明确不实现

- 不提供任意用户代码上传、在线 IDE、npm 安装、动态 Dependency Resolution 或恶意多租户沙箱；
- 不实现 Production Artifact Catalog、签名服务、镜像构建、Promotion、Rollback 或 Admin UI；
- 不实现真实 Query Service、Policy Gateway、Action Preflight / Apply、Mutation Plan Commit 或 Outbox Consumer；
- 不用 Fixture Query Result 冒充真实 Policy-aware Query；
- 不宣称 macOS 进程测试已经证明 Linux 容器 Egress、cgroup、seccomp、AppArmor 或容量行为；
- 不在 G2-00-07 引入 Redis、Kafka、远程执行集群或跨区域调度。

只有自动测试证明上述 seam，并由 Red-Team 与 Intended-vs-Implemented 审查关闭当前范围偏差后，本 ADR 才改为 Accepted for G2-00-07。
