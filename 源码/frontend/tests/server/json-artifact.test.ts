import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTempDb,
  migrateTempDb,
  seedUser,
  setupTempEnv,
} from "../adapters/fixture";

/**
 * 保护按文件名读 json 产物：answers.json 比 spec.json 新时，读规格仍要拿到规格。
 * 取最新那个 json 的写法会在用户答过一轮之后把答案当成规格读到。
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

// 想写坏 JSON 必须用原始内容：save 会把字符串再 stringify 一次，那仍是合法 JSON。
// 第一版就是这么错的。
const saveRaw = (name: string, content: string) =>
  fsArtifactStore.save({ runId, kind: "json", path: `${runId}/${name}`, content });

describe("按文件名读 json 产物", () => {
  it("answers.json 比 spec.json 新时，读 spec.json 仍然拿到**规格**", async () => {
    await save("spec.json", { goal: "番茄钟", questions: ["要不要提示音？"] });
    await new Promise((r) => setTimeout(r, 3)); // 让 answers.json 的 createdAt 更大
    await save("answers.json", {
      runId,
      answers: [{ question: "要不要提示音？", answer: "要" }],
    });

    const spec = await readJsonArtifact<Spec>(runId, "spec.json");
    expect(spec).not.toBeNull();
    expect(spec!.goal).toBe("番茄钟");
    expect(spec!.questions).toEqual(["要不要提示音？"]);
    // 反例的另一面：绝不能读到答案那份，它没有 goal / questions。
    expect(spec as unknown as { answers?: unknown }).not.toHaveProperty("answers");
  });

  it("反例：直接 findLatest 会拿到答案那份 —— 这正是当初那个 bug", async () => {
    // 把坑本身钉在测试里：将来有人想换回 findLatest，这里告诉他为什么不能。
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

  it("文件在但内容坏了 → bad-json（接口据此回 500，而不是说“没有规格”）", async () => {
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
