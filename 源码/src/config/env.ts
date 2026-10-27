/**
 * 环境配置集中处：全项目只有这一个文件读取 process.env。
 * 密钥等敏感信息只放 .env.local（已忽略），仓库里只保留 .env.example。
 * 仅服务端使用，不要在任何 "use client" 组件里引入。
 * 所有键在 .env.example 里都有对应说明。
 */

import fs from "node:fs";

/**
 * 让命令行脚本也能读到 .env.local。
 * NEXT_RUNTIME 是 Next.js 注入的标志，有它说明已经加载过，不必重复加载。
 */
if (!process.env.NEXT_RUNTIME && fs.existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

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

/**
 * 门禁覆盖取白名单：不认识的值一律回落到 "declared"。
 * 若写成"非 pause 即放行"，拼错的值会静默放行，而放行意味着模型替用户猜。
 */
function parseGateOverride(raw: string): "declared" | "pause" | "continue" {
  if (raw === "pause" || raw === "continue" || raw === "declared") return raw;
  return "declared";
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
    /**
     * 并行构建的并发上限。默认 3：模块构建是网络等待，几个同时在飞对内存影响很小；
     * <=0 或未配置时，编排层回落到 domain/module-build.ts 的 DEFAULT_BUILD_CONCURRENCY。
     */
    maxParallelBuild: num("MAX_PARALLEL_BUILD", 3),
  },
  run: {
    /** 单次运行成本上限（元）；各工序入口的预算闸门据此拒绝继续 */
    costLimitCny: num("RUN_COST_LIMIT_CNY", 5),
    /** 工作流版本：产物契约或阶段定义变更时必须递增，否则旧产物会被误判为兼容 */
    workflowVersion: "v1",
    /**
     * 人工门禁的运行时覆盖，取值 declared / pause / continue。
     * 真相来源是 core/pipeline/stages.ts 的 humanGate 声明，规则见 gate-policy.ts。
     * 默认 continue：几乎每次生成都会被拦，与"一句话出成品"的承诺冲突；
     * 覆盖不静默，resolveGatePolicy 会标成 overridden，事件流照实说明。
     */
    specGate: parseGateOverride(str("SPEC_GATE", "declared")),
  },
  paths: {
    database: str("DATABASE_PATH", "./data/nexus.db"),
    workspaceRoot: str("WORKSPACE_ROOT", "./data/workspace"),
  },
  /** 能力探测脚本用。留成可配置是为了做对照实验（换档位、换预算再跑一次） */
  probe: {
    effort: str("PROBE_EFFORT", "high"),
    maxOutputTokens: num("PROBE_MAX_TOKENS", 16384),
    /** 去掉代码块外壳，只留正文，便于把整段 HTML 贴进命令行 */
    systemPromptOverride: str("PROBE_SYSTEM_PROMPT", ""),
  },
} as const;