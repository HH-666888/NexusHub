/**
 * DeepSeek 适配器
 * ============================================================
 * ModelPort 的真实实现。内核只认识 ModelPort 接口，
 * 换供应商只需另写一个这个文件。
 *
 * 本文件里每一个「看起来多余的判断」，都对应一次真实的踩坑或官方文档的明确限制：
 *
 *   ① 思考 token 计入输出预算
 *      实测：max_tokens 设为 20 时，模型把预算全花在思考上，
 *      content 返回空串、finish_reason 为 "length"。
 *      → 必须给出足够的默认预算，并把「被截断」显式标记出来。
 *
 *   ② 思考模式下 temperature 不生效
 *      官方文档明确：设置不会报错，但也不会生效。
 *      → 与其假装设置了，不如只在关闭思考时才传，并在这里写清楚。
 *
 *   ③ 关闭思考会连带减少输入 token
 *      实测：同一问题，开启思考输入 36 tokens，关闭思考只要 10 tokens ——
 *      服务端在开启思考时会自动注入一段思考引导提示词。
 *
 *   ④ 缓存命中的输入价格是未命中的 1/50
 *      → 用量字段必须区分 cache_hit 与 cache_miss，否则成本会算错一个量级。
 */

import { env } from "@/config/env";
import { computeCost } from "./pricing";
import type {
  ModelChunk,
  ModelEffort,
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelResult,
  ModelTier,
  TokenUsage,
} from "@/core/ports/model";

/** 默认输出预算。给足余量，避免思考 token 把预算吃光 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/** 单次调用超时（毫秒）。构建任务可能很慢，给到 5 分钟 */
const TIMEOUT_MS = 300_000;

/**
 * 各档位的默认思考投入。
 *
 *   decide     —— 架构决策、方案裁决、复杂归因，必须深思
 *   execute    —— 写码改码，默认强度
 *   mechanical —— 重命名、样板代码、格式化，关掉思考
 *                 省时间（实测快 42%）也省钱（思考 token 按输出价计费）
 */
const DEFAULT_EFFORT: Record<ModelTier, ModelEffort> = {
  decide: "high",
  execute: "high",
  mechanical: "none",
};

/**
 * 模型接入点
 * ============================================================
 * 默认取自平台自己的环境变量；用户配置了自定义接入时，这一组值被替换掉。
 *
 * 为什么做成参数而不是让适配器直接读全局配置：
 *   适配器因此保持**无状态** —— 同一个进程里可以同时存在多个
 *   指向不同服务商的实例，互不干扰。将来要做「按运行选择模型」时，
 *   不用去改这里的任何一行。
 */
export interface ModelEndpoint {
  baseUrl: string;
  apiKey: string;
  decideModel: string;
  executeModel: string;
}

/** 平台自己的接入点（来自 .env.local），也是所有人的默认值 */
export function platformEndpoint(): ModelEndpoint {
  return {
    baseUrl: env.model.baseUrl,
    apiKey: env.model.apiKey,
    decideModel: env.model.decideModel,
    executeModel: env.model.executeModel,
  };
}

/**
 * 档位 → 模型名。
 * 注意这是「职责切分」而不是「挑便宜的用」：
 * 机械档位用的是同一个模型，只是把思考关掉 —— 因为那类活儿不需要思考。
 */
function modelForTier(tier: ModelTier, endpoint: ModelEndpoint): string {
  return tier === "decide" ? endpoint.decideModel : endpoint.executeModel;
}

/* ============================================================
   请求体构造
   ============================================================ */

interface ApiContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface ApiMessage {
  role: string;
  content: string | ApiContentPart[];
}

function toApiMessage(m: ModelMessage): ApiMessage {
  if (typeof m.content === "string") {
    return { role: m.role, content: m.content };
  }
  return {
    role: m.role,
    content: m.content.map((p): ApiContentPart => {
      if (p.type === "text") return { type: "text", text: p.text };
      return {
        type: "image_url",
        image_url: { url: `data:${p.mimeType};base64,${p.dataBase64}` },
      };
    }),
  };
}

function buildBody(
  req: ModelRequest,
  endpoint: ModelEndpoint,
  stream: boolean,
): Record<string, unknown> {
  const effort = req.effort ?? DEFAULT_EFFORT[req.tier];

  const body: Record<string, unknown> = {
    model: modelForTier(req.tier, endpoint),
    messages: req.messages.map(toApiMessage),
    max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    stream,
  };

  if (stream) {
    // 流式模式下用量只在最后一个数据块里给出，必须显式索取
    body.stream_options = { include_usage: true };
  }

  if (effort === "none") {
    body.thinking = { type: "disabled" };
    // 只有关闭思考时 temperature 才有效（文档明确：思考模式下设置不报错也不生效）
    if (req.temperature !== undefined) body.temperature = req.temperature;
  } else {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = effort;
  }

  if (req.responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }

  return body;
}

/* ============================================================
   响应解析
   ============================================================ */

interface ApiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

interface ApiChoice {
  message?: { content?: string | null; reasoning_content?: string | null };
  delta?: { content?: string | null; reasoning_content?: string | null };
  finish_reason?: string | null;
}

interface ApiResponse {
  model?: string;
  choices?: ApiChoice[];
  usage?: ApiUsage;
  error?: { message?: string; type?: string; code?: string };
}

