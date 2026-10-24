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

import fs from "node:fs";

/**
 * 让命令行脚本也能读到 .env.local
 * ============================================================
 * Next.js 会自动加载 .env.local，但用 tsx 直接跑的脚本不会 ——
 * 于是「页面上能跑、脚本里说密钥缺失」这种困惑就会出现。
 *
 * 这里统一解决：非 Next.js 环境下自己加载一次。
 * 判断依据是 NEXT_RUNTIME —— 它是 Next.js 注入的标志，
 * 有这个标志说明 Next 已经加载过了，不必重复加载，
 * 也避免在真实部署环境里用本地文件覆盖掉容器注入的环境变量。
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
 * 读门禁覆盖的那个环境变量。
 *
 * ── 为什么写成一个函数而不是 `=== "pause" ? ... : ...` ──
 *   那个写法**只有一个有效值**：除了 "pause" 之外全是"放行"。
 *   于是 `SPEC_GATE=continue` 和 `SPEC_GATE=香蕉` 和没设
 *   得到的结果一模一样 —— 一个拼错的值会静默变成"放行"，
 *   而放行意味着模型替用户猜。
 *
 *   这里改成白名单：不认识的值一律回落到 "declared"（按权限模型来）。
 *   拼错时的后果是"多问了一次人"，而不是"少问了一次" ——
 *   这两个代价不对等。
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
    /** 并发构建数。本机内存小，默认 1（串行），线上可调高 */
    maxParallelBuild: num("MAX_PARALLEL_BUILD", 1),
  },
  run: {
    /** 单次运行成本上限（元），超过后自动降档 */
    costLimitCny: num("RUN_COST_LIMIT_CNY", 5),
    /** 当前工作流版本。产物契约或阶段定义变更时必须递增，
     *  否则旧产物会被误判为兼容 —— 这是「失效传播」的判据 */
    workflowVersion: "v1",
    /**
     * 人工门禁的**运行时覆盖**。
     *
     * ⚠️ 它不是这件事的真相来源。
     *    真相在 core/pipeline/stages.ts：规格化那一道声明了
     *    `humanGate: true`，也就是"这一步要人点头"。
     *    这里只是允许你在运行时改主意，规则在 core/pipeline/gate-policy.ts。
     *
     * "declared" —— 按声明来（也就是步骤自己的权限模型说了算）
     * "pause"    —— 强制停下等人。**加严永远允许**，不需要理由
     * "continue" —— 强制放行。这是**覆盖声明**，所以会留下痕迹：
     *               事件流里会明说"这一步声明了要人点头，但当前设置
     *               是先放行，模型会替你猜"。
     *
     * ── 为什么默认 continue ──
     *   这是跑真实端到端时改的。原来默认拦，结果发现模型对
     *   「做一个番茄钟」这种一句话需求也会问出 3 个问题 ——
     *   也就是说**几乎每次生成都会被拦一次**。
     *
     *   这个产品的承诺是「一句话 → 一个能用的成品」。
     *   每次都要先回答三个问题才能看到东西，那个承诺就不成立了。
     *
     *   所以默认放行：疑问仍然显示，用户看到了可以主动回头改，
     *   但不会因为没回答而拿不到东西。
     *
     * ── 但覆盖不能是静默的 ──
     *   一个静默关掉的门禁，和没有门禁是同一件事 —— 而且更糟，
     *   因为界面上还写着「要人点头」，用户会以为有人把关过了。
     *   所以 resolveGatePolicy 会把它标成 overridden 并带上 overrideNote，
     *   事件流照实说。
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

/** 启动期自检：密钥缺失时给出明确指引，而不是等到调用失败 */
export function assertModelConfigured(): void {
  if (!env.model.apiKey) {
    throw new Error(
      "缺少模型密钥。请复制 源码/.env.example 为 源码/.env.local，并填入 DEEPSEEK_API_KEY。",
    );
  }
}