/**
 * 解析「这一次调用该用哪套模型接入」
 * ============================================================
 * 规则：
 *   配了自定义且配全了 → 用自定义
 *   配了自定义但没配全 → **不静默退回平台配置**，而是明确拒绝
 *   没配自定义         → 用平台自己的（默认，永远可用）
 *
 * 为什么「没配全」不退回平台：
 *   用户切到自定义的意图是「用我的额度」。如果因为少填一项就
 *   悄悄用平台的钱去跑，他会在完全不知情的情况下消耗别人的额度 ——
 *   这比直接报错糟糕得多。宁可让他看到一句「接口地址没填」，
 *   也不要让他以为自己在用自己的账号。
 *
 * 为什么放在 adapters 而不是 server/：
 *   它只是「读一次配置、挑一组值」，不依赖 cookies() 或任何
 *   Next.js 请求上下文。放进 server/ 会让命令行脚本没法复用它
 *   （server/ 目录带着 server-only 守卫，脚本一引入就报错）。
 *   server/ 只留给真正需要请求上下文的东西。
 */

import { platformEndpoint, type ModelEndpoint } from "@/adapters/model/deepseek";
import { sqliteSettingsStore } from "@/adapters/store/settings-repo";
import { describeModelSource, loadModelConfig } from "@/core/settings/service";

export interface ResolvedEndpoint {
  endpoint: ModelEndpoint;
  source: "platform" | "custom";
  /** 当前配置能不能直接拿来跑 */
  ready: boolean;
  /** 不能跑时的中文原因，可直接显示给用户 */
  reason?: string;
}

export async function resolveModelEndpoint(): Promise<ResolvedEndpoint> {
  const config = await loadModelConfig(sqliteSettingsStore);
  const status = describeModelSource(config);

  if (status.using === "custom") {
    if (!status.ready) {
      return {
        endpoint: platformEndpoint(),
        source: "custom",
        ready: false,
        reason: status.reason,
      };
    }
    return {
      endpoint: {
        baseUrl: config.custom.baseUrl.trim(),
        apiKey: config.custom.apiKey,
        decideModel: config.custom.decideModel.trim(),
        executeModel: config.custom.executeModel.trim(),
      },
      source: "custom",
      ready: true,
    };
  }

  return { endpoint: platformEndpoint(), source: "platform", ready: true };
}