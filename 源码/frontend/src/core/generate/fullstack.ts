/**
 * 全栈编排：数据库 → 后端 → 前端 → 起容器 → 三层验证。
 *
 * 只在这一条链路上负责"按顺序调用与把结果变成事件"，不重写六个方向内部的事
 * （那些在 generate/directions.ts）。任何一步失败都立刻返回，原因原样带出。
 */

import type { CostStore } from "../ports/cost-store";
import type { ModelPort } from "../ports/model";
import type { Workspace } from "../ports/workspace";
import type { AppSpec } from "../domain/spec";
import type { Verdict } from "@/adapters/runtime/client";
import type { GenerateEvent } from "./service";
import {
  runApiDirection,
  runDbDirection,
  runWebDirection,
  type DirectionEvent,
} from "./directions";

export interface RuntimePort {
  start(
    runId: string,
    filesDir: string,
  ): Promise<{ previewUrl: string; status: string }>;
  verify(runId: string): Promise<Verdict>;
  stop(runId: string): Promise<void>;
}

export interface FullstackDeps {
  model: ModelPort;
  workspace: Workspace;
  costs: CostStore;
  runtime: RuntimePort;
}

export interface FullstackInput {
  runId: string;
  prompt: string;
  spec: AppSpec;
  /** 产物工作区的绝对路径（后端要按这个路径挂载） */
  filesDir: string;
}

export type FullstackEvent =
  | DirectionEvent
  | { kind: "preview"; url: string; ready: boolean }
  | { kind: "verdict"; layer: "db" | "api" | "ui"; passed: number; total: number }
  | { kind: "done"; verdict: Verdict };

/** 跑完整条全栈链路，逐个事件吐出。第一个失败即停止（后面没有意义） */
export async function* runFullstack(
  deps: FullstackDeps,
  input: FullstackInput,
): AsyncIterable<FullstackEvent> {
  const directionDeps = {
    model: deps.model,
    workspace: deps.workspace,
    costs: deps.costs,
  };

  for (const stage of [runDbDirection, runApiDirection, runWebDirection]) {
    let ok = true;
    for await (const event of stage(directionDeps, input)) {
      yield event;
      if (event.kind === "error") ok = false;
    }
    if (!ok) return;
  }

  /*
    起之前先停：续跑会重写 api/web，旧进程跑的是上一版代码。
    不停就会出现"新代码 + 旧进程"的组合，验证结果与源码对不上，比失败更难查。
  */
  try {
    await deps.runtime.stop(input.runId);
  } catch {
    // 本来就没在跑
  }

  let started: { previewUrl: string; status: string };
  try {
    started = await deps.runtime.start(input.runId, input.filesDir);
  } catch (err) {
    yield {
      kind: "error",
      message: `起容器失败：${err instanceof Error ? err.message : String(err)}`,
      hint: "确认后端在跑、本机有 docker；也可以先看工作区里的文件",
    };
    return;
  }
  yield {
    kind: "preview",
    url: started.previewUrl,
    ready: started.status === "running",
  };

  let verdict: Verdict;
  try {
    verdict = await deps.runtime.verify(input.runId);
  } catch (err) {
    yield {
      kind: "error",
      message: `验证失败：${err instanceof Error ? err.message : String(err)}`,
      hint: "容器可能已经退出；看看日志再重试",
    };
    return;
  }

  for (const layer of verdict.layers) {
    yield {
      kind: "verdict",
      layer: layer.layer,
      passed: layer.passed,
      total: layer.total,
    };
  }
  yield { kind: "done", verdict };
}

/**
 * 全栈事件 → 通用 GenerateEvent。
 *
 * 界面只认一套事件；这里把"全栈特有的形状"翻译成它认识的那几种。
 * 不新增渲染分支，先用既有卡片承载（后续 G 阶段再加专属卡片）。
 */
export function toGenerateEvent(event: FullstackEvent): GenerateEvent {
  switch (event.kind) {
    case "phase":
    case "error":
    case "tool":
    case "verdict":
    case "preview":
      return event;
    case "files":
      return {
        kind: "phase",
        phase: "building",
        label: `已写出 ${event.files.length} 个文件：${event.files.map((f) => f.path).join("、")}`,
      };
    case "done": {
      const { verdict } = event;
      return {
        kind: "phase",
        phase: verdict.passed === verdict.total ? "done" : "failed",
        label:
          verdict.passed === verdict.total
            ? `三层验证全部通过（${verdict.total} 项）`
            : `验收有未通过项：${verdict.passed}/${verdict.total}`,
      };
    }
  }
}
