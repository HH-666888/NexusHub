import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, migrateTempDb, seedUser, setupTempEnv } from "./fixture";

/**
 * 保护运行记录与成本流水（真库）：用量累加、totalCostCny 覆盖、归属与级联删除。
 * 两个相邻字段口径相反，所以各钉一条，免得下一个人顺手统一。
 */

const tmp = setupTempEnv();

// 顺序：env 设好之后才 import adapter（client.ts 在 import 期开库）。
const { sqliteRunStore } = await import("@/adapters/store/run-repo");
const { sqliteCostStore } = await import("@/adapters/store/cost-repo");
const { sqliteEventStore } = await import("@/adapters/store/event-repo");
const { db } = await import("@/adapters/store/client");
const { users } = await import("@/adapters/store/schema");

let userId = 0;
let otherId = 0;

beforeAll(async () => {
  await migrateTempDb();
  userId = await seedUser("alice");
  otherId = await seedUser("bob");
});

afterAll(async () => {
  await closeTempDb(); // 必须先关连接：Windows 上文件被占用时删目录会 EPERM
  tmp.cleanup();
});

const usage = (
  input: number,
  output: number,
  reasoning: number,
): { inputTokens: number; outputTokens: number; reasoningTokens: number; cacheHitTokens: number; cacheMissTokens: number } => ({
  inputTokens: input,
  outputTokens: output,
  reasoningTokens: reasoning,
  cacheHitTokens: 0,
  cacheMissTokens: input,
});

async function newRun(prompt = "做一个任务看板"): Promise<string> {
  const run = await sqliteRunStore.create({ userId, prompt, workflowVersion: "v1" });
  return run.id;
}

describe("运行记录 · 基本读写", () => {
  it("create → findById 往返一致，新运行从第①阶段开始", async () => {
    const id = await newRun("往返一次");
    const run = await sqliteRunStore.findById(id);

    expect(run).not.toBeNull();
    expect(run!.prompt).toBe("往返一次");
    expect(run!.status).toBe("running");
    expect(run!.stage).toBe("spec");
    expect(run!.totalCostCny).toBe(0);
    expect(run!.usage).toEqual(usage(0, 0, 0));
  });

  it("读不存在的 id → null（而不是抛错）", async () => {
    expect(await sqliteRunStore.findById("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("listByUser 只列自己的，且按创建时间倒序", async () => {
    const mine = await newRun("我的第一条");
    await new Promise((r) => setTimeout(r, 2));
    const mine2 = await newRun("我的第二条");
    const other = await sqliteRunStore.create({
      userId: otherId,
      prompt: "别人的",
      workflowVersion: "v1",
    });

    const list = await sqliteRunStore.listByUser(userId);
    const ids = list.map((r) => r.id);
    expect(ids.indexOf(mine2)).toBeLessThan(ids.indexOf(mine));
    expect(ids).not.toContain(other.id);
  });

  it("countByUser 只数自己的", async () => {
    const before = await sqliteRunStore.countByUser(otherId);
    await newRun("再建一条");
    expect(await sqliteRunStore.countByUser(otherId)).toBe(before);
  });
});

describe("运行记录 · 用量是累加的（★ 这条挡过一次真实故障）", () => {
  it("【关键】连续两次 update，用量是**两次之和**", async () => {
    const id = await newRun("累加");
    await sqliteRunStore.update(id, { usage: usage(100, 200, 50) });
    await sqliteRunStore.update(id, { usage: usage(300, 400, 150) });

    const run = await sqliteRunStore.findById(id);
    expect(run!.usage).toEqual(usage(400, 600, 200));
    // 思考那一项单独再钉一次：真实故障里它正是那个被显示成 0 的数字
    expect(run!.usage.reasoningTokens).toBe(200);
  });

  it("★ 反例：只更新一次时**不许**被放大（累加不能变成翻倍）", async () => {
    const id = await newRun("一次");
    await sqliteRunStore.update(id, { usage: usage(7, 8, 9) });

    const run = await sqliteRunStore.findById(id);
    expect(run!.usage).toEqual(usage(7, 8, 9));
  });

  it("★ 反例：不带 usage 的更新（只改状态）不许动用量", async () => {
    const id = await newRun("只改状态");
    await sqliteRunStore.update(id, { usage: usage(5, 6, 7) });
    await sqliteRunStore.update(id, { status: "done" });

    const run = await sqliteRunStore.findById(id);
    expect(run!.usage).toEqual(usage(5, 6, 7));
    expect(run!.status).toBe("done");
  });

  it("【关键】totalCostCny 反而是**覆盖** —— 调用方给的就是累计值", async () => {
    const id = await newRun("金额");
    await sqliteRunStore.update(id, { totalCostCny: 0.1 });
    await sqliteRunStore.update(id, { totalCostCny: 0.25 });

    const run = await sqliteRunStore.findById(id);
    expect(run!.totalCostCny).toBeCloseTo(0.25, 9); // 不是 0.35
  });
});

describe("运行记录 · 归属", () => {
  it("用别人的 userId 删不掉（防伪造 id 越权）", async () => {
    const id = await newRun("删不掉");
    expect(await sqliteRunStore.remove(id, otherId)).toBe(false);
    expect(await sqliteRunStore.findById(id)).not.toBeNull();
  });

  it("本人删除成功，且级联删掉它的会话/事件（外键真的生效）", async () => {
    const id = await newRun("删得掉");
    await sqliteEventStore.appendMany([
      { runId: id, seq: 1, at: 1, kind: "phase", payload: { kind: "phase", phase: "spec", label: "x" } },
    ]);
    expect(await sqliteEventStore.countByRun(id)).toBe(1);

    expect(await sqliteRunStore.remove(id, userId)).toBe(true);
    expect(await sqliteRunStore.findById(id)).toBeNull();
    // 外键 ON + onDelete cascade：事件跟着走（这一条同时验了 client.ts 里那个 pragma）
    expect(await sqliteEventStore.countByRun(id)).toBe(0);
  });
});

describe("成本流水", () => {
  const record = (runId: string, stage: string, costCny: number) =>
    sqliteCostStore.record({
      runId,
      stage,
      nodeId: null,
      tier: "execute",
      model: "fake-model",
      purpose: `${stage} 那一次`,
      usage: usage(10, 20, 5),
      costCny,
      priceTier: "offPeak",
      latencyMs: 100,
    });

  it("按运行落库、按 id 顺序读回（钱花在哪一步要能按发生顺序看）", async () => {
    const id = await newRun("流水");
    await record(id, "spec", 0.01);
    await record(id, "arch", 0.02);
    await record(id, "build", 0.03);

    const rows = await sqliteCostStore.listByRun(id);
    expect(rows.map((r) => r.stage)).toEqual(["spec", "arch", "build"]);
    expect(rows[1].purpose).toBe("arch 那一次");
  });

  it("totalByRun 是流水之和；没花过钱的运行是 0", async () => {
    const id = await newRun("合计");
    await record(id, "spec", 0.01);
    await record(id, "build", 0.02);

    expect(await sqliteCostStore.totalByRun(id)).toBeCloseTo(0.03, 9);
    expect(await sqliteCostStore.totalByRun(await newRun("空"))).toBe(0);
  });

  it("totalByUser 只算这个用户的（别人的钱不算我的）", async () => {
    const mine = await newRun("我的花费");
    await record(mine, "spec", 0.05);
    const otherRun = await sqliteRunStore.create({
      userId: otherId,
      prompt: "别人的花费",
      workflowVersion: "v1",
    });
    await record(otherRun.id, "spec", 100);

    const total = await sqliteCostStore.totalByUser(userId);
    expect(total).toBeGreaterThanOrEqual(0.05);
    expect(total).toBeLessThan(1); // 别人那 100 元不许算进来
  });

  it("runId 可以为空（探测脚本那种独立调用不属于任何运行）", async () => {
    await sqliteCostStore.record({
      runId: null,
      stage: null,
      nodeId: null,
      tier: "decide",
      model: "fake-model",
      purpose: "能力探测",
      usage: usage(1, 2, 3),
      costCny: 0.001,
      priceTier: "offPeak",
      latencyMs: 10,
    });
    // 不抛错就是通过（这一条是回归用的：run_id 那列必须允许为空）
    expect(true).toBe(true);
  });
});

describe("运行事件", () => {
  it("appendMany 落库、listByRun 按 seq 回放，deleteByRun 清空", async () => {
    const id = await newRun("事件");
    await sqliteEventStore.appendMany([
      { runId: id, seq: 1, at: 10, kind: "phase", payload: { kind: "phase", phase: "spec", label: "第一步" } },
      { runId: id, seq: 2, at: 20, kind: "reasoning", payload: { kind: "reasoning", delta: "想了" } },
      { runId: id, seq: 3, at: 30, kind: "text", payload: { kind: "text", delta: "写了" } },
    ]);

    const rows = await sqliteEventStore.listByRun(id);
    expect(rows.map((r) => r.kind)).toEqual(["phase", "reasoning", "text"]);
    expect(rows.map((r) => r.seq)).toEqual([...rows.map((r) => r.seq)].sort((a, b) => a - b));
    expect(rows[1].payload).toEqual({ kind: "reasoning", delta: "想了" });

    expect(await sqliteEventStore.deleteByRun(id)).toBe(3);
    expect(await sqliteEventStore.countByRun(id)).toBe(0);
  });

  it("★ 反例：只属于这条运行的事件才读得到（别人的事件不许串进来）", async () => {
    const mine = await newRun("我的事件");
    const theirs = await sqliteRunStore.create({
      userId: otherId,
      prompt: "别人的事件",
      workflowVersion: "v1",
    });
    await sqliteEventStore.appendMany([
      { runId: mine, seq: 1, at: 1, kind: "phase", payload: { kind: "phase", phase: "spec", label: "我的" } },
    ]);
    await sqliteEventStore.appendMany([
      { runId: theirs.id, seq: 1, at: 1, kind: "phase", payload: { kind: "phase", phase: "spec", label: "别人的" } },
    ]);

    const rows = await sqliteEventStore.listByRun(mine);
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { label: string }).label).toBe("我的");
  });

  it("外键：给不存在的运行写事件会被拒绝（数据不许无主）", async () => {
    await expect(
      sqliteEventStore.appendMany([
        {
          runId: "00000000-0000-0000-0000-000000000000",
          seq: 1,
          at: 1,
          kind: "phase",
          payload: { kind: "phase", phase: "spec", label: "孤儿" },
        },
      ]),
    ).rejects.toThrow();
  });
});

describe("夹具本身", () => {
  it("跑的是**临时库**，不是仓库里那个 data/nexus.db", () => {
    // 这条断言不验产品，验的是"测试没有误伤演示素材"
    expect(tmp.dbPath).toContain("nexus-adapters-");
    expect(tmp.dbPath).not.toContain("data");
    expect(process.env.DATABASE_PATH).toBe(tmp.dbPath);
  });

  it("users 表在这个临时库里真的有数据（说明迁移跑过了）", () => {
    const rows = db.select().from(users).all();
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});