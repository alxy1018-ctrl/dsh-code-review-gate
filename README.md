# dsh-code-review-gate

DSH 的**代码工程评审闸门**：收到会导致代码产出或工程结论的要求时，先分析、再把分析交给
**千问子代理**做第二次评审，然后才动手；代码与验证完成后各复审一次。日常问答与文件编辑不触发。

这是三层结构，缺一层就不成立：

| 层 | 承担什么 | 为什么必须在这一层 |
|---|---|---|
| **插件常驻段** | 纪律与闸门：先评审再动手、小错可直接改、评审内部完成、评审完自动继续 | 只有 systemPrompt 常驻段是**每轮、每个根会话**都注入的（子代理不注入，见「强度与开关」）。技能永远需要先有一次"决定加载"的动作，而这条规则的核心恰恰是"在我还没意识到时也生效" |
| **技能** | 评审的具体做法：三段提问模板、调用方式、合并意见、并行模块、交叉检查 | 细则每轮全量注入会占上下文；放技能里按需加载 |
| **千问子代理** | 真正发起第二意见调用；并行开发时写另一个模块 | 子代理是完整 agent——有文件读写、能跑命令、能自测自修，提示词自包含，失败不必重发整段载荷。旧的命令行脚本 `lib/qwen-client.js` **已退出评审流程**，只留作凭据/网络的诊断工具 |

**2026-10-10 起：所有问千问的动作都走子代理，不走脚本。** 脚本那条路是
「JSON 从 stdin 喂进去 → 180 秒硬超时 → 失败整段重发」，实测经常超时无响应，
重试既费时间又费 token。

## 安装

### 从 GitHub（当前可用）

```powershell
dsh plugin --profile desktop add github:alxy1018-ctrl/dsh-code-review-gate
```

插件管理器识别 `github:` / `git+` / `git@` 等来源。

