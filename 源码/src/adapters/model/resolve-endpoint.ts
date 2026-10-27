/**
 * 解析本次调用使用哪套模型接入：自定义配全用自定义，未配置用平台默认。
 * 自定义未配全时明确拒绝而不退回平台，避免用户在不知情时消耗平台额度。
 * 放在 adapters 而非 server：不依赖请求上下文，命令行脚本也能复用。
 */

import { platformEndpoint, type ModelEndpoint } from "@/adapters/model/deepseek";
import { sqliteSettingsStore } from "@/adapters/store/settings-repo";
import { describeModelSource, loadModelConfig } from "@/core/settings/service";

export interface ResolvedEndpoint {
  endpoint: ModelEndpoint;
  source: "platform" | "custom";
  /** 当前配置能否直接拿来跑 */
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
