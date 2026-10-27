/**
 * 模型端口：内核与模型供应商之间的唯一契约。
 * core/ 只认识这里，不认识 DeepSeek、不认识 HTTP；换供应商 = 换 adapters/model/ 下的实现。
 */

/** 档位是职责切分，不是挑便宜的用 */
export type ModelTier =
  | "decide" // 决策级：架构决策、方案裁决、复杂归因。永不写代码
  | "execute" // 执行级：绝大多数写码与改码
  | "mechanical"; // 机械级：重命名、样板代码、格式化、写提交信息

/**
 * 思考投入档位。官方文档：思考默认打开、强度默认 high。
 * 实测关闭后输入 token 从 36 降到 10（服务端不再注入思考引导），同一问题耗时 1114ms 降到 646ms。
 * "none" 对应 thinking.type = "disabled"：机械任务不需要思考，输出侧价格是输入侧的 4 倍。
 */
export type ModelEffort = "none" | "low" | "high" | "max";

export type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; dataBase64: string };

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string | ModelContentPart[];
}

export interface ModelRequest {
  tier: ModelTier;
  effort?: ModelEffort;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** 要求返回严格 JSON 时置为 "json" */
  responseFormat?: "text" | "json";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** 计费，也是思考可视化的数据源 */
  reasoningTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface ModelResult {
  text: string;
  /** 供应商单独返回该字段时填充，否则为空串 */
  reasoning: string;
  usage: TokenUsage;
  /** 折算人民币 */
  costCny: number;
  /**
   * 计价档位。峰谷价差一倍，不记下来复盘时会以为模型变笨了。
   * 交给适配器报出来而不是内核自己算：价目表是供应商的数据，内核不该认识任何一家。
   */
  priceTier: "peak" | "offPeak";
  /** 实际使用的模型名 */
  model: string;
  latencyMs: number;
  /**
   * 输出是否被长度上限截断。思考 token 计入输出预算，maxOutputTokens 太小会把预算
   * 全花在思考上，content 返回空串、finish_reason 为 length。
   * 显式标出来，编排层才能区分预算不够与模型不会，从而提高预算重试。
   */
  truncated: boolean;
  /** 供应商返回的原始结束原因 */
  finishReason: string;
}

export type ModelChunk =
  | { kind: "text"; delta: string }
  | { kind: "reasoning"; delta: string }
  /** 最后一个 chunk 带完整结果，用量与花费只在它里面 */
  | { kind: "done"; result: ModelResult };

export interface ModelPort {
  /** 一次性调用，等完整结果 */
  complete(req: ModelRequest): Promise<ModelResult>;
  /** 流式调用，逐块产出文本与思考 */
  stream(req: ModelRequest): AsyncIterable<ModelChunk>;
}