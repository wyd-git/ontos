# Spike D：第二领域与 Package

## 假设

两个结构不同的业务模型可以只增加 Resource Definitions、Handlers 和 View Config，而不修改 Query、Action 或 Policy Core。

## Test Package A

关系密集型工作管理：

- Object Types：Site、Asset、WorkItem、Person、Inspection；
- Links：site-assets、asset-work-items、assignee-work-items、asset-inspections、inspection-inspector；
- Actions：assignWork、completeInspection、changeAssetState。

## Test Package B

交易状态型业务：

- Object Types：Customer、Order、Product、Shipment、Return；
- Links：customer-orders、order-products、order-shipments、order-returns、return-products；
- Actions：confirmOrder、dispatchShipment、approveReturn。

这些名称是 Test Fixture，不进入 Kernel Core。

## Manifest 能力

- Namespace 和 Package Version；
- Resource Definitions；
- Handler Artifact Reference；
- Policy Templates；
- Object Views；
- Mapping Inputs；
- Release Tests；
- Migration Metadata。

## 验证

1. 校验并安装 Package A；
2. 运行 Get/Search/Link/Action/Policy 最小闭环；
3. 校验并安装 Package B；
4. 重复相同闭环；
5. 升级 B 的兼容版本；
6. 尝试一个破坏性升级并确认被阻止；
7. 创建定义回滚 Release；
8. 扫描 Core Source，确认没有领域 API Name。

## 通过条件

- 两包各至少 5 Object Types、5 Links、3 Actions、2 Policies、2 Views；
- 使用同一 Manifest Loader；
- B 不新增 Query Operator 或 Endpoint；
- B 不修改 Action Transaction Pipeline；
- B 不修改 Policy Evaluation 顺序；
- 基础 List/Detail/Form 无定制前端；
- 历史 Action 能解析原 Handler/Action Revision。

## 失败判定

- Core 出现 `if package == ...`；
- 必须新增 B 专用数据库表或 API；
- Package 可以携带 Kernel Migration 或绕过 Policy；
- 升级会原地修改 Published Revision；
- 回滚导致历史 Action 无法解释。
