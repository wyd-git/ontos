# G2-00-07 Trusted Handler Host seam 验收记录

- 结论：**PASS（仅限 G2-00-07 独立进程 seam proof）**
- 执行日期：2026-08-13
- 分支：`agent/g2-00-07-handler-host-seam`
- 起始 Commit：`584b97da6cf14d7428bda817ae38b357abb3df7f`
- 工具：Node.js 24.18.0 / npm 11.16.0
- 环境：macOS 26.5.2（Build 25F84）arm64

本记录对应 [G2-00-07 WWA](../delivery/g2-00-foundation-task-pack.md#g2-00-07adr-011-与-handler-host-seam-proof)。最终实现 Commit 由 Draft PR head 记录，避免在被提交文件中写入自身 Commit Hash。

## 1. 验收映射

| WWA 声明                                                   | 实现证据                                                                                                                                        | 执行证据                                                                                                               | 结果             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Host 环境不含 DB、S3、OIDC 管理或 Registry Credential      | `launch.ts` 从零构造 4 项非敏感环境白名单；Capability Probe 固定检查 DB / PG / AWS / S3 / OIDC / Registry / npm 凭据                            | 父进程真实注入全部测试 Secret，Host 返回 `present: []`                                                                 | PASS             |
| RPC 只接受登记 Digest 与类型化请求，不接受代码、路径或模块 | `protocol.ts` 精确字段 / v1 / JSON / 256 KiB Gate；`catalog.ts` 静态冻结 Registry、独立 Input / Output Schema；`registry.ts` 加载前重算 SHA-256 | Code / Path / Module / URL / Package 额外字段、未知 Digest、错误 Schema、版本错均被拒绝；5 个 Artifact Digest 重算一致 | PASS             |
| 正常、异常、无限循环、Host kill、重启后再调用都有自动测试  | `pool.test.ts` 覆盖完整独立进程生命周期                                                                                                         | 正常 Query / Echo、异常脱敏、Infinite、活动 Host `SIGKILL`、替代 PID、Pool Restart 全部 PASS                           | PASS             |
| 无限循环在硬 Timeout + 1 秒内终止，Coordinator 继续可用    | `pool.ts` 父进程 Timer → `SIGTERM` → 有界 `SIGKILL`，Timeout / Exit 后整代替换                                                                  | 100ms Timeout 在全仓 Gate 中约 180ms 返回；原 PID 被替换，随后 Echo 成功；上界 1.1 秒                                  | PASS             |
| Context 拒绝未声明 Query、Read Set 外读取与任意网络        | `context.ts` 同时检查 Manifest / Invocation / Object / Property / Read Budget；`network-guard.ts` 在 Artifact 加载前禁用常用网络入口            | 未声明 Query、对象/Property 越界、Read Limit；fetch、HTTP/1、HTTP/2、TCP、TLS、UDP、DNS 全部拒绝                       | PASS（应用护栏） |
| ADR 明确 trusted deployment boundary，不宣称恶意多租户沙箱 | ADR-011 §2、§5、§9–10；专项 Red-Team                                                                                                            | 明确用户上传、恶意 Native / Runtime Escape、容器 Egress / cgroup 不属于当前证明                                        | PASS（声明）     |

网络结果只证明 Node / 应用级受信任 Artifact 误用护栏。Production 环境仍必须以容器 / Pod / 主机策略验证 Egress Deny；没有该证据时，不得把本项 PASS 扩大为恶意代码或网络沙箱结论。

## 2. 冻结的 seam 合同

### 2.1 Artifact 与 RPC

- RPC `v1` 只有 `READY / INVOKE / RESULT`，每层只接受精确字段；
- 调用只携带 `artifactDigest`、Revision、Release、Correlation、Timeout、Parameters 和受限 Context 数据；
- 不存在 Code、Path、Module、Package、URL、Export 或 Loader Option 字段；
- Registry 按真实 Artifact 源文件 SHA-256 登记，条目和 Query Capability 在运行时冻结；
- Coordinator 与 Host 都校验 Envelope、Artifact Revision、Timeout、Read Budget 和 Input Schema；Host 再校验 Output Schema；
- Query / Capability Probe 的 Input 与 Output Schema 独立，不用字段猜测方向；
- 单条序列化 RPC 上限 256 KiB；这是私有 IPC 合同，不是 Decode 前恶意内存流量防火墙。

### 2.2 Restricted Context

- Artifact 唯一读取方法为 `context.query({ queryName, objectRid, properties })`；
- Query 必须同时属于 Manifest 和本次 Invocation Declaration；
- Object RID 和每个 Property 必须属于固定 Read Set；
- 读取次数不能超过 Manifest 与 Invocation Budget 的较小值；
- Host 不查询数据库，只投影 Runtime 已授权并随调用传入的 Fixture Result；
- 返回对象为结构化 Clone 后的深冻结最小投影；未请求字段不返回；
- 未声明 Query、Object / Property 扩大和 Read Limit 分别使用稳定错误。

### 2.3 进程与能力

- Host 是独立 OS 进程，READY 握手同时校验协议版本和 Child PID；
- 环境从零构造，只包含 `LANG / LC_ALL / TZ / ONTOS_HANDLER_HOST_PROTOCOL`；
- Node Permission Model 只允许读取 Handler Host 自身目录与根 `package.json`，不允许目录外读取、文件写入、子进程或 Worker；
- `fetch`、HTTP/1、HTTP/2、TCP、TLS、UDP、DNS、WebSocket / EventSource 常用入口在 Artifact 动态加载前被禁用；
- 未知异常跨 RPC 统一为 `HANDLER_EXECUTION_FAILED`，不传原始 Message / Stack；
- 当前 Host 不输出 stdout / stderr，普通错误不会把 Parameters / Query Result 带回 Coordinator。

### 2.4 Timeout 与恢复

- Pool 每个 Host 同时执行一个 Artifact，父进程从实际 Dispatch 开始计时；
- 请求只能缩短登记 Timeout，不能超过 Artifact 或全局 10 秒上限；
- Timeout 后先 `SIGTERM`，最多等待配置 Grace（默认 250ms，本测试 100ms），再 `SIGKILL`；
- Timeout / 非预期 Exit 后不复用原进程，Pool 只在替代进程 READY 后继续分配；
- 替代启动失败时 Pool fail closed，当前 Queue 和未来调用明确失败，直到显式 Restart；
- Queue Wait、总 API Deadline、Backpressure 和生产重试策略属于后续 Runtime / Capacity Gate。

## 3. Red-Team 与 Intended-vs-Implemented 结果

[专项审查](../reviews/adr-011-trusted-handler-host-red-team.md)在 Accepted 前关闭了以下当前范围偏差：

- Query / Capability Probe 的 Input 与 Output 最初共用宽校验器，现拆分方向明确的 Schema 并增加错误输出反例；
- `requireJsonObject` 最初可把 Array 强转为 Object，且普通 `__proto__` 赋值会改变结果原型，现先验证 Plain Object 并定义 own data property；
- Protocol / Version mismatch 最初归入普通 Invalid Invocation，现使用稳定 `PROTOCOL_MISMATCH`；
- TypeScript `readonly` 最初没有冻结运行时 Registry，现条目、Query Array 和 Registry 都冻结；
- 网络护栏最初漏掉 HTTP/2，现覆盖 fetch、HTTP/1、HTTP/2、TCP、TLS、UDP 与 DNS；
- Permission Probe 最初没有证明目录外读取和 Worker 被拒绝，现与文件写入 / 子进程一起覆盖；
- Host kill 健康检查最初可能在 Exit 事件前误认旧 PID，现恢复条件显式排除旧 PID；
- 替代 Host 启动失败最初可能让后续请求进入无 Worker Queue，现进入可恢复的 fail-closed 状态。

修正后没有仍未关闭、且属于 G2-00-07 seam proof 范围的 Intended-vs-Implemented 漂移。Production Artifact 签名 / Promotion、真实 Policy Query、Action Transaction、Linux Container Egress / Resource Limits、Queue Backpressure、Telemetry 和 Rolling Upgrade Matrix 仍明确 OPEN。

## 4. 可复现执行

### 4.1 Clean install

```text
NODE_VERSION=24.18.0 /Users/wangyudong/.nvm/nvm-exec npm ci
toolchain: PASS (node 24.18.0, npm 11.16.0)
added 136 packages
```

执行前后 `package-lock.json` SHA-256 均为：

```text
596243cf1053ee28b22ba1f66307403d0627338bd56582dcfa1f4b88197bb45b
```

### 4.2 全仓 Gate

```text
NODE_VERSION=24.18.0 /Users/wangyudong/.nvm/nvm-exec npm run verify

check:toolchain     PASS
format:check        PASS
lint                PASS
typecheck           PASS
test:unit           PASS — 135/135
check:architecture  PASS — 1 package / 7 source files
```

G2-00-07 专项为 16/16 top-level tests，包含 7 个真实 OS Process 生命周期子场景。其余 Protocol、Registry、Context 和 Digest 测试在 Coordinator 进程运行。

### 4.3 Artifact Digest

对 `tools/handler-host/` 全部 18 个文件按路径排序后逐文件 SHA-256，再对清单 SHA-256：

```text
f768df5e3d7a909666ac77b4fe21060269a9bd97940ad05f4766d068152d3edb
```

后续任何 Protocol、Registry、Context、Host、Pool、Fixture 或测试变更都必须重新生成 Evidence，不得沿用本结论。单个 Fixture 的 Artifact Digest 是其源文件真实 SHA-256，并由静态 Registry 分别固定。

## 5. 明确不宣称

- 本记录不是 G2-00 Foundation 总 Gate PASS；G2-00-08～13 仍未完成。
- 当前不是可部署的 `apps/handler-host`，没有 API、Policy Gateway、真实 Query Port、Function / Action Runtime、数据库或 Transaction。
- Fixture `queryResults` 不是 Policy-aware Query 证据；外部客户端不得在 Production API 直接提交 Read Set 或 Query Result。
- 当前没有 Production Artifact Catalog、签名、Promotion、镜像组装、只读 RootFS、Admin Audit 或 Rollback。
- macOS 子进程测试没有证明 Linux Container / Pod 的 Egress、Service Account、Secret Mount、cgroup、seccomp、AppArmor、OOM 或容量行为。
- 应用级网络替换不是恶意代码防线；当前不支持用户上传、互不信任租户、任意 npm 依赖、Native Addon 或 Runtime Escape 对抗。
- 当前 Pool 没有生产 Queue 上限、总请求 Deadline、取消传播、Retry Policy、Telemetry、Rolling Upgrade Matrix 或长期负载结论。
- 当前只证明 trusted Function 形状；Action Mutation Plan、Preflight / Apply 重跑、锁定 Read Set、Write Set 与 Outbox 仍由 G2-04 验证。

这些限制不阻止 G2-00-07 seam 合同 Accepted，但分别阻断 Function / Action / Deployment / Security / Capacity 的生产放行。
