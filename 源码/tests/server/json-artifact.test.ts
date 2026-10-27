import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, migrateTempDb, seedUser, setupTempEnv } from "../adapters/fixture";

/**
 * 按文件名读 json 产物（回归测试）
 * ============================================================
 * 这条测试钉的是一个**真实存在过的 bug**：
 *
 *   spec.json 与 answers.json 都是 json 类型，而 answers.json 是后写的。
 *   "取最新的那个 json"（findLatest(runId,"json")）会在用户答过一轮之后
 *   把**答案**当成规格读到 —— 于是按它算疑问：算不出来、也不报错，
 *   只是行为诡异。
 *
 *   它在"续跑会重跑规格化"的年代碰巧看不出来（重跑会把 spec.json
 *   重新写成最新的那份），直到续跑改成"沿用已确认的规格"之后才暴露：
 *   **用户分两次答题时，第二次会被判成"没有提交任何有效的回答"（400），
 *   而他明明答了。**
 *
 * 所以下面第一条是最要紧的：answers.json 比 spec.json 新的时候，
 * 按文件名读仍然必须读到 **spec**。
 */

const tmp = setupTempEnv();

const { fsArtifactStore } = await import("@/adapters/store/artifact-repo");
const { sqliteRunStore } = await import("@/adapters/store/run-repo");
const { readJsonArtifact, loadJsonArtifact } = await import("@/server/json-artifact");

interface Spec {
  goal: string;
  questions: string[];
}

let runId = "";

beforeAll(async () => {
  await migrateTempDb();
  const userId = await seedUser("json-artifact-user");
  runId = (
    await sqliteRunStore.create({ userId, prompt: "读产物", workflowVersion: "v1" })
  ).id;
});

afterAll(async () => {
  await closeTempDb();
  tmp.cleanup();
});

const save = (name: string, value: unknown) =>
  fsArtifactStore.save({
    runId,
    kind: "json",
    path: `${runId}/${name}`,
    content: JSON.stringify(value),
  });

/**
 * 写**原始内容**（不经过 JSON.stringify）。
 * ⚠️ 想写坏 JSON 必须用它：`save("x.json", "这不是 JSON")` 写出来的是
 *    `"这不是 JSON"` —— 那是**合法**的 JSON（一个字符串），
 *    于是那条"坏 JSON"的断言反而会红。第一版就是这么错的。
 */
const saveRaw = (name: string, content: string) =>
  fsArtifactStore.save({ runId, kind: "json", path: `${runId}/${name}`, content });

describe("按文件名读 json 产物", () => {
  it("【关键】answers.json 比 spec.json 新时，读 spec.json 仍然拿到**规格**", async () => {
    await save("spec.json", { goal: "番茄钟", questions: ["要不要提示音？"] });
    await new Promise((r) => setTimeout(r, 3)); // 让 answers.json 的 createdAt 更大
    await save("answers.json", { runId, answers: [{ question: "要不要提示音？", answer: "要" }] });

    const spec = await readJsonArtifact<Spec>(runId, "spec.json");
    expect(spec).not.toBeNull();
    expect(spec!.goal).toBe("番茄钟");
    expect(spec!.questions).toEqual(["要不要提示音？"]);
    // ★ 反例的另一面：绝不能读到答案那份（它没有 goal/questions）
    expect(spec as unknown as { answers?: unknown }).not.toHaveProperty("answers");
  });

  it("★ 反例：直接 findLatest 会拿到答案那份 —— 这正是当初那个 bug", async () => {
    /*
      这一条不是"验产品"，是把**坑本身**钉在测试里：
      将来有人觉得 readJsonArtifact 多此一举、想换回 findLatest 时，
      这里会告诉他为什么不能。
    */
    const latest = await fsArtifactStore.findLatest(runId, "json");
    expect(latest).not.toBeNull();
    const raw = await fsArtifactStore.readContent(latest!);
    expect(raw).toContain("answers"); // 最新的那个 json 是答案，不是规格
  });

  it("读一个不存在的文件名 → null（不是抛错，也不是随手给一份别的）", async () => {
    expect(await readJsonArtifact<Spec>(runId, "ui-spec.json")).toBeNull();
  });

  it("内容不是合法 JSON → null（坏产物不许把调用方带崩）", async () => {
    await saveRaw("broken.json", "{这半个对象没有闭合");
    expect(await readJsonArtifact<Spec>(runId, "broken.json")).toBeNull();
  });

  it("文件被外部删掉 → null", async () => {
    const artifact = await save("gone.json", { ok: true });
    const { rmSync } = await import("node:fs");
    const path = await import("node:path");
    rmSync(path.join(tmp.workspace, artifact.path), { force: true });
    expect(await readJsonArtifact<{ ok: boolean }>(runId, "gone.json")).toBeNull();
  });
});

describe("需要区分失败原因时（loadJsonArtifact）", () => {
  it("没这份产物 → missing（接口据此回 409）", async () => {
    const r = await loadJsonArtifact<Spec>(runId, "never-written.json");
    expect(r).toEqual({ ok: false, reason: "missing" });
  });

  it("文件在但内容坏了 → bad-json（接口据此回 500，而不是说「没有规格」）", async () => {
    await saveRaw("bad.json", "{{{");
    const r = await loadJsonArtifact<Spec>(runId, "bad.json");
    expect(r).toEqual({ ok: false, reason: "bad-json" });
  });

  it("正常那份 → ok + 值", async () => {
    const r = await loadJsonArtifact<Spec>(runId, "spec.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.goal).toBe("番茄钟");
  });
});