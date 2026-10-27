# 进阶手册

**简体中文** | [English](advanced.en.md) · [返回 README](../README.md)

[架构](#架构) · [看板设置](#看板设置) · [MCP 工具](#mcp-工具) · [任务状态](#任务状态) · [预算与用量](#预算与用量) · [模型](#模型) · [Worker 工具（MCP）](#worker-工具mcp) · [Worker 插件](#worker-插件) · [配置](#配置) · [共享后台](#共享后台) · [监控](#监控) · [不经 Claude Code 直接运行](#不经-claude-code-直接运行) · [更新与卸载](#更新与卸载) · [已知限制](#已知限制) · [开发与验证](#开发与验证)

## 架构

```
Claude Code 会话（监督者：规划、下达、验收）                 看板面板（/forge-board）
   │  MCP stdio：forge_* / sdd_task 工具                          │  function hooks，/api/*
   ▼                                                              ▼
agentforge serve（轻量 stdio 转发）──── HTTP ────► agentforge-backend（每个 AGENTFORGE_HOME 一个）
                                                     ├─ 任务存储（~/.agentforge/tasks）
                                                     ├─ 看板设置、SDD 文档、插件更新
                                                     ▼  @cursor/sdk（本机运行）
                                                   Cursor agent（在 cwd 中改文件、跑命令）
```

所有 Claude Code 会话和看板都连接同一个后台进程：打开多个会话不会启动多套 worker，派工的会话关闭后任务仍继续执行。Claude Code 负责推理，`forge_*` 调用是动作，状态、结果和验证输出回传给它作为观察。

## 看板设置

| 控件 | 作用 |
|---|---|
| 自动派工 | **开**：Claude Code 规划、拆解、下达并验收，执行端负责实现。**关**（默认）：Claude Code 照常工作；明确要求（「交给 Cursor」、`/forge`）仍会派工。 |
| Hook 状态 | `UserPromptSubmit` Hook 在最近一次修改后运行过即为 `Hook active`；下一条消息生效前为 `Pending`；设置了 `disableAllHooks` 时显示警告。开关已保存不代表 Hook 已运行。 |
| Token savings (estimate) | 按今天、最近 7 天和全部显示 (委派 − Claude) / 委派；没有委派时显示 `—`。委派按任务创建时间汇总执行端各轮用量；Claude 按每次 MCP 工具调用的参数和返回文本估算（约 4 个 ASCII 字符或 1 个中日韩字符算 1 token），记在 `~/.agentforge/claude-traffic.jsonl`。假设 Claude 自己做会花掉与执行端差不多的 token，不计 Claude 之后重读工具结果的消耗；比例可能为负。移动端不显示。 |
| 执行端 | Cursor，或 Worker 插件（`AGENTFORGE_WORKERS`）。切换时清空为上一个执行端选择的模型、强度和权限。 |
| 模型 | 跟随执行端默认，或从实时目录中选固定模型。执行端离线或目录读取失败会明确提示；已从目录下架的模型保持选中并给出警告，不会静默替换。 |
| 思考强度 | 只显示目录为该固定模型提供的强度；否则跟随模型默认，不虚构选项。 |
| 新会话权限 | 执行端支持时显示（Cursor：sandbox、auto-review 或两者）。只在为任务新建 agent 时应用一次，追问沿用；执行端无法应用时拒绝派工。 |
| SDD 文档 | 任务文档的独立开关、工作区和编辑器。 |
| 任务 | 最近 100 个任务，每次显示 8 行，用 ▲ / ▼ 翻页，旁边显示位置（如 `9–16 / 40`）和运行中的数量。运行中的任务可 **Pause**（停止当前轮次但保留 agent，状态变为 `paused`）或 **Cancel**（结束任务）；暂停的任务可 **Resume**（在同一个 agent 上重发被停下的那一轮）或 **Cancel**；其余任务可 **Delete**（删除任务记录和事件日志）。**Clear finished** 删除所有既不在运行也未暂停的任务。删除都需要再点 Confirm 确认。移动端只显示文字。 |
| Plugin update | 折叠区，见[更新与卸载](#更新与卸载)。 |

开关从下一条消息生效：Hook 在每条消息前加一行 ON/OFF 说明，是否派工仍由 Claude Code 按任务判断。看板隐藏时暂停轮询；Claude Code 移动端只显示文字。除 Dispatch 外的各区可用 ▾ / ▸ 折叠为一行摘要；折叠列表存为 `delegation.json` 的 `board.collapsed`，所有会话共用，不算作会让 Hook 状态变为 Pending 的设置变更。

不用看板时，设置保存在 `~/.agentforge/delegation.json`，通过后台修改：

```bash
agentforge on | off
agentforge config show
agentforge config set executor=cursor model=gpt-5.5 effort=high permission=sandbox
agentforge config set model=default effort=default permission=default sdd=false sdd-workspace=/abs/dir
```

SDD 文档的目录结构：

```
<workspace>/<project-uuid>/project.json
<workspace>/<project-uuid>/<task-uuid>/task.md   （目标、范围、计划、验收）
<workspace>/<project-uuid>/<task-uuid>/meta.json
```

工作区默认 `~/.agentforge/sdd`，在看板或用 `config set sdd-workspace=` 设置；Claude Code 可以读取，但不能移动工作区或切换开关。每次保存都带读取时的版本号：期间被改过的文档会以冲突拒绝，看板保留你的草稿。从看板关闭 SDD 时会先保存未提交的草稿，保存失败则保持开启。SDD 关闭后文档仍可读，写入一律拒绝。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `forge_capabilities` | 可用 worker、`mcp.json` 中的 MCP 服务器、默认模型、参数与预算，以及看板当前设置。 |
| `forge_runtime_info` | 各执行端是否在线、默认模型、含强度的模型目录和支持的权限；不提交任何任务。 |
| `forge_dispatch` | 用任务说明、验收条件和 `verify_command` 启动后台 agent。带 `order_id`（UUID）保证重试幂等。未指定的 `worker` / `model` / 强度 / 权限跟随看板；可选 `mcp_servers`、`max_turns`、`max_minutes`、`max_rework`。agent 启动后返回 `task_id`、`order_status` 和 `conversation_id`。 |
| `forge_status` | 状态、`order_status`、当前轮次、最近步骤（消息、思考摘要、工具调用）、正在运行的工具调用及已运行秒数（`currentTool`），以及 worker 最后一次事件后的 `idleSec`。传 `since` 只取新步骤。 |
| `forge_wait` | 阻塞到当前轮次结束，每次最多 240 秒，只返回这次等待期间的新步骤。长任务更适合把 `forge_dispatch` 返回的 `wait_command`（即 `agentforge wait <task_id>`）放到后台 shell 运行，任务结束时 Claude Code 会自动通知，不用轮询。 |
| `forge_followup` | 给同一个 agent 发消息。运行中时尽量插入当前轮次，否则排队；可恢复空闲、被中断或已验收的任务。 |
| `forge_result` | 最终报告、派工以来的 git 改动（含新文件）和可选 diff。派工前已有改动的文件标记为 `preExisting`。 |
| `forge_accept` | 运行验证命令。通过即验收；失败则把输出和反馈发回返工，超过 `max_rework` 后判为拒绝。 |
| `forge_retry` | 对临时错误（`lastError.retryable`），在同一 agent 上重发最近失败或被中断的轮次。用户要求时也可恢复 `paused` 的任务。 |
| `forge_cancel` | 停止运行中的轮次；对已暂停的任务则直接结束为 `cancelled`。 |
| `forge_conversations` | 列出执行端的 agent 会话，归档或恢复其中一个。 |
| `sdd_task` | 读写 SDD 文档：工作区、项目、任务，创建、读取、按版本保存。 |
| `forge_list` | 最近的任务及其 order id 和状态。 |

status、wait、result 和 cancel 都接受 `task_id` 或 `order_id`。在 Claude Code 中工具全名为 `mcp__plugin_agentforge_agentforge__<工具名>`。

来自 Cursor 的错误带 `error_type` 和 `retryable` 判断：工具错误写在错误文本里，失败的轮次写在 `lastError` 中。判断综合了 SDK 的 `isRetryable`、错误类别（网络或限流）和连接失败信息，因为 SDK 对普通断线也常报 `isRetryable: false`。worker 在 `AGENTFORGE_START_TIMEOUT_SEC` 内没有开始运行也按此处理；对该任务 `forge_retry` 会继续等待同一个 agent，不会另开一个。

某一轮因可重试的连接错误失败时（例如 `Agent turn stopped after repeated resume attempts made no progress`，这是 SDK 在与 Cursor 的连接反复断开时抛出的），AgentForge 会在同一个 agent 上自动续跑一次，并要求它从中断处接着做；期间任务保持 `running`。如果续跑也失败，`forge_status` 会提示连接反复中断，并建议把任务拆小。设置 `AGENTFORGE_AUTO_RETRY=0` 可关闭。

SDK 断线恢复时可能把最后几个工具调用再执行一遍。AgentForge 发现同一调用完成两次时会记一条步骤，并在 `forge_result` 的 `replayed` 中列出：被重放的编辑可能写入了两次。`forge_result` 还会标出同一目录下其他任务编辑过的文件（`byOtherTask`），diff 默认不包含它们。

## 任务状态

`forge_dispatch` 接收 `order_id`：每项工作一个新 UUID。用相同 `order_id` 和参数重试会返回已有任务（`reused: true`），不会启动第二个 agent；相同 id 但参数不同会被拒绝。

每个任务都有 `order_status`：`queued`、`dispatching`、`executing`、`paused`（在看板上被暂停，不计入运行中、不阻止重启后台，重启后仍为暂停；Claude Code 不应重新派发，从看板恢复）、`completed`、`failed`、`blocked`（预算用完）、`cancelled` 或 `uncertain`。`uncertain` 表示轮次中途被打断（例如后台在运行中停止）：先检查 agent 会话和实际文件，再用原 `order_id` 查询，不要新建任务。`conversation_id` 是 Cursor agent 的 id，与 order id 不同。

## 项目级 worker 说明

每个任务都要重复交代的环境信息（构建命令、离线 Maven、shell、不要动的目录等）写进仓库里的 `.agentforge/worker.md`，所有对象都适用的写进 `~/.agentforge/worker.md`。派发时从 `cwd` 向上找到仓库根为止的最近一份，与全局那份一起以 "Project notes" 一节附加到 brief，`forge_dispatch` 的 warnings 会列出用到的文件。不想提交到仓库的话，把 `.agentforge/` 加进 `.git/info/exclude`。Cursor 自己会读的 `AGENTS.md` 和 `.cursor/rules` 不需要在这里重复。

## 并行任务与 worktree 隔离

多个任务同时改同一个仓库时，给 `forge_dispatch` 传 `isolation: "worktree"`。任务会在 `~/.agentforge/worktrees/<task_id>` 下以当前 HEAD 新建一个 git worktree，分支为 `agentforge/<task_id>`，agent 只在这个目录里改，其 diff 也只包含自己的改动。`forge_accept` 校验通过后，把改动以未提交的形式应用回原目录，再删除 worktree 和分支。应用冲突时 worktree 保留，补丁留在 `~/.agentforge/worktrees/<task_id>.patch`，可以手动 `git apply --3way` 后删除该任务。

worktree 从 HEAD 开始：原目录里未提交的改动不在其中，`node_modules`、构建产物等被忽略的文件也没有，需要的话 agent 或 `verify_command` 要先在 worktree 里安装或构建。

## 预算与用量

每个任务有轮次预算（`max_turns`，默认 20）和 worker 时间预算（`max_minutes`，默认 60，只计算轮次运行的时间）。超出时间预算的轮次会被取消；任一预算用完后，新轮次会被拒绝，并提示 Claude Code 先征求你的同意。`forge_status` 和 `forge_result` 以 `used/max` 显示 `budget`。

`forge_result` 汇总任务各轮次的 token 用量；Cursor 账号提供计费数据时，改用计费总量（以及 `chargedUsd`）。

## 模型

`agentforge models` 列出模型及其参数。看板选择的模型和强度适用于所有未自行指定的派工；其下是默认值 `AGENTFORGE_MODEL` 和 `AGENTFORGE_MODEL_PARAMS`（`reasoning=high,fast=true`）。单个任务可用 `forge_dispatch` 的 `model` / `model_params` 或 `run --model ... --param id=value` 覆盖。

## Worker 工具（MCP）

worker 可以从 `~/.agentforge/mcp.json`（或 `AGENTFORGE_MCP_CONFIG`）列出的 MCP 服务器获得额外工具。文件使用常见的 `{"mcpServers": {...}}` 格式，条目为 `command`/`args`/`env`（stdio）或 `url`/`headers`（HTTP），`${VAR}` / `${VAR:-default}` 从环境变量填充。按名称为每个任务选择服务器（`mcp_servers: ["github"]`、`run --mcp github`）。任务记录只保存名称，凭据不会写进 `~/.agentforge/tasks`。示例见 [`examples/mcp.example.json`](../examples/mcp.example.json)。

## Worker 插件

`AGENTFORGE_WORKERS` 接收逗号分隔的 ES 模块列表，模块导出 `createWorker(config)`（或默认工厂函数），返回一个 `Worker`（`src/workers/worker.ts`）。插件 worker 会出现在 `forge_capabilities` 和看板中，用 `worker` 选择。示例见 [`examples/workers/echo-worker.mjs`](../examples/workers/echo-worker.mjs)。

## 配置

设置先读环境变量，再读 `AGENTFORGE_ENV_FILE` 或 `~/.agentforge/.env`（复制 [`.env.example`](../.env.example)）。已有的环境变量优先，被修改项目自己的 `.env` 不会被读取。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CURSOR_API_KEY` | - | 未设置时使用 `agentforge login` 保存的 key（`~/.cursor/sdk/auth.json`） |
| `CURSOR_BACKEND_URL` | Cursor 官方 | 其他 Cursor 后端，由 SDK 读取；API key 必须来自该后端 |
| `AGENTFORGE_WORKER` | `cursor` | 新看板的执行端；之后以看板选择为准 |
| `AGENTFORGE_MODEL` | `composer-2.5` | 执行端默认模型（见 `agentforge models`）；看板选了固定模型时以看板为准 |
| `AGENTFORGE_MODEL_PARAMS` | - | 默认模型参数，`id=value,...`；看板的强度覆盖对应参数 |
| `AGENTFORGE_SETTING_SOURCES` | `project` | worker 加载的 Cursor 设置层（项目规则、AGENTS.md） |
| `AGENTFORGE_AUTO_REVIEW` | 关 | `1` 为工具调用开启 Cursor Auto-review |
| `AGENTFORGE_MAX_TURNS` | `20` | 每个任务的轮次预算 |
| `AGENTFORGE_MAX_TASK_MINUTES` | `60` | 每个任务的 worker 时间预算 |
| `AGENTFORGE_MAX_REWORK` | `3` | 验证失败后的自动返工轮数 |
| `AGENTFORGE_VERIFY_TIMEOUT_SEC` | `900` | 验证命令超时 |
| `AGENTFORGE_STALL_WARN_SEC` | `120` | worker 静默多久后 `forge_status` 提示可能卡住 |
| `AGENTFORGE_START_TIMEOUT_SEC` | `300` | 创建 agent 和每次开始运行的时限 |
| `AGENTFORGE_AUTO_RETRY` | `1` | 因连接错误失败的轮次自动续跑一次；`0` 关闭 |
| `AGENTFORGE_OPEN_PROGRESS` | `cursor` | 任务启动后用来打开进度页的编辑器命令；`off` 关闭 |
| `AGENTFORGE_MONITOR_PORT` | `18862` | 后台提供只读监控网页的端口；`0` 关闭 |
| `AGENTFORGE_MCP_CONFIG` | `~/.agentforge/mcp.json` | worker 可用的 MCP 服务器（绝对路径） |
| `AGENTFORGE_WORKERS` | - | Worker 插件模块，逗号分隔 |
| `AGENTFORGE_ENV_FILE` | `~/.agentforge/.env` | 设置时文件必须存在 |
| `AGENTFORGE_HOME` | `~/.agentforge` | 任务记录、事件日志、看板设置、SDD 默认工作区、后台文件 |

## 共享后台

```bash
agentforge backend status          # pid、端口、版本、启动时间、MCP 会话数、运行中的任务
agentforge backend restart         # 有任务运行时拒绝；加 --force 强制重启
agentforge backend stop | start
```

第一个 MCP 连接或看板会按需启动 `agentforge-backend`；它只监听 127.0.0.1，并使用每个数据目录独立的 bearer token（`~/.agentforge/backend.token`，权限 0600）。重启后已连接的会话会自动重连。停止后台不会卸载插件；被打断的轮次显示 `uncertain`（`interrupted`），用 `forge_followup` 可在同一个 agent 上续跑。

## 监控

```bash
agentforge monitor                 # 终端实时视图：↑↓/j k 选择，f 过滤，r 刷新，q 退出
agentforge monitor --once          # 单次快照（非 TTY 时也是这个）；--json 输出原始数据
agentforge monitor --web           # 只读网页 http://127.0.0.1:18862（--port 修改端口）
```

监控按原样读取任务文件和设置：不会启动后台、创建数据目录或修改任务。没有后台响应时，进行中的任务标记 `*`，因为在后台响应前无法确定其真实状态。网页只接受本机 GET 请求。后台运行时自己也在 `http://127.0.0.1:18862` 提供同一个网页（`AGENTFORGE_MONITOR_PORT` 修改，`0` 关闭；端口被占用时只记日志），可以在 Cursor 内置浏览器里一直开着。

### 在 Cursor 里看单个任务

Cursor SDK 启动的 agent 不会出现在 Cursor 客户端的 agent 列表（Repositories）里，SDK 没有提供写入这个列表的接口。AgentForge 改为给每个任务维护一个进度页 `~/.agentforge/progress/<task_id>.md`：状态、耗时、改过的文件、最近 40 步（最新在上）、错误和 worker 报告，运行中最多每秒刷新一次。任务启动后后台用 `cursor --reuse-window` 在最近使用的 Cursor 窗口打开它，编辑器会随文件更新；`forge_dispatch` 也返回 `progress_file`。`AGENTFORGE_OPEN_PROGRESS=off` 不自动打开，设为其它命令或绝对路径则用那个编辑器。删除任务时进度页一并删除。

取消和暂停会在任务步骤里记下来源：看板、主会话的 `forge_cancel`，或终端 Ctrl+C。

## 不经 Claude Code 直接运行

```bash
agentforge run --cwd ~/repo --verify "npm test" "Fix the SAVE10 double discount and add a test"
echo "Rename the config loader" | agentforge run --cwd ~/repo --json > result.json
agentforge watch cf-20261023-abc123     # 在另一个终端跟踪任意任务（包括 Claude Code 派发的）
agentforge tasks | show <task_id>
```

`run` 实时输出 worker 的步骤，运行 `--verify` 并自动返工，最后打印报告、改动文件、验证结果、预算和 token 用量。任务完成（或带 `--verify` 时验收通过）退出码为 0，失败或被拒绝为 2，无法启动为 1，Ctrl-C 取消轮次为 130。`--json` 让 stdout 只输出结果 JSON，进度写到 stderr。全部选项见 `agentforge run --help`（`--model`、`--param`、`--mcp`、`--worker`、`--max-turns`、`--max-minutes` 等）。可运行的演示见 [`examples/`](../examples/README.md)。

## 更新与卸载

看板的 **Plugin update** 区，或 `agentforge update status|check|apply`，从 `origin` 更新本仓库。打开看板时每天最多检查一次（多个看板共享）；**Update to latest** 一键检查并安装，**Check for updates** 只检查；查看状态只读本地缓存。`origin` 必须是 `package.json` 中登记的仓库。

更新即快进当前分支，然后执行 `npm ci`、`npm run build` 并重装插件。只有已跟踪文件干净、分支可快进且没有运行中的任务时才执行；有本地改动、分叉、离线或任务忙碌时会阻止并说明原因。不会 stash、reset、强推，也不会动 SDD 文档等未跟踪文件。依赖安装或重装失败时，**Retry install** 从该步骤继续。从看板更新时，完成后后台会自动重启（有任务运行时等任务结束），之后运行 `/reload-plugins`。运行中的后台比仓库旧时（按 commit 比较，版本号不变的更新也能发现），看板会提供 **Restart backend**。

`agentforge uninstall [--claude <path>]` 移除插件和 marketplace；`~/.agentforge` 中的任务记录和设置保留。

## 已知限制

- worker 运行在共享后台中。关闭 Claude Code 会话不会停止它们；运行中停止或重启后台会打断，任务显示 `uncertain`，直到用 `forge_followup` 在同一个 Cursor agent 上续跑。
- 看板需要 Claude Code 的 function hooks（`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`，早期功能）。没有它时，工具、提示 Hook 和 `agentforge config` 仍可用。
- `verify_command` 由系统 shell 执行：macOS 是 `/bin/sh`，Windows 是 `cmd.exe`。需要跨平台时写成 `npm test`、`node ...` 这类两边都能跑的命令。
- Windows 上插件更新用 `npm install` 而不是 `npm ci`，因为后台已加载的原生模块会被系统锁定，无法删除 `node_modules`。
- Hook 说明是给 Claude Code 的建议，不是锁：开启自动派工时它仍可能自己回答问题或做很小的改动，关闭时你要求仍会派工。
- 同一 `cwd` 中并行的任务可能互相覆盖改动。`forge_dispatch` 会警告，但不会阻止。
- Cursor worker 以你的用户权限运行，请像对待 Cursor 的 agent 模式一样信任它。
- 启动 Cursor agent 通常需要 10-60 秒，挂载 MCP 服务器时曾需要数分钟。`forge_dispatch` 在 agent 启动后返回，`AGENTFORGE_START_TIMEOUT_SEC` 限制等待时长。
- 计费总量取决于 Cursor 账号；没有用量 API 的账号只显示 token 数。

## 开发与验证

```bash
npm test            # 使用假 worker 的单元测试
npm run dev         # tsc --watch
node dist/cli.js install && claude plugin test ~/.agentforge/marketplace/agentforge   # 看板面板测试
(cd plugin && npx -p typescript@5 tsc -p tsconfig.json)   # 看板类型检查；先把 claude-code.d.ts 复制到 plugin/.claude-plugin/types/claude-code/index.d.ts
```