> ⚠️ **这条路要求 `git` 已经装好，而且 DSH 是在装完 git 之后启动的。**
> 详见下面的[换新电脑后的恢复清单](#换新电脑后的恢复清单)——那里有一个会让整个安装失败的坑。

### 从 npm（尚未发布）

```powershell
dsh plugin --profile desktop add dsh-code-review-gate
```

包名 `dsh-code-review-gate` 在 npm 上**目前还空着，尚未发布**。等发布之后这条命令可用，
好处是不依赖 `git`、命令更短。在那之前请用上面的 GitHub 方式。

### 从本地目录（开发时）

```powershell
dsh plugin --profile desktop add 'link:D:\Code\dsh-code-review-gate'
```

⚠️ `link:` **不会**自动写进 `bundles` 数组（npm 源和 tarball 安装会），
但包内的 `dsh.bundle.patch` + 已列在 `dependencies` 也足以挂载。

### 依赖

- **DSH** 0.2.0-rc.2 或更高（peer：`@deepseek-ai/cordis` ^4.0.1）
- **一个千问模型路由**：Provider ID `qwen-token-plan-individual`、端点
  `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，并填好 API Key
- **授权千问子代理路由**（设置 → 插件 → 子智能体）：**必做**。评审与并行写模块全走子代理，
  没授权会报 `child model selection is disabled`，本会话就拿不到评审
- **node**（只给诊断脚本用）：优先用 DSH 自带运行时；找不到则退回 PATH 里的 `node`

### 换新电脑后的恢复清单

**顺序不能变。** 第 2、3 步是实测踩出来的，跳过的结果是安装失败，而且报错信息会把你引向错误的方向。

| 步骤 | 命令 / 操作 | 为什么 |
|---|---|---|
| 1. 装 DSH | 正常安装客户端 | — |
| 2. **装 git** | `winget install --id Git.Git --exact`，或从官网下安装包 | 从 GitHub 装插件要 `git ls-remote`，没它装不了 |
| 3. **重启 DSH 客户端** | 完全退出再打开 | ⚠️ **关键**：DSH 进程的环境变量在启动时固定。git 安装器把路径写进**机器级 PATH**，但**已经在跑的 DSH 看不到**，于是它 spawn 的 `git` 找不到 |
| 4. 装插件 | `dsh plugin --profile desktop add github:alxy1018-ctrl/dsh-code-review-gate` | 装依赖 + 自动登记 bundle 栈 |
| 5. 加千问模型路由 | 设置 → 模型 → 添加模型提供商：Provider ID 用 `qwen-token-plan-individual`，端点 `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，协议选 OpenAI Chat Completions | 子代理路由与诊断脚本都按这个 ID 找端点 |
| 6. 填 API Key | 同一张卡片里填入千问 token plan 的 Key | 写进凭据库；配置文件里不留密钥 |
| 7. **授权子代理路由** | 设置 → 插件 → 子智能体 → 授权千问的模型 | ⚠️ **必做**：评审现在全走子代理，没授权就拿不到评审（报 `child model selection is disabled`） |
| 8. 开新会话 | — | 策略段与技能在新会话里生效 |

#### 第 3 步为什么不能省（以及那个骗人的报错）

不重启 DSH 直接跑第 4 步，你会看到：

```
[ERROR] Command failed with exit code 1:
        git ls-remote "https://github.com/.../dsh-code-review-gate.git" HEAD
        'git' 不是内部或外部命令，也不是可运行的程序
```

而 DSH 自己给出的总结性提示是这样的：

```
dsh: git-hosted plugins build on install via their prepare script, which pnpm
     blocks until allowed — add the exact key pnpm printed above under allowBuilds
```

**这条提示是错的**，跟 `allowBuilds` 毫无关系。真实原因只有一个：**DSH 进程的 PATH 里没有 git**。
去改 `pnpm-workspace.yaml` 只会白费功夫。**重启 DSH 即可解决。**

> 如果重启后仍然报同样的错，手动确认 git 可见：
> ```powershell
> Get-Command git        # 应输出 C:\Program Files\Git\cmd\git.exe
> ```
> 若查不到，说明 git 安装没写 PATH，手动加 `C:\Program Files\Git\cmd` 后再重启 DSH。

#### 第 4 步的两个陷阱

**陷阱一：不要用 `pnpm add` 代替 `dsh plugin add`。**
底层 `pnpm add` 只装依赖，**不会把包登记进 profile 的 `bundles` 栈**，结果是：文件全在、依赖也列了，
但**插件静默不加载**——技能目录里没有它，而且**不报任何错**。官方命令会做"装依赖 + 登记 bundle"两步。

**陷阱二：验证安装是否真的成功。**
不要只看命令退出码。装完检查 profile 的 `bundles` 数组里有没有这个包：

```powershell
(Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles
```

应该看到 `dsh-code-review-gate` 在里面。没有就说明没登记成功。

#### 装完自检

**评审主路径是子代理**，所以先确认子代理路由已授权：在会话里看一眼 `list_subagent_models`，
能看到 `qwen-token-plan-individual` 就说明路由在。真正确认要走一次——让 agent 按技能 §三
派一次评审，没授权会明确报 `child model selection is disabled`。

`lib/qwen-client.js` 保留了一个更底层的检查（**诊断用，不是评审通道**）。
把 `<插件目录>` 换成实际安装位置（通常是
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-code-review-gate`）：

```powershell
$payload = '{"stage":"requirement","request":"测试","analysis":"测试分析"}'
$payload | & "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
              "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-code-review-gate\lib\qwen-client.js"
```

打印出 `[千问评审 · …]` 说明**凭据解析 + 网络 + 端点**这条链路通了。
如果报 `找不到千问凭据`，回到第 6 步确认 Key 填了。
注意：这只证明诊断通道通，**不证明评审通道通**——评审通道是子代理路由。

### 生效方式

| 改了什么 | 怎么生效 |
|---|---|
| `POLICY_TEXT`（策略段） | 改文件后**重启客户端**（插件本体不重载） |
| 技能正文（`skillContent()`） | 同样要**重启客户端**——它在 `apply()` 里一次性生成并注册 |
| 插件配置（provider/模型/端点/模式） | 随上面两条 |

> ⚠️ **2026-10-10 实测**：改完文件后新开的会话里，注入的仍是**旧**策略段；同一进程里 11:20 派出的
> 子代理收到的也是旧文本。所以"技能内容开新会话就生效"这条旧说法**不成立**，
> 改完文件一律**重启客户端**，再用新会话确认。

## 配置项

写在 profile patch 里：

```yaml
- id: code-review-gate
  name: 'dsh-code-review-gate'
  config:
    defaultMode: code                                          # code | always | off
    qwenProvider: qwen-token-plan-individual                   # 子代理路由的 provider id
    qwenModel: qwen3.8-max                                     # 换 qwen3.8-flash 省额度
    qwenBaseURL: https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1   # 只影响诊断脚本
    registerSkill: true
    registerCommand: true
```

`qwenProvider` 与 `qwenModel` 会写进技能正文——技能里给出的 `subagent` 调用参数就是你配的这一对，
不会出现"配置改了但技能里还是老默认值"的错位。
**`qwenBaseURL` 只影响诊断脚本**（评审走宿主的模型路由配置，不读这个端点）。

环境变量也能覆盖这三个值：`REVIEW_GATE_QWEN_PROVIDER` / `REVIEW_GATE_QWEN_MODEL` /
`REVIEW_GATE_QWEN_BASE`（优先级：配置 > 环境变量 > 内置默认）。
三个值里含引号、反引号或空白的会被**拒绝并退回默认**，同时记一条 warn——
它们会被插进技能正文（其中一条还是 PowerShell 命令），坏值生成的是坏文本，而且不报错。


## 强度与开关

| 模式 | 行为 |
|---|---|
| `code`（默认） | 只对代码产出/工程结论类要求评审；问答、日常改文件直接执行 |
| `always` | 一律先评审 |
| `off` | 关闭 |

切换方式（三选一）：

- 会话内命令：`/review-gate code|always|off|status`
- 环境变量：`REVIEW_GATE_MODE=off`
- profile patch 里的插件配置：`config.defaultMode`

命令切换是**每会话**的进程内状态，不写会话日志，重启后回到默认。

### 闸门对谁生效：只对根会话

**子代理收不到策略段**。判据是 `agent.session.header.parentSession` 有值、或 `origin === 'subagent'`。

原因（**2026-10-10 重启后实测修正过**）：子代理会连策略段一起继承。但"无限套娃"其实到不了第二层——
宿主默认 `maxDepth = 1`，子代理再派子代理会被直接拒（探针子代理实测报
`subagent depth 2 exceeds maxDepth 1`）。真实代价是另外两条：

- 子代理会白跑一遍**它做不到的**评审（分析完了才发现派不出评审员）；
- 每个子代理每轮都多背约 1.3 KB 的策略段。

而 `maxDepth` 是**用户可调的设置**（`subagents` 运行时的 `maxDepth`）。一旦调大，
"闸门只对根会话"就从省 token 变成**防套娃的硬需求**。

**重启后的活体验证**：根会话的系统提示里有新策略段；同一次派出的子代理，系统提示里
`代码工程评审闸门` / `review gate` **一个字都没有**，而人味宪法等其他段落仍在——
说明是精准摘除，不是整体失效。

本机 60+ 会话实测边界很干净：子代理一律 `origin="subagent"` + 有 `parentSession` + `delegationDepth=1`，
用户直接开的会话三者都没有。

判据能被信任，是因为两条都对着宿主实现核过（读的 `app.asar`，不是猜的）：

- **`context.agent` 就是"正在装配的那个 agent"**。宿主调的是
  `systemPrompt.assemble(assembleContextFor(agent, signal))`，而 `assembleContextFor` 的实现是
  `return { agent, scope: agent, ... }`——把当前 agent 原样放进去。所以子代理装配时判的是它自己。
- **`session.header` 的形状**：宿主的 `SessionHeader` 接口里就声明了 `parentSession` / `origin` / `delegationDepth`。

读不到 `header` 时按**根会话**处理，并**告警一次**（只一次：这个回调每步都会跑）——
宁可多注入，也不要因为宿主改了字段路径，就把所有会话的闸门静默关掉、或者让套娃悄悄复发。
`/review-gate status` 与设置模式在子会话里会补一句"本会话是子会话，闸门不注入"，
免得显示一个实际不生效的模式。
（根会话侧已实测：输出 `评审闸门：当前 code　默认 code`，**不带**那句提示；
子会话侧那句话只有桩测试覆盖——斜杠命令得人手敲，进不去子会话。）

**维护提示**：哪天发现子代理又收到了策略段，先查 `isRootSession()` 里那两个字段名
（宿主升级可能改 `SessionHeader` 的形状）；运行时那条 warn 会直接指到这里。

两个要知道的边界：

- **Agent Teams 的队友会话**：宿主代码里 `origin` 只有 `"subagent"` 一个取值，队友会话如果也是
  被派生的（带 `parentSession`），同样不带闸门——这是"只对主会话生效"的直接后果。
  **这条还没实测**，第一次真用队友时留意一眼。
- **技能本身是全局注册的**（`skills.register` 在插件加载时只跑一次），没法按会话隐藏：
  实测子代理那边**既拿得到 `skill` 工具、也能加载这个技能**（探针加载成功）。所以策略段里那句
  "你是子代理就不要派评审"仍然保留，作为第二道防线；技能 §8.3 里也写明"子代理收不到策略段、
  它的产出由主代理交叉检查"。

## 千问通道

**评审主路径：千问子代理。** 技能正文里给出的调用方式是 `subagent` 工具配
`provider: qwen-token-plan-individual` + `model: qwen3.8-max`（两个都可在配置里改）。
凭据由宿主的模型提供商配置解析，插件自己不碰密钥。

**前置条件**：子代理路由必须授权（设置 → 插件 → 子智能体 → 授权千问的模型）。
未授权时报 `child model selection is disabled`，此时闸门**不降级回脚本**：
按纪律继续干，并一句话告知用户本会话没拿到评审。

**诊断通道（不是评审通道）**：`lib/qwen-client.js` 保留下来只为回答"凭据 / 网络 / 端点通不通"。
它的凭据解析顺序：

1. 环境变量 `REVIEW_GATE_QWEN_KEY_REF` 指名的变量 → 否则 `QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY`
2. `DASHSCOPE_API_KEY`
3. DSH 凭据库 `~/.dsh/.credentials.yaml` 的 `refs` 段（只读、不回显）

端点默认 `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，模型默认 `qwen3.8-max`。
可用 `REVIEW_GATE_QWEN_BASE` / `REVIEW_GATE_QWEN_MODEL` 覆盖。

诊断调用形态：

```powershell
$payload = @{
  stage    = 'requirement'   # requirement | code | test
  request  = '用户原始要求'
  analysis = '我的分析'
} | ConvertTo-Json -Compress
$payload | & '<node.exe>' '<包目录>\lib\qwen-client.js'
```

## 开发踩坑记录（别重复踩）

### 1. 插件必须零外部依赖

第三方插件装在 profile 里，Node 从插件目录向上找 `node_modules`，
**路径穿不进 `app.asar`**。所以：

```js
import { Service } from '@deepseek-ai/cordis';   // ❌ ERR_MODULE_NOT_FOUND
import { readFileSync } from 'node:fs';          // ✅ 只用内置模块
```

上游 `dsh-ponytail` 正是死在这一点上（它的 `settingsNamespace` 导入直接让模块加载失败）。
对照：能正常工作的 `dsh-whale-widget` 只 import `node:` 内置模块。

### 2. `inject` 必须挂在导出对象上

```js
export default { name, inject: ['systemPrompt', 'agents'], apply };   // ✅
export function apply(ctx) { ctx.systemPrompt.section(...) }          // ❌ 抛错
```

只用局部的 `ctx.inject([...], cb)` 不够——Cordis 在构造 ctx 访问器时就要看到声明，否则：

```
Error: cannot get property "systemPrompt" without inject
```

### 3. 插件名必须能按**包名**解析

Cordis 的加载器本质是裸 ESM：`await import(name)`。
绝对路径 `D:\Code\xxx` 在 ESM 里会被当成协议 `d:`，必然失败——**即使这个插件零依赖什么都不做**。
所以必须：

```powershell
dsh plugin --profile <名> add 'link:<目录>'   # 装成包名，由 bundle 栈引入
```

`link:` 安装**不会**自动写进 `bundles` 数组（npm 源安装会），需要手动补一行；
但包内 `dsh.bundle.patch` 声明 + 已列在 `dependencies` 也能被挂载。

### 4. Electron 的 exe 当 node 用时有坑

- `electron.exe script.mjs` 走 ESM 时 `fs.readFileSync('x.asar')` 会被 Electron 的 asar 拦截层劫持，
  想读 asar 要么用 `process._linkedBinding('electron_common_asar')`，要么先把文件复制成非 `.asar` 后缀。
- **GUI 子系统程序通过管道喂 stdin 读不到数据**。`echo '{}' | & 'DeepSeek Harness.exe' script.js` 会静默退出 0。
  要跑读 stdin 的脚本，用真 node：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`。

### 4.1 用 DSH 的 shell 去启动别的 Electron 应用会静默失败

**症状**：启动命令退出码 0、没有任何输出，目标应用（GitHub Desktop、VS Code 之类）窗口不出现。

**原因**：DSH 的 shell 环境里带着 `ELECTRON_RUN_AS_NODE=1`（宿主用它跑 Node 脚本）。
这个变量会**让任何 Electron 应用把自己当成命令行 node**——于是它一启动就"干完活退出"，退出码 0。

**解决**：启动前先清掉这个变量。

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process "$env:LOCALAPPDATA\GitHubDesktop\GitHubDesktop.exe"
```

**为什么值得记**：它失败得**完全不报错**，很容易被误判成"程序装坏了"或"找不到快捷方式"。

### 5. 沙箱与 ACL

在受限模式下 spawn 子进程去跑 `qwen-client.js`（诊断通道）可能被 ACL 挡住。
**评审主路径不受影响**——子代理不经过本机子进程。
闸门对"拿不到评审"有统一的降级设计：**继续干，并告知用户原因**，不卡住流程。
若诊断命令频繁被挡，检查该脚本所在目录的 Windows 文件权限（见 `diagnose-windows-sandbox-acl` 技能）。

## 设计变更记录

### 2026-10-10：评审改成强制子代理；并行分工改为双方一致

**改了什么**：

1. **所有问千问的动作都走子代理**（`subagent` + provider/model）：三处评审
   （requirement / code / test）与 §8.3 的写模块全部走这条路。`lib/qwen-client.js`
   退出评审流程，降为凭据/网络的诊断工具；旧技能里的 `stage` 参数、`artifact` 打包、
   "子进程降级"整条路一并删除。
2. **§8 改成两道闸门**：拆分要同时满足"值不值得"（成本，我方把关）**且**"双方一致"
   （requirement 评审里明确问过千问该不该拆、边界怎么切）。千问说要拆、我方判断过不了
   成本阈值 → 不拆。契约冻结之后两边**同时开工**，交叉检查要求不变。
3. **防递归（当天补的第二版）**：先在策略段里加了一句自然语言约束，当天又改成**机制**——
   闸门只对根会话注入，子代理根本收不到策略段（`always` 模式下也不注入）。
   判据用 `agent.session.header.parentSession` / `origin === 'subagent'`，本机 60+ 会话实测边界干净，
   并对着宿主实现核过"装配上下文里的 `agent` 就是当前 agent"。
   策略段里那句自然语言约束保留，作为第二道防线。
   **重启后实测**：根会话有新策略段、子代理一个字段都没有；但套娃其实到不了第二层——
   宿主默认 `maxDepth = 1`（可配），子代理派子代理会被直接拒。这条改动的即时收益是
   子代理不再白跑 + 每轮省约 1.3 KB；`maxDepth` 一旦调大，它就是防套娃的硬需求。

**为什么改**：脚本那条路是「JSON 从 stdin 喂进去 → 180 秒硬超时 → 失败整段重发」，
实测经常超时无响应，agent 只能再请求一次，时间和 token 都白费。子代理是真的子对话：
提示词自包含、能自己读文件、失败不必重发整段载荷。

**实测依据（本机 2026-10-10）**：派 qwen 子代理后，会话记录里 `subagent/descriptor` 写着
`agentProvider: qwen-token-plan-individual` / `agentModel: qwen3.8-max`，
`subagent/model-selection-policy` 的 `allowedModels` 就是那三个千问模型——本会话子代理路由
**已授权**。同一份记录还显示子代理拿到了完整的策略段，这正是递归风险的来源。
**并行演练**也在同一天跑通：两个小模块冻结契约后同时开工，各写各的文件，互相核对，
集成验收 3/3 通过（见「已知未完成」）。

**生效方式**：`POLICY_TEXT` 与技能正文都在插件加载时定稿——改完**重启客户端**，
再用新会话确认（见「生效方式」一节里的实测记录）。

### 2026-10-09：并行写代码改为子代理优先

> ⚠️ **此条已被 2026-10-10 的改动覆盖**：①子进程降级路线已整条删除；
> ②"技能内容开新会话即生效"被实测推翻（见「生效方式」）。
> 保留在此只为记录当时的判断，不要照它执行。

**改了什么**：技能 8.3 从"千问产出代码块、我方落盘"改为**"派子代理写模块"为首选**，
子进程降级为备选（子代理被拒、任务很小、或只需一段独立函数时用）。8.4 的交叉检查
随之改为**核对子代理实际写出的文件**，而不是审一段文本。

**为什么改**：原来那版把"当前做不到"固化成了"设计如此"。子进程是纯文本通道，
它写的代码必须由我方落盘、跑测试、把错误贴回去——**那是并行起草、串行落地**，不是真并行。
子代理是完整 agent，有文件读写与命令执行，它那一侧的循环不经过主代理。

**新增的配套纪律**：

- **8.3.1 文件所有权**：一个文件同一时间只能有一个写手。共享接口文件由接口定义方独占，
  子代理需要新接口时通过消息提出、由主代理改契约——防止两边对契约的理解悄悄分叉。
- **8.6 成本提醒**：子代理按多轮计费，比单次评审贵一个数量级，只在该用时用。

**生效方式**：技能内容在插件加载时读入，**开新会话即生效，不需要重启客户端**。
（这次验证过：新会话里 8.3 标题已是「两条写代码的路」。）

### 2026-10-09：澄清闸门收敛

**改了什么**：策略段第 4 条从"方案清晰就直接开工，有歧义才澄清"改为明确的**分流规则**：

- **停下来问**：需求有歧义、验收标准无法确定、千问与我方判断冲突且影响结果、
  需要用户拍板取舍、发现要求本身可能多余。
- **不要问，直接干**：只想再确认一遍理解、想征求风格偏好、想汇报进度、
  想问"需要我继续吗"——这些属于**为了确认而确认**。

判据一句话：**问，是因为答案会改变你接下来做的事；不是因为你想让别人放心。**

技能第四节同步加了 4.1/4.2 两小节，保持策略段与细则一致。

## 已知未完成

- **"派子代理写模块 + 交叉检查"只跑过一次演练，没有真实项目规模的案例**。2026-10-10 用两个
  小模块（M1 `slug.mjs` / M2 `run.mjs`）走完整流程：冻结契约 → 两边同时开工 → 各写各的文件 →
  互相核对（我方读它实际写出的文件逐条对契约，它方用**另一个**子代理审我的模块）→ 集成验收
  3/3 通过，文件所有权没有越界（只有约定的三个文件，我的 `m1/slug.mjs` 时间戳没被动过）。
  真实活儿比演练复杂得多，第一次真用时留意两点：子代理是否收到
  `child model selection is disabled`（说明该会话没授权路由），以及文件所有权有没有被越界。
- **子代理是一次性的**：跑完就结束，`send_message` 叫不回来（它不是常驻队友，本机实测报
  `active teammate not found`）。要它改自己刚写的模块，只能重新派一个，把契约、文件路径与
  失败现象再写一遍——技能 §8.3 已写明。
- **`qwen-client.js` 现在没有自动调用方了**：只有人工、或技能 §3.4 的排查步骤会用它。
  留着是为了在"评审总是拿不到"时分清是凭据/网络的问题还是路由授权的问题。
  哪天确认不再需要，连同 `package.json` 的 `exports` 与 README 对应小节一起删。

