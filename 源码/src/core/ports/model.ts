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
 *
 * 这一档的取值来自实测与官方文档，不是拍脑袋：
 *   - 官方文档：思考模式默认打开，强度默认 high
 *   - 实测：关闭思考后，输入 token 从 36 降到 10（服务端不再注入思考引导提示词），
 *           同一问题耗时从 1114 毫秒降到 646 毫秒
 *
 * "none" 对应 API 的 thinking.type = "disabled"。
 * 它存在的意义：机械任务（重命名、样板代码、格式化）不需要思考，
 * 关掉能同时省时间和省钱 —— 输出侧的价格是输入侧的 4 倍，而思考 token 算作输出。
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
  /**
   * 计价档位。峰谷价差一倍，不记下来的话，
   * 事后复盘会以为「同样的活儿这次怎么贵了一倍」是模型变笨了。
   *
   * 为什么交给适配器报出来而不是内核自己算：
   *   价格表是供应商的数据，属于适配器，内核不该认识任何一家的价目表。
   *   内核只负责把「花了多少、按什么价」记进流水。
   */
  priceTier: "peak" | "offPeak";
  /** 实际使用的模型名 */
  model: string;
  latencyMs: number;
  /**
   * 是否因为输出长度上限被截断。
   *
   * 这个字段来自一次真实的踩坑：
   *   思考 token 计入输出预算。若 maxOutputTokens 设得过小，
   *   模型会把预算全花在思考上，content 返回空串、finish_reason 为 "length"。
   *   把这种情况显式标记出来，编排层才能识别「是预算不够，不是模型不会」，
   *   从而做出正确的处置（提高预算重试），而不是误判为模型能力问题。
   */
  truncated: boolean;
  /** 供应商返回的原始结束原因，便于归因 */
  finishReason: string;
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