function extractUsage(u: ApiUsage | undefined): TokenUsage {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    // 思考 token 不单独计费 —— 它已经包含在 outputTokens 里（官方计费口径是输入+输出总量）
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
    cacheHitTokens: u?.prompt_cache_hit_tokens ?? 0,
    cacheMissTokens: u?.prompt_cache_miss_tokens ?? 0,
  };
}

/** 把 HTTP 层的失败翻译成能直接照做的中文提示 */
async function describeFailure(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as ApiResponse;
    detail = body.error?.message ?? "";
  } catch {
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      detail = "";
    }
  }

  const hint =
    res.status === 401
      ? "密钥无效或已过期，请检查 .env.local 里的 DEEPSEEK_API_KEY"
      : res.status === 402
        ? "账户余额不足，请到 DeepSeek 开放平台充值"
        : res.status === 429
          ? "触发限速，稍后重试即可"
          : res.status >= 500
            ? "供应商服务异常，属于环境类故障，不应归因到代码或模型"
            : "";

  return `模型调用失败（HTTP ${res.status}）${detail ? `：${detail}` : ""}${
    hint ? `\n处理建议：${hint}` : ""
  }`;
}

function assertConfigured(endpoint: ModelEndpoint) {
  if (!endpoint.apiKey) {
    throw new Error(
      "缺少模型密钥。请复制 源码/.env.example 为 源码/.env.local 并填入 DEEPSEEK_API_KEY，" +
        "或到「设置 → 模型接入」里配置自己的密钥。",
    );
  }
}

/* ============================================================
   端口实现
   ============================================================ */

async function complete(
  req: ModelRequest,
  endpoint: ModelEndpoint,
): Promise<ModelResult> {
  assertConfigured(endpoint);
  const started = Date.now();
  const body = buildBody(req, endpoint, false);

  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(await describeFailure(res));

  const data = (await res.json()) as ApiResponse;
  const latencyMs = Date.now() - started;
  const choice = data.choices?.[0];
  const usage = extractUsage(data.usage);
  const model = data.model ?? modelForTier(req.tier, endpoint);
  const finishReason = choice?.finish_reason ?? "unknown";
  const cost = computeCost(model, usage);

  return {
    text: choice?.message?.content ?? "",
    reasoning: choice?.message?.reasoning_content ?? "",
    usage,
    costCny: cost.costCny,
    priceTier: cost.tier,
    model,
    latencyMs,
    truncated: finishReason === "length",
    finishReason,
  };
}

/**
 * 流式调用：逐块产出正文与思考过程，最后给一次完整结果。
 *
 * 流式的价值不只是「打字机效果」——
 * 它是「AI 思考可视化」的数据来源：用户在还没出结果时就能看到模型在想什么，
 * 这对我们这套「把过程完全摊开给用户看」的产品定位是必需的。
 */
async function* stream(
  req: ModelRequest,
  endpoint: ModelEndpoint,
): AsyncIterable<ModelChunk> {
  assertConfigured(endpoint);
  const started = Date.now();
  const body = buildBody(req, endpoint, true);

  const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(await describeFailure(res));
  if (!res.body) throw new Error("模型返回了空响应体，无法读取流");

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let usage = extractUsage(undefined);
  let model = modelForTier(req.tier, endpoint);
  let finishReason = "unknown";

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });

    // SSE 以空行分隔事件；只处理完整行，残行留在缓冲区等下一块
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;

      let parsed: ApiResponse;
      try {
        parsed = JSON.parse(payload) as ApiResponse;
      } catch {
        continue; // 半截 JSON 直接跳过，不因为一行解析失败就中断整个流
      }

      if (parsed.model) model = parsed.model;
      if (parsed.usage) usage = extractUsage(parsed.usage);

      const choice = parsed.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      const rDelta = choice?.delta?.reasoning_content;
      if (rDelta) {
        reasoning += rDelta;
        yield { kind: "reasoning", delta: rDelta };
      }

      const tDelta = choice?.delta?.content;
      if (tDelta) {
        text += tDelta;
        yield { kind: "text", delta: tDelta };
      }
    }
  }

  // 价格与档位都由适配器算好再报出去 —— 内核不认识任何一家的价目表
  const streamCost = computeCost(model, usage);

  yield {
    kind: "done",
    result: {
      text,
      reasoning,
      usage,
      costCny: streamCost.costCny,
      priceTier: streamCost.tier,
      model,
      latencyMs: Date.now() - started,
      truncated: finishReason === "length",
      finishReason,
    },
  };
}

/**
 * 创建一个绑定到某个接入点的模型端口。
 *
 * 不传参数时用平台自己的接入点 —— 这也是绝大多数情况。
 * 用户配置了自定义接入时，调用方传入那一组值即可，
 * 适配器本身不需要知道「配置」这件事存在。
 */
export function createDeepSeekPort(endpoint?: ModelEndpoint): ModelPort {
  const resolved = endpoint ?? platformEndpoint();
  return {
    complete: (req) => complete(req, resolved),
    stream: (req) => stream(req, resolved),
  };
}

/** 全局单例：平台默认接入。适配器无状态，复用即可 */
export const deepseekPort: ModelPort = createDeepSeekPort();