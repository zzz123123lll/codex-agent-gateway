# 新实现任务与兼容性规范

目标：保留监督端规划/检查/返工/正式验收与原生执行端自身工具执行；重写借用的基础实现，形成可审查的模块化0.3.0。不把改名、格式化、移动旧函数算重写。不声称法律上的净室开发或授权已自动解决。

授权范围：仅本 gateway-rebuild 目录。原本TRAЕ任务提示中的“不要修改网关”指正在运行的旧网关和配置，本任务明确授权开发这个独立新网关项目。禁止改变旧服务、原有数据、安装、账户、模型、安全设置；禁止修改 express 根目录业务源码。不提交GitHub、不联系他人。

不读取或复制 work/codex-workbuddy-gateway，也不读取旧版 src/platform/client/contracts/engine/http/mcp/store/ui 及旧版 platform.test 的实现。依据本规范独立实现；本目录保留的Windows桌面扩展/安装/trae适配是本项目新增组件，可读并兼容。已有Codex验收测试不可修改，自己的额外测试写新文件。

## 结构

src/domain：输入契约/状态与转移规则。
src/application：任务编排、调度、验收、返工。
src/infrastructure：SQLite持久化、结果文件验证、原生传输。
src/transport：HTTP路由、SDK、MCP、工作台。
旧 src/platform 路径保留薄兼容导出，不能在那里继续堆整个实现。src/cli.ts重写入口/服务生命周期并保留命令。
SQLite必须兼容原hub_runs/hub_events表及已存JSON，无破坏迁移。先写/运行自己的测试，观察红再实现；npm run build及npm test通过。

## 公共API（接口名称是兼容协议）

platform/contracts.js 导出 HubError(code,message,httpStatus=400), requestSchema(zod), waitingStates(Set), TS类型 AgentProvider/HubRun/HubEvent/ProviderSnapshot/RunRequestInput/RunInput/Artifact。
request：provider默认trae长度1..80；task trim非空<=100000；workspace可选非空；output text/json/artifacts默认text；idempotencyKey可选长度1..200；constraints默认[]最多100条1..4000；timeoutSeconds整数10..86400默认1800；拒绝额外字段。
HubRun：id,input,workspace,providerTaskId,status,review(pending|accepted),holdsCapacity,round,resultFile,previousAttemptId?,feedback?,attemptId?,sessionId?,runtimeSource?,result?,error?,lastPollError?,usage={credits:null,source:unavailable},createdAt,updatedAt,deadline。
状态 queued/dispatching/submitted/running/completed/blocked/failed/cancel_requested/cancelled/uncertain；result含text,json?,artifacts数组、digest。Artifact含path/name/bytes/sha256。ProviderSnapshot含status queued/running/completed/blocked/failed/cancelled,holdsCapacity,attemptId?,sessionId?,runtimeSource?,error?,events[{key,type,text}]。Provider接口 id,label,capabilities,health,submit,poll,cancel,rework,accept,recover可选。
HubStore(file)：close/get/byKey/create/list(limit=100,offset=0)/all/save(run,audit?)/event/events；get不存在返回undefined；create返回{run,created}；event按runId+key去重；save任务与审计事件同事务。表 hub_runs(id TEXT PK,request_key TEXT UNIQUE,fingerprint TEXT,body TEXT), hub_events(id INTEGER PK AUTOINCREMENT,run_id TEXT,event_key TEXT,type TEXT,data TEXT,created_at TEXT,UNIQUE(run_id,event_key))。
HubEngine(store,providers,directory,maxConcurrent=1)：store/providers/directory/maxConcurrent公开，get/provider/describeProviders/submit/tick/cancel/rework/accept/recover/exclusive；providers是Map可注入测试；submit同步返回{run,created}；其余动作Promise。导出 inside/workspacesOverlap/readResult/artifactFor用于兼容。
AgentHubClient(url,token)，static local(directory默认AGENT_HUB_STATE_DIR或包data/platform)，request(route,method=GET,data?,signal?)/submit/get/events/cancel/rework/accept/wait/run。local读取connection.json的url/tokenFile。只允许127.0.0.1 HTTP原点，禁止用户密码/额外路径/query/hash，禁止重定向；wait超时不取消任务；支持AbortSignal。

## 编排正确性

幂等重复同语义请求（默认值、真实路径规范化）返回原任务，变更请求409 IDEMPOTENCY_CONFLICT；未派发队列最多100。
任务ID hub-UUID；轮次output位置 results/ID/round-N/output.json，隔离工作目录workspaces/ID，创建目录canonical realpath。并发1..16；序列化tick与变更防双发；同目录及父子目录互斥跨provider，Windows忽略大小写，project与project-other不冲突。
派工之前写dispatching+holdsCapacity=true；重启已派工任务只查询、不能重发。poll无记录或返工时旧attempt返回 -> uncertain占位；网络失败保留身份占位。DISPATCH_NOT_SENT仅明确未发送才failed释放。超时未确认原生结束继续blocked占位。
完成回报+原生停止由provider确认；若completed仍holdsCapacity，应保持占位并拒绝验收/返工。provider.accepted不可赋予Codex验收。输出验证不通过INVALID_OUTPUT；真结束才释放。
cancel队列直接cancelled，执行中cancel_requested占位直到原生确认停止，不因HTTP请求成功释放。
rework非空反馈，只有确认结束的attempt可返工；cancelled必须有session；原任务ID/providerTaskID/session保持，round+1，new resultFile，review清pending，result/旧error清空，反馈和旧round/session/digest/验收写审计。failed DISPATCH_NOT_SENT且无attempt/session允许显式新轮重试。所有返工走同session，不能旧attempt输出算新成果。
accept只能completed且无占位、本轮result及artifacts全部摘要与完成时匹配；note/evidence非空；provider无验收权限。旧数据无digest不自动验收。正式review事件可持久恢复。
recover只uncertain/blocked且占位+明确reason，provider必须确认idle，不能accept或重新派发。

## 文件与HTTP

结果UTF8 JSON <=1MiB，严格{text非空,json可选(允许null),artifacts最多100绝对路径}。json模式要求json键，artifacts模式至少1文件。仅workspace/本轮result目录真实文件可导出，canonical路径禁止链接逃逸/替换根；目录不能作成果。保存结果+成果SHA256，验收/下载再核验；避免hash与读取不同文件的竞争窗口（用同一fd核验和流式下载）。
createHubServer(engine,token)返回node.http.Server。只绑定外部调用的127.0.0.1；校验精确Host含port与Origin，拒跨站API/重定向；匿名GET /仅静态工作台，不发token；带正确Bearer访问/发HttpOnly SameSite=Strict cookie，接口接受cookie或Bearer，恒时比较。对内部异常返回通用信息，不泄露堆栈、token或私有路径。
GET /v1/health,/v1/providers,/v1/runs?limit&offset,/v1/runs/ID,/events?after,/wait?timeoutSeconds(<=50秒),/stream(SSE增量id,last-event-id,heartbeat且断开清理),/artifacts/N。
POST /v1/runs(202新200重复),/ID/cancel,/rework(202),/accept,/recover，严格body Schema，application/json，1MiB上限，非法参数400、unknown404、auth401、Host/Origin403。等待断开清理；非等待状态马上返回。
MCP保留10工具agent_hub_providers/submit/get/list/wait/events/cancel/rework/accept/recover，用官方SDK和stdio，stdio stdout仅协议，不污染调试日志。工具结果text JSON+isError。
工作台重新写页面，可中文；具备provider选择、提交任务/输出/约束/幂等/目录，任务列表与状态/轮次/验收、详情和事件、取消/返工/验收/恢复、artifact下载。无innerHTML插入模型内容；textContent安全呈现，匿名不泄露token。

## Windows执行能力

已提供桌面扩展、desktop.ts、trae.ts及安装/worker脚本保持协议兼容。TRAE原生执行/取消/恢复沿用这些本项目组件，不绕过审批。
重新实现WorkBuddy provider及native driver，保持接口：
WorkBuddyProvider(directory,executable,worker,driver,port=18496,verifyActor=verifyWorkBuddyActor), start/close/health/submit/poll/cancel/rework/accept/recover; attempts公开路径，report/progress端口协议不变，worker.mjs报文兼容。
WorkBuddyDriver owner()->pid,create(workspace,sessionId),inspect(sessionId)->{state:idle|busy|waiting_input,workspace,reason?},receipt(sessionId,wakeId),send(sessionId,wakeId,prompt),cancel(sessionId),close。NativeState、WORKBUDDY_BRIDGE、WindowsWorkBuddyDriver导出。
native身份校验：Windows CDP端口只能127.0.0.1单个配置exe所属pid；只选exe目录resources/app.asar/renderer/index.html的file页面。CDP websocket请求有id/timeout/disconnect拒绝，未确认发送不重试。
已调研的应用公开给renderer的通信协议：MessageChannel，window.postMessage({type:'workbuddy:open-local-daemon-transport-port',target:{transportType:'local'}},'*',[port2])；收到port open；消息frame kind=message,json含{id,type:'request',channel,args}；响应type:error或result；event channel session:event:SID，result.sessionId/update.sessionUpdate=user_message_chunk，文本 [CODEX_QUEUE_WAKE wake-run-UUID] 或result._meta['codebuddy.ai'] requestId/userMessageId/messageRequestId作派发收据。
RPC workspace:initialize([{cwd}]), session:create([{cwd,sessionId,isPlayground:false}]), daemon:getActiveSessions([]),session:get([sid]),session:load([sid,{cwd,forceRendererHistoryReplay:true}]),session:sendMessage([sid,[{type:'text',text:prompt}],{'codebuddy.ai':{requestId:wake,userMessageId:wake,messageRequestId:wake,emitSyntheticUserPromptLive:true}}]),session:cancel([sid])。
idle必须全无pendingInputKind/pendingPermissions/pendingQuestions/pendingElicitations/isProcessing/stopRequested/hasActiveTeamMembers/hasActiveToolCalls且active列表无sid或cwd。允许completed/failed/cancelled/idle/stopped/pending/terminated；unknown忙。send不等待整个推理结束，但必须收到本次wake收据，无收据标不确定；history receipt检查可load重放。
provider派发前持久化attempt/session/wake/lease；项目绑定native session，同目录现有session必须idle；返工原session。原进程工具用worker.mjs+grant lease报告，pid核验node工具exe及祖先desktop pid/exe，不能伪造本机任意node。报告不能使任务自动completed，至少连续3次idle+正确本轮报告+receipt才能结束；cancel/recover需确认idle，报告冲突409、重复幂等、终态progress拒绝。report主体<=128KiB，text非空<=60000；旧grant/attempt仍可读取用于兼容升级。
Windows安装/管理保持脚本入口及settings结构，服务根data/platform读取；版本0.3.0。不要启动新模型任务/真实桌面进行自己的测试；只离线mock测试，本轮TRAE自己就是唯一授权执行任务。不要安装到用户账户；不要改系统服务。

## 交付

实现全部上述功能，自己的新测试覆盖模块/WorkBuddy rpc，现有Codex写的 independent.test.mjs不可改。生成docs/ARCHITECTURE.md、docs/REWRITE-LEDGER.md记录模块责任、重新实现与保留自写组件、迁移/版本/测试。诚实保留思路/协议研究来源，不能凭文本相似低就声称法律授权。修复 scripts/release.mjs/package.mjs的新模块/doc/test打包清单及硬编码版本使完整交付。
最终npm build/test，报告具体结果/限制，不自验收。不得仅给计划，不从上游复制，不通过删功能让测试通过。
