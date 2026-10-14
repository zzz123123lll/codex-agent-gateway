# 原生协议勘误

原始 REIMPLEMENTATION-SPEC.md 保留为重写前冻结的行为合同，不改动其摘要。2026-10-12 的真实 WorkBuddy 5.7.7 本机采样发现，该合同把成功响应写成 type=result，实际应用使用 type=response；消息框架仍是 kind=message，json 中含 id、type、channel、result。数字和字符串请求标识均收到相应响应。

第一次新实现读取 session:get 因忽略 response 而超时。这个问题由实际协议检查发现，不能用此前的模拟检查通过来否定。补充的回归使用实际 response 报文结构；旧 result / error 形式仅作兼容输入。

采样只读取既有会话和状态，没有发送模型任务。对外验证记录必须分别说明协议读取、真实模型执行和离线模拟，不能互相替代。原始合同与验收测试保留，新增测试和本勘误说明真实修正。

## 新版界面的执行归属

后续 lowdb 真实任务暴露另一项兼容问题：同一原生会话的旧 session 接口等待工具审批，新界面使用的 conversation 接口却为 idle、没有 pending input，界面显示已取消。旧后台原生事件重放成功，但界面仍无审批卡片。安装包接口源码确认，两者拥有独立的运行和待输入存储。[原生接口对照 / 本机界面 / 安装包接口源码]

0.3.1 通过已验证 renderer 中的原生 `__wbInvoke(fullChannel, context, ...args)` 调用 `wb:conversations:create/get/getPendingInfo/queueItems/sendPrompt/inputHistory/cancel`。`create` 使用稳定 `conversationId` 和授权 `cwd`，返工通过原 ID 继续，不重复创建。派工不传模型或权限配置；原生 inputHistory 的真实用户消息标记确认收据。旧 session 活动仍参与检查，非空队列、后台或子任务、未知状态均不视为空闲。错误不会触发另一接口重发。[源码 / 12 项回归]

旧 lowdb 执行确认停止后，原任务和原会话在 0.3.1 进入第四轮原生复测。新建/读取另通过不发送 prompt 的真实元数据探针；它不算第四个业务项目，也不能替代最终功能验收。冻结合同及三个项目验收文件保持原摘要。[取消记录 / 同会话事件 / 元数据探针 / 冻结摘要]
