import { describe, expect, it } from "vitest";
import { inspectUi, type UiCheck } from "@/core/generate/ui-check";
import { STAGE_MAP } from "@/core/pipeline/stages";
import type { ArchSpec } from "@/core/domain/arch";
import type { AppSpec } from "@/core/domain/spec";
import { parseUi, type UiSpec } from "@/core/domain/ui-spec";

/**
 * 界面设计的本地检查：单测
 * ============================================================
 * 结构照 arch-check.test.ts：三条检查各自成组，每组先验"过"，再验"不过"。
 *
 * ── 本文件里最要紧的两条 ──
 *   ① **悬空设计变量**：detail 必须点名"哪个组件引用了哪个没定义的变量"。
 *      悬空引用在浏览器里是**静默失效** —— 只说"有 1 处悬空"的话，
 *      用户还得自己把组件树读一遍才知道是哪一处。
 *   ② **第三条检查的边界**：它的名字里必须带着「未核实接口契约」。
 *      这张代码库里根本没有"接口契约"这一栏，检查实际做的只是
 *      "dataNeeds 能不能指到某个模块头上"。写成更强的话就是撒谎 ——
 *      用户会据此省掉自己该做的接口核对。有专门的用例钉着这几个字。
 *
 * ── 一条贯穿全篇的取材原则 ──
 *   三条检查的顺序、以及前两条的名字，都**从 stages.ts 里取**，
 *   不在这里手抄一份。手抄的话，产品改了而那三个字没改，
 *   测试会继续绿着，说的却已经是另一件事了。
 */

/* ============================================================
   夹具
   ============================================================ */

/** 一份规格：验收条目 id 是 ac-1… */
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

const SPEC = specWith(["ac-1", "ac-2", "ac-3"]);

/** 一份架构：两个模块，覆盖规格里全部条目（第三条检查要靠它） */
const ARCH: ArchSpec = {
  modules: [
    {
      id: "task-store",
      name: "任务存储",
      responsibility: "任务的增删改与本地持久化",
      dependsOn: [],
      coversFeatures: ["ac-1", "ac-3"],
    },
    {
      id: "board-ui",
      name: "看板界面",
      responsibility: "三栏看板与拖拽交互",
      dependsOn: ["task-store"],
      coversFeatures: ["ac-2"],
    },
  ],
  packages: [],
};

/** 一份能过三条检查的界面设计 */
function goodUi(over: Partial<UiSpec> = {}): UiSpec {
  return {
    tokens: [
      { name: "--color-surface", value: "#0f172a" },
      { name: "--space-1", value: "8px" },
    ],
    pages: [
      {
        id: "board",
        name: "看板页",
        route: "/",
        coversFeatures: ["ac-1", "ac-2"],
        dataNeeds: ["task-store"], // 按模块 id 匹配
      },
      {
        id: "archive",
        name: "归档页",
        route: "/archive",
        coversFeatures: ["ac-3"],
        dataNeeds: ["看板界面"], // 按模块**名称**匹配 —— 两种写法都要算对上
      },
    ],
    components: [
      {
        id: "task-card",
        name: "任务卡",
        usedOn: ["board"],
        usesTokens: ["--color-surface", "--space-1"],
      },
    ],
    ...over,
  };
}

const itemOf = (check: UiCheck, i: number) => check.results[i];

/* ============================================================
   ① 每条功能都有对应的页面或入口
   ============================================================ */

describe("检查① 每条功能都有对应的页面或入口", () => {
  it("每条功能都有页面承接 → 通过，且 detail 说出覆盖了几条", () => {
    const check = inspectUi(goodUi(), SPEC, ARCH);
    const item = itemOf(check, 0);

    expect(item.pass).toBe(true);
    expect(item.detail).toContain("3 条功能全部有页面承接");
    expect(item.detail).toContain("2 个页面");
  });

  it("【关键】孤儿功能：没有任何页面承接 → 不通过，而且**逐条列出 id**", () => {
    /*
      只说"有孤儿功能"对用户毫无用处：他还得自己把规格和页面读一遍才知道是哪条。
      这里断的是 detail 里真的出现了那两个 id —— 而 ac-1 覆盖到了，不该出现。
    */
    const ui = goodUi({
      pages: [
        {
          id: "board",
          name: "看板页",
          route: "/",
          coversFeatures: ["ac-1"],
          dataNeeds: [],
        },
      ],
    });
    const item = itemOf(inspectUi(ui, SPEC, ARCH), 0);

    expect(item.pass).toBe(false);
    expect(item.detail).toContain("ac-2");
    expect(item.detail).toContain("ac-3");
    expect(item.detail).toContain("孤儿功能");
    // 覆盖到的那个不该被列进去 —— 否则这条断言对"列得准不准"毫无区分度
    expect(item.detail).not.toContain("ac-1、");
  });

  it("一条功能都没覆盖时把三条都列出来（不是只报第一条）", () => {
    const ui = goodUi({
      pages: [
        { id: "empty", name: "空页", route: "/", coversFeatures: [], dataNeeds: [] },
      ],
    });
    const item = itemOf(inspectUi(ui, SPEC, ARCH), 0);

    expect(item.pass).toBe(false);
    for (const id of ["ac-1", "ac-2", "ac-3"]) {
      expect(item.detail, `${id} 没有被列出来`).toContain(id);
    }
  });

  it("规格里一条验收标准都没有 → 通过，但 detail 明说这一条无从判定", () => {
    /*
      空规格时记 pass 是一句**有边界的实话**，不是"全覆盖"。
      detail 不写明"规格本身是空的"的话，这个绿点会被读成"每条功能都有页面了"。
    */
    const item = itemOf(inspectUi(goodUi(), specWith([]), ARCH), 0);

    expect(item.pass).toBe(true);
    expect(item.detail).toContain("没有任何验收标准");
    expect(item.detail).toContain("无从判定");
  });

  it("页面多写了规格里不存在的条目 id：不影响通过，但要在 detail 里说出来", () => {
    /*
      多出来的引用不制造孤儿功能，所以不该判不通过；
      但它多半意味着模型看错了规格 —— 静默吞掉是最难查的一类问题。
    */
    const ui = goodUi({
      pages: [
        { id: "board", name: "看板页", route: "/", coversFeatures: ["ac-1", "ac-2", "ac-3", "ac-9"], dataNeeds: [] },
      ],
    });
    const item = itemOf(inspectUi(ui, SPEC, ARCH), 0);

    expect(item.pass).toBe(true);
    expect(item.detail).toContain("ac-9");
  });
});

/* ============================================================
   ② 组件引用的设计变量全部已定义（无悬空引用）
   ============================================================ */

describe("检查② 组件引用的设计变量全部已定义", () => {
  it("引用的变量全都定义过 → 通过", () => {
    const item = itemOf(inspectUi(goodUi(), SPEC, ARCH), 1);

    expect(item.pass).toBe(true);
    expect(item.detail).toContain("全部已定义");
  });

  it("【关键】悬空引用 → 不通过，而且 detail 点名「哪个组件引用了哪个变量」", () => {
    /*
      这是本文件最要紧的一条断言。
      悬空引用在浏览器里**静默失效**：样式不生效、控制台不报错。
      检查必须把"组件 + 变量名"一起说出来，否则用户没法定位。
    */
    const ui = goodUi({
      tokens: [{ name: "--color-surface", value: "#0f172a" }],
      components: [
        {
          id: "task-card",
          name: "任务卡",
          usedOn: ["board"],
          usesTokens: ["--color-surface", "--color-danger"],
        },
      ],
    });
    const item = itemOf(inspectUi(ui, SPEC, ARCH), 1);

    expect(item.pass).toBe(false);
    // 说的是哪一处：组件 id + 变量名，一个都不能少
    expect(item.detail).toContain("task-card");
    expect(item.detail).toContain("--color-danger");
    // 定义过的那个不该被算成悬空
    expect(item.detail).not.toContain("→ --color-surface");
    expect(item.detail).toContain("静默失效");
  });

  it("多处悬空时每一处都列出来", () => {
    const ui = goodUi({
      tokens: [],
      components: [
        { id: "a", name: "A", usedOn: [], usesTokens: ["--x"] },
        { id: "b", name: "B", usedOn: [], usesTokens: ["--y"] },
      ],
    });
    const item = itemOf(inspectUi(ui, SPEC, ARCH), 1);

    expect(item.pass).toBe(false);
    expect(item.detail).toContain("a → --x");
    expect(item.detail).toContain("b → --y");
    expect(item.detail).toContain("2 处");
  });

  it("模型把变量名写成 var(--x) 也算同一个变量（解析层归一，不是检查层去猜）", () => {
    /*
      不归一的话，`var(--color-surface)` 和定义里的 `--color-surface`
      会被判成两个东西 —— 检查会**误报**一份其实自洽的产物。
      归一的活干在 domain 层的 parseUi 里（一个变量只有一个名字），
      这里验的是两层接起来之后没有假红。
    */
    const parsed = parseUi(
      JSON.stringify({
        tokens: [{ name: "--color-surface", value: "#0f172a" }],
        pages: [
          {
            id: "board",
            name: "看板页",
            route: "/",
            coversFeatures: ["ac-1", "ac-2", "ac-3"],
            dataNeeds: ["task-store"],
          },
        ],
        components: [
          {
            id: "card",
            name: "卡",
            usedOn: ["board"],
            usesTokens: ["var(--color-surface)", "--Color Surface"],
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.ui.components[0].usesTokens).toEqual([
      "--color-surface",
      "--color-surface",
    ]);
    expect(itemOf(inspectUi(parsed.ui, SPEC, ARCH), 1).pass).toBe(true);
  });

  it("一个组件都没有 → 通过，但 detail 明说这一条无从判定", () => {
    const item = itemOf(inspectUi(goodUi({ components: [] }), SPEC, ARCH), 1);

    expect(item.pass).toBe(true);
    expect(item.detail).toContain("没有任何组件");
    expect(item.detail).toContain("判不了");
  });

  it("有组件但一个变量都没引用 → 通过，且说清楚这一条判不了什么", () => {
    /*
      这一条只判"引用了的是不是都定义过"，判不了"该引用的有没有引用"。
      detail 里必须写明这个边界，否则绿点会被读成"变量都用对了"。
    */
    const ui = goodUi({
      components: [{ id: "shell", name: "外壳", usedOn: ["board"], usesTokens: [] }],
    });
    const item = itemOf(inspectUi(ui, SPEC, ARCH), 1);

    expect(item.pass).toBe(true);
    expect(item.detail).toContain("没有引用可查");
  });

  it("定义了但没人用的变量不影响通过，但要在 detail 里说出来", () => {
    const ui = goodUi({
      tokens: [
        { name: "--color-surface", value: "#0f172a" },
        { name: "--never-used", value: "1px" },
      ],
      components: [
        { id: "task-card", name: "任务卡", usedOn: ["board"], usesTokens: ["--color-surface"] },
      ],
    });
    const item = itemOf(inspectUi(ui, SPEC, ARCH), 1);

    expect(item.pass).toBe(true);
    expect(item.detail).toContain("--never-used");
    expect(item.detail).toContain("没有任何组件引用");
  });
});

/* ============================================================
   ③ 页面声明的数据需求都能对应到架构里的模块
   ------------------------------------------------------------
   ★ 这一组守的是「不许把话说得比实际更强」★
   ============================================================ */

describe("检查③ 数据需求对得上模块（★ 边界说明在这里）", () => {
  it("【关键】检查名里必须带着「未核实接口契约」—— 边界写在名字上", () => {
    /*
      stages.ts 那句验收标准是「页面用到的数据都能在**接口契约**里找到」，
      而这张代码库里**没有**接口契约这一栏（ArchModule 没有 interfaces 字段）。
      检查实际做的是"dataNeeds 指不指得到某个模块"。

      所以：名字里必须同时出现【按模块 id/名称匹配】和【未核实接口契约】。
      少了后半句，界面上就会出现一句比实际更强的结论 ——
      那比不做检查更危险：用户会据此省掉自己该做的接口核对。
    */
    const item = itemOf(inspectUi(goodUi(), SPEC, ARCH), 2);

    expect(item.name).toContain("模块 id/名称匹配");
    expect(item.name).toContain("未核实接口契约");

    // 而且它**不能**直接照抄那句验收标准：那句话描述的判据在这里不存在
    const acceptance = STAGE_MAP.ui.acceptance[2];
    expect(item.name).not.toBe(acceptance);
  });

  it("按模块 id 匹配 → 通过；按模块名称匹配也算对上", () => {
    const check = inspectUi(goodUi(), SPEC, ARCH);
    const item = itemOf(check, 2);

    expect(item.pass).toBe(true);
    expect(item.detail).toContain("2 项数据需求");
    // 夹具里一个页面写 id、另一个写名称，两个都要算对上
    expect(item.detail).toContain("task-store");
    expect(item.detail).toContain("board-ui");
  });

  it("对不上模块的数据需求 → 不通过，列出「哪个页面需要什么」和现有模块", () => {
    const ui = goodUi({
      pages: [
        {
          id: "board",
          name: "看板页",
          route: "/",
          coversFeatures: ["ac-1", "ac-2", "ac-3"],
          dataNeeds: ["task-store", "notification-service"],
        },
      ],
    });
    const item = itemOf(inspectUi(ui, SPEC, ARCH), 2);

    expect(item.pass).toBe(false);
    expect(item.detail).toContain("board");
    expect(item.detail).toContain("notification-service");
    // 现有模块也要列出来 —— 用户才知道该改成什么
    expect(item.detail).toContain("task-store");
    expect(item.detail).toContain("board-ui");
  });

  it("每一档 detail 里都带着同一句边界说明，而不是只写在名字里", () => {
    /*
      只把边界写在检查名里是不够的：用户点开详情看的是 detail。
      通过的那一档尤其要带上它 —— 一个绿点最容易被读成"接口都对上了"。
    */
    const boundary = "只做了字面匹配";

    const passing = itemOf(inspectUi(goodUi(), SPEC, ARCH), 2);
    expect(passing.pass).toBe(true);
    expect(passing.detail).toContain(boundary);
    expect(passing.detail).toContain("接口契约");

    const failing = itemOf(
      inspectUi(
        goodUi({
          pages: [
            {
              id: "board",
              name: "看板页",
              route: "/",
              coversFeatures: ["ac-1", "ac-2", "ac-3"],
              dataNeeds: ["ghost"],
            },
          ],
        }),
        SPEC,
        ARCH,
      ),
      2,
    );
    expect(failing.pass).toBe(false);
    expect(failing.detail).toContain(boundary);
    expect(failing.detail).toContain("接口契约");

    // 一条数据需求都没有的那一档也要带上（"无从判定"同样是一句有边界的话）
    const vacuous = itemOf(
      inspectUi(
        goodUi({ pages: goodUi().pages.map((p) => ({ ...p, dataNeeds: [] })) }),
        SPEC,
        ARCH,
      ),
      2,
    );
    expect(vacuous.pass).toBe(true);
    expect(vacuous.detail).toContain(boundary);
  });

  it("没有任何页面声明数据需求 → 通过，但 detail 明说这一条无从判定", () => {
    const item = itemOf(inspectUi(goodUi({ pages: goodUi().pages.map((p) => ({ ...p, dataNeeds: [] })) }), SPEC, ARCH), 2);

    expect(item.pass).toBe(true);
    expect(item.detail).toContain("无从判定");
  });

  it("架构里一个模块都没有 → 不通过（每一项都无从对应，不许当通过）", () => {
    const item = itemOf(inspectUi(goodUi(), SPEC, { modules: [], packages: [] }), 2);

    expect(item.pass).toBe(false);
    expect(item.detail).toContain("一个模块都没有");
  });
});

/* ============================================================
   汇总
   ============================================================ */

describe("三条检查的汇总与顺序", () => {
  it("恰好三条，passed / total 与逐项结果一致", () => {
    const good = inspectUi(goodUi(), SPEC, ARCH);
    expect(good.total).toBe(3);
    expect(good.passed).toBe(3);
    expect(good.results.map((r) => r.pass)).toEqual([true, true, true]);

    // 一份三条全不过的产物：孤儿功能 + 悬空变量 + 对不上的数据需求
    const bad = inspectUi(
      {
        tokens: [],
        pages: [
          {
            id: "board",
            name: "看板页",
            route: "/",
            coversFeatures: ["ac-1"],
            dataNeeds: ["ghost"],
          },
        ],
        components: [{ id: "card", name: "卡", usedOn: ["board"], usesTokens: ["--nope"] }],
      },
      SPEC,
      ARCH,
    );
    expect(bad.total).toBe(3);
    expect(bad.passed).toBe(0);
    expect(bad.results.map((r) => r.pass)).toEqual([false, false, false]);
  });

  it("顺序就是 stages.ts 里验收标准的顺序 —— 界面上要能逐行对上", () => {
    const check = inspectUi(goodUi(), SPEC, ARCH);

    // 前两条与验收标准**逐字相同**：它们判的正是那句话
    expect(check.results[0].name).toBe(STAGE_MAP.ui.acceptance[0]);
    expect(check.results[1].name).toBe(STAGE_MAP.ui.acceptance[1]);

    // 第三条是有意写弱的（见上面那组用例），但顺序仍然是第三位
    expect(check.results[2].name).toContain("数据需求");
    expect(check.results[2].name).toContain("未核实接口契约");
  });

  it("相同输入算两次结果完全一样（纯函数）", () => {
    const ui = goodUi();
    expect(inspectUi(ui, SPEC, ARCH)).toEqual(inspectUi(ui, SPEC, ARCH));
  });
});