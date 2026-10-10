/**
 * dsh-code-review-gate —— 代码工程任务的评审闸门。
 *
 * 解决的具体问题：agent 收到涉及代码产出（或需要给出工程结论）的要求时，
 * 容易立刻动手写代码、顺手重构，堆出无意义的改动。
 *
 * 评审通道（2026-10-10 改）：**所有问千问的动作都派子代理**（subagent + provider/model），
 * 不再走命令行脚本。旧路子是把 JSON 从 stdin 喂给 qwen-client.js，180 秒硬超时、失败只能整段重发，
 * 又慢又费 token。脚本保留但退出评审流程，只作凭据/网络诊断。
 * 子代理会继承本策略段，所以策略里必须写明"被派出去的子代理不再适用本闸门"，否则递归。
 *
 * 实现要点（踩过的坑，别改回去）：
 *   1. **零外部依赖**。插件装在 profile 里，Node 从插件目录向上找 node_modules，
 *      路径穿不进 app.asar，所以 `import '@deepseek-ai/cordis'` 之类一律解析失败
 *      （原版 ponytail 正是死在这里）。只用 node: 内置模块。
 *   2. **不用 Service / Schema**。第三方插件拿不到宿主包，就用普通对象 + apply(ctx)，
 *      配置直接从 ctx.config 读。
 *   3. **不 import 自己的 qwen-client**。它是给 agent 或人手动跑的命令行脚本
 *      （Node 直接跑，不经 DSH），评审已不走它；插件进程里更没必要加载，
 *      也避免任何跨文件解析风险。
 *
 * 强制手段说明：用"常驻指令 + 可选命令"而不是硬拦工具调用。硬拦在没有明确编码任务时
 * 会产生大量误报，而误报会让人直接关掉整个闸门。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

export const name = 'code-review-gate';

const MODES = ['always', 'code', 'off'];
const DEFAULT_MODE = 'code';
const SECTION_NAME = 'review-gate:policy';
/** 工具引导带是 100–199；紧跟在 tool:bash(105) 之后。 */
const SECTION_ORDER = 108;
const SKILL_NAME = 'code-review-gate';

/** 千问端点与模型的默认值（必须与 lib/qwen-client.js 里的默认一致）。 */
const DEFAULT_QWEN_BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const DEFAULT_QWEN_MODEL = 'qwen3.8-max';
/** 子代理路由的 provider id：评审与写模块都按它派千问子代理。 */
const DEFAULT_QWEN_PROVIDER = 'qwen-token-plan-individual';

