/**
 * 架构的本地检查
 * ============================================================
 * 第二道工序产出 arch.json 之后，**不调模型**就能判的三件事。
 * 三条一一对应 `core/pipeline/stages.ts` 里 arch 这一段已经写好的验收标准：
 *
 *   stages.ts:206  「规格里每条功能都能映射到至少一个模块（无孤儿需求）」
 *   stages.ts:207  「依赖清单里的包真实存在」
 *   stages.ts:208  「模块依赖图无环」
 *
 * ── ⚠️ 第二条：这里必须说实话，而且必须说清楚它**没做什么** ──
 *   验收标准那句话是「依赖清单里的包真实存在」。
 *   但**纯函数没法联网** —— 这个文件零 IO（不 import store / adapter / fetch），
 *   所以它做不到"核实存在"这件事。
 *
 *   于是这一条的 name 写成「依赖包名合法（未联网核实是否真实存在）」，
 *   detail 里再重复一遍这件事。**不许写成"依赖真实存在"那种更强的话。**
 *   理由不是措辞洁癖：
 *     界面上写着"依赖都真实存在"，而实际上只查了字符串格式 ——
 *     用户会据此跳过自己该做的核实，装的时候才发现包名是编的。
 *     一句过强的结论，比没有结论更危险。
 *   真要做"真实存在"，得由 adapters 层去查 registry（一次网络往返），
 *   那是另一件事，也必须在界面上让用户看见它在联网。
 *
 * ── 为什么是纯函数 ──
 *   和 domain/spec.ts 的 validateSpec 同一条理由：这套判断不该依赖网络。
 *   抽出来之后，"自引用算不算环""引用不存在的模块怎么报"这些边界
 *   可以用几十条单测钉死。
 */

import type { ArchSpec } from "../domain/arch";
import type { AppSpec } from "../domain/spec";

export interface ArchCheckItem {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ArchCheck {
  results: ArchCheckItem[];
  passed: number;
  total: number;
}

/* ============================================================
   ① 无孤儿需求
   ============================================================ */

function checkNoOrphans(arch: ArchSpec, spec: AppSpec): ArchCheckItem {
  const name = "规格里每条功能都能映射到至少一个模块（无孤儿需求）";

  /*
    先算"被承接的条目集合"，再看规格里哪些没落进去。
    方向不能反：反过来的话，一个模块多写了几个不存在的条目 id
    就会让这条检查看起来"覆盖得很全"，而规格里真正的孤儿一条也没少。
  */
  const covered = new Set<string>();
  for (const m of arch.modules) {
    for (const id of m.coversFeatures) covered.add(id);
  }

  const missing = spec.acceptance.map((a) => a.id).filter((id) => !covered.has(id));

  if (spec.acceptance.length === 0) {
    /*
      规格里一条验收标准都没有时，这条检查**没有可判的东西**。
      记 pass —— 但它是一句有边界的实话，不是"全覆盖"：
      detail 必须写明规格本身是空的，否则这个绿点会被读成"需求都安排好了"。
    */
    return {
      name,
      pass: true,
      detail: "规格里没有任何验收标准，这一条无从判定（规格本身是空的）",
    };
  }

  if (missing.length > 0) {
    return {
      name,
      pass: false,
      detail:
        `规格里有 ${missing.length} 条功能没有任何模块承接（孤儿需求）：` +
        `${missing.join("、")}。在模块的 coversFeatures 里补上归属，或调整模块划分`,
    };
  }

  /*
    多出来的引用（模块写了规格里不存在的条目 id）不影响这一条的通过与否 ——
    它不制造孤儿需求，只是模型多写了几个字符串。
    但它值得被说出来：那多半意味着模型看错了规格。
  */
  const known = new Set(spec.acceptance.map((a) => a.id));
  const stray = [...covered].filter((id) => !known.has(id));

  return {
    name,
    pass: true,
    detail:
      `规格里 ${spec.acceptance.length} 条功能全部有模块承接` +
      (stray.length > 0
        ? `（另有 ${stray.length} 个 coversFeatures 引用在规格里找不到对应条目：${stray.join("、")}）`
        : ""),
  };
}

/* ============================================================
   ② 依赖包名合法（未联网核实是否真实存在）
   ============================================================ */

/**
 * npm 包名语法。
 *
 * 规则来自 npm 自己的命名约束（只取**能离线判定**的那几条）：
 *   · 全小写；可含 `-` `_` `.`
 *   · 可以带 `@scope/` 前缀，scope 与包名各是一条同样的字符序列
 *   · 首字符必须是字母或数字（所以 `.foo`、`_foo` 不合法）
 *
 * 刻意**不**检查的那几条（长度上限、保留名、是否已被占用、是否存在）：
 * 它们要么不影响可用性，要么必须联网。少查一条就说少查一条，
 * 不能因为"大概没问题"就把它算进通过。
 */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function isValidPackageName(name: string): boolean {
  return NPM_PACKAGE_NAME.test(name);
}

function checkPackageNames(arch: ArchSpec): ArchCheckItem {
  /*
    ★ 这一个字串就是这条检查的名字，也是本文件最要紧的一句实话 ★
    必须带「未联网核实是否真实存在」—— 有单测用 toContain 钉着它。
  */
  const name = "依赖包名合法（未联网核实是否真实存在）";

  const notChecked = "⚠️ 未联网核实这些包是否真实存在，只做了包名语法检查";

  if (arch.packages.length === 0) {
    /*
      空清单 → 通过，但 detail 必须说清是"没有可查的"，
      不能让这个绿点被读成"依赖都核实过了"。
    */
    return {
      name,
      pass: true,
      detail: `依赖清单是空的（一个第三方包都没声明），没有包名可查。${notChecked}`,
    };
  }

  const bad = arch.packages.filter((p) => !isValidPackageName(p.name));

  if (bad.length > 0) {
    return {
      name,
      pass: false,
      detail:
        `${bad.length} 个包名不符合 npm 包名语法（全小写、可含 - _ .、可带 @scope/）：` +
        `${bad.map((p) => `「${p.name}」`).join("、")}。${notChecked}`,
    };
  }

  return {
    name,
    pass: true,
    detail:
      `${arch.packages.length} 个包名都符合 npm 包名语法（${arch.packages
        .map((p) => p.name)
        .join("、")}）。${notChecked}`,
  };
}

/* ============================================================
   ③ 模块依赖图无环
   ============================================================ */

/**
 * 从 start 出发找一条回到自己的路径；找不到返回 null。
 *
 * 返回**路径**而不只是布尔值，是为了 detail 能写出「a → b → a」——
 * 「有环」这三个字对用户毫无用处：他还得自己把图读一遍才知道环在哪。
 *
 * 用三色标记（白=没走过，灰=在当前这条路径上，黑=走完了）而不是
 * 简单的 visited 集合：只有"灰"才代表环，走完的节点再遇到不算环
 * （菱形依赖 A→B→D、A→C→D 是合法的，被 visited 一刀切会误报）。
 */
function findCycle(
  graph: Map<string, string[]>,
  start: string,
): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    color.set(node, GRAY);
    stack.push(node);

