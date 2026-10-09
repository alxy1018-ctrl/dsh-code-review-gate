/**
 * dsh-code-review-gate —— 代码工程任务的评审闸门。
 *
 * 解决的具体问题：agent 收到涉及代码产出（或需要给出工程结论）的要求时，
 * 容易立刻动手写代码、顺手重构，堆出无意义的改动。
 *
 * 实现要点（踩过的坑，别改回去）：
 *   1. **零外部依赖**。插件装在 profile 里，Node 从插件目录向上找 node_modules，
 *      路径穿不进 app.asar，所以 `import '@deepseek-ai/cordis'` 之类一律解析失败
 *      （原版 ponytail 正是死在这里）。只用 node: 内置模块。
 *   2. **不用 Service / Schema**。第三方插件拿不到宿主包，就用普通对象 + apply(ctx)，
 *      配置直接从 ctx.config 读。
 *   3. **不 import 自己的 qwen-client**。它是给 agent 当命令行脚本用的（Node 直接跑，
 *      不经 DSH），插件进程里没必要加载；也避免任何跨文件解析风险。
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
2. 把《用户原始要求 + 你的分析》交给千问做第二次分析
   （加载 \`${SKILL_NAME}\` 技能，里面有确切的调用方式）。
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
5. 代码写完后，把**改动内容**交给千问复审；测试/验证完成后，把**验证方式与结论**再交给千问复审。
   有真实缺陷就改，纯风格偏好不改。
6. 评审完成后**自动接着干活**，不要停下来等用户确认。
   整条流程的默认结局是"东西做完了"，不是"我来问一下下一步做什么"。

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

/** 技能正文 —— 只在模型主动加载技能时进入上下文；路径与端点按实际配置生成。 */
function skillContent(model, base) {
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

## 三、第二步：取千问的第二意见

本插件自带客户端，路径已按安装位置算好：

\`\`\`powershell
$env:REVIEW_GATE_QWEN_MODEL = '${model}'
$env:REVIEW_GATE_QWEN_BASE  = '${base}'

$payload = @{
  stage    = 'requirement'
  request  = '用户的原始要求（原文，不要转述）'
  analysis = '你上一步写出的分析'
} | ConvertTo-Json -Compress

$payload | & '${nodeForClient()}' '${CLIENT_PATH}'
\`\`\`

（上面两行环境变量取的是本插件的当前配置；如果你改了配置，这里的值会跟着变。）

它会读 DSH 凭据库里的千问密钥，输出一段压缩过的评审：

\`\`\`
[千问评审 · ${model}] <总体判断>
发现：
  - <具体问题>
待澄清：
  - <需要问用户的问题>
\`\`\`

**阶段参数**：
- \`stage: 'requirement'\` —— 动手前评需求与分析
- \`stage: 'code'\` —— 代码写完后评改动（把 diff 或关键片段放进 \`artifact\`）
- \`stage: 'test'\` —— 验证完成后评验证方式与结论（放进 \`artifact\`）

**长度控制**：传给千问的 \`artifact\` 只放**关键片段**——改动的函数、diff 的 hunk、
要评审的那段逻辑。不要把整个文件或整份对话贴进去，那既慢又稀释重点。

**失败处理**：客户端报错（凭据缺失、网络不通）时**不要卡住**——照自己的分析继续干活，
最后用一句话告诉用户"本次未取得千问评审，原因是 X"。

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

代码写完、自测通过后，把改动交给千问做 \`stage: 'code'\` 评审。重点看：
逻辑错误、边界条件、错误处理、资源释放、是否偏离用户要求、是否引入了不必要的抽象。

有真实缺陷就修；修完不必再走一轮完整评审，除非修的是结构性问题。

## 七、第六步：验证后复审

跑完测试或验证后，用 \`stage: 'test'\` 评一次。要回答的是：
**这次的验证真的能证明要求被满足吗？** 常见的假验证：
- 只跑了编译没跑行为
- 用自己写的桩验证自己写的逻辑
- 覆盖的是 happy path，而用户的场景在边界上

验证结论也留在内部，只把「做了什么、结果如何」告诉用户。

## 八、多模块任务：并行开发 + 交叉检查

当任务能拆成**两个以上边界清晰、互不重叠**的模块时，用这个模式提速。

### 8.1 先判断值不值得

**值得**：模块之间有明确接口、各自可独立验证、合起来工作量明显大于沟通成本，
而且**大到值得起一个子代理**（它按多轮计费，比单次评审贵得多）。
**不值得**：改动集中在一两个文件、模块间耦合紧密、或者拆完还要来回对齐接口——
这种时候并行反而更慢。**能不拆就不拆**，拆错了比不拆糟。

### 8.2 拆分与分工

1. 在第二步评审之后，把任务切成 \`M1 / M2 / …\`，每个模块写清：
   - 边界：负责什么、**不负责什么**
   - 对外接口：函数签名、文件、数据格式（这是双方唯一的契约）
   - 验收：怎么单独验证这个模块
2. **接口先定死再开工**。接口没定就并行，等于制造两份不兼容的实现。
3. 我方先认领**难度高或风险大**的那个（接口定义方、核心算法），
   千问认领**边界清晰、模式化**的那个。理由：接口方先落地，另一边才好对齐。

### 8.3 两条写代码的路

**首选：派子代理写模块。** 子代理是一个完整的 agent——有文件读写、能跑命令、能自测自修，
它那一侧的循环不经过你，这才是真并行。

调用要点：

- 同时传 \`provider\` 与 \`model\`，路由取当前会话已授权的千问模型
  （通常是 \`qwen-token-plan-individual\` 配 \`qwen3.8-max\`）。
- **任务提示词必须自足**：子代理是全新上下文，看不到你的对话。把接口契约、
  模块边界、验收标准、要创建的文件路径全部写进提示词。
- **写清"你只负责这几个文件"**，见 8.3.1 的文件所有权。
- 用后台模式启动，然后**你继续做自己那个模块**，不要空等它。

**备选：子进程（文本产出，由你落盘）。** 适用于以下任一情况：

- 子代理调用被拒（收到 \`child model selection is disabled\` 之类的错误）
  —— 说明当前会话没有授权路由，**自动降级到这条路**，不要卡住，也不用问用户；
- 任务很小（单文件、几十行），起 agent 的开销不划算；
- 只需要一段独立函数或算法，不需要它碰其他文件。

降级时的调用方式（千问产出完整代码块，由你写入文件）：

\`\`\`powershell
$payload = @{
  stage    = 'requirement'
  request  = '整个任务的要求'
  analysis = @'
已定的接口契约：
  <逐条列出>
请实现模块 M2：<边界与验收>
产出完整的 <文件名>，不要解释，不要省略。
'@
} | ConvertTo-Json -Compress
$payload | & '<node>' '<client>'
\`\`\`

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

### 8.4 交叉检查

两边都写完后，互相检查对方的模块。

**我查它写的（子代理模式下的重点变了）**：它已经真的动过磁盘了，所以不能只看它嘴上说"做完了"。
必须**读它实际写出的文件**，逐条核对：

1. 文件路径与约定的所有权清单一致吗？有没有越界改了别人的文件？
2. 接口实现与契约是否严格一致（函数签名、参数顺序、返回结构、错误约定）？
3. 边界条件与错误处理是否实现，还是只写了 happy path？
4. 有没有偷偷引入契约外的依赖或全局状态？

**它查我写的**：把我写的模块作为 \`artifact\` 发 \`stage: 'code'\` 评审，
重点核对**接口实现是否与契约一致**。

**如果走的是子进程降级路线**：它写的代码是你落的盘，所以"查它写的"依旧是读那段代码，
但要额外问自己一句：**我落盘时有没有抄错？** 那是降级路线特有的一种错误来源。

发现问题就改，改完再对一次契约。**不要跳过契约核对直接测**——
接口不一致时测试失败的原因会被误判成逻辑错误，白折腾。

### 8.5 合并与验证

1. 先做**接口级验证**：两边都编译/加载通过，签名对得上。
2. 再做**集成验证**：跑真实用例。这时候才用 \`stage: 'test'\` 找千问评一次。
3. 如果集成失败，**先分清是谁的模块的问题**再动手改，不要两边一起乱改。

### 8.6 别把并行用成负担

- 模块数**两个够了**，三个以上沟通成本会吃掉收益。
- **子代理比子进程贵一个数量级**：它多轮 + 工具调用，每轮重建上下文。
  只在你确实需要"它自己写、自己测"时才用它；单纯要一段算法或一次评审，别起 agent。
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

  // 千问端点与模型：配置 → 环境变量 → 内置默认（与 qwen-client.js 保持一致）
  const qwenModel = (typeof config.qwenModel === 'string' && config.qwenModel.trim().length > 0)
    ? config.qwenModel.trim()
    : (process.env.REVIEW_GATE_QWEN_MODEL?.trim() || DEFAULT_QWEN_MODEL);
  const qwenBase = (typeof config.qwenBaseURL === 'string' && config.qwenBaseURL.trim().length > 0)
    ? config.qwenBaseURL.trim()
    : (process.env.REVIEW_GATE_QWEN_BASE?.trim() || DEFAULT_QWEN_BASE);
  // 让插件进程自己与它 spawn 的客户端用同一套端点，避免技能正文与实际行为不一致
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

  // 1) 全局层策略注入：主代理与子代理都能收到。
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      const agent = context?.agent;
      if (agent === undefined) return '';
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
              text: `评审闸门：当前 ${agent === undefined ? effectiveDefault() : modeFor(agent)}　默认 ${effectiveDefault()}`,
            };
          }
          if (!MODES.includes(arg)) {
            return { kind: 'error', text: `未知模式 "${arg}"，可用 code / always / off / status` };
          }
          if (agent === undefined) return { kind: 'error', text: '当前没有可绑定模式的会话' };
          sessionModes.set(agent.session.id, arg);
          return {
            kind: 'success',
            text: arg === 'off'
              ? '评审闸门已关闭：本会话后续要求直接执行。'
              : `评审闸门已设为 ${arg}（${arg === 'always' ? '一律先评审' : '仅代码产出类要求评审'}）。`,
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
          content: skillContent(qwenModel, qwenBase),
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
