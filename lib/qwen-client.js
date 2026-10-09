/**
 * Qwen 调用客户端 —— 审查闸门的"第二意见"通道。
 *
 * 设计目标：让 agent 用最省事的方式拿到一份结构化评审意见。
 *   - 凭据优先读环境变量，其次读 DSH 凭据库（只读文件，不回显密钥）
 *   - 同时支持 OpenAI 兼容端点与阿里云原生多模态端点
 *   - 返回值是结构化对象，agent 不需要解析自由文本
 *
 * 作为库用：
 *   import { reviewWithQwen } from 'dsh-code-review-gate/qwen-client'
 *   const r = await reviewWithQwen({ stage: 'requirement', request, analysis })
 *
 * 作为命令行用（stdin 喂 JSON，stdout 出 JSON）：
 *   node lib/qwen-client.js < input.json
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.8-max';
const DEFAULT_CRED = 'QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY';

/** 凭据库可能出现的几个位置，按优先级探测。 */
function credentialCandidates() {
  const home = homedir();
  return [
    process.env.DSH_HOME ? join(process.env.DSH_HOME, '.credentials.yaml') : null,
    join(home, '.dsh', '.credentials.yaml'),
  ].filter((p) => p !== null);
}

/**
 * 从 DSH 凭据库里取出某个 ref 的值。
 * 只做按行解析，不引入 YAML 依赖；找不到就返回 undefined。
 */
function readCredentialRef(ref) {
  for (const path of credentialCandidates()) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === 'refs:');
    if (start < 0) continue;
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break;
      const m = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(\S+)\s*$/);
      if (m !== null && m[1] === ref) return m[2];
    }
  }
  return undefined;
}

/**
 * 解析本次调用要用的端点、模型与密钥。
 * @returns {{ base: string, model: string, key: string, ref: string | undefined, source: string }}
 */
export function resolveQwenConnection(config = {}) {
  const base = config.baseURL ?? process.env.REVIEW_GATE_QWEN_BASE ?? DEFAULT_BASE;
  const model = config.model ?? process.env.REVIEW_GATE_QWEN_MODEL ?? DEFAULT_MODEL;
  const ref = config.apiKeyEnv ?? process.env.REVIEW_GATE_QWEN_KEY_REF ?? DEFAULT_CRED;

  const fromEnv = process.env[ref] ?? process.env.DASHSCOPE_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return { base, model, key: fromEnv.trim(), ref, source: 'environment' };
  }
  const fromStore = readCredentialRef(ref);
  if (fromStore !== undefined && fromStore.length > 0) {
    return { base, model, key: fromStore, ref, source: `credential-store:${ref}` };
  }
  throw new Error(
    `审查闸门找不到千问凭据：环境变量 ${ref} / DASHSCOPE_API_KEY 都为空，凭据库里也没有 ${ref}。` +
      `请先在 DSH 设置里为 dashscope 或 token plan 路由填入密钥。`,
  );
}

/** 判断端点是否为 OpenAI 兼容形态（含 /compatible-mode 或 /v1 结尾）。 */
function isCompatibleEndpoint(base) {
  return /\/compatible-mode(\/v1)?$/.test(base) || /\/v1$/.test(base);
}

const STAGE_PROMPTS = {
  requirement: `你是一位资深工程师，正在对下属的任务分析做二次评审。你的职责是**阻止无意义的改动**，不是鼓励多干活。
请针对下面的「用户原始要求 + 我的任务分析」回答：
1. 这个需求真正要解决的问题是什么？有没有被误读？
2. 分析里有没有把简单问题复杂化的地方（过度设计、无谓重构、引入新依赖）？
3. 有没有遗漏的约束（现有代码习惯、最小改动面、可逆性）？
4. 如果必须向用户澄清，最多列 3 个最关键的问题；没有就留空数组。
只指出真正值得改的地方；没有问题的方面不要为了凑数而写。`,
  code: `你是一位资深工程师，正在评审刚写完的代码改动。请只关注真实缺陷：
- 逻辑错误、边界条件、资源泄漏、错误处理缺失
- 明显偏离用户要求的地方
- 过度设计：为了「更优雅」而增加抽象、参数、依赖
不要评论代码风格偏好，不要要求补充测试以外的额外工程设施。`,
  test: `你是一位资深工程师，正在评审一次验证/测试过程。请回答：
- 这次的验证是否真的能证明用户要求被满足？有没有自证式的假验证？
- 有没有更省事但同样有效的验证方式？
- 有没有被忽略的回归风险点？`,
};