/** 本包安装位置，用于在技能正文里给出客户端脚本的绝对路径。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_PATH = join(PACKAGE_ROOT, 'lib', 'qwen-client.js');

/** 评审闸门策略正文：每轮注入，必须短且可执行；细则放技能里按需加载。 */
const POLICY_TEXT = `## 代码工程评审闸门（review gate）

**触发条件**：用户的要求会导致**代码产出或工程结论**——写/改代码、新增功能、重构、设计接口、
写脚本或配置、排查 bug 并给出修复方案。此时**先评审，再动手**。

**不触发**（直接执行，不要评审）：回答问题、查资料、看文件、日常文件编辑（改错别字、调格式、
改文档措辞）、运行命令看结果。

**触发后的固定流程**：
1. **不动手、不写任何代码**。先把任务拆开：用户真正要解决的问题、验收标准、
   改动面、必须保持不变的既有约定。
2. 把《用户原始要求 + 你的分析》交给千问做第二次评审——**派千问子代理**
   （\`subagent\` 工具，\`provider\` 与 \`model\` 必须同时给；任务提示词模板与输出格式见技能
   \`${SKILL_NAME}\` 第三节）。**不要用命令行脚本当评审通道。**
3. 拿到千问意见后**合并**：采纳合理的、驳回不适用的，形成最终方案。
   评审结果留在内部，不要贴给用户。
4. **分流：有疑问就停下来问清楚，没有就一路干到底。**
   - **停下来问**（必须问，用一句话，不要展开成问卷）：
     需求本身有歧义、验收标准无法确定、千问与我方判断冲突且影响最终结果、
     需要用户拍板取舍（例如要不要动某个对外接口、能不能加依赖）、
     发现用户的要求本身可能是多余的改动。
   - **不要问，直接干**：方案已经清晰、只是你自己想再确认一遍；
     想征求风格偏好；想汇报进度；想确认"我这样理解对不对"但你已经相当确定。
     这些都属于**为了确认而确认**，是打扰。
   - 判据一句话：**问，是因为答案会改变你接下来做的事；不是因为你想让别人放心。**
5. 代码写完后，把**改动内容**交给千问子代理复审；测试/验证完成后，把**验证方式与结论**再交给
   千问子代理复审。有真实缺陷就改，纯风格偏好不改。
6. 评审完成后**自动接着干活**，不要停下来等用户确认。
   整条流程的默认结局是"东西做完了"，不是"我来问一下下一步做什么"。

**大活并行**：requirement 评审里双方一致认为这是过得了成本阈值、值得拆的大活时，按技能第八节：
先冻结接口契约，再与千问子代理**同时开工**写不同模块。交叉检查不变——你写的它查，它写的你查。

**闸门只对根会话注入**：子代理收不到这段——它们派不出子代理（宿主默认 depth 1），
让它们跑一遍评审只会白跑。
万一你作为子代理还是看到了它：本闸门不适用于你，**不要再派子代理做评审**，
评审意见由你直接给出，你写的模块由派你的主代理交叉检查。

**判定"明显的小错误"**：拼写错误、语法错误、明显的变量名笔误——直接改，不用评审。
但"顺手把这段重构一下""顺便优化下结构"**不属于**小错误，必须走评审流程。

**边界**：评审是为了少干活、干对活，不是为了多写文档。
分析后发现用户的要求本身就是多余的改动（例如已有等价实现）时，直接说出来并给出最小方案，
而不是照着做。`;

/**
 * 运行客户端脚本的 node。
 *
 * 移植性要求：换机器、换平台都要能找到。
 * 解析顺序：环境变量 → DSH 自带运行时的常见位置（含 Windows 与非 Windows 布局）
 *          → 裸 `node`（依赖 PATH）。
 *
 * 注意：早期版本把 Windows 路径和 `.exe` 写死过，换台电脑就失效——别再改回去。
 */
