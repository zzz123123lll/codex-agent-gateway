---
name: agent-executor
description: 将用户授权的任务交给 Windows TRAE 或 WorkBuddy 桌面执行，Codex 监督、同会话返工并独立验收。用于要求这两个执行端之一实际干活的任务。
---

Codex 制定目标、约束和验收标准；执行端使用自己桌面会话的模型和工具。Skill 需要完整网关和对应桌面连接，单独复制不能建立连接。

- 先 `agent_hub_providers` 查看接入情况。用户指定 TRAE 时用 `provider: trae`，指定 WorkBuddy 时用 `provider: workbuddy`；不得悄悄替换执行端。指定分工时拆成有明确交付物的任务，同目录串行。
- `agent_hub_submit` 使用稳定幂等键、项目绝对路径、授权修改范围和可检验的要求。保存任务编号。已有编号先 get/wait，断线或超时不重新提交。
- wait 每次至多50秒。`completed` 仅代表执行结束和结果格式合格。Codex 必须独立读取真实成果、运行相关功能检查；不能用执行端自述替代验收。
- 发现问题，用 rework 集中提交问题编号、文件位置、重现证据、期望行为、允许修改范围和复验要求，沿用原任务和原生会话。保存每轮检查证据；新轮次清除旧验收。
- 用户授权完成项目后，持续执行“执行端交付 → Codex 检查 → 具体返工 → 复验”，不每轮询问。明确标准全部通过且无未解决阻塞后，accept 记录具体 note/evidence。
- 同一问题连续两轮无进展时先诊断、调整指示；权限或环境阻塞保留未通过状态。不能无限重试、降标准或按轮数自动验收。
- `uncertain`、`holdsCapacity` 或取消未确认时不得重发。检查原会话，只有原生停止后才能 checked recovery；恢复不会验收或重发。
- 登录、信任和工具审批沿用对应桌面原生流程。委派不扩大授权，Codex 不代写执行端的成果或冒充其回报。不切换外部模型，不承诺积分统计；升级桌面后重新验证连接接口。

无 MCP 时可在完整网关目录使用 `node dist/cli.js submit @task.json`、get/wait/rework/accept；本机配置和安装见项目 README。
