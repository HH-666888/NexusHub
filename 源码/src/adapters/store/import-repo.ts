/**
 * 导入一条运行的存储实现
 * ============================================================
 * 「把一个导出文件写回库里」这件事**只有存储层能做**，所以它落在这里。
 *
 * ── 为什么不让接口层自己拼 ──
 *   导入要写四样东西：runs 一行、run_events 一串、cost_records 一串、
 *   外加每个产物一个文件 + 一行登记。这四样**必须一起成立** ——
 *   少了产物，画布上那个运行的「产物」面板就是空的；
 *   少了事件，清单和画布会退化成六道「待规划」。
 *   让接口层一步步调四个 store，等于把这套顺序与补偿逻辑
 *   散在 HTTP 处理器里，而它和 HTTP 一点关系都没有。
 *
 * ── 为什么不用 RunStore / EventStore / CostStore 那几个端口 ──
 *   端口的契约是"业务动作"：create 是"新建一次运行"（时间就是现在），
 *   record 是"记一次刚刚发生的调用"（时间也是现在）。
 *   而导入要的是**原样写回**：运行创建于什么时候、这一笔账发生在什么时候，
 *   都得是导出文件里那个值。用端口逐个写出来，"原样"会在好几处被悄悄改掉，
 *   而每一处看起来都很合理 —— 这正是最难发现的一类失真。
 *
 * ── 先验后写 ──
 *   所有会失败的东西（产物路径合不合法）在**写下第一行之前**就查完。
 *   边写边校验的话，一个坏路径会留下一条"运行在、产物少一个"的记录 ——
 *   而那正是导出时的 `skipped` 想避免的处境：用户看到的东西少了，
 *   却没人告诉他少了什么。宁可整份拒绝，也不留半个运行。
 */

import { eq } from "drizzle-orm";
import { fsArtifactStore } from "./artifact-repo";
import { db } from "./client";
import { costRecords, runEvents, runs } from "./schema";
import { isSafePathSegment, type ArtifactKind } from "@/core/domain/artifact";
import { rebaseArtifactPath } from "@/core/domain/export";
import { newRunId, type RunStatus } from "@/core/domain/run";
import type { RunEventKind } from "@/core/domain/run-event";
import type { StageId } from "@/core/pipeline/stages";

export interface ImportRunPayload {
  /** 导入到谁名下 —— 就是发起导入的那个登录用户，不是导出文件里的原主人 */
  userId: number;
  prompt: string;
  stage: StageId;
  status: RunStatus;
  workflowVersion: string;
  createdAt: number;
  updatedAt: number;
  events: { seq: number; at: number; kind: RunEventKind; payload: unknown }[];
  /**
   * 产物。
   * ⚠️ 这里给的 path 是**导出文件里的原路径**，换根由本函数做 ——
   *    调用方不需要知道"新运行目录"这件事，它只知道文件里写了什么。
   */
  artifacts: { path: string; kind: ArtifactKind; content: string }[];
  costs: {
    stage: string | null;
    nodeId: string | null;
    tier: string;
    model: string;
    purpose: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    costCny: number;
    priceTier: string;
    latencyMs: number;
    createdAt: number;
  }[];
}

/** 和 core/run/service.ts 的 RunResult 同一个形状：失败是一句能读的原因，不是一个异常 */
export type ImportRunResult = { ok: true; runId: string } | { ok: false; reason: string };

/**
 * 把一份导出载荷写成一条新的运行。
 *
 * 返回 ok:false 时**什么都没写**（校验没过）；
 * 抛出时也**什么都没留下**（写到一半失败会把自己写的东西撤干净）。
 */