    for (const next of graph.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        // 回到当前路径上的某个节点 —— 环就是这一段
        const at = stack.indexOf(next);
        return [...stack.slice(at), next];
      }
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
      // BLACK：这条支路已经走完且无环，直接跳过 —— 不重复走，也不误报
    }

    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  return visit(start);
}

function checkNoCycle(arch: ArchSpec): ArchCheckItem {
  const name = "模块依赖图无环";

  const ids = new Set(arch.modules.map((m) => m.id));

  /*
    引用不存在的 id：**也判不通过**。
    它不是"环"，但它让这个图根本不是一个图 ——
    而画布/并行构建会照着 dependsOn 去找上游，找不到时的表现
    （静默跳过、或者当成没有依赖先跑）都不报错，只会做出错的顺序。
    所以这一条要把"引用了谁、被谁引用"逐个点名。
  */
  const missing: string[] = [];
  for (const m of arch.modules) {
    for (const dep of m.dependsOn) {
      if (!ids.has(dep)) missing.push(`${m.id} → ${dep}`);
    }
  }

  if (missing.length > 0) {
    return {
      name,
      pass: false,
      detail:
        `${missing.length} 处依赖指向不存在的模块：${missing.join("、")}。` +
        `dependsOn 只能引用本架构里其它模块的 id（现有模块：${[...ids].join("、")}）`,
    };
  }

  const graph = new Map<string, string[]>();
  for (const m of arch.modules) {
    // 自引用（a → a）在这一步就落进图里，下面 DFS 会在"回到自己"时抓到它
    graph.set(m.id, [...m.dependsOn]);
  }

  for (const m of arch.modules) {
    const cycle = findCycle(graph, m.id);
    if (cycle) {
      return {
        name,
        pass: false,
        detail: `模块依赖成环：${cycle.join(" → ")}。先把这一圈拆开，否则"谁先做"没有答案`,
      };
    }
  }

  const edges = arch.modules.reduce((n, m) => n + m.dependsOn.length, 0);
  return {
    name,
    pass: true,
    detail: `${arch.modules.length} 个模块、${edges} 条依赖，没有任何环`,
  };
}

/* ============================================================
   汇总
   ============================================================ */

/**
 * 三条本地检查。
 *
 * 顺序就是 stages.ts 里 acceptance 的顺序 ——
 * 界面上那三条与工序定义那三条要能逐行对上，
 * 顺序不同的话，人核对时得来回找。
 */
export function inspectArch(arch: ArchSpec, spec: AppSpec): ArchCheck {
  const results: ArchCheckItem[] = [
    checkNoOrphans(arch, spec),
    checkPackageNames(arch),
    checkNoCycle(arch),
  ];

  return {
    results,
    passed: results.filter((r) => r.pass).length,
    total: results.length,
  };
}