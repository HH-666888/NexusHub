/**
 * 界面设计的本地检查
 * ============================================================
 * 第三道工序产出 ui-spec.json 之后，**不调模型**就能判的三件事。
 * 三条一一对应 `core/pipeline/stages.ts` 里 ui 这一段已经写好的验收标准：
 *
 *   stages.ts:242  「每条功能都有对应的页面或入口」
 *   stages.ts:243  「组件树引用的设计变量全部已定义（无悬空引用）」
 *   stages.ts:244  「页面用到的数据都能在接口契约里找到」
 *
 * ── ⚠️ 第三条：这里必须说实话，而且必须说清楚它**没做什么** ──
 *   验收标准那句话是「页面用到的数据都能在**接口契约**里找到」。
 *   但**这张代码库里现在没有"接口契约"这个东西**：
 *   `domain/arch.ts` 的 ArchModule 只有 id / name / responsibility /
 *   dependsOn / coversFeatures 五个字段，没有任何一栏描述"这个模块导出什么接口"。
 *   拿一个不存在的字段去判，只有两种写法，两种都是在撒谎：
 *     · 写成"接口契约完备" → 用户会据此以为接口对过了，实际上一行都没核；
 *     · 反过来一律判不通过 → 每一份产物都无故变红，检查失去区分度。
 *
 *   所以这一条做的是**它能做的那件事**：把每个页面的 dataNeeds
 *   逐项拿去和架构里模块的 id / 名称做字面比对 —— 回答的是
 *   「这个页面要的数据，能不能指到某个模块头上」。
 *   **name 里就写着这个边界**（「按模块 id/名称匹配」「未核实接口契约」），
 *   detail 里再重复一遍：没有核实模块真的导出了对应的接口，也没有核实
 *   数据的形状与字段。真要做到那一步，得先给 ArchModule 加上接口契约字段
 *   （并让第二道工序真的产出它），那是另一件事，也该由那次改动自己声明。
 *
 *   一句过强的结论比没有结论更危险：界面上写着"接口都对上了"，
 *   而实际上只比了几个字符串 —— 用户会据此跳过自己该做的核对。
 *
 * ── 为什么是纯函数 ──
 *   和 domain/spec.ts 的 validateSpec、generate/arch-check.ts 同一条理由：
 *   这套判断不该依赖网络，也不该依赖 store。
 *   抽出来之后，「悬空引用怎么报」「孤儿功能怎么列」这些边界
 *   可以用几十条单测钉死。
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

/* ============================================================
   ① 每条功能都有对应的页面或入口
   ============================================================ */

function checkEveryFeatureHasAPage(ui: UiSpec, spec: AppSpec): UiCheckItem {
  const name = "每条功能都有对应的页面或入口";

  /*
    先算"被承接的条目集合"，再看规格里哪些没落进去。
    方向不能反：反过来的话，一个页面多写了几个不存在的条目 id
    就会让这条检查看起来"覆盖得很全"，而规格里真正的孤儿功能一条也没少。
  */
  const covered = new Set<string>();
  for (const page of ui.pages) {
    for (const id of page.coversFeatures) covered.add(id);
  }

  const missing = spec.acceptance.map((a) => a.id).filter((id) => !covered.has(id));

  if (spec.acceptance.length === 0) {
    /*
      规格里一条验收标准都没有时，这条检查**没有可判的东西**。
      记 pass —— 但它是一句有边界的实话，不是"全覆盖"：
      detail 必须写明规格本身是空的，否则这个绿点会被读成"每条功能都有页面了"。
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
        `规格里有 ${missing.length} 条功能没有任何页面承接（孤儿功能）：` +
        `${missing.join("、")}。在页面的 coversFeatures 里补上归属，或调整页面划分`,
    };
  }

  /*
    多出来的引用（页面写了规格里不存在的条目 id）不影响这一条的通过与否 ——
    它不制造孤儿功能，只是模型多写了几个字符串。
    但它值得被说出来：那多半意味着模型看错了规格。
  */
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

/* ============================================================
   ② 组件引用的设计变量全部已定义（无悬空引用）
   ============================================================ */

function checkTokenRefs(ui: UiSpec): UiCheckItem {
  /*
    这个名字与 stages.ts:243 那句验收标准**逐字相同** —— 它判的正是那句话
    （组件树里的引用是不是都落在已定义的变量上）。
    只有第三条有意写弱了，理由见本文件开头那段。
  */
  const name = "组件树引用的设计变量全部已定义（无悬空引用）";

  const defined = new Set(ui.tokens.map((t) => t.name));

  /*
    逐项记下"哪个组件引用了哪个没定义的变量"，而不是只报一个数量。
    悬空引用在浏览器里是**静默失效**：样式不生效、控制台不报错。
    只说"有 3 处悬空引用"的话，用户还得自己把组件树读一遍才知道是哪三处。
  */
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
    /*
      没有可查的引用 → 通过，但 detail 必须说清是"没有可查的"，
      不能让这个绿点被读成"变量都用对了"。
    */
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

  /*
    没人用的变量不影响这一条的通过与否 —— 它不是悬空引用。
    但它值得被说出来：定义了一堆没人用的变量，多半意味着组件树还没画完。
  */
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

/* ============================================================
   ③ 页面声明的数据需求都能对应到架构里的模块
   ------------------------------------------------------------
   ★ 这一条的 name 与 detail 是本文件最要紧的一句实话，见文件头那段 ★
   ============================================================ */

/** 一条判据的边界说明，**每一条 detail 里都要带上它** */
const DATA_NEED_BOUNDARY =
  "⚠️ 只做了字面匹配：架构里现在没有「接口契约」这一栏" +
  "（ArchModule 只有 id/name/responsibility/dependsOn/coversFeatures），" +
  "所以这一条**没有**核实模块真的导出了对应的接口，也没有核实数据的形状与字段";

/** 比对用的归一：两边都去空白、不分大小写，其余逐字符相同才算对上 */
function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function checkDataNeeds(ui: UiSpec, arch: ArchSpec): UiCheckItem {
  /*
    ★ 这个名字就是这条检查的边界，也是本文件最要紧的一句实话 ★
    它说的是「对应到架构里的模块（按 id/名称匹配）」，**不是**「接口契约完备」。
    有单测用 toContain 钉着「未核实接口契约」这几个字。
  */
  const name = "页面声明的数据需求都能对应到架构里的某个模块（按模块 id/名称匹配，未核实接口契约）";

  const needs = ui.pages.flatMap((p) => p.dataNeeds.map((need) => ({ page: p.id, need })));

  if (needs.length === 0) {
    /*
      一个页面都没声明数据需求 → 没有可判的东西，记 pass，
      但 detail 必须写明是"没有可查的"，不能让这个绿点被读成"数据都接上了"。
    */
    return {
      name,
      pass: true,
      detail:
        `${ui.pages.length} 个页面都没有声明 dataNeeds，这一条无从判定。${DATA_NEED_BOUNDARY}`,
    };
  }

  /*
    架构里一个模块都没有时（正常路径不会出现：parseArch 要求至少一个模块，
    兜底架构也固定有一个），**判不通过**：
    这时每一项 dataNeeds 都无从对应，说它"通过"等于替一个空洞背书。
  */
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