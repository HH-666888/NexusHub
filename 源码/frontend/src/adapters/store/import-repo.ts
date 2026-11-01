/**
 * 导入一条运行的存储实现：runs、事件、产物与成本必须一起成立，故整体落在此处。
 * 要求原样写回（创建时间、发生时刻取文件里的值），因此不走端口而直接插行。
 * 先验后写：路径校验在写入第一行之前完成，宁可整份拒绝也不留半个运行。
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
  /** 归属为发起导入的登录用户，不是导出文件里的原主人 */
  userId: number;
  prompt: string;
  stage: StageId;
  status: RunStatus;
  workflowVersion: string;
  createdAt: number;
  updatedAt: number;
  events: { seq: number; at: number; kind: RunEventKind; payload: unknown }[];
  /**
   * 产物；path 是导出文件里的原路径，换根由本函数负责。
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

/** 与 core/run/service.ts 的 RunResult 同形：失败是可读原因而非异常 */
export type ImportRunResult =
  { ok: true; runId: string } | { ok: false; reason: string };

/**
 * 把一份导出载荷写成一条新运行。
 * ok:false 表示校验未过、什么都没写；抛出时会撤销本次已写入的内容。
 */
export async function importRun(payload: ImportRunPayload): Promise<ImportRunResult> {
  const runId = newRunId();

  // ① 先验：产物路径
  // 路径来自外部文件，不能假设干净：逐段检查，不合格整份拒绝，
  // 避免写到工作区之外，或写了一半才失败。
  const artifacts = payload.artifacts.map((a) => ({
    ...a,
    // 换根 <原运行id>/ → <新运行id>/，否则会覆盖导出那条运行的产物
    path: rebaseArtifactPath(a.path, runId),
  }));
  for (const a of artifacts) {
    for (const segment of a.path.split("/")) {
      if (!isSafePathSegment(segment)) {
        return {
          ok: false,
          reason: `产物路径里有不合法的片段“${segment}”，整份导入已拒绝（原路径：${a.path}）`,
        };
      }
    }
  }

  try {
    // 时间用文件里的原值：换成导入时刻会让旧运行挤到列表最上方，像是刚做的构建。
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

    // seq 原样保留，它是回放的坐标；一批一次事务，避免逐条插入各自 fsync。
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

    // 走 fsArtifactStore.save：路径校验、写文件、算哈希、登记的顺序已在那里定好，
    // 此处再抄一遍等于有两份约定。
    for (const a of artifacts) {
      await fsArtifactStore.save({
        runId,
        kind: a.kind,
        path: a.path,
        content: a.content,
      });
    }

    // createdAt 原样写回，故直接插行而不走 CostStore.record（后者写当前时间）
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
    // 失败时撤销本次写入：删 runs 行即级联清掉库内数据，产物文件另需 removeByRun。
    try {
      await fsArtifactStore.removeByRun(runId);
      db.delete(runs).where(eq(runs.id, runId)).run();
    } catch {
      // 补偿本身失败也只能算了 —— 不能让它盖掉真正的错误原因
    }
    throw err;
  }
}
