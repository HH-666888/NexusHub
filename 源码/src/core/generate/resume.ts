/**
 * 断点续跑：哪些模块的产出可以接着用
 * ============================================================
 * ── 为什么需要它（真实场景，不是设想）──
 *   并行构建是整条流水线里最贵的一道（实测一次 ¥0.25 上下，占大头）。
 *   而它又是最容易被外力打断的一道：关掉浏览器、dev server 重启、
 *   网络断一下 —— 都已经落盘的那几个模块，凭什么再花一次钱重写？
 *
 *   更实际的一层：`stages.ts` 里第四道的产物契约写的就是 `modules/*.json`。
 *   这份文件以前**从来没被写出来过** —— 契约与实际不符；
 *   写出来之后，"接着上次跑"才有东西可接。
 *
 * ── 判据为什么是"内容哈希"，而不是"文件在不在" ──
 *   文件在，不代表内容还是那次构建的产出：可能被人手改过、可能写了一半
 *   被杀掉留下半截、也可能是别的东西覆盖了同名文件。
 *   而产物登记里存着当初那份内容的 sha256 —— 重算一遍对得上，才算"是它"。
 *   对不上就**重新构建**：钱可以再花一次，把半截代码装配进产物不行。
 */

export interface ModuleArtifactState {
  moduleId: string;
  /** 登记里有这个模块的产出文件 */
  present: boolean;
  /**
   * 文件内容与登记里的 sha256 是否一致。
   * `present` 为 false 时这一项无意义（统一按不通过处理）。
   */
  sha256Ok: boolean;
}

export interface ModuleResumePlan {
  /** 可以直接沿用的模块（顺序与 expectedIds 一致） */
  reuse: string[];
  /** 还需要构建的模块（顺序与 expectedIds 一致） */
  build: string[];
  /** 有文件但不能用的，附原因（界面上要说清"为什么又花了一次钱"） */
  rejected: Array<{ moduleId: string; reason: string }>;
  /** 给用户看的一句话；没有可沿用的产出时是空串 */
  reason: string;
}

/**
 * 决定哪些模块沿用、哪些重构建。
 *
 * @param expectedIds 架构里声明的模块 id（顺序就是界面上的顺序）
 * @param states      这些模块的产出文件现状（多出来的、架构里没有的会被忽略）
 */
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
    /*
      有文件但内容对不上：**不能用**。
      说清原因（而不是悄悄重构建），因为用户会看到"钱又花了一次"，
      他有权知道那一次是为什么花的。
    */
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
 * 把模块产出序列化成 `modules/<id>.json` 的内容。
 *
 * 存什么：模块的 id、名字、三段代码，以及它依赖谁。
 * 不存什么：思考过程（那是过程，不是产物；产物登记里也不该出现过程）。
 *
 * ⚠️ 存**原始三段代码**而不是装配后的产物：续跑时要把它原样喂给装配，
 *    多包一层（比如拼好的 html）就等于把装配这一步的输入固化死了，
 *    以后改装配策略还得回头清理这些文件。
 */
export interface ModuleArtifactPayload {
  moduleId: string;
  name: string;
  dependsOn: string[];
  html: string;
  css: string;
  js: string;
  /** 当初是哪个模型写的（沿用时界面上要能显示，而不是留空） */
  model: string;
  /** 写这份产出的时刻（毫秒） */
  builtAt: number;
}