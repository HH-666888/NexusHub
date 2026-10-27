/**
 * 界面设计的本地检查：功能有页面、设计变量无悬空、数据需求能对上模块，不调模型。
 * 第三条只能按模块 id/名称做字面匹配，name 与 detail 必须写明「未核实接口契约」。
 */

import type { ArchSpec } from "../domain/arch";
import type { AppSpec } from "../domain/spec";
import type { UiSpec } from "../domain/ui-spec";

export interface UiCheckItem {
  name: string;
  pass: boolean;
  detail: string;
}

export interface UiCheck {
  results: UiCheckItem[];
  passed: number;
  total: number;
}


function checkEveryFeatureHasAPage(ui: UiSpec, spec: AppSpec): UiCheckItem {
  const name = "每条功能都有对应的页面或入口";

  // 先算被承接的集合再回看规格，否则页面多写几个假 id 也显得覆盖很全
  const covered = new Set<string>();
  for (const page of ui.pages) {
    for (const id of page.coversFeatures) covered.add(id);
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
        `规格里有 ${missing.length} 条功能没有任何页面承接（孤儿功能）：` +
        `${missing.join("、")}。在页面的 coversFeatures 里补上归属，或调整页面划分`,
    };
  }

  // 多余的 coversFeatures 引用不影响通过，但要说出来：模型多半看错了规格
  const known = new Set(spec.acceptance.map((a) => a.id));
  const stray = [...covered].filter((id) => !known.has(id));

  return {
    name,
    pass: true,
    detail:
      `规格里 ${spec.acceptance.length} 条功能全部有页面承接（${ui.pages.length} 个页面）` +
      (stray.length > 0
        ? `（另有 ${stray.length} 个 coversFeatures 引用在规格里找不到对应条目：${stray.join("、")}）`
        : ""),
  };
}


function checkTokenRefs(ui: UiSpec): UiCheckItem {
  // 名字与 stages.ts:243 的验收标准逐字相同；只有第三条有意写弱
  const name = "组件树引用的设计变量全部已定义（无悬空引用）";

  const defined = new Set(ui.tokens.map((t) => t.name));

  // 逐项记下哪个组件引用了哪个未定义变量：悬空引用在浏览器里静默失效，只报数量没用
  const dangling: string[] = [];
  for (const c of ui.components) {
    for (const token of c.usesTokens) {
      if (!defined.has(token)) dangling.push(`${c.id} → ${token}`);
    }
  }

  if (dangling.length > 0) {
    return {
      name,
      pass: false,
      detail:
        `${dangling.length} 处引用了没有定义的设计变量：${dangling.join("、")}。` +
        `usesTokens 里的每个变量都必须先在 tokens 里定义` +
        `（现有变量：${ui.tokens.map((t) => t.name).join("、") || "一个都没有"}）——` +
        `用了没定义的变量在浏览器里是静默失效，不报错`,
    };
  }

  const refs = ui.components.reduce((n, c) => n + c.usesTokens.length, 0);

  if (refs === 0) {
    // 没有可查的引用即通过，但 detail 要写明没有可查的
    return {
      name,
      pass: true,
      detail:
        (ui.components.length === 0
          ? "没有任何组件，"
          : `${ui.components.length} 个组件都没有声明 usesTokens，`) +
        `没有引用可查（已定义 ${ui.tokens.length} 个设计变量）。` +
        `这一条只判"引用了的是不是都定义过"，判不了"该引用的有没有引用"`,
    };
  }

  // 没人用的变量不算悬空引用，但要说出来：多半是组件树还没画完
  const used = new Set<string>();
  for (const c of ui.components) {
    for (const token of c.usesTokens) used.add(token);
  }
  const unused = ui.tokens.filter((t) => !used.has(t.name)).map((t) => t.name);

  return {
    name,
    pass: true,
    detail:
      `${ui.components.length} 个组件引用的 ${refs} 处变量全部已定义（共 ${ui.tokens.length} 个）` +
      (unused.length > 0
        ? `（另有 ${unused.length} 个变量定义了但没有任何组件引用：${unused.join("、")}）`
        : ""),
  };
}


/** 判据边界说明，每一条 detail 都要带上 */
const DATA_NEED_BOUNDARY =
  "⚠️ 只做了字面匹配：架构里现在没有「接口契约」这一栏" +
  "（ArchModule 只有 id/name/responsibility/dependsOn/coversFeatures），" +
  "所以这一条**没有**核实模块真的导出了对应的接口，也没有核实数据的形状与字段";

/** 比对前归一：去首尾空白、不分大小写 */
function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function checkDataNeeds(ui: UiSpec, arch: ArchSpec): UiCheckItem {
  // 名字就是这条的边界，不是「接口契约完备」；有单测 toContain「未核实接口契约」
  const name = "页面声明的数据需求都能对应到架构里的某个模块（按模块 id/名称匹配，未核实接口契约）";

  const needs = ui.pages.flatMap((p) => p.dataNeeds.map((need) => ({ page: p.id, need })));

  if (needs.length === 0) {
    // 没有数据需求即无物可判：记 pass，detail 要写明没有可查的
    return {
      name,
      pass: true,
      detail:
        `${ui.pages.length} 个页面都没有声明 dataNeeds，这一条无从判定。${DATA_NEED_BOUNDARY}`,
    };
  }

  // 架构里一个模块都没有时判不通过：说通过等于替一个空洞背书
  if (arch.modules.length === 0) {
    return {
      name,
      pass: false,
      detail:
        `有 ${needs.length} 项数据需求，而架构里一个模块都没有 —— 无从对应。` +
        `先让架构定型产出模块。${DATA_NEED_BOUNDARY}`,
    };
  }

  const unmatched: string[] = [];
  for (const { page, need } of needs) {
    const hit = arch.modules.some(
      (m) => sameLabel(need, m.id) || sameLabel(need, m.name),
    );
    if (!hit) unmatched.push(`「${page}」需要 ${need}`);
  }

  if (unmatched.length > 0) {
    return {
      name,
      pass: false,
      detail:
        `${unmatched.length} 项数据需求在架构里找不到对应模块：${unmatched.join("、")}。` +
        `dataNeeds 只能写架构里已有的模块 id 或名称` +
        `（现有模块：${arch.modules.map((m) => m.id).join("、")}）。${DATA_NEED_BOUNDARY}`,
    };
  }

  const moduleNames = arch.modules.map((m) => m.id);

  return {
    name,
    pass: true,
    detail:
      `${needs.length} 项数据需求逐项都对上了架构里的模块` +
      `（${ui.pages.length} 个页面 · 架构里 ${arch.modules.length} 个模块：${moduleNames.join("、")}）。` +
      `${DATA_NEED_BOUNDARY}`,
  };
}


/** 三条本地检查，顺序与 stages.ts 的 acceptance 一致，界面可逐行核对 */
export function inspectUi(ui: UiSpec, spec: AppSpec, arch: ArchSpec): UiCheck {
  const results: UiCheckItem[] = [
    checkEveryFeatureHasAPage(ui, spec),
    checkTokenRefs(ui),
    checkDataNeeds(ui, arch),
  ];

  return {
    results,
    passed: results.filter((r) => r.pass).length,
    total: results.length,
  };
}