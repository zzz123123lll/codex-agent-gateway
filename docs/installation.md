# Windows 安装与管理

当前入口面向 Windows 上的 Codex + TRAE CN / WorkBuddy。本轮实际桌面验证使用 TRAE CN 3.4.2、WorkBuddy 5.7.7；其他版本需先检查兼容性。

## 环境与下载

- Windows 桌面环境，所选执行端能正常登录和运行。
- Node.js **22.13 或以上**及 npm；本轮使用 Node.js 24.15.0。
- **PowerShell 7**，命令名为 `pwsh`。Windows 自带的 PowerShell 5 不满足此安装入口。
- 能正常运行的 **Codex CLI**，安装脚本通过它注册 MCP；本轮使用 0.160.0。
- TRAE CN 和/或 WorkBuddy 已安装、登录并选择模型。模型调用使用对应产品的账户与工具权限。

从 [v0.3.1 Releases](https://github.com/zzz123123lll/codex-agent-gateway/releases/tag/v0.3.1) 下载 `codex-agent-gateway-windows-0.3.1.zip` 和对应 `.sha256`，解压到长期保留的目录，例如 `C:\Tools\codex-agent-gateway`。使用 `Get-FileHash -Algorithm SHA256 <ZIP路径>` 可核对摘要。

也可以克隆源码：

```powershell
git clone https://github.com/zzz123123lll/codex-agent-gateway.git
cd codex-agent-gateway
```

以下命令在解压后的 `codex-agent-gateway` 或克隆目录运行。示例路径需替换为实际安装路径。安装入口会自动执行依赖安装、构建和 VSIX 打包；按锁文件从官方 registry 下载依赖，仍需要网络。

开发者也可单独准备源码：

~~~powershell
npm ci
npm run build
npm run package
~~~

## 检查与安装

只使用 TRAE 的预检查与安装：

~~~powershell
pwsh -NoProfile -File scripts/setup.ps1 -CheckOnly -TraeExecutable 'C:\Apps\TRAE\Trae CN.exe'
pwsh -NoProfile -File scripts/setup.ps1 -TraeExecutable 'C:\Apps\TRAE\Trae CN.exe'
~~~

只使用 WorkBuddy 的预检查与安装：

~~~powershell
pwsh -NoProfile -File scripts/setup.ps1 -CheckOnly -WorkBuddyExecutable 'C:\Apps\WorkBuddy\WorkBuddy.exe'
pwsh -NoProfile -File scripts/setup.ps1 -WorkBuddyExecutable 'C:\Apps\WorkBuddy\WorkBuddy.exe'
~~~

同时配置时将两个 Executable 参数一起传入。CheckOnly 仅检查，不安装、不改变配置；无需事先下载依赖或构建。安装配置本地 MCP `trae-gateway`、`agent-executor` / `trae-executor` 技能、所选执行端和当前目录的登录自启与进程退出重启观察。原生应用登录、目录信任及工具权限仍需按产品提示处理。

若 WorkBuddy 已经以普通方式运行，先完成工作，再通过应用自己的退出入口正常退出，例如 About → Quit WorkBuddy。管理脚本需要以本机连接端口启动它；既有实例缺少该端口时会提示退出后重试，不会强杀应用。明确启动入口为：

```powershell
pwsh -NoProfile -File scripts/start-workbuddy.ps1 -WorkBuddyExecutable 'C:\Apps\WorkBuddy\WorkBuddy.exe'
```

WorkBuddy 托管 Node 的自动身份核验当前支持默认 `.workbuddy` 配置根；自定义配置根需后续适配。TRAE CN 使用桌面桥与专用项目窗口。

## 开始任务

安装完成后新建 Codex 会话，确认能看到 MCP 与技能，例如：

```text
$agent-executor
请让 WorkBuddy 在 C:\Projects\my-app 中实现本次需求。
你负责制定验收要求、独立检查并给出返工指示；
执行端用自己的工具修改项目，全部检查通过后再正式验收。
```

使用 TRAE CN 时将执行端名称改为 TRAE。写清功能、边界、允许修改的目录和证据要求。`completed` 表示执行端结束；监督端独立检查并明确验收后才是 `accepted`。网关不代答原生权限请求，也不代替账户登录或模型选择。

## 管理与升级

服务管理：

~~~powershell
pwsh -NoProfile -File scripts/manage.ps1 start
pwsh -NoProfile -File scripts/manage.ps1 status
pwsh -NoProfile -File scripts/manage.ps1 stop
~~~

需要登录自启和退出重启观察时执行 `manage.ps1 install`；移除观察执行 `manage.ps1 uninstall`。服务 `stop` 保留任务数据与原生会话，停止网关不代表取消桌面执行；此观察机制不保证识别仍存活但卡住的进程，也没有长期无人值守结论。完整卸载入口为 `scripts/uninstall.ps1`，先确认集成属于当前目录、执行任务已经完成或取消；卸载保留任务数据和业务成果。

默认状态目录为包内 `data/platform`，包含私有连接与任务信息，应留在本机。CLI / MCP 可用 `AGENT_HUB_STATE_DIR` 指定隔离目录；现有桌面安装与管理脚本仍围绕安装目录默认状态配置，改变一个环境变量不等于完成全部迁移。settings.json 支持 port、maxConcurrent、TRAE executable 和 workbuddy.executable/cdpPort/reportPort；三个端口必须不同。AGENT_HUB_PORT、AGENT_HUB_MAX_CONCURRENT、TRAE_EXECUTABLE、WORKBUDDY_EXECUTABLE 可覆盖对应运行设置；并发须为 1 至 16 的整数。服务只绑定 127.0.0.1。

已有版本升级前备份状态与配置、确认原生任务结束，在隔离副本验证后安排切换。若预检查报另一个 MCP 配置或桌面桥属于另一目录，先核对原安装归属，不要直接删除配置绕过检查。本次公开发布不自动升级既有桌面服务。

构建和测试入口为 `npm run build`、`npm test`；完整发布打包入口为 `node scripts/release.mjs`。自动检查不发送模型任务。真实桌面验证范围见 [验证说明](validation.md) 与 [三个项目报告](REAL-PROJECT-VALIDATION.md)。
