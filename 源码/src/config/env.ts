/**
 * 环境配置集中处
 * ============================================================
 * 全项目只有这一个文件读取 process.env。
 * 其他任何地方要配置，都从这里取 —— 这样「配置有哪些」永远只有一个答案。
 *
 * 安全（赛题硬性要求）：
 *   API 密钥等敏感信息不得出现在公开仓库中，须通过环境变量方式配置。
 *   本地开发把真实值写进 .env.local（已被 .gitignore 忽略），
 *   仓库里只保留 .env.example 模板。
 *
 * 注意：本文件只在服务端使用，不要在任何 "use client" 组件里引入。
 */

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  model: {
    baseUrl: str("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    apiKey: str("DEEPSEEK_API_KEY", ""),
    /** 决策级模型：架构决策、方案裁决、复杂归因 */
    decideModel: str("MODEL_DECIDE", "deepseek-flash"),
    /** 执行级模型：绝大多数写码与改码 */
    executeModel: str("MODEL_EXECUTE", "deepseek-flash"),
  },
  sandbox: {
    memoryMb: num("SANDBOX_MEMORY_MB", 1024),
    cpus: num("SANDBOX_CPUS", 1),
    timeoutSeconds: num("SANDBOX_TIMEOUT_SECONDS", 300),
    /** 并发构建数。本机内存小，默认 1（串行），线上可调高 */
    maxParallelBuild: num("MAX_PARALLEL_BUILD", 1),
  },
  run: {
    /** 单次运行成本上限（元），超过后自动降档 */
    costLimitCny: num("RUN_COST_LIMIT_CNY", 5),
    /** 当前工作流版本。产物契约或阶段定义变更时必须递增，
     *  否则旧产物会被误判为兼容 —— 这是「失效传播」的判据 */
    workflowVersion: "v1",
  },
  paths: {
    database: str("DATABASE_PATH", "./data/nexus.db"),
    workspaceRoot: str("WORKSPACE_ROOT", "./data/workspace"),
  },
} as const;

/** 启动期自检：密钥缺失时给出明确指引，而不是等到调用失败 */
export function assertModelConfigured(): void {
  if (!env.model.apiKey) {
    throw new Error(
      "缺少模型密钥。请复制 源码/.env.example 为 源码/.env.local，并填入 DEEPSEEK_API_KEY。",
    );
  }
}