/**
 * 断点续跑：按 sha256 判断哪些模块产出可以沿用，其余重新构建。
 * 文件存在不等于内容未变（手改、写了一半），所以只认哈希一致。
 */

export interface ModuleArtifactState {
  moduleId: string;
  /** 登记里有产出文件 */
  present: boolean;
  /** 文件内容与登记里的 sha256 一致；present 为 false 时无意义 */
  sha256Ok: boolean;
}

export interface ModuleResumePlan {
  /** 可沿用的模块，顺序同 expectedIds */
  reuse: string[];
  /** 仍需构建的模块，顺序同 expectedIds */
  build: string[];
  /** 有文件但不可用的模块与原因，界面要说清为什么又花了一次钱 */
  rejected: Array<{ moduleId: string; reason: string }>;
  /** 给用户看的一句话，没有可沿用产出时为空串 */
  reason: string;
}

/** 架构里没有的模块会被忽略 */
export function planModuleResume(
  expectedIds: readonly string[],
  states: readonly ModuleArtifactState[],
): ModuleResumePlan {
  const byId = new Map(states.map((s) => [s.moduleId, s]));
  const reuse: string[] = [];
  const build: string[] = [];
  const rejected: Array<{ moduleId: string; reason: string }> = [];

  for (const id of expectedIds) {
    const state = byId.get(id);
    if (!state || !state.present) {
      build.push(id);
      continue;
    }
    if (state.sha256Ok) {
      reuse.push(id);
      continue;
    }
    // 有文件但哈希对不上：如实报原因，用户会看到钱又花了一次
    rejected.push({ moduleId: id, reason: "产出文件的内容与登记里的哈希对不上（可能被改过或写了一半）" });
    build.push(id);
  }

  const reason =
    reuse.length === 0
      ? ""
      : build.length === 0
        ? `上次构建好的 ${reuse.length} 个模块产出都还在（校验通过），全部沿用`
        : `上次构建好的 ${reuse.length} 个模块产出还在（校验通过），沿用；这次只补 ${build.length} 个`;

  return { reuse, build, rejected, reason };
}

/**
 * modules/<id>.json 的内容：原始三段代码与依赖，不含思考过程。
 * 存原始代码而非装配产物，否则等于把装配的输入固化死。
 */
export interface ModuleArtifactPayload {
  moduleId: string;
  name: string;
  dependsOn: string[];
  html: string;
  css: string;
  js: string;
  /** 产出模型，沿用时要显示 */
  model: string;
  /** 产出时刻（毫秒） */
  builtAt: number;
}