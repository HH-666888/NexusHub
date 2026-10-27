/**
 * DeepSeek 适配器，ModelPort 的实现；换供应商只需另写一个此文件。
 * 思考 token 计入 max_tokens，预算不足会返回空正文并标记 length；思考模式下 temperature 不生效。
 * 缓存命中的输入价是未命中的 1/50，用量必须区分 cache_hit 与 cache_miss。
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

/** 默认输出预算，给足余量，避免被思考 token 吃光 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/** 单次调用超时（毫秒）；构建任务可能很慢，给到 5 分钟 */
const TIMEOUT_MS = 300_000;

/**
 * 各档位的默认思考投入：decide 求深思，execute 默认，mechanical 关掉思考。
 * 关掉思考既省时也省钱：思考 token 按输出价计费。
 */
const DEFAULT_EFFORT: Record<ModelTier, ModelEffort> = {
  decide: "high",
  execute: "high",
  mechanical: "none",
};

/**
 * 模型接入点：默认取平台环境变量，配置了自定义接入时整组替换。
 * 做成参数使适配器无状态，同一进程可并存指向不同服务商的实例。
 */
export interface ModelEndpoint {
  baseUrl: string;
  apiKey: string;
  decideModel: string;
  executeModel: string;
}

/** 平台接入点（来自 .env.local），所有人的默认值 */
export function platformEndpoint(): ModelEndpoint {
  return {
    baseUrl: env.model.baseUrl,
    apiKey: env.model.apiKey,
    decideModel: env.model.decideModel,
    executeModel: env.model.executeModel,
  };
}

/**
 * 档位到模型名的映射。这是职责切分而非挑便宜的用：mechanical 用同一个模型，只关掉思考。
 */
function modelForTier(tier: ModelTier, endpoint: ModelEndpoint): string {
  return tier === "decide" ? endpoint.decideModel : endpoint.executeModel;
}

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
    // 思考 token 不单独计费：已包含在 outputTokens 里（官方口径为输入 + 输出总量）
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
    cacheHitTokens: u?.prompt_cache_hit_tokens ?? 0,
    cacheMissTokens: u?.prompt_cache_miss_tokens ?? 0,
  };
}

/**
 * 把 HTTP 失败翻译成能直接照做的中文提示。
 * 按状态码给出密钥、余额、限速、供应商故障四类建议。
 */
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
        "或到“设置 → 模型接入”里配置自己的密钥。",
    );
  }
}

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
 * 流式调用：逐块产出正文与思考，最后给一次完整结果。
 * 流式是思考可视化的数据来源，不只是打字机效果。
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

    // SSE 以空行分隔事件；只处理完整行，残行留在缓冲区等下一块。
    // 流式响应的用量只在最后一个数据块里出现。
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

  // 价格与档位由适配器算好再报出，内核不认识任何一家的价目表。
  // 价格表在 pricing.ts，换供应商只改那一个文件。
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
 * 创建绑定到某个接入点的模型端口；不传参数时用平台接入点。
 * 自定义接入由调用方传入，适配器不需要知道配置的存在。
 */
export function createDeepSeekPort(endpoint?: ModelEndpoint): ModelPort {
  const resolved = endpoint ?? platformEndpoint();
  return {
    complete: (req) => complete(req, resolved),
    stream: (req) => stream(req, resolved),
  };
}

/** 平台默认接入的单例；适配器无状态，复用即可 */
export const deepseekPort: ModelPort = createDeepSeekPort();
