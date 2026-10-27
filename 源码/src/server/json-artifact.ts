/**
 * 按**文件名**读 json 产物
 * ============================================================
 * ── 为什么不能写成 findLatest(runId, "json") ──
 *   spec.json 与 answers.json 都是 json 类型，而 answers.json 是后写的。
 *   "取最新的那个 json" 于是在用户答过一轮之后就会拿到**答案**当成规格：
 *   门禁按它算疑问 → 算不出来 → 行为诡异，而且不报错。
 *
 *   generate 那条路由早就吃过这个亏，所以在它内部写了一个按文件名找的版本；
 *   而 answers 那条路由一直用的是 findLatest —— 在"续跑会重跑规格化"的年代
 *   这件事碰巧看不出来（重跑会把 spec.json 重新写成最新的），
 *   直到续跑改成"沿用已确认的规格"之后才暴露：
 *   用户分两次答题时，第二次会把 answers.json 当规格读，直接 400
 *   （"没有提交任何有效的回答"），而他明明答了。
 *
 *   所以把它提到这里共用 —— 两个调用方各写一份，迟早只有一份是对的。
 */

import { fsArtifactStore } from "@/adapters/store/artifact-repo";

/**
 * 读一个指定文件名的 json 产物。
 *
 * 三种失败（没这份产物 / 文件读不出来 / 内容不是合法 JSON）都返回 null：
 * 调用方要的大多是"有没有可用的值"。需要区分原因时，
 * 用下面的 `loadJsonArtifact`。
 */
export async function readJsonArtifact<T>(
  runId: string,
  fileName: string,
): Promise<T | null> {
  const all = await fsArtifactStore.listByRun(runId);
  const hit = all.find((a) => a.path.endsWith(`/${fileName}`));
  if (!hit) return null;
  const raw = await fsArtifactStore.readContent(hit);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 失败原因。"没这份产物"与"读不出来"是两件事，界面/接口要能分开说 */
export type JsonArtifactFailure = "missing" | "unreadable" | "bad-json";

export type JsonArtifactResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: JsonArtifactFailure };

/** 需要区分失败原因时用这个（例如接口要回 409 还是 500） */
export async function loadJsonArtifact<T>(
  runId: string,
  fileName: string,
): Promise<JsonArtifactResult<T>> {
  const all = await fsArtifactStore.listByRun(runId);
  const hit = all.find((a) => a.path.endsWith(`/${fileName}`));
  if (!hit) return { ok: false, reason: "missing" };
  const raw = await fsArtifactStore.readContent(hit);
  if (raw === null) return { ok: false, reason: "unreadable" };
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false, reason: "bad-json" };
  }
}