function nodeForClient() {
  const fromEnv = process.env.DSH_DESKTOP_NODE_EXECUTABLE;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();

  const home = process.env.DSH_HOME
    ?? (process.platform === 'win32'
      ? join(process.env.USERPROFILE ?? '', '.dsh')
      : join(process.env.HOME ?? '', '.dsh'));

  const isWin = process.platform === 'win32';
  const exe = isWin ? 'node.exe' : 'node';
  const candidates = [
    join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', exe),
    join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', exe),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // 环境变量里可能有 PATH 之外的位置；最后退回裸 node 交给 PATH 解析
  const pathHint = process.env.DSH_NODE_PATH;
  if (typeof pathHint === 'string' && pathHint.trim().length > 0) return pathHint.trim();
  return 'node';
}

/**
 * 取一个会插进技能正文的配置值：配置 → 环境变量 → 内置默认。
 *
 * 这些值会被插进技能正文，其中一条还是 PowerShell 单引号里的实参——值里混进引号、
 * 反引号或空白，生成出来的就是坏文本 / 坏命令，而且**不报错**，很难查。
 * 所以这类值一律拒绝、退回默认并告警（provider id、模型名、URL 本来也不该含这些字符）。
 */
function pickRouteValue(configured, fromEnv, fallback, label, logger) {
  for (const candidate of [configured, fromEnv]) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim();
    if (value.length === 0) continue;
    if (/['`\s]/.test(value)) {
      logger?.warn?.('code-review-gate: 配置项 %s 含引号/反引号/空白，已忽略并退回默认值 %s', label, fallback);
      continue;
    }
    return value;
  }
  return fallback;
}

/** 技能正文 —— 只在模型主动加载技能时进入上下文；路由、端口与脚本路径按实际配置生成。 */
function skillContent(provider, model, base) {
  return `# 代码评审闸门 · 操作细则

这个技能配合每轮注入的「代码工程评审闸门」策略使用。策略给纪律，这里给做法。

## 一、判断是否触发

触发：会导致**代码产出或工程结论**的要求。
- 写新代码、加功能、改行为
- 重构、拆模块、改接口
- 写脚本、配置文件、构建/部署脚本
- 排查 bug 并给出修复

不触发：纯问答、查资料、读代码看结构、日常文件编辑（错别字/格式/文档措辞）、只跑命令看输出。

判不准时按**触发**处理，并在分析里用一句话说明退出的理由。

## 二、第一步：分析（不写代码）

在动任何文件之前，写出一段分析，包含：

1. **真正的问题**：用户要解决什么，而不是他字面说了什么。
2. **验收标准**：怎么算做完了、怎么验证。
3. **改动面**：预计动哪几个文件、哪些函数；能不能更小。
4. **既有约定**：这个仓库/工作区里已有的模式、命名、依赖，必须沿用而不是另起一套。
5. **不确定项**：哪些地方有歧义、需要用户澄清。

分析要短。五行能说清就不要写二十行。

## 三、第二步：取千问的第二评审（强制子代理）

**所有问千问的动作都派子代理**，不再用 \`node lib/qwen-client.js\` 子进程。
子进程那条路是「JSON 从 stdin 喂进去 → 180 秒硬超时 → 失败整段重发」，又慢又费 token；
子代理是真正的子对话，提示词自包含，失败也不必重发整段。

### 3.1 调用要点

- 工具：\`subagent\`；\`provider\` 与 \`model\` **必须同时给** —— \`${provider}\` / \`${model}\`。
- **提示词必须自足**：子代理是全新上下文，看不到你的对话。把 §3.2 的模板整段写进去，
  不要写成"按我们刚才说的评审一下"。
- 用后台模式启动（\`run_in_background: true\`）也行，只要在继续动手前拿到它的回复。
- **长度控制**：只给文件路径、关键 hunk、以及你要它判断的点。不要贴整个文件、整份对话，
  也不要让它通读仓库——那既慢又稀释重点。
- 子代理自己能读文件，所以"路径 + 判断点"通常比"贴一大段代码"更好用。

### 3.2 三段模板

三个阶段问法不同，其余相同。模板之后附上要评审的东西——
requirement 阶段是「## 用户的原始要求」原文加上「## 我的分析」，code 阶段是 diff 或关键 hunk，
test 阶段是「做了什么、结果如何」。

**requirement（动手前）**

\`\`\`
你是资深工程师，正在对下属的任务分析做二次评审。你的职责是阻止无意义的改动，不是鼓励多干活。
针对下面的「用户原始要求 + 我的分析」回答：
1. 这个需求真正要解决的问题是什么？有没有被误读？
2. 分析里有没有把简单问题复杂化（过度设计、无谓重构、引入新依赖）？
3. 有没有遗漏的约束（现有代码习惯、最小改动面、可逆性）？
4. 这活该不该拆成多个模块并行写？该拆就说清模块边界与接口契约；只是一两个文件的改动，直说"不必拆"。
最多列 3 个最关键、需要向用户澄清的问题；没有就留空。
只指出真正值得改的地方，没问题的方面不要凑数。
\`\`\`

**code（代码写完后）**

\`\`\`
你是资深工程师，正在评审刚写完的代码改动。只关注真实缺陷：
- 逻辑错误、边界条件、资源泄漏、错误处理缺失
- 明显偏离用户要求的地方
- 过度设计：为了"更优雅"而增加抽象、参数、依赖
不要评论代码风格偏好，不要要求补测试以外的额外工程设施。
你可以自己读这些文件：<路径清单>
\`\`\`

**test（验证完成后）**

\`\`\`
你是资深工程师，正在评审一次验证/测试过程。请回答：
- 这次的验证是否真的能证明用户要求被满足？有没有自证式的假验证？
- 有没有更省事但同样有效的验证方式？
- 有没有被忽略的回归风险点？
\`\`\`

### 3.3 输出格式

要求子代理严格按这个格式回复，你才好合并（不要让它返回 JSON，也不要加前后缀）：

\`\`\`
[千问评审 · <一句话总体判断>]
发现：
  - <具体问题>
待澄清：
  - <需要向用户澄清的问题>
\`\`\`

### 3.4 拿不到评审怎么办

- 子代理报 \`child model selection is disabled\` → **本会话没授权千问子代理路由**。
  **不要退回命令行脚本**：一句话告诉用户"本次未取得千问评审，原因是会话未授权子代理路由"，
  然后按自己的分析继续干。
- 不确定路由是否可用：\`list_subagent_models\` 里能看到 \`${provider}\`，就说明这条路由存在。
- 其他失败（端点报错、超时）：**不要原样重发整段载荷**——那正是过去浪费的来源；
  要么把载荷缩到最小重试一次，要么说明原因后继续。
- 想确认凭据/网络本身通不通（**不是评审通道**，只回答"通不通"）：

\`\`\`powershell
$env:REVIEW_GATE_QWEN_MODEL = '${model}'
$env:REVIEW_GATE_QWEN_BASE  = '${base}'
'{"stage":"requirement","request":"测试","analysis":"测试分析"}' | & '${nodeForClient()}' '${CLIENT_PATH}'
\`\`\`

## 四、第三步：合并意见，然后决定要不要打扰用户

千问给的是**参考**，不是命令。逐条判断：

- **采纳**：指出了真实缺陷、误读、过度设计 → 改方案。
- **驳回**：不了解本仓库约定、提的是纯风格偏好、要求增加用不上的工程设施 → 内部记一句理由，不改。
- **冲突**：它的判断和你的相反且**影响最终结果** → 这时才值得问用户。

评审结论**不要贴给用户看**。用户要的是结果，不是我们内部的讨论记录。

### 4.1 只有这几种情况才停下来问

- 需求本身有歧义，不同理解会做出不同的东西
- 验收标准无法确定（不知道什么算"做对了"）
- 千问与我方判断冲突，且这个分歧**会改变最终结果**
- 需要用户拍板取舍：要不要动对外接口、能不能加依赖、要不要牺牲兼容性
- 分析后发现用户的要求本身可能是多余的改动

问的时候**一句话说清问题和选项**，不要展开成问卷，也不要顺带汇报进度。

### 4.2 这些**不要**问，直接继续

- 方案已经清晰，只是想再确认一遍理解对不对
- 想征求命名、目录结构、代码风格之类的主观偏好
- 想汇报"我已经分析完了，准备开始"——没人要求这个
- 想问"需要我继续吗"——需要，继续就是默认答案

判据一句话：**问，是因为答案会改变你接下来做的事；不是因为你想让别人放心。**

这条规则的默认结局是**把东西做完**。停下来问是例外，不是流程的一部分。

## 五、第四步：执行

方案定了就动手。执行期间不需要反复评审——只有**方案发生实质变化**时才回去再评一次
（例如实现中发现要动接口、要加依赖、要改超出原计划的数据结构）。

## 六、第五步：代码完成后复审

代码写完、自测通过后，用 §3.2 的 code 模板派千问子代理评一次。重点看：
逻辑错误、边界条件、错误处理、资源释放、是否偏离用户要求、是否引入了不必要的抽象。

有真实缺陷就修；修完不必再走一轮完整评审，除非修的是结构性问题。

## 七、第六步：验证后复审

跑完测试或验证后，用 §3.2 的 test 模板派子代理评一次。要回答的是：
**这次的验证真的能证明要求被满足吗？** 常见的假验证：
- 只跑了编译没跑行为
- 用自己写的桩验证自己写的逻辑
- 覆盖的是 happy path，而用户的场景在边界上

验证结论也留在内部，只把「做了什么、结果如何」告诉用户。

## 八、多模块任务：并行开发 + 交叉检查

只有**过得了成本阈值**、而且**双方一致认为该拆**时，才走这一节。否则一路串行写完。

### 8.1 两道闸门，缺一不可

1. **值不值得**（成本这道关由我方把关）：模块之间有明确接口、各自可独立验证、
   合起来的工作量明显大于沟通成本，而且**大到值得起一个子代理**（它按多轮计费，
   比一次脚本评审贵得多）。不值得：改动集中在一两个文件、模块间耦合紧密、
   或者拆完还要来回对齐接口——**能不拆就不拆**，拆错了比不拆糟。
2. **双方一致**：requirement 评审里已经明确问过千问"这活该不该拆、边界怎么切"
   （§3.2 模板第 4 问）。它给出切法、**我方也认可** → 才拆。

**千问说要拆、我方判断过不了成本阈值 → 不拆**，并在分析里写明理由。
评审方天然倾向于展示分析深度，成本这一关必须由我方守住。

### 8.2 拆分与分工

1. 把任务切成 \`M1 / M2 / …\`，每个模块写清：
   - 边界：负责什么、**不负责什么**
   - 对外接口：函数签名、文件、数据格式（这是双方唯一的契约）
   - 验收：怎么单独验证这个模块
2. **契约在开工前冻结**：写进契约文件，或原样写进两边的任务提示词。
   契约没冻结就同时开工，等于制造两份不兼容的实现。
3. 我方认领**难度高或风险大**的那个（接口定义方、核心算法），
   千问认领**边界清晰、模式化**的那个。
4. 契约冻结之后**两边同时开工**，不要再等谁先落地。

### 8.3 写模块的路：只有子代理一条

派千问子代理写模块：\`subagent\` 工具，\`provider\` / \`model\` 与 §3.1 相同。

- **任务提示词必须自足**：子代理是全新上下文，看不到你的对话。把接口契约、模块边界、
  验收标准、要创建的文件路径全部写进提示词。
- **写清"你只负责这几个文件"**，见 8.3.1 的文件所有权。
- 用后台模式启动，然后**你继续做自己那个模块**，不要空等它。
- 子代理**收不到闸门策略段**（闸门只对根会话注入），所以它不会自己再走一遍评审——
  它的产出由你按 §8.4 交叉检查。
- **子代理跑完就结束了，叫不回来**（它不是常驻队友）：要它改自己刚写的模块，
  只能重新派一个，并把契约、文件路径、失败现象再写一遍——所以提示词一开始就要写全。
- 路由不可用时（\`child model selection is disabled\`）：**放弃并行，自己串行写完**，
  一句话告诉用户，**不要退回命令行脚本**。
- 任务很小（单文件、几十行）就别起子代理——自己写完更快，并行是给大活儿用的。

### 8.3.1 文件所有权（两个写手同时干活时的硬纪律）

**一个文件在同一时间只能有一个写手。** 这是并行开发最容易翻车的地方——
两个写手改同一个文件，后写的覆盖先写的，而且往往到集成时才发现。

开工前列出清单：

\`\`\`
文件                 写手
m1/xxx.c             我方
m2/yyy.c             子代理
include/contract.h   我方（接口定义方独占，见 8.2）
tests/               集成阶段由我方统一生成
\`\`\`

**共享的接口文件由接口定义方独占。** 子代理需要新接口时，让它通过消息告诉你，
由你改契约——**不要让它自己动契约文件**，否则两边对契约的理解会悄悄分叉。

### 8.4 交叉检查（要求不变）

两边都写完后，互相检查对方的模块。

**我查它写的**：它真的动过磁盘，不能只看它嘴上说"做完了"。必须**读它实际写出的文件**，逐条核对：

1. 文件路径与约定的所有权清单一致吗？有没有越界改了别人的文件？
2. 接口实现与契约是否严格一致（函数签名、参数顺序、返回结构、错误约定）？
3. 边界条件与错误处理是否实现，还是只写了 happy path？
4. 有没有偷偷引入契约外的依赖或全局状态？

**它查我写的**：派一个千问子代理（§3.2 的 code 模板），把契约与文件路径写进提示词，
让它核对**我写的模块与契约是否一致**。

发现问题就改，改完再对一次契约。**不要跳过契约核对直接测**——
接口不一致时测试失败的原因会被误判成逻辑错误，白折腾。

### 8.5 合并与验证

1. 先做**接口级验证**：两边都编译/加载通过，签名对得上。
2. 再做**集成验证**：跑真实用例。这时候才用 §3.2 的 test 模板派子代理评一次。
3. 如果集成失败，**先分清是谁的模块的问题**再动手改，不要两边一起乱改。

### 8.6 别把并行用成负担

- 模块数**两个够了**，三个以上沟通成本会吃掉收益。
- **子代理比单次脚本调用贵一个数量级**：它多轮 + 工具调用，每轮重建上下文。
  只在确实需要"它自己写、自己测"时才用它；单纯要一段算法，别起 agent。
- 千问的产出要**当成外部代码审**，不要因为它"是 AI 写的"就放松检查；
  子代理模式下它真动过磁盘，更要核实际文件而不是它的自述。
- 任务小就老老实实自己写完——并行是给大活儿用的。

## 九、明显的小错误

**可以直接改、不用评审**：拼写错误、语法错误、明显的笔误（变量名/函数名拼错、少个分号、
明显的字符替换错误）。

**不属于小错误**（必须走评审）：命名风格调整、"顺手"重构、抽取公共函数、
补类型标注、调整文件结构、引入格式化工具。

判据：**改完之后功能与结构不变**的，是小错误；**会改变结构或影响面**的，不是。
`;
}

/**
 * 插件入口。
 *
 * 三个踩过的坑，别改回去：
 *   - `inject` 必须是**导出对象上的属性**。Cordis 在构造 ctx 访问器时要先看到这个声明，
 *     否则访问 ctx.systemPrompt 直接抛 "cannot get property ... without inject"。
 *     只用局部的 ctx.inject([...], cb) 不够。
 *   - `name` 也要在导出对象上。
 *   - 插件名必须能按**包名**解析。绝对路径（D:\...）会被 ESM 当作协议而失败；
 *     要用 `dsh plugin --profile <p> add link:<dir>` 装成包，再由 bundle 栈引入。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {object} config - 来自 profile patch 的配置
 */
export function apply(ctx, config = {}) {
  const defaultMode = MODES.includes(config.defaultMode) ? config.defaultMode : DEFAULT_MODE;
  const wantSkill = config.registerSkill !== false;
  const wantCommand = config.registerCommand !== false;
  /** 每个会话的运行时模式覆盖（进程内，不写会话日志）。 */
  const sessionModes = new Map();

  // 千问路由：配置 → 环境变量 → 内置默认（模型与端点必须与 qwen-client.js 保持一致）
  const qwenProvider = pickRouteValue(config.qwenProvider, process.env.REVIEW_GATE_QWEN_PROVIDER, DEFAULT_QWEN_PROVIDER, 'qwenProvider', ctx.logger);
  const qwenModel = pickRouteValue(config.qwenModel, process.env.REVIEW_GATE_QWEN_MODEL, DEFAULT_QWEN_MODEL, 'qwenModel', ctx.logger);
  const qwenBase = pickRouteValue(config.qwenBaseURL, process.env.REVIEW_GATE_QWEN_BASE, DEFAULT_QWEN_BASE, 'qwenBaseURL', ctx.logger);
  // 技能正文里那条排查命令会 spawn 客户端脚本，让它俩用同一套端点，避免正文与实际行为不一致
  process.env.REVIEW_GATE_QWEN_MODEL = qwenModel;
  process.env.REVIEW_GATE_QWEN_BASE = qwenBase;

  const effectiveDefault = () => {
    const fromEnv = process.env.REVIEW_GATE_MODE;
    if (typeof fromEnv === 'string' && MODES.includes(fromEnv.trim().toLowerCase())) {
      return fromEnv.trim().toLowerCase();
    }
    return defaultMode;
  };

  /** 某 agent 的模式：自身覆盖 → 最近祖先覆盖 → 默认。 */
  const modeFor = (agent) => {
    const seen = new Set();
    let current = agent;
    while (current !== undefined && current !== null) {
      const id = current.session?.id;
      if (id === undefined || seen.has(id)) break;
      seen.add(id);
      const stored = sessionModes.get(id);
      if (stored !== undefined) return stored;
      const parentId = current.session?.header?.parentSession;
      if (parentId === undefined) break;
      current = ctx.agents?.get?.(parentId);
    }
    return effectiveDefault();
  };

  /**
   * 是不是"根会话"（用户直接开的那个）。
   *
   * 闸门**只对根会话注入**。原来的坑：子代理会连策略段一起继承，于是千问写模块时可能自己
   * 再派一个子代理做评审——评审的评审，无限套娃，比旧方案还费。
   *
   * 判据沿用 `modeFor()` 已经在用的那条路径 `agent.session.header`（宿主那边就是 SessionHeader，
   * asar 里的接口定义含 `parentSession` / `origin: 'subagent'` / `delegationDepth`）。
   * 本机 60+ 会话实测：子代理一律 `origin="subagent"` + 有 `parentSession` + `delegationDepth=1`，
   * 用户直接开的会话三者都没有，边界很干净。
   *
   * 读不到 header 时按**根会话**处理：宁可闸门多生效，也不要因为字段路径变了就把所有会话的
   * 闸门静默关掉（那种故障没有任何提示）。
   */
  let warnedMissingHeader = false;
  const isRootSession = (agent) => {
    const header = agent?.session?.header;
    if (header === undefined) {
      // 只在第一次告警：这个回调每步都会跑，形状真变了会刷屏。
      if (!warnedMissingHeader) {
        warnedMissingHeader = true;
        ctx.logger?.warn?.(
          'code-review-gate: 读不到 session.header，本轮按"根会话"处理。' +
            '若宿主改了字段路径，子代理会重新收到策略段（套娃风险），请核对 lib/index.js 的 isRootSession。',
        );
      }
      return true;
    }
    return header.parentSession === undefined && header.origin !== 'subagent';
  };

  /**
   * 命令回执里补一句"这个会话到底生不生效"。
   * 子会话里 modeFor() 仍会沿着父链报出一个继承来的模式，但闸门根本不注入——
   * 不回这句话，`/review-gate status` 就是在撒谎。
   */
  const childNote = (agent) => (agent !== undefined && !isRootSession(agent))
    ? '（本会话是子会话，闸门不注入——避免套娃）'
    : '';

  // 1) 全局层策略注入：**只对根会话**（子代理套娃，见 isRootSession）。
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      const agent = context?.agent;
      if (agent === undefined) return '';
      if (!isRootSession(agent)) return '';
      return modeFor(agent) === 'off' ? '' : POLICY_TEXT;
    },
  });

  // 2) /review-gate 命令（宿主提供服务时才注册）。
  if (wantCommand) {
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'review-gate',
        description: '切换代码评审闸门强度（code/always/off）或查看当前状态',
        input: { hint: '[code|always|off|status]' },
        handler: ({ agent, rawInput }) => {
          const arg = String(rawInput ?? '').trim().toLowerCase();
          if (arg === '' || arg === 'status') {
            return {
              kind: 'success',
              text: `评审闸门：当前 ${agent === undefined ? effectiveDefault() : modeFor(agent)}　默认 ${effectiveDefault()}${childNote(agent)}`,
            };
          }
          if (!MODES.includes(arg)) {
            return { kind: 'error', text: `未知模式 "${arg}"，可用 code / always / off / status` };
          }
          if (agent === undefined) return { kind: 'error', text: '当前没有可绑定模式的会话' };
          sessionModes.set(agent.session.id, arg);
          return {
            kind: 'success',
            text: (arg === 'off'
              ? '评审闸门已关闭：本会话后续要求直接执行。'
              : `评审闸门已设为 ${arg}（${arg === 'always' ? '一律先评审' : '仅代码产出类要求评审'}）。`) + childNote(agent),
          };
        },
      });
    });
  }

  // 3) 技能注册：细则按需加载，不占用每轮上下文。
  if (wantSkill) {
    ctx.inject(['skills'], (skillsCtx) => {
      try {
        skillsCtx.skills.register({
          name: SKILL_NAME,
          description:
            '代码工程任务的评审流程细则：如何做需求分析、如何调用千问做二次评审、' +
            '代码与测试完成后如何复审。当用户的要求会导致代码产出或工程结论时使用。',
          source: 'runtime',
          content: skillContent(qwenProvider, qwenModel, qwenBase),
        });
      } catch (error) {
        ctx.logger?.warn?.('code-review-gate: 技能注册失败 %o', error);
      }
    });
  }

  ctx.logger?.info?.('code-review-gate: 已挂载（默认模式 %s）', effectiveDefault());
}

export default {
  name,
  /** Cordis 要先看到这个声明才允许访问对应服务。 */
  inject: ['systemPrompt', 'agents'],
  apply,
};
