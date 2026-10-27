import { describe, expect, it } from "vitest";
import {
  inspectArch,
  isValidPackageName,
  type ArchCheckItem,
} from "@/core/generate/arch-check";
import type { ArchModule, ArchSpec } from "@/core/domain/arch";
import type { AppSpec } from "@/core/domain/spec";
import { STAGES } from "@/core/pipeline/stages";

/**
 * 架构的本地检查：单测
 * ============================================================
 * 这个文件守着三件事，每一件都必须有正反两面的用例：
 *
 *   ① **三条检查与 stages.ts 的验收标准严格对应** ——
 *      从 STAGES 里读那三句话，而不是在这里手抄一份。
 *      手抄的话，产品改了而那三个字没改，测试会继续绿着、
 *      说的却已经是另一件事了。
 *   ② **每一条的判据都能分得开**：过了的、没过的各来一组。
 *      只验"该过的过了"是不够的 —— 一个恒返回 pass 的实现也能全绿。
 *   ③ ★ 诚实底线：第二条检查**必须**写明"未联网核实" ★
 *      这是本期最要紧的一条断言。它防的不是逻辑错，是**话说过头**：
 *      纯函数查不了包是否存在，界面上就不能写着"依赖都真实存在"。
 *      所以下面用 toContain 把"未联网"三个字钉死在检查名和 detail 上。
 *
 * 取材全部来自产品代码（stages.ts / arch-check.ts 自己的导出），
 * 不在这里编造一条"现实里不可能出现的形状"。
 */

/* ============================================================
   造数据
   ============================================================ */

/** 一份带指定验收条目 id 的规格 */
function specWith(ids: string[]): AppSpec {
  return {
    prompt: "做一个任务看板",
    goal: "团队任务看板",
    audience: "小团队",
    scenarios: ["新建任务", "拖动状态"],
    acceptance: ids.map((id, i) => ({
      id,
      statement: `第 ${i + 1} 条可判定的功能`,
      verifyBy: "打开页面点一下按钮，有可见响应",
      level: "must" as const,
    })),
    scope: { inScope: ["看板"], outOfScope: ["多人协作"] },
    questions: [],
    model: "fake-model",
    generatedAt: 0,
  };
}

/** 一个模块。默认不依赖任何人、不覆盖任何条目 —— 各用例只写自己要验的那部分 */
function mod(id: string, over: Partial<ArchModule> = {}): ArchModule {
  return {
    id,
    name: `模块 ${id}`,
    responsibility: "负责一块具体的东西",
    dependsOn: [],
    coversFeatures: [],
    ...over,
  };
}

function archWith(modules: ArchModule[], packages: ArchSpec["packages"] = []): ArchSpec {
  return { modules, packages };
}

/** 按检查名里的关键词取一条结果 —— 顺序不该由测试另行假设 */
function byKeyword(check: { results: ArchCheckItem[] }, keyword: string): ArchCheckItem {
  const hit = check.results.find((r) => r.name.includes(keyword));
  if (!hit) {
    throw new Error(
      `检查结果里没有含「${keyword}」的那一条（现有：${check.results.map((r) => r.name).join(" / ")}）`,
    );
  }
  return hit;
}

/** 三条检查在规格里的原文 —— 直接读 STAGES，不手抄 */
const STAGE_ACCEPTANCE = STAGES.find((s) => s.id === "arch")!.acceptance;

/* ============================================================
   ① 无孤儿需求
   ============================================================ */