export async function importRun(payload: ImportRunPayload): Promise<ImportRunResult> {
  const runId = newRunId();

  /* ---------- ① 先验：产物路径 ---------- */
  /*
    产物路径来自**别人给的文件**，所以这里不能假设它是干净的：
    `../` 能把文件写到工作区外面去（artifact-repo.ts 的
    resolveInsideWorkspace 是最后一道防线，但那道防线是"抛异常"，
    走到那里就说明已经写了一半了）。
    所以在这里逐段查一遍，不合格就整份拒绝。
  */
  const artifacts = payload.artifacts.map((a) => ({
    ...a,
    // 换根：<原运行id>/index.html → <新运行id>/index.html。
    // 不换的话会覆盖导出那条运行的产物 —— 理由见 rebaseArtifactPath
    path: rebaseArtifactPath(a.path, runId),
  }));
  for (const a of artifacts) {
    for (const segment of a.path.split("/")) {
      if (!isSafePathSegment(segment)) {
        return {
          ok: false,
          reason: `产物路径里有不合法的片段「${segment}」，整份导入已拒绝（原路径：${a.path}）`,
        };
      }
    }
  }

  try {
    /*
      ---------- ② runs 一行 ----------
      时间用导出文件里的原值，不用 now：
      "这条运行创建于什么时候"是这次导入要还原的事实之一，
      换成导入时刻的话，运行列表里它会挤到最上面，
      看起来像刚做的一次构建 —— 而它其实是几个月前的东西。
    */
    db.insert(runs)
      .values({
        id: runId,
        userId: payload.userId,
        prompt: payload.prompt,
        stage: payload.stage,
        status: payload.status,
        workflowVersion: payload.workflowVersion,
        totalCostCny: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
      })
      .run();

    /*
      ---------- ③ 事件 ----------
      seq **原样保留**。它是回放的坐标（run-event.ts 的 offsetOfSeq 认它），
      重排一遍的话，导出前后两次打开同一条运行，时间轴上的刻度会对不上。
      一批一次事务：和 event-repo 同一个理由（逐条插入会让 SQLite 每行 fsync）。
    */
    if (payload.events.length > 0) {
      db.transaction((tx) => {
        for (const e of payload.events) {
          tx.insert(runEvents)
            .values({
              runId,
              seq: e.seq,
              at: e.at,
              kind: e.kind,
              payload: JSON.stringify(e.payload),
            })
            .run();
        }
      });
    }

    /*
      ---------- ④ 产物 ----------
      走 fsArtifactStore.save 而不是自己写文件：
      路径校验、写文件、算 sha256、登记这几步的顺序和口径
      在 artifact-repo.ts 里已经定好了（先写文件再登记），
      这里再抄一遍就等于有了第二份约定，迟早分叉。
    */
    for (const a of artifacts) {
      await fsArtifactStore.save({
        runId,
        kind: a.kind,
        path: a.path,
        content: a.content,
      });
    }

    /*
      ---------- ⑤ 成本流水 ----------
      createdAt 也原样写回（这里直接插行，不走 CostStore.record ——
      后者的契约是"记一次刚刚发生的调用"，它会写当前时间）。
    */
    if (payload.costs.length > 0) {
      db.transaction((tx) => {
        for (const c of payload.costs) {
          tx.insert(costRecords)
            .values({
              runId,
              stage: c.stage,
              nodeId: c.nodeId,
              tier: c.tier,
              model: c.model,
              purpose: c.purpose,
              inputTokens: c.inputTokens,
              outputTokens: c.outputTokens,
              reasoningTokens: c.reasoningTokens,
              cacheHitTokens: c.cacheHitTokens,
              cacheMissTokens: c.cacheMissTokens,
              costCny: c.costCny,
              priceTier: c.priceTier,
              latencyMs: c.latencyMs,
              createdAt: c.createdAt,
            })
            .run();
        }
      });
    }

    return { ok: true, runId };
  } catch (err) {
    /*
      ---------- 失败：把这次写的东西全撤掉，再原样抛出 ----------
      删 runs 那一行就够了（run_events / cost_records / artifacts
      都有 ON DELETE CASCADE），但产物文件不在库里 ——
      所以要额外走一次 removeByRun 把目录清掉，否则磁盘上会留下
      一堆没人引用的文件，而"导入失败"这件事在界面上是看不出来的。
    */
    try {
      await fsArtifactStore.removeByRun(runId);
      db.delete(runs).where(eq(runs.id, runId)).run();
    } catch {
      // 补偿本身失败也只能算了 —— 不能让它盖掉真正的错误原因
    }
    throw err;
  }
}