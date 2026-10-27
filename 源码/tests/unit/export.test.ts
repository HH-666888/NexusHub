import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  buildExport,
  exportFileName,
  parseExport,
  rebaseArtifactPath,
  type NexusExport,
} from "@/core/domain/export";

/* ============================================================
   导出 / 导入的领域模型
   ------------------------------------------------------------
   这一期要兑现的是用户那句话：「换一个地方旧项目就没有了，
   或者打开是空的」。

   所以下面所有用例其实只在守**一条性质**：
     **导出去的东西，导回来必须一模一样。**

   它有三层意思，缺一层这句话就不成立：
     ① 该在的都在（parseExport 认得自己的产物，且不悄悄补、不悄悄丢）；
     ② 不该在的不在（版本不对、形状不对的一律拒绝，不许"当成 1 处理"）；
     ③ 往返之后逐字段相同（deep equal —— 不是"关键字段对得上"）。

   为什么第 ③ 条必须用 deep equal：
     因为这正是最容易失守的地方。少一个 at，回放的时间轴就只能是编的；
     少一个 tier，事后就答不出"钱花在哪个档位上"。
     而这两种失真都不会让**界面报错** —— 它只会让用户在另一台电脑上
     看到一个"看起来没问题"的残缺项目。用逐字段比对才拦得住。
   ============================================================ */

/** 一条形状完整的运行 —— 下面绝大多数用例都从它出发 */
const RUN: NexusExport["run"] = {
  id: "run-abc",
  prompt: "做一个番茄钟",
  stage: "build",
  status: "done",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000,
};

const NOW = 1_700_000_100_000;

/** 组装一份**合法**的导出载荷（走 buildExport，不手抄形状） */
function validExport(): NexusExport {
  return buildExport({
    run: { ...RUN },
    events: [
      {
        seq: 0,
        at: 1_700_000_000_000,
        payload: {
          kind: "phase",
          phase: "spec",
          label: "正在把你的需求整理成规格",
        },
      },
      { seq: 1, at: 1_700_000_001_000, payload: { kind: "text", delta: "好的" } },
      {
        seq: 2,
        at: 1_700_000_002_000,
        payload: { kind: "check", results: [], summary: { total: 0, passed: 0, failed: 0, failures: [] } },
      },
    ],
    artifacts: [
      { path: "run-abc/index.html", kind: "html", content: "<html>番茄钟</html>" },
      { path: "run-abc/spec.json", kind: "json", content: '{"a":1}' },
    ],
    costs: [
      {
        stage: "spec",
        model: "deepseek-flash",
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
        costCny: 0.0123,
        priceTier: "offPeak",
        latencyMs: 1200,
        createdAt: 1_700_000_000_500,
        nodeId: "spec",
        tier: "decide",
        purpose: "规格化",
        cacheHitTokens: 30,
        cacheMissTokens: 70,
      },
    ],
    skipped: [{ path: "run-abc/huge.bin", reason: "单个产物 9MB，超过 1024KB 上限" }],
    now: NOW,
  });
}

/** 走一趟真实的搬运路径：组装 → 落成 JSON 文本 → 再解析回来 */
function roundTrip(payload: NexusExport): NexusExport | null {
  return parseExport(JSON.parse(JSON.stringify(payload)));
}

describe("parseExport：合法的文件必须通过", () => {
  it("一份自己组装出来的导出文件，解析回来逐字段相同（不是「关键字段对得上」）", () => {
    const before = validExport();
    const after = roundTrip(before);
    expect(after).not.toBeNull();
    expect(after).toEqual(before);
  });

  it("三个数组的元素确实是**同一个值**，不是被重新造了一遍", () => {
    const before = validExport();
    const after = roundTrip(before)!;
    // 事件：seq / at / payload 三者都在，且 payload 内容一致
    expect(after.events).toHaveLength(3);
    expect(after.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(after.events.map((e) => e.at)).toEqual([
      1_700_000_000_000, 1_700_000_001_000, 1_700_000_002_000,
    ]);
    expect(after.events[1].payload).toEqual({ kind: "text", delta: "好的" });
    // 产物：内容一个字不改
    expect(after.artifacts[0].content).toBe("<html>番茄钟</html>");
    // 成本：新版才有的那几个字段也在（老形状的文件里没有它们）
    expect(after.costs[0].nodeId).toBe("spec");
    expect(after.costs[0].tier).toBe("decide");
    expect(after.costs[0].cacheHitTokens).toBe(30);
  });

  it("skipped 原样带回来 —— 被跳过的产物不许在往返里消失", () => {
    const after = roundTrip(validExport())!;
    expect(after.skipped).toEqual([
      { path: "run-abc/huge.bin", reason: "单个产物 9MB，超过 1024KB 上限" },
    ]);
  });
});

describe("parseExport：形状不对的一律拒绝（返回 null，不抛）", () => {
  it("format 不是 nexus-run → null", () => {
    const bad = { ...validExport(), format: "something-else" };
    expect(parseExport(bad)).toBeNull();
  });

  it("version = 2（未来的版本）→ null，绝不「当成 1 处理」", () => {
    const bad = { ...validExport(), version: 2 };
    expect(parseExport(bad)).toBeNull();
  });

  it("version 是字符串「1」→ null（类型不对也是不对）", () => {
    const bad = { ...validExport(), version: "1" };
    expect(parseExport(bad)).toBeNull();
  });

  it("缺 run.id → null", () => {
    const v = validExport();
    const bad = { ...v, run: { ...v.run, id: undefined } };
    expect(parseExport(bad)).toBeNull();
  });

  it("run.id 是空串 → null（有键但没有值，等于没有身份）", () => {
    const v = validExport();
    const bad = { ...v, run: { ...v.run, id: "   " } };
    expect(parseExport(bad)).toBeNull();
  });

  it("缺 run.prompt → null", () => {
    const v = validExport();
    const bad = { ...v, run: { ...v.run, prompt: undefined } };
    expect(parseExport(bad)).toBeNull();
  });

  it("events 不是数组 → null", () => {
    expect(parseExport({ ...validExport(), events: "零条" })).toBeNull();
  });

  it("artifacts 不是数组 → null", () => {
    expect(parseExport({ ...validExport(), artifacts: null })).toBeNull();
  });

  it("costs 不是数组 → null", () => {
    expect(parseExport({ ...validExport(), costs: {} })).toBeNull();
  });

  it("events 里混了一个字符串 → null（这里根本不是一条事件，补不出东西）", () => {
    const v = validExport();
    expect(parseExport({ ...v, events: [...v.events, "这是被改坏的一行"] })).toBeNull();
  });

  it("产物的 path 是空串 → null（没有路径就写不出文件）", () => {
    const v = validExport();
    const bad = { ...v, artifacts: [{ path: "  ", kind: "html", content: "x" }] };
    expect(parseExport(bad)).toBeNull();
  });

  it("顶层是 null / 字符串 / 数字 / 数组 / undefined → 全是 null", () => {
    for (const bad of [null, undefined, "nexus-run", 42, true, [validExport()]]) {
      expect(parseExport(bad)).toBeNull();
    }
  });
});

describe("parseExport：缺失的字段补安全默认（而不是拒绝）", () => {
  it("skipped 整个缺失 → 当空数组", () => {
    const v = validExport();
    const { skipped: _drop, ...withoutSkipped } = v;
    const parsed = parseExport(withoutSkipped);
    expect(parsed).not.toBeNull();
    expect(parsed!.skipped).toEqual([]);
  });

  it("skipped 不是数组（比如写成了字符串）→ 也当空数组", () => {
    const parsed = parseExport({ ...validExport(), skipped: "没有" });
    expect(parsed).not.toBeNull();
    expect(parsed!.skipped).toEqual([]);
  });

  it("缺 exportedAt → 从 run.createdAt 推一个合法 ISO，而不是 1970 那种假占位", () => {
    const v = validExport();
    const { exportedAt: _drop, ...withoutAt } = v;
    const parsed = parseExport(withoutAt)!;
    expect(parsed.exportedAt).toBe(new Date(RUN.createdAt).toISOString());
  });

  it("缺 run.stage / run.status → 补最保守的取值（还没开始跑）", () => {
    const v = validExport();
    const parsed = parseExport({
      ...v,
      run: { id: v.run.id, prompt: v.run.prompt },
    })!;
    expect(parsed.run.stage).toBe("spec");
    expect(parsed.run.status).toBe("running");
  });

  it("缺 updatedAt → 回落到 createdAt（不能补成 0，那会让界面说「从 1970 年起就没动过」）", () => {
    const v = validExport();
    const parsed = parseExport({
      ...v,
      run: { ...v.run, updatedAt: undefined },
    })!;
    expect(parsed.run.updatedAt).toBe(RUN.createdAt);
  });

  it("缺产物的 kind / content → 补「text」与空串（文件在、内容是空的，仍算成功导出）", () => {
    const v = validExport();
    const parsed = parseExport({ ...v, artifacts: [{ path: "run-abc/a.txt" }] })!;
    expect(parsed.artifacts).toEqual([{ path: "run-abc/a.txt", kind: "text", content: "" }]);
  });

  it("缺事件的 seq → 用它的下标补（顺序不能丢）", () => {
    const v = validExport();
    const parsed = parseExport({
      ...v,
      events: [{ payload: { kind: "text", delta: "甲" } }, { payload: { kind: "text", delta: "乙" } }],
    })!;
    expect(parsed.events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it("事件缺 at → 这一条**不带这个键**（而不是带一个 undefined）", () => {
    const v = validExport();
    const parsed = parseExport({ ...v, events: [{ seq: 7, payload: { kind: "text", delta: "甲" } }] })!;
    expect(parsed.events[0]).toEqual({ seq: 7, payload: { kind: "text", delta: "甲" } });
    expect("at" in parsed.events[0]).toBe(false);
  });
});

describe("buildExport：组装出来的东西自己得先站得住", () => {
  it("exportedAt 是一个合法的 ISO 字符串（且就是 now 那一刻）", () => {
    const e = validExport();
    expect(e.exportedAt).toBe(new Date(NOW).toISOString());
    // 反过来转一遍也必须相等 —— 这才叫"合法的 ISO"
    expect(new Date(e.exportedAt).toISOString()).toBe(e.exportedAt);
  });

  it("format / version 写的是常量，不是硬编码的字面量", () => {
    const e = validExport();
    expect(e.format).toBe(EXPORT_FORMAT);
    expect(e.version).toBe(EXPORT_VERSION);
    expect(EXPORT_FORMAT).toBe("nexus-run");
    expect(EXPORT_VERSION).toBe(1);
  });

  it("skipped 原样带上（跳过了什么，文件里就得写着什么）", () => {
    const skipped = [
      { path: "run-abc/a.html", reason: "太大" },
      { path: "run-abc/b.html", reason: "读不到" },
    ];
    const e = buildExport({ ...validExport(), skipped, now: NOW });
    expect(e.skipped).toEqual(skipped);
  });

  it("导出的形状由这个文件说了算：事件上多的字段不会被顺手带出去", () => {
    const e = buildExport({
      ...validExport(),
      events: [
        { seq: 0, at: 5, payload: { kind: "text", delta: "甲" }, 顺手夹带的字段: 1 },
      ] as unknown as NexusExport["events"],
      now: NOW,
    });
    expect(Object.keys(e.events[0]).sort()).toEqual(["at", "payload", "seq"]);
  });
});

describe("exportFileName：文件名不能拿用户那句话直接当路径", () => {
  it("普通中文：前 20 字 + .nexus.json", () => {
    expect(exportFileName("做一个番茄钟")).toBe("做一个番茄钟.nexus.json");
  });

  it("路径分隔符与 Windows 保留字符全部去掉", () => {
    expect(exportFileName('a/b:c*d?e"f<g>h|i')).toBe("abcdefghi.nexus.json");
    // 反斜杠是路径分隔符里最危险的那个（Windows 上它就是目录分隔符）
    expect(exportFileName("a\\b")).toBe("ab.nexus.json");
    // 换行之类的控制字符在 Windows 上同样不允许出现在文件名里
    expect(exportFileName("番\n茄")).toBe("番茄.nexus.json");
  });

  it("空 prompt（或只有空白）→ 回落到 nexus-run.nexus.json", () => {
    expect(exportFileName("")).toBe("nexus-run.nexus.json");
    expect(exportFileName("    ")).toBe("nexus-run.nexus.json");
    // 洗干净之后什么都不剩，也要回落 —— 否则会得到一个只有后缀的文件名
    expect(exportFileName('///:::')).toBe("nexus-run.nexus.json");
  });

  it("超长只取前 20 个字", () => {
    const long = "一".repeat(30);
    expect(exportFileName(long)).toBe("一".repeat(20) + ".nexus.json");
  });

  it("首尾的点与空白去掉，中间的不动（「番茄钟 v1.2」不该被改）", () => {
    expect(exportFileName("...番茄钟...")).toBe("番茄钟.nexus.json");
    expect(exportFileName("  番茄钟  ")).toBe("番茄钟.nexus.json");
    expect(exportFileName("番茄钟 v1.2")).toBe("番茄钟 v1.2.nexus.json");
  });

  it("结果里永远不含路径分隔符（无论输入多脏）—— 它决定不了这个文件存到哪去", () => {
    for (const dirty of ["../../etc/passwd", "C:\\Windows\\system32", "a/b\\c", ".."]) {
      const name = exportFileName(dirty);
      expect(name).not.toMatch(/[\\/]/);
      expect(name.endsWith(".nexus.json")).toBe(true);
    }
  });
});

describe("rebaseArtifactPath：导入不能覆盖导出那条运行的产物", () => {
  it("只换最外层那一段（运行目录），文件名一个字不动", () => {
    expect(rebaseArtifactPath("run-abc/index.html", "run-new")).toBe("run-new/index.html");
  });

  it("运行目录里的小目录也照旧（相对布局不动）", () => {
    expect(rebaseArtifactPath("run-abc/modules/a.css", "run-new")).toBe(
      "run-new/modules/a.css",
    );
  });

  it("没有运行目录的路径（只有一个文件名）→ 挂到新运行目录下，而不是落到工作区根上", () => {
    expect(rebaseArtifactPath("index.html", "run-new")).toBe("run-new/index.html");
  });

  it("换出来的路径不会和原路径相等 —— 否则导入就有覆盖别人产物的可能", () => {
    const original = "run-abc/index.html";
    expect(rebaseArtifactPath(original, "run-new")).not.toBe(original);
  });
});