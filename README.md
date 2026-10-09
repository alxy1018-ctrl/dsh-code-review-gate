# dsh-code-review-gate

DSH 的**代码工程评审闸门**：收到会导致代码产出或工程结论的要求时，先分析、再取千问第二意见，
然后才动手；代码与验证完成后各复审一次。日常问答与文件编辑不触发。

这是三层结构，缺一层就不成立：

| 层 | 承担什么 | 为什么必须在这一层 |
|---|---|---|
| **插件常驻段** | 纪律与闸门：先评审再动手、小错可直接改、评审内部完成、评审完自动继续 | 只有 systemPrompt 常驻段是**每轮、每个会话**都注入的。技能永远需要先有一次"决定加载"的动作，而这条规则的核心恰恰是"在我还没意识到时也生效" |
| **技能** | 评审的具体做法：提问模板、调用命令、合并意见、并行模块、交叉检查 | 细则每轮全量注入会占上下文；放技能里按需加载 |
| **千问客户端** | 真正发起第二意见调用 | 插件进程内不便发 HTTP + 管凭据；脚本形态还能被 agent 直接调用 |

## 安装

### 从 npm（推荐，换机器最省事）

```powershell
dsh plugin --profile desktop add dsh-code-review-gate
```

一条命令完成：装包 + 自动写进 profile 的 `bundles` 栈。**开新会话即生效**，不用重启客户端。

### 从 GitHub

```powershell
dsh plugin --profile desktop add github:REPLACE_WITH_YOUR_GITHUB_USERNAME/dsh-code-review-gate
```

插件管理器识别 `github:` / `git+` / `git@` 等来源；这条路需要机器上有 `git`。

### 从本地目录（开发时）

```powershell
dsh plugin --profile desktop add 'link:D:\Code\dsh-code-review-gate'
```

⚠️ `link:` **不会**自动写进 `bundles` 数组（npm 源和 tarball 安装会），
但包内的 `dsh.bundle.patch` + 已列在 `dependencies` 也足以挂载。

### 依赖

- **DSH** 0.2.0-rc.2 或更高（peer：`@deepseek-ai/cordis` ^4.0.1）
- **一个千问凭据**：环境变量、`DASHSCOPE_API_KEY`，或 DSH 凭据库里的
  `QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY`（客户端按这个顺序解析）
- **node**：优先用 DSH 自带运行时；找不到则退回 PATH 里的 `node`

### 换新电脑后的恢复清单

| 步骤 | 命令 / 操作 |
|---|---|
| 1. 装 DSH | 正常安装客户端 |
| 2. 装插件 | `dsh plugin --profile desktop add dsh-code-review-gate` |
| 3. 配千问凭据 | 设置 → 模型 → 给 `dashscope` 或 token plan 路由填 Key（界面写入凭据库，配置文件里不留密钥） |
| 4. 配模型路由（可选，用于子代理并行） | 设置 → 插件 → 子智能体 → 授权千问的模型路由 |
| 5. 开新会话 | 策略段与技能在这个新会话里自动生效 |

第 3 步之后可以先自检：

```powershell
$payload = '{"stage":"requirement","request":"测试","analysis":"测试分析"}' 
$payload | & '<DSH自带node>' '<插件目录>\lib\qwen-client.js'
```

打印出 `[千问评审 · …]` 就说明通道通了。

### 生效方式

| 改了什么 | 怎么生效 |
|---|---|
| `POLICY_TEXT`（策略段） | 改文件后**重启客户端**（插件本体不重载） |
| 技能内容 | **开新会话**即可（技能在插件加载时读入，新会话会重新加载） |
| 插件配置（模型/端点/模式） | 随上面两条 |

## 配置项

写在 profile patch 里：

```yaml
- id: code-review-gate
  name: 'dsh-code-review-gate'
  config:
    defaultMode: code                                          # code | always | off
    qwenModel: qwen3.8-flash                                   # 换便宜模型省额度
    qwenBaseURL: https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
    registerSkill: true
    registerCommand: true
```

配置值会同步进环境变量，所以**技能正文里给出的调用命令带的就是你配的模型与端点**，
不会出现"配置改了但技能里还是老默认值"的错位。


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

## 千问通道

客户端 `lib/qwen-client.js` 的凭据解析顺序：

1. 环境变量 `REVIEW_GATE_QWEN_KEY_REF` 指名的变量 → 否则 `QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY`
2. `DASHSCOPE_API_KEY`
3. DSH 凭据库 `~/.dsh/.credentials.yaml` 的 `refs` 段（只读，不回显）

端点默认 `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，模型默认 `qwen3.8-max`。
可用 `REVIEW_GATE_QWEN_BASE` / `REVIEW_GATE_QWEN_MODEL` 覆盖。

调用形态（技能里给出的就是这条）：

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

### 5. 沙箱与 ACL

在受限模式下，插件里 spawn 子进程去跑 `qwen-client.js` 可能被 ACL 挡住
（现象是 agent 自述"千问客户端被 ACL 阻塞，改用自身分析"）。
闸门对此有降级设计：**评审拿不到就继续干，并告知用户原因**，不卡住流程。
若频繁发生，检查该脚本所在目录的 Windows 文件权限（见 `diagnose-windows-sandbox-acl` 技能）。

## 设计变更记录

### 2026-10-09：并行写代码改为子代理优先

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

- **子代理并行这条路本身还没端到端验证过**：改动已生效（新会话会照它执行），
  但"派子代理写模块 + 交叉检查"这一整套流程尚无真实案例跑通。第一次用的时候要留意
  子代理是否收到了 `child model selection is disabled`——那说明该会话没有授权路由，
  按 8.3 的备选路径降级即可。