/**
 * 让千问对一个阶段做评审。
 *
 * @param {object} input
 * @param {'requirement'|'code'|'test'} input.stage - 评审阶段
 * @param {string} input.request - 用户的原始要求
 * @param {string} [input.analysis] - 我方分析（requirement 阶段必填）
 * @param {string} [input.artifact] - 待评审的代码/测试记录（code、test 阶段）
 * @param {object} [config] - 端点覆盖 { baseURL, model, apiKeyEnv, timeoutMs }
 * @returns {Promise<{ verdict: string, findings: string[], questions: string[], raw: string, model: string, source: string }>}
 */
export async function reviewWithQwen(input, config = {}) {
  const stage = input.stage ?? 'requirement';
  const stagePrompt = STAGE_PROMPTS[stage];
  if (stagePrompt === undefined) {
    throw new Error(`未知评审阶段 "${stage}"，可选：${Object.keys(STAGE_PROMPTS).join(' / ')}`);
  }

  const { base, model, key, source } = resolveQwenConnection(config);
  const timeoutMs = config.timeoutMs ?? 180_000;

  const sections = [`## 用户的原始要求\n${input.request ?? '(未提供)'}`];
  if (typeof input.analysis === 'string' && input.analysis.trim().length > 0) {
    sections.push(`## 我的任务分析\n${input.analysis}`);
  }
  if (typeof input.artifact === 'string' && input.artifact.trim().length > 0) {
    sections.push(`## 待评审的产出\n\`\`\`\n${input.artifact}\n\`\`\``);
  }

  const userContent = `${stagePrompt}\n\n${sections.join('\n\n')}\n\n` +
    `请严格按下面的 JSON 结构回复，不要加任何解释性前后缀：\n` +
    `{"verdict":"一段总的判断（不超过 80 字）","findings":["每条一个具体问题"],"questions":["需要向用户澄清的问题"]}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text;
  try {
    text = await callQwen({ base, key, model, userContent, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseReviewJson(text);
  return { ...parsed, raw: text, model, source };
}

/** 按端点形态选择调用方式。 */
async function callQwen({ base, key, model, userContent, signal }) {
  if (isCompatibleEndpoint(base)) {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: userContent }] }),
      signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`千问调用失败 HTTP ${res.status}：${JSON.stringify(json).slice(0, 300)}`);
    }
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(`千问返回结构异常：${JSON.stringify(json).slice(0, 300)}`);
    }
    return content;
  }

  // 原生多模态端点（dashscope / token plan 都支持）
  const res = await fetch(`${base.replace(/\/$/, '')}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: { messages: [{ role: 'user', content: [{ text: userContent }] }] } }),
    signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`千问调用失败 HTTP ${res.status}：${JSON.stringify(json).slice(0, 300)}`);
  }
  const parts = json.output?.choices?.[0]?.message?.content ?? [];
  const joined = parts.map((p) => p.text ?? '').join('');
  if (joined.length === 0) {
    throw new Error(`千问返回结构异常：${JSON.stringify(json).slice(0, 300)}`);
  }
  return joined;
}

/** 宽容地解析模型回复里的 JSON；失败时把整段文本当作 verdict。 */
export function parseReviewJson(text) {
  const trimmed = String(text ?? '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], trimmed];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) continue;
    try {
      const obj = JSON.parse(candidate.trim());
      if (typeof obj === 'object' && obj !== null) {
        return {
          verdict: typeof obj.verdict === 'string' ? obj.verdict : '',
          findings: Array.isArray(obj.findings) ? obj.findings.filter((f) => typeof f === 'string') : [],
          questions: Array.isArray(obj.questions) ? obj.questions.filter((q) => typeof q === 'string') : [],
        };
      }
    } catch {
      // 试下一个候选
    }
  }
  return { verdict: trimmed.slice(0, 800), findings: [], questions: [] };
}

/** 把评审结果渲染成 agent 好读的短文本。 */
export function renderReview(review) {
  const lines = [`[千问评审 · ${review.model}] ${review.verdict}`];
  if (review.findings.length > 0) {
    lines.push('发现：');
    for (const f of review.findings) lines.push(`  - ${f}`);
  }
  if (review.questions.length > 0) {
    lines.push('待澄清：');
    for (const q of review.questions) lines.push(`  - ${q}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- CLI
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const rawInput = Buffer.concat(chunks).toString('utf8').trim();
  if (rawInput.length === 0) {
    console.error('用法: echo \'{"stage":"requirement","request":"...","analysis":"..."}\' | node lib/qwen-client.js');
    process.exit(2);
  }
  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch (error) {
    console.error(`stdin 不是合法 JSON：${error.message}`);
    process.exit(2);
  }
  try {
    const review = await reviewWithQwen(payload, payload.config ?? {});
    process.stdout.write(renderReview(review) + '\n');
  } catch (error) {
    console.error(`评审失败：${error.message}`);
    process.exit(1);
  }
}
