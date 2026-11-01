/**
 * 架构的本地检查：孤儿需求、包名语法、依赖成环，不调模型。
 * 包名那条只能验证语法，name 与 detail 必须写明“未联网核实是否真实存在”。
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

function checkNoOrphans(arch: ArchSpec, spec: AppSpec): ArchCheckItem {
  const name = "规格里每条功能都能映射到至少一个模块（无孤儿需求）";

  // 先算被承接的集合再回看规格：反过来的话，模块多写几个假 id 也会显得覆盖很全
  const covered = new Set<string>();
  for (const m of arch.modules) {
    for (const id of m.coversFeatures) covered.add(id);
  }

  const missing = spec.acceptance.map((a) => a.id).filter((id) => !covered.has(id));

  if (spec.acceptance.length === 0) {
    // 规格为空时无物可判：记 pass，但 detail 要写明规格本身是空的
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

  // 多余的 coversFeatures 引用不影响通过，但要说出来：模型多半看错了规格
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

/**
 * npm 包名语法：全小写，可含 - _ .，可带 @scope/ 前缀，首字符为字母或数字。
 * 只做离线可判的部分，长度上限、保留名、是否被占用都不查。
 */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function isValidPackageName(name: string): boolean {
  return NPM_PACKAGE_NAME.test(name);
}

function checkPackageNames(arch: ArchSpec): ArchCheckItem {
  // 这句就是检查名字，必须带“未联网核实”—— 有单测用 toContain 钉着
  const name = "依赖包名合法（未联网核实是否真实存在）";

  const notChecked = "未联网核实这些包是否真实存在，只做了包名语法检查";

  if (arch.packages.length === 0) {
    // 空清单即通过，但 detail 要写明没有可查的
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
        `${bad.map((p) => `“${p.name}”`).join("、")}。${notChecked}`,
    };
  }

  return {
    name,
    pass: true,
    detail: `${arch.packages.length} 个包名都符合 npm 包名语法（${arch.packages
      .map((p) => p.name)
      .join("、")}）。${notChecked}`,
  };
}

/**
 * 从 start 出发找一条回到自己的路径，找不到返回 null；返回路径是为了 detail 能写出 a → b → a。
 * 用三色标记而非 visited 集合：只有灰节点代表环，走完的再遇到不算（菱形依赖不误报）。
 */
function findCycle(graph: Map<string, string[]>, start: string): string[] | null {
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
        // 回到当前路径上的节点，这一段即环
        const at = stack.indexOf(next);
        return [...stack.slice(at), next];
      }
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
      // 黑：这条支路已走完且无环
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

  // 引用不存在的 id 也判不通过：图不成图，构建会照着错的顺序跑
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
    // 自引用也进图，下面 DFS 会抓到
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

/** 三条本地检查，顺序与 stages.ts 的 acceptance 一致，界面可逐行核对 */
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
