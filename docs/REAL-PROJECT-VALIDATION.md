# Codex 与 TRAE / WorkBuddy 真实项目监督验证报告：0.3.0 → 0.3.1

生成时间 2026-10-13T11:57:56.179Z。本轮从 0.3.0 新建真实任务开始，实际暴露的问题形成 0.3.1 修复。三个项目均已完成执行、具体返工、独立复验和 Codex 正式验收。 本报告只读取保存的证据，不向模型发送任务；后续若有更晚任务或返工事件，打包门槛将拒绝过时快照。

用户验证的分工是：Codex 制定要求、独立检查、给出修复指示并最终验收；TRAE / WorkBuddy 使用各自模型和工具实际执行。每个项目采用固定 GitHub 提交的新工作目录和新增 validation 成果，没有把旧版本成果充当本轮执行结果。

|项目|难度|执行端|最终网关轮次|已观察原生执行次数|任务状态 / 验收|当前轮冻结业务检查|
|---|---|---|---|---|---|---|
|slugify|基础|workbuddy|3|2|completed / accepted|21/21|
|p-limit|中等|trae|3|2|completed / accepted|37/37|
|lowdb|较高|workbuddy|6|6|completed / accepted|52/52|

冻结标准 2026-10-12T10:42:38.705Z，范围 Codex-owned contracts and 110 independent checks, frozen before native dispatch；冻结文件摘要保持一致。最终冻结业务检查合计 21 + 37 + 52 = 110 项通过。 网关轮次、原生执行次数、业务检查项和自动回归项是四个不同统计。

## 网关回归与修复范围

此前 0.3.0 重新实现时的 71/71 自动检查是历史基线，原日志 outputs/gateway-reimplementation-evidence/delivery-regression.log 保留。0.3.1 最终网关自动回归为 113/113，失败 0（outputs/v3-real-project-benchmark/gateway-final-regression-0.3.1.log）。 自动回归包含模拟、兼容性、鉴权与 Windows 预检查；它们不能替代三个项目实际模型执行和监督端业务验收。

本轮网关修复包括：仅截止时间导致的不确定 TRAE attempt 可继续观察晚到报告，并要求报告之后的三次新 idle 观测；收到报告与在途状态查询的竞态不再提前计入 idle；确认从未派发的队列超时任务可显式进入新轮次；HTTP / MCP 使用包版本；新版 WorkBuddy 原生接口、GUI owner 与会话路由适配；worker 以异步方式查询真实进程祖先；WorkBuddy 服务端增加限定托管 Node 身份的核验，同时保留真正祖先链校验。异常、未确认派发、权限和恢复不会因此自动变成成功。

TRAE 桌面观察器修复仍未安装到本机扩展，只有离线验证，不能称为新扩展的真实回归。WorkBuddy 新接口、异步 worker 与限定 Node 身份核验在 lowdb 后续实际执行、报告回传和三次 idle 完成确认中得到验证。初次部署范围见 patch-deployment-scope.json，后续范围见相应原生创建、worker、actor 与 lowdb-final-native-completion-proof.json 记录；这些记录的实际时间和范围分别保留。

gateway-incident-review.json：3 条诊断发现（诊断结果，非验收通过数）。

- GW-DEADLINE-OBSERVATION-001 [high / 此文件未标闭合状态] The TRAE extension stops observing a known native attempt after its deadline changes status from running to uncertain. Later verified tool reports are persisted but cannot complete the attempt even if its original session becomes idle.
- GW-QUEUE-RETRY-002 [medium / 此文件未标闭合状态] An initial task that expired without dispatch has no native identity but explicit rework rejects it because the never-sent predicate recognizes only DISPATCH_NOT_SENT, not QUEUE_TIMEOUT.
- GW-HISTORICAL-IDENTITY-003 [informational / 此文件未标闭合状态] The slugify round-2 queue timeout retains the confirmed stopped round-1 attempt and session. Existing rework permits round 3 in the original session; it must not be reclassified as a first dispatch or accept old output as new.

gateway-fix-code-review.json：1 通过 / 1 失败。

- GATEWAY-OBSERVATION-REPORT-RACE [WARNING / 此文件未标闭合状态] A STATUS observation requested before the first verified late report can contribute to its fresh post-report idle sequence. The attempt becomes completed after only two newly requested post-report status observations.

gateway-fix-code-review-final.json：3 通过 / 0 失败。

- GATEWAY-OBSERVATION-REPORT-RACE [WARNING / RESOLVED] A STATUS observation requested before the first verified late report can contribute to its fresh post-report idle sequence. The attempt becomes completed after only two newly requested post-report status observations.

包审查状态：READY_FOR_PACKAGING_LOCAL_PATCH_NOT_DEPLOYED

历史 WARNING 发现、失败红测及后续 RESOLVED 复验均保留。早期 gateway-fix-verification.json 中 LOCAL_PATCH_TESTED_NOT_DEPLOYED 是生成当时的历史快照；后续新版 WorkBuddy 补丁已有真实执行和回报验证，而 TRAE 扩展的迟到观察补丁仍未安装。早期局部通过数不替代最新完整回归计数，也不能自动证明所有补丁都已安装。

## 真实问题、返工与复验

1. slugify 首轮冻结检查 21/21，但额外审查发现 SL-ARG-001：先给非法 separator 再给合法值会掩盖前一错误。Codex 给出具体返工指示；网关 round 2 在队列中超时，未派发，显式 round 3 才完成实际第二次原生执行。修复后冻结检查 21/21、额外复验 9/9，随后正式验收。网关 round 3 不等于模型执行三次。

2. p-limit 首轮 36/37，业务额外检查 9/9；tsd 正常静默成功导致日志为空，交付证据不满足非空记录要求。原生报告在截止时间后约 51 秒到达，旧 TRAE 扩展转 uncertain 后停止观察，网关继续保留占位。Codex 核验原会话 idle 后 checked recovery，只记 failed / pending；round 2 因原会话未选中而预派发失败，未产生第二次执行。round 3 返回原会话修复真实命令元数据，37/37 复验及额外审查通过后正式验收。

3. lowdb 最初的独立任务在队列中超时，从未派发；旧 ID 作为 previousIds 保留，不计为模型执行。新任务早期暴露 tracked package-lock 改动、缺少 README / summary、export 路径行为、失败写入期间 GET 读到未提交数据、并发 close 等问题。Codex 给出逐项修复要求；原生权限等待与界面已取消提示不一致导致多次中断，监督端保留证据，未绕过审批或把部分成果提前验收。round 4 在新版 WorkBuddy GUI owner 接口下交付文档、summary、40 项执行端自检和 13 项上游测试；round 5 修复 README，异步 helper 成功查到祖先后仍被服务端旧 Node 身份判断误拒；round 6 修复限定托管 Node 身份核验后，真实 report 成功，三次 idle 确认 completed / pending，最后 Codex 再复验并 accept。lowdb 最终网关 round 6，已观察 6 次实际原生执行；冻结检查 52/52 并已由 Codex 正式验收。

## 原始命令与等效检查

slugify / p-limit 原始 npm test 的 Windows XO / 类型项目服务失败照实保留；AVA / tsd 的成功属于单独命令。lowdb 原始 npm ci / npm run build 的依赖或产物清理被本机保护拦截，npm run lint 受 CRLF 影响失败；同源编译步骤与固定 Git blobs 的 LF 等效 lint 成功分别记录。lowdb 原生 npm test 13 项和自检 40 项成功，也不把上面的非零命令改写为成功。存在失败命令不等于冻结业务功能失败；功能验收也不等于所有原始上游脚本零退出。详细限制、命令时间、退出码及日志以各项目 summary 和各轮归档为准。

### slugify

固定源码 sindresorhus/slugify@3b17b2e84b97624a683aafaa38184bf2746fab22。当前任务 hub-d08ce3f8-ab49-4e72-aaf2-32550cbf293a，原生会话 06ffb293-9132-40bb-81b0-0266f7841d93。

- slugify-checks-round-1.json：21 通过 / 0 失败。
- slugify-checks-round-3.json：21 通过 / 0 失败。
- slugify-checks-round-initial-red.json：1 通过 / 20 失败。失败项 S-002-genuine-local-source-import、S-003-executor-summary-and-log-evidence、S-004-log-evidence-confined-and-without-credentials、SL-001-documented-multilingual-examples、SL-002-empty-fallback-and-default-duplicates、SL-003-unique-suffix-collision、SL-004-separator-and-unique-combined、SL-005-empty-array、SL-006-non-array、SL-006-null、SL-006-nonstring、SL-006-malformed、SL-006-too-many、SL-006-too-long、SL-007---unknown、SL-007---separator=/、SL-007---separator=ab、SL-008-one-MiB-input-limit、SL-009-thousand-items-collision-stress、SL-010-max-title-boundary。

slugify-code-review.json：7 通过 / 2 失败。

- SL-ARG-001 [WARNING / 此文件未标闭合状态] An unsupported separator is accepted if a later separator overrides it; validation only inspects the final value

slugify-code-review-round-3.json：9 通过 / 0 失败。

- SL-ARG-001 [WARNING / RESOLVED] An unsupported separator is accepted if a later separator overrides it; validation only inspects the final value

交付 summary 仍保留以下非零命令记录；原始失败与后续等效检查分别计算：

- npm test，exit 1，<PROJECT_slugify>\validation\logs\native-npm-test.log
- npx xo index.js index.d.ts overridable-replacements.js test.js，exit 1，<PROJECT_slugify>\validation\logs\equivalent-lint-original-tracked.log
- npm test，exit 1，<PROJECT_slugify>\validation\logs\round-2\native-npm-test.log
- npx xo index.js index.d.ts overridable-replacements.js test.js，exit 1，<PROJECT_slugify>\validation\logs\round-2\equivalent-lint-original-tracked.log

正式验收文件：slugify-acceptance.json。当前冻结业务检查和额外审查是监督端证据，执行端自检不替代正式验收。

### p-limit

固定源码 sindresorhus/p-limit@a8a6fbec4e0e866d6d779b10889bb4f5567e70eb。当前任务 hub-eaa7f368-53c7-4fb6-b42e-6a6968f169d1，原生会话 6accbb2b2962f13cbf0aa0c7。

- p-limit-checks-round-1.json：36 通过 / 1 失败。失败项 S-003-executor-summary-and-log-evidence。
- p-limit-checks-round-3.json：37 通过 / 0 失败。
- p-limit-checks-round-initial-red.json：1 通过 / 36 失败。失败项 S-002-genuine-local-source-import、S-003-executor-summary-and-log-evidence、S-004-log-evidence-confined-and-without-credentials、PL-000-exported-module、PL-001-limit-1、PL-001-limit-2、PL-001-limit-3、PL-001-limit-8、PL-001a-concurrency-is-observable-through-elapsed-time、PL-002-empty、PL-003-repeat-and-simultaneous-isolation、PL-004-bad-jobs-0、PL-004-bad-jobs-1、PL-004-bad-jobs-2、PL-004-bad-jobs-3、PL-004-bad-jobs-4、PL-004-bad-jobs-5、PL-004-bad-jobs-6、PL-004-bad-jobs-7、PL-004-bad-jobs-8、PL-004-bad-jobs-9、PL-005-bad-limit-0、PL-005-bad-limit-9、PL-005-bad-limit-1.5、PL-005-bad-limit-2、PL-005-bad-limit-null、PL-005-bad-limit-NaN、PL-005-bad-limit-Infinity、PL-006-all-rejected-drains、PL-007-JSON-values、PL-008-real-cli、PL-009-cli-invalid-"{oops"、PL-009-cli-invalid-{"jobs":[{"id":"x","、PL-009-cli-invalid-null、PL-009-cli-invalid-[]、PL-010-hundred-jobs-stress。

p-limit-code-review.json：9 通过 / 0 失败。

- PL-OPTIONAL-BOOLEAN-SEMANTICS [INFO / 此文件未标闭合状态] Direct API accepts an own fail property whose value is undefined; literal presence-based interpretation of the task would require a boolean.

p-limit-code-review-round-3.json：18 通过 / 0 失败。

- PL-OPTIONAL-BOOLEAN-SEMANTICS [INFO / 此文件未标闭合状态] Direct API accepts an own fail property whose value is undefined; literal presence-based interpretation of the task would require a boolean.

当前 summary 未列出非零命令；不能据此推断历史命令全部成功。

正式验收文件：p-limit-acceptance.json。当前冻结业务检查和额外审查是监督端证据，执行端自检不替代正式验收。

### lowdb

固定源码 typicode/lowdb@8a6fce9b72f769b22533f0979fbc2e73180f8112。当前任务 hub-e284d878-0201-4114-a8e9-803b0ac475f1，原生会话 29891a47-6522-405f-9b12-7ccc96640774。

- lowdb-checks-round-1-preliminary.json：48 通过 / 4 失败。失败项 S-001-upstream-tracked-files-unchanged、S-003-executor-summary-and-log-evidence、S-004-log-evidence-confined-and-without-credentials、DB-022-export-rejects-relative-path。
- lowdb-checks-round-3-preliminary.json：49 通过 / 3 失败。失败项 S-001-upstream-tracked-files-unchanged、S-003-executor-summary-and-log-evidence、S-004-log-evidence-confined-and-without-credentials。
- lowdb-checks-round-4.json：52 通过 / 0 失败。
- lowdb-checks-round-6.json：52 通过 / 0 失败。
- lowdb-checks-round-initial-red.json：1 通过 / 51 失败。失败项 S-002-genuine-local-source-import、S-003-executor-summary-and-log-evidence、S-004-log-evidence-confined-and-without-credentials、DB-000-real-process-start、DB-001-health-and-empty、DB-002-create-trim-and-persist-before-response、DB-003-invalid-post-0、DB-003-invalid-post-1、DB-003-invalid-post-2、DB-003-invalid-post-3、DB-003-invalid-post-4、DB-003-invalid-post-5、DB-003-invalid-post-6、DB-003-invalid-post-7、DB-003-invalid-post-8、DB-004-malformed-json、DB-005-oversize-and-still-alive、DB-005a-json-media-type-required、DB-006-title-100-boundary、DB-007-get-and-patch、DB-007a-patch-media-type-required-and-charset-accepted、DB-008-invalid-patch-0、DB-008-invalid-patch-1、DB-008-invalid-patch-2、DB-008-invalid-patch-3、DB-008-invalid-patch-4、DB-008-invalid-patch-5、DB-008-invalid-patch-6、DB-009-not-found、DB-010-fifty-concurrent-creates、DB-011-concurrent-updates、DB-012-delete-and-new-id、DB-013-restart-full-durability、DB-014-independent-exported-instances、DB-015-bad-port-"-1"、DB-015-bad-port-"65536"、DB-015-bad-port-"1.5"、DB-015-bad-port-"1e3"、DB-015-bad-port-"0x10"、DB-015-bad-port-" 0"、DB-015-bad-port-"00"、DB-015-bad-port-"foo"、DB-015-bad-port-""、DB-016-corrupt-file-preserved、DB-017-missing-file-setting、DB-019-failed-write-must-not-publish-uncommitted-state、DB-020-relative-database-path-rejected、DB-021-failed-patch-rollback、DB-021-failed-delete-rollback、DB-022-export-rejects-relative-path、DB-018-service-closed。

lowdb-code-review-round-1.json：5 项诊断记录（诊断结果，非验收通过数）。

- DB-RV-001 [INFO / 此文件未标闭合状态 / optional-contract-hardening / 非验收阻断] Exported startServer accepts a relative database path
- DB-RV-002 [P2 质量风险 / 此文件未标闭合状态 / reproduced-isolation-risk / 非验收阻断] GET exposes an in-flight write candidate which later fails
- DB-RV-003 [INFO / 此文件未标闭合状态 / optional-contract-hardening / 非验收阻断] Concurrent close callers do not await the same shutdown completion
- DB-RV-004 [INFO / 此文件未标闭合状态 / optional-contract-hardening / 非验收阻断] Existing database item rows are not validated at startup

lowdb-code-review-before-final-delivery.json：6 通过 / 0 失败。 未记录新增发现。

lowdb-code-review-current.json：6 通过 / 0 失败。 未记录新增发现。

lowdb-code-review-round-5.json：6 通过 / 0 失败。 未记录新增发现。

交付 summary 仍保留以下非零命令记录；原始失败与后续等效检查分别计算：

- node -e "const c=require('crypto'),f=require('fs');const b=f.readFileSync('package-lock.json');console.log('worktree sha256',c.createHash('sha256').update(b).digest('hex'),'bytes',b.length);console.log('worktree CRLF count',(b.toString('latin1').match(/\\r\\n/g)||[]).length)"，exit 1，validation/logs/round-4/lock-hash-before.log
- node validation/tools/baseline-probe.mjs，exit 1，validation/logs/round-4/baseline.log
- node validation/tools/baseline-probe.mjs，exit 1，validation/logs/round-4/baseline-retry.log
- npm run build，exit 1，validation/logs/round-4/npm-build.log
- npm run lint，exit 1，validation/logs/round-4/npm-lint.log
- node_modules/.bin/tsc，exit 1，validation/logs/round-4/build-equivalent-tsc.log
- node validation/tools/lint-original-blobs.mjs --mode=head，exit 1，validation/logs/round-4/lint-equivalent-head.log
- npm run lint，exit 1，validation/logs/round-4/npm-lint-native-raw.log

正式验收文件：lowdb-acceptance.json。当前冻结业务检查和额外审查是监督端证据，执行端自检不替代正式验收。

## 证据打包与服务恢复

最终 ZIP 门槛保持：三个当前任务 completed / accepted、无占位、当前轮冻结检查零失败、验收文件存在、冻结文件字节一致、无更晚任务或返工证据；监督端还须显式确认额外缺陷复验完毕，并保存通过的运行服务恢复证明。本报告本身不降低这些条件。

runtime-restored.json 已明确通过：原 0.2.1 服务、设置与注册文件摘要、观察任务 action 和历史身份恢复核验，具体字段以该记录为准。

包保留任务、固定源码摘要、冻结检查、各轮失败、返工、验收、故障记录和真实 validation 成果，包括 lowdb 早期 partial artifacts 与用于验证损坏数据库的非法 JSON。导出副本脱敏，原始本地证据不改；MANIFEST 区分原始和导出 SHA。依赖、Git、平台 SQLite、授权与令牌不导出，原生 trace / uid 元数据也移除。

范围限制：一台 Windows 电脑、三个固定 GitHub 库及新增 CLI / 并发执行 / 持久化 HTTP 功能。没有多机、24 小时无人值守或定量额度节省证据；GitHub CI 定义与本地测试不等于实际 GitHub CI 运行。
