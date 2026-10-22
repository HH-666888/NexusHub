/**
 * 模型端口 —— 内核与「模型供应商」之间的唯一契约
 * ============================================================
 * core/ 层只认识这个文件里的接口，不认识 DeepSeek、不认识 HTTP、不认识任何 SDK。
 * 换供应商 = 换一个 adapters/model/ 下的实现，内核一行不改。
 */

/** 模型档位：这是「职责切分」，不是「挑便宜的用」 */
export type ModelTier =
  | "decide" // 决策级：架构决策、方案裁决、复杂归因。永不写代码
  | "execute" // 执行级：绝大多数写码与改码
  | "mechanical"; // 机械级：重命名、样板代码、格式化、写提交信息

/**
 * 思考投入档位。
 * deepseek-flash 支持 low / high / max，默认 high。
 * 这是成本与质量的第二个旋钮 —— 不只选模型，还能选「用多少脑力」。
 */
export type ModelEffort = "low" | "high" | "max";

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
  /** 思考 token —— 计费，且是「AI 思考可视化」的数据源 */
  reasoningTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface ModelResult {
  text: string;
  /** 思考过程。供应商单独返回该字段时填充，否则为空串 */
  reasoning: string;
  usage: TokenUsage;
  /** 本次调用折算人民币 */
  costCny: number;
  /** 实际使用的模型名 */
  model: string;
  latencyMs: number;
}

export type ModelChunk =
  | { kind: "text"; delta: string }
  | { kind: "reasoning"; delta: string }
  | { kind: "done"; result: ModelResult };

export interface ModelPort {
  /** 一次性调用，等完整结果 */
  complete(req: ModelRequest): Promise<ModelResult>;
  /** 流式调用，逐块产出文本与思考过程 */
  stream(req: ModelRequest): AsyncIterable<ModelChunk>;
}