/**
 * 按文件名读 json 产物。
 * 不能用 findLatest(runId, "json")：answers.json 也是 json 且后写，会把答案当成规格。
 */

import { fsArtifactStore } from "@/adapters/store/artifact-repo";

/**
 * 读指定文件名的 json 产物；三种失败都返回 null，需要区分原因时用下面的 loadJsonArtifact。
 * 文件名按 endsWith('/<name>') 匹配，避免子串误命中。
 * 三种失败对应接口层的 409 与 500 两种状态码。
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

/** 失败原因；界面与接口需要区分没这份产物与读不出来 */
export type JsonArtifactFailure = "missing" | "unreadable" | "bad-json";

export type JsonArtifactResult<T> =
  { ok: true; value: T } | { ok: false; reason: JsonArtifactFailure };

/** 需要区分失败原因时用这个，例如决定接口回 409 还是 500 */
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
