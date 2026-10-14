# 参与改进

欢迎提交可复现问题、桌面版本兼容反馈、安装改进与执行端适配。先查看 [README](README.md)、[架构](docs/ARCHITECTURE.md)、[协议](docs/REIMPLEMENTATION-SPEC.md) 与 [来源记录](PROVENANCE.md)。

## 问题反馈

通过 [Issues](https://github.com/zzz123123lll/codex-agent-gateway/issues/new) 提交：网关版本、Windows / Node / PowerShell 版本、执行端名称和版本、预期行为、实际行为、复现步骤，以及删除凭据后的相关错误。只提交实现复现所需的内容；`data/platform`、账户信息、令牌和真实项目私有文件留在本机。

## 本地检查

在 Windows、Node.js ≥22.13、PowerShell 7 和已安装 Codex CLI 的环境中运行：

```powershell
npm ci
npm run build
npm test
npm run package
```

测试使用隔离配置及模拟，不要求登录桌面产品或调用模型。真实桌面兼容验证需单独记录应用版本、原生会话、实际派发和独立验收，不能用模拟测试代替。

## 改动原则

- 保持执行与正式验收分离；执行者的报告不能自行授予 `accepted`。
- 身份或原生执行状态不确定时保持占位，不因超时盲目重复派工。
- 返工说明要包含可复现问题、具体修复要求和独立复验条件，沿原任务/原生会话继续。
- 功能或缺陷改动先添加能复现问题的测试，再修复；说明测试结果及实际部署范围。
- 保留历史来源与第三方许可，不引入缺少许可授权的代码。提交贡献时应有权按本项目 MIT 许可提供该内容。

提交 PR 时说明触发条件、修复后的行为、验证方法与剩余边界。涉及新的执行端时提供适配文档和实际验证证据。