describe("第一条 · 规格里每条功能都能映射到至少一个模块（无孤儿需求）", () => {
  it("每条功能条目都被某个模块覆盖 → 通过，且 detail 说清覆盖了几条", () => {
    const spec = specWith(["ac-1", "ac-2", "ac-3"]);
    const arch = archWith([
      mod("store", { coversFeatures: ["ac-1", "ac-2"] }),
      mod("board-ui", { coversFeatures: ["ac-3"] }),
    ]);

    const item = byKeyword(inspectArch(arch, spec), "无孤儿需求");
    expect(item.pass).toBe(true);
    expect(item.detail).toContain("3 条功能全部有模块承接");
  });

  it("【关键】有孤儿需求时**不通过**，而且 detail 把没被覆盖的 id 逐条列出来", () => {
    /*
      只说"有孤儿需求"是不够的：用户还得自己去比对哪一条没人管。
      detail 里必须出现那两个 id —— 这条断言就是在钉这件事。
    */
    const spec = specWith(["ac-1", "ac-2", "ac-3", "ac-4"]);
    const arch = archWith([mod("store", { coversFeatures: ["ac-1", "ac-2"] })]);

    const item = byKeyword(inspectArch(arch, spec), "无孤儿需求");
    expect(item.pass).toBe(false);
    expect(item.detail).toContain("ac-3");
    expect(item.detail).toContain("ac-4");
    // 已经被覆盖的那两条不该出现在"没被覆盖"的通报名单里
    expect(item.detail).not.toContain("ac-1");
  });

  it("同一条功能被两个模块同时覆盖，仍然只算覆盖一次（不算孤儿）", () => {
    const spec = specWith(["ac-1", "ac-2"]);
    const arch = archWith([
      mod("a", { coversFeatures: ["ac-1", "ac-2"] }),
      mod("b", { coversFeatures: ["ac-2"] }),
    ]);

    expect(byKeyword(inspectArch(arch, spec), "无孤儿需求").pass).toBe(true);
  });

  it("模块一条功能都没覆盖时，规格里每条都是孤儿（不通过）", () => {
    const spec = specWith(["ac-1", "ac-2"]);
    const arch = archWith([mod("a"), mod("b")]);

    const item = byKeyword(inspectArch(arch, spec), "无孤儿需求");
    expect(item.pass).toBe(false);
    expect(item.detail).toContain("2 条功能");
  });

  it("规格里一条验收标准都没有时：通过，但 detail 明说这一条无从判定", () => {
    /*
      这是"不许把没判过的说成判过了"的一个小例子：
      通过是空真（没有孤儿可谈），可这个绿点不能被读成"需求都安排好了"。
    */
    const item = byKeyword(inspectArch(archWith([mod("a")]), specWith([])), "无孤儿需求");
    expect(item.pass).toBe(true);
    expect(item.detail).toContain("无从判定");
  });
});

/* ============================================================
   ② 依赖包名合法（未联网核实是否真实存在）
   ============================================================ */

describe("第二条 · 依赖包名合法（未联网核实是否真实存在）", () => {
  it("★ 诚实底线：检查名里必须写着「未联网」★", () => {
    /*
      ★★★ 这是本期最重要的一条断言 ★★★

      纯函数没法联网，所以「依赖清单里的包真实存在」这条验收标准
      在这里只能做到"包名合法"。这一条把这个边界钉死在**名字**上：
      谁哪天把名字改成更强的话（比如"依赖真实存在"），这条立刻红。

      为什么值得用一个 toContain 去钉：
        界面上写着"依赖都真实存在"，用户会据此跳过自己该做的核实 ——
        一句话说过头的代价，比没有这句话大得多。
    */
    const item = byKeyword(inspectArch(archWith([mod("a")]), specWith(["ac-1"])), "包名合法");
    expect(item.name).toContain("未联网");
    expect(item.detail).toContain("未联网");
    // 而且它必须说清楚"没做什么"，而不是含糊过去
    expect(item.detail).toContain("未联网核实这些包是否真实存在");
  });

  it("合法包名（含 @scope/ 与 - _ . 三种字符）→ 通过", () => {
    const arch = archWith(
      [mod("a")],
      [
        { name: "dayjs", why: "格式化时间" },
        { name: "@tanstack/query-core", why: "缓存请求" },
        { name: "lodash.merge", why: "深合并" },
        { name: "my_utils", why: "自有小工具" },
      ],
    );

    const item = byKeyword(inspectArch(arch, specWith(["ac-1"])), "包名合法");
    expect(item.pass).toBe(true);
    expect(item.detail).toContain("4 个包名都符合 npm 包名语法");
  });

  it("非法包名（大写 / 前导点 / 空 scope / 空格）→ 不通过，且 detail 逐个点名", () => {
    const arch = archWith(
      [mod("a")],
      [
        { name: "DayJS", why: "大小写错" },
        { name: ".hidden", why: "前导点" },
        { name: "@scope/", why: "空的包名" },
        { name: "has space", why: "带空格" },
      ],
    );

    const item = byKeyword(inspectArch(arch, specWith(["ac-1"])), "包名合法");
    expect(item.pass).toBe(false);
    expect(item.detail).toContain("DayJS");
    expect(item.detail).toContain("has space");
    // 说"不合法"的同时，也得把"没联网"这件事再说一遍
    expect(item.detail).toContain("未联网");
  });

  it("依赖清单为空 → 通过，但 detail 明说没有包名可查（不许读成「都核实过了」）", () => {
    const item = byKeyword(inspectArch(archWith([mod("a")]), specWith(["ac-1"])), "包名合法");
    expect(item.pass).toBe(true);
    expect(item.detail).toContain("依赖清单是空的");
    expect(item.detail).toContain("未联网");
  });

  it("isValidPackageName 与检查用的是同一套判据（抽查几个边界）", () => {
    // 这个导出存在的意义：别处要判包名时不必再抄一份正则
    for (const ok of ["a", "a-b_c.d", "@s/p", "0abc"]) {
      expect(isValidPackageName(ok), `${ok} 应当是合法包名`).toBe(true);
    }
    for (const bad of ["", "A", "_a", ".a", "@s", "@s/", "a/b", "中文包"]) {
      expect(isValidPackageName(bad), `${bad} 应当是不合法包名`).toBe(false);
    }
  });
});

/* ============================================================
   ③ 模块依赖图无环
   ============================================================ */

describe("第三条 · 模块依赖图无环", () => {
  it("A→B→C 这种链式依赖 → 通过", () => {
    const arch = archWith([
      mod("c"),
      mod("b", { dependsOn: ["c"] }),
      mod("a", { dependsOn: ["b"] }),
    ]);

    const item = byKeyword(inspectArch(arch, specWith(["ac-1"])), "无环");
    expect(item.pass).toBe(true);
    expect(item.detail).toContain("没有任何环");
  });

  it("菱形依赖（A→B、A→C、B→D、C→D）→ 通过 —— 走完的节点不该被当成环", () => {
    /*
      这一条防的是一种很常见的误报：用"访问过的节点"一刀切地判环，
      于是 D 被访问两次就被判成环。实际它只是被两条路径共用的下游。
    */
    const arch = archWith([
      mod("d"),
      mod("b", { dependsOn: ["d"] }),
      mod("c", { dependsOn: ["d"] }),
      mod("a", { dependsOn: ["b", "c"] }),
    ]);

    expect(byKeyword(inspectArch(arch, specWith(["ac-1"])), "无环").pass).toBe(true);
  });

  it("【关键】A→B→A → 不通过，且 detail 写出环是哪几个模块", () => {
    const arch = archWith([
      mod("a", { dependsOn: ["b"] }),
      mod("b", { dependsOn: ["a"] }),
    ]);

    const item = byKeyword(inspectArch(arch, specWith(["ac-1"])), "无环");
    expect(item.pass).toBe(false);
    expect(item.detail).toContain("成环");
    // 路径要读得出来：a 和 b 都得在，"→"也得在
    expect(item.detail).toContain("a");
    expect(item.detail).toContain("b");
    expect(item.detail).toContain("→");
  });

  it("自引用（a→a）→ 不通过 —— 它是最短的一个环", () => {
    const arch = archWith([mod("a", { dependsOn: ["a"] })]);

    const item = byKeyword(inspectArch(arch, specWith(["ac-1"])), "无环");
    expect(item.pass).toBe(false);
    expect(item.detail).toContain("a → a");
  });

  it("【关键】引用了不存在的模块 id → 不通过，且 detail 指出是哪一个被谁引用", () => {
    /*
      它不是"环"，但它让这张图根本不成图：第四道并行构建会照着
      dependsOn 去找上游，找不到时的表现（静默跳过、或当成没有依赖先跑）
      都不报错，只是顺序会错。所以要点名到"谁指向谁"。
    */
    const arch = archWith([
      mod("a", { dependsOn: ["b", "ghost"] }),
      mod("b"),
    ]);

    const item = byKeyword(inspectArch(arch, specWith(["ac-1"])), "无环");
    expect(item.pass).toBe(false);
    expect(item.detail).toContain("a → ghost");
    // 真实存在的那个依赖不该被误报
    expect(item.detail).not.toContain("a → b");
    // 现有模块清单也一并给出，便于用户就地改
    expect(item.detail).toContain("a、b");
  });

  it("三个模块串成的长环（a→b→c→a）也能找出来", () => {
    const arch = archWith([
      mod("a", { dependsOn: ["b"] }),
      mod("b", { dependsOn: ["c"] }),
      mod("c", { dependsOn: ["a"] }),
    ]);

    expect(byKeyword(inspectArch(arch, specWith(["ac-1"])), "无环").pass).toBe(false);
  });
});

/* ============================================================
   汇总与对账
   ============================================================ */

describe("汇总：passed / total / 与 stages.ts 的对应关系", () => {
  it("恰好三条检查，三条全过时 passed=3、total=3", () => {
    const arch = archWith(
      [mod("store", { coversFeatures: ["ac-1"] })],
      [{ name: "dayjs", why: "时间" }],
    );
    const check = inspectArch(arch, specWith(["ac-1"]));

    expect(check.total).toBe(3);
    expect(check.results).toHaveLength(3);
    expect(check.passed).toBe(3);
  });

  it("一条不过时 passed 少一个，没过的那条能被单独取出来", () => {
    const arch = archWith([
      mod("a", { coversFeatures: ["ac-1"], dependsOn: ["b"] }),
      mod("b", { dependsOn: ["a"] }),
    ]);
    const check = inspectArch(arch, specWith(["ac-1"]));

    expect(check.total).toBe(3);
    expect(check.passed).toBe(2);
    expect(check.results.filter((r) => !r.pass).map((r) => r.name)).toEqual([
      byKeyword(check, "无环").name,
    ]);
  });

  it("三条检查与 stages.ts 里 arch 那三条验收标准一一对应（按顺序）", () => {
    /*
      这条测的不是某个函数算得对，而是**两处有没有对上**：
      工序定义那三句话（stages.ts）是这个阶段的契约，
      而检查是它的实现。实现少一条、或者顺序变了，
      界面上摆出来的"三条过了两条"就没法和契约逐行核对。

      关键词从哪来：就写在下面这张表里，而它对应的是
      STAGES 里那三句原文 —— 原文一改，这里立刻红。
    */
    const keywords = ["无孤儿需求", "包名合法", "无环"];
    const check = inspectArch(archWith([mod("a")]), specWith(["ac-1"]));

    expect(STAGE_ACCEPTANCE).toHaveLength(3);
    keywords.forEach((kw, i) => {
      expect(check.results[i].name, `第 ${i + 1} 条检查与验收标准对不上`).toContain(kw);
    });

    // 三句原文本身也要能被认出来，否则上面那张表就是空的
    expect(STAGE_ACCEPTANCE[0]).toContain("无孤儿需求");
    expect(STAGE_ACCEPTANCE[1]).toContain("依赖清单里的包真实存在");
    expect(STAGE_ACCEPTANCE[2]).toContain("模块依赖图无环");
  });

  it("纯函数：同一份输入判两次结果完全一样，且不改动输入", () => {
    const arch = archWith([mod("a", { coversFeatures: ["ac-1"], dependsOn: ["b"] }), mod("b")]);
    const spec = specWith(["ac-1"]);
    const archBefore = structuredClone(arch);
    const specBefore = structuredClone(spec);

    expect(inspectArch(arch, spec)).toEqual(inspectArch(arch, spec));
    expect(arch).toEqual(archBefore);
    expect(spec).toEqual(specBefore);
  });
});