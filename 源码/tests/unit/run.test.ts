import { beforeEach, describe, expect, it } from "vitest";
import {
  checkPrompt,
  describeTime,
  emptyUsage,
  newRunId,
  PROMPT_MAX,
  type NewRun,
  type Run,
} from "@/core/domain/run";
import type { RunStore } from "@/core/ports/run-store";
import { createRun, deleteRun, getOwnedRun, listRuns } from "@/core/run/service";

/**
 * 保护一句话输入的校验与归一化、相对时间描述、运行 id，
 * 以及运行服务的创建、归属校验与列表。
 */
describe("一句话输入的校验与归一化", () => {
  it("正常输入通过，并去掉首尾空白", () => {
    const r = checkPrompt("  做一个待办清单  ");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("做一个待办清单");
  });

  it("合并连续空白与换行", () => {
    const r = checkPrompt("做一个   团队\n\n任务\t看板");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("做一个 团队 任务 看板");
  });

  it("去掉零宽字符与控制字符 —— 从别处粘贴时常夹带这些", () => {
    const r = checkPrompt("做一个\u200B待办\uFEFF清单\u0007");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("做一个 待办 清单");
  });

  it("太短被拒绝", () => {
    const r = checkPrompt("好");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("太短");
  });

  it("只有空白也被拒绝", () => {
    expect(checkPrompt("        ").ok).toBe(false);
  });

  it("过长被拒绝，边界值恰好通过", () => {
    expect(checkPrompt("啊".repeat(PROMPT_MAX)).ok).toBe(true);
    const r = checkPrompt("啊".repeat(PROMPT_MAX + 1));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("太长");
  });
});

// 时间描述
describe("相对时间描述", () => {
  const now = 1_800_000_000_000;
  const min = 60_000;

  it("一分钟内是“刚刚”", () => {
    expect(describeTime(now - 30_000, now)).toBe("刚刚");
  });

  it("分钟级与小时级", () => {
    expect(describeTime(now - 5 * min, now)).toBe("5 分钟前");
    expect(describeTime(now - 3 * 60 * min, now)).toBe("3 小时前");
  });

  it("一天左右显示“昨天”", () => {
    expect(describeTime(now - 30 * 60 * min, now)).toBe("昨天");
  });

  it("更久显示天数", () => {
    expect(describeTime(now - 5 * 24 * 60 * min, now)).toBe("5 天前");
  });

  it("未来时间不出现负数，按“刚刚”处理", () => {
    expect(describeTime(now + 10 * min, now)).toBe("刚刚");
  });
});

// 运行 id
describe("运行 id", () => {
  it("每次生成都不同，且不可枚举", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(newRunId());
    expect(ids.size).toBe(200);
    // UUID v4 格式
    expect(newRunId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("空用量全是零", () => {
    const u = emptyUsage();
    expect(Object.values(u).every((v) => v === 0)).toBe(true);
  });
});

// 运行服务用内存假存储，不碰数据库。
function createFakeRunStore(): RunStore & { _runs: Map<string, Run> } {
  const _runs = new Map<string, Run>();

  return {
    _runs,
    async create(data: NewRun) {
      const now = Date.now();
      const run: Run = {
        id: newRunId(),
        userId: data.userId,
        prompt: data.prompt,
        stage: "spec",
        status: "running",
        workflowVersion: data.workflowVersion,
        totalCostCny: 0,
        usage: emptyUsage(),
        createdAt: now,
        updatedAt: now,
      };
      _runs.set(run.id, run);
      return run;
    },
    async findById(id) {
      return _runs.get(id) ?? null;
    },
    async listByUser(userId, limit = 50) {
      return [..._runs.values()]
        .filter((r) => r.userId === userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
    },
    async update(id, patch) {
      const r = _runs.get(id);
      if (!r) return;
      _runs.set(id, {
        ...r,
        stage: patch.stage ?? r.stage,
        status: patch.status ?? r.status,
        totalCostCny: patch.totalCostCny ?? r.totalCostCny,
        usage: patch.usage ?? r.usage,
        updatedAt: Date.now(),
      });
    },
    async remove(id, userId) {
      const r = _runs.get(id);
      if (!r || r.userId !== userId) return false;
      _runs.delete(id);
      return true;
    },
    async countByUser(userId) {
      return [..._runs.values()].filter((r) => r.userId === userId).length;
    },
  };
}

describe("创建运行", () => {
  let store: ReturnType<typeof createFakeRunStore>;

  beforeEach(() => {
    store = createFakeRunStore();
  });

  it("创建成功，初始状态是“进行中”、停在第一道工序", async () => {
    const r = await createRun(store, {
      userId: 1,
      prompt: "做一个团队任务看板",
      workflowVersion: "v1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stage).toBe("spec");
    expect(r.value.status).toBe("running");
    expect(r.value.totalCostCny).toBe(0);
    expect(r.value.usage.inputTokens).toBe(0);
    expect(store._runs.size).toBe(1);
  });

  it("入库的是归一化之后的文本，不是原始输入", async () => {
    const r = await createRun(store, {
      userId: 1,
      prompt: "  做一个   待办清单  ",
      workflowVersion: "v1",
    });
    expect(r.ok && r.value.prompt).toBe("做一个 待办清单");
  });

  it("校验不通过时不写库", async () => {
    const r = await createRun(store, {
      userId: 1,
      prompt: "好",
      workflowVersion: "v1",
    });
    expect(r.ok).toBe(false);
    expect(store._runs.size).toBe(0);
  });

  it("不同用户的记录互不干扰", async () => {
    await createRun(store, {
      userId: 1,
      prompt: "用户一的活儿",
      workflowVersion: "v1",
    });
    await createRun(store, {
      userId: 2,
      prompt: "用户二的活儿",
      workflowVersion: "v1",
    });

    const u1 = await listRuns(store, 1);
    const u2 = await listRuns(store, 2);
    expect(u1).toHaveLength(1);
    expect(u2).toHaveLength(1);
    expect(u1[0].prompt).toBe("用户一的活儿");
    expect(u2[0].prompt).toBe("用户二的活儿");
  });
});

describe("归属校验 —— 这是防越权的关键", () => {
  let store: ReturnType<typeof createFakeRunStore>;
  let ownedId: string;

  beforeEach(async () => {
    store = createFakeRunStore();
    const r = await createRun(store, {
      userId: 1,
      prompt: "属于用户一的构建",
      workflowVersion: "v1",
    });
    if (!r.ok) throw new Error("准备失败");
    ownedId = r.value.id;
  });

  it("本人可以取到", async () => {
    expect(await getOwnedRun(store, ownedId, 1)).not.toBeNull();
  });

  it("别人拿到 id 也取不到 —— 猜到 id 不等于有权访问", async () => {
    expect(await getOwnedRun(store, ownedId, 2)).toBeNull();
  });

  it("不存在的 id 返回 null，不抛异常", async () => {
    expect(await getOwnedRun(store, "not-a-real-id", 1)).toBeNull();
  });

  it("别人无法删除我的记录", async () => {
    expect(await deleteRun(store, ownedId, 2)).toBe(false);
    expect(store._runs.has(ownedId)).toBe(true);
  });

  it("本人可以删除", async () => {
    expect(await deleteRun(store, ownedId, 1)).toBe(true);
    expect(store._runs.has(ownedId)).toBe(false);
  });
});

describe("构建记录列表", () => {
  it("按创建时间倒序，最新的在前", async () => {
    const store = createFakeRunStore();
    for (const p of ["第一个活儿", "第二个活儿", "第三个活儿"]) {
      await createRun(store, { userId: 1, prompt: p, workflowVersion: "v1" });
      // 保证时间戳有区分度
      await new Promise((r) => setTimeout(r, 2));
    }
    const list = await listRuns(store, 1);
    expect(list.map((r) => r.prompt)).toEqual([
      "第三个活儿",
      "第二个活儿",
      "第一个活儿",
    ]);
  });

  it("limit 生效", async () => {
    const store = createFakeRunStore();
    for (let i = 0; i < 5; i++) {
      await createRun(store, {
        userId: 1,
        prompt: `第 ${i} 个活儿`,
        workflowVersion: "v1",
      });
    }
    expect(await listRuns(store, 1, 2)).toHaveLength(2);
  });
});
