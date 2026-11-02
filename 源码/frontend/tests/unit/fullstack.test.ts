/**
 * 全栈编排：顺序、失败即停、事件形状。
 *
 * 用假的模型/工作区/运行时——这里要验的是"编排对不对"，不是模型写得好不好。
 */

import { describe, expect, it, vi } from "vitest";
import { runFullstack, type FullstackEvent } from "@/core/generate/fullstack";
import type { AppSpec } from "@/core/domain/spec";

const SPEC: AppSpec = {
  prompt: "做一个待办",
  goal: "记事情",
  audience: "自己",
  scenarios: [],
  acceptance: [{ id: "a1", statement: "能新增", verifyBy: "点新增", level: "must" }],
  scope: { inScope: [], outOfScope: [] },
  questions: [],
  model: "fake",
  generatedAt: 1,
};

const SQL =
  "CREATE TABLE IF NOT EXISTS todos (id BIGINT PRIMARY KEY, title VARCHAR(64));";
const PY = [
  "from fastapi import FastAPI",
  "import os",
  "app = FastAPI()",
  "DB = os.environ['DATABASE_URL']",
  "@app.get('/health')",
  "def health(): return {'ok': True}",
  "@app.get('/api/todos')",
  "def list_todos(): return []",
].join("\n");
const HTML = "<html><body><script>fetch('/api/todos')</script></body></html>";

/** 按 system 提示词判断这一步该返回什么；返回 null 表示故意给坏的 */
function fakeModel(reply: (system: string) => string | null) {
  return {
    complete: vi.fn(
      async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const text = reply(system);
        if (text === null) throw new Error("model boom");
        return {
          text,
          model: "fake",
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
          costCny: 0.001,
          priceTier: "offPeak" as const,
          latencyMs: 10,
          truncated: false,
          reasoning: "",
        };
      },
    ),
  };
}

function fakeWorkspace() {
  const files = new Map<string, string>();
  return {
    files,
    async write(_runId: string, path: string, content: string) {
      files.set(path, content);
      return { path, bytes: content.length, sha256: "0".repeat(64) };
    },
    async read(_runId: string, path: string) {
      const content = files.get(path);
      if (content === undefined) throw new Error("missing");
      return content;
    },
  };
}

const costs = { record: vi.fn(async () => undefined) } as never;

/**
 * 三个方向的 system 提示词里都出现"数据库"字样，光靠这个词分不开。
 * 用各自独有的一句来认：后端看"可运行的"，前端看"自包含"，剩下的当数据库。
 */
function pickReply(system: string): string {
  if (system.includes("可运行的")) return PY;
  if (system.includes("自包含")) return HTML;
  return SQL;
}

async function collect(
  events: AsyncIterable<FullstackEvent>,
): Promise<FullstackEvent[]> {
  const out: FullstackEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const INPUT = {
  runId: "r_full_0001",
  prompt: "做一个待办",
  spec: SPEC,
  filesDir: "/srv/r_full_0001",
};

describe("runFullstack", () => {
  it("按 数据库→后端→前端→起容器→验证 的顺序产出事件", async () => {
    const workspace = fakeWorkspace();
    const runtime = {
      start: vi.fn(async () => ({
        previewUrl: "http://127.0.0.1:50123",
        status: "running",
      })),
      verify: vi.fn(async () => ({
        layers: [
          { layer: "db" as const, checks: [], passed: 2, total: 2 },
          { layer: "api" as const, checks: [], passed: 1, total: 2 },
          { layer: "ui" as const, checks: [], passed: 1, total: 1 },
        ],
        passed: 4,
        total: 5,
        screenshots: [],
      })),
      stop: vi.fn(async () => undefined),
    };

    const events = await collect(
      runFullstack(
        { model: fakeModel(pickReply) as never, workspace, costs, runtime },
        INPUT,
      ),
    );

    // 三个方向的文件都写了
    expect([...workspace.files.keys()].sort()).toEqual([
      "api/main.py",
      "db/schema.sql",
      "web/index.html",
    ]);
    // 起容器与验证各调用一次
    expect(runtime.start).toHaveBeenCalledWith("r_full_0001", "/srv/r_full_0001");
    expect(runtime.verify).toHaveBeenCalledTimes(1);

    // 事件序列：预览 → 三条 verdict → done
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("preview");
    expect(kinds.filter((k) => k === "verdict")).toHaveLength(3);
    expect(kinds.at(-1)).toBe("done");
  });

  it("数据库方向不合格就停，不会去起容器", async () => {
    const runtime = {
      start: vi.fn(async () => ({ previewUrl: "", status: "running" })),
      verify: vi.fn(),
      stop: vi.fn(),
    };

    const events = await collect(
      runFullstack(
        {
          model: fakeModel(() => "SELECT 1") as never,
          workspace: fakeWorkspace(),
          costs,
          runtime,
        },
        INPUT,
      ),
    );

    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === "done")).toBe(false);
  });

  it("模型调用失败时给出可读错误，不抛异常", async () => {
    const runtime = { start: vi.fn(), verify: vi.fn(), stop: vi.fn() };

    const events = await collect(
      runFullstack(
        {
          model: fakeModel(() => null) as never,
          workspace: fakeWorkspace(),
          costs,
          runtime,
        },
        INPUT,
      ),
    );

    const error = events.find((e) => e.kind === "error");
    expect(error).toBeDefined();
    expect(String((error as { message: string }).message)).toContain("调用失败");
    expect(runtime.start).not.toHaveBeenCalled();
  });
});
describe("方向校验失败会重试一次", () => {
  it("第一次前端不给 /api/ 请求，第二次给了 → 用第二次并落盘", async () => {
    let webCalls = 0;
    const counts = { db: 0, api: 0, web: 0 };
    const BAD = "<html><body>只有文字，没有请求</body></html>";

    const model = {
      complete: async ({
        messages,
      }: {
        messages: Array<{ role: string; content: string }>;
      }) => {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        // 与真实提示词对应的判据：后端看"可运行的"，前端看"自包含"，其余按数据库处理
        let text: string;
        if (system.includes("可运行的")) {
          counts.api += 1;
          text = PY;
        } else if (system.includes("自包含")) {
          counts.web += 1;
          webCalls += 1;
          text = webCalls === 1 ? BAD : HTML;
        } else {
          counts.db += 1;
          text = SQL;
        }
        return {
          text,
          model: "fake",
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
          costCny: 0.001,
          priceTier: "offPeak" as const,
          latencyMs: 10,
          truncated: false,
          reasoning: "",
        };
      },
    };
    const workspace = fakeWorkspace();
    const runtime = {
      start: async () => ({ previewUrl: "http://127.0.0.1:1", status: "running" }),
      verify: async () => ({ layers: [], passed: 0, total: 0, screenshots: [] }),
      stop: async () => undefined,
    };

    const events = await collect(
      runFullstack({ model: model as never, workspace, costs, runtime }, INPUT),
    );

    // 前端调了两次（第二次是重试），其余各一次
    expect(counts.web).toBe(2);
    expect(counts.api).toBe(1);
    expect(workspace.files.get("web/index.html")).toContain("/api/todos");
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });
});
