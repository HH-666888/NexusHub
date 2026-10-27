import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeTempDb, migrateTempDb, seedUser, setupTempEnv } from "./fixture";

/**
 * 保护产物存取（真库 + 真文件系统）：写盘与登记合成一个操作，两边都验。
 * 覆盖内容寻址、文件被外部删掉、removeByRun 幂等、别条运行不受影响、路径穿越防线。
 */

const tmp = setupTempEnv();

const { fsArtifactStore } = await import("@/adapters/store/artifact-repo");
const { sqliteRunStore } = await import("@/adapters/store/run-repo");
const { db } = await import("@/adapters/store/client");
const { artifacts } = await import("@/adapters/store/schema");

let runId = "";
let userId = 0;

beforeAll(async () => {
  await migrateTempDb();
  userId = await seedUser("artifact-user");
  // 必须建一条真运行：artifacts 表有指向 runs 的外键。
  runId = (
    await sqliteRunStore.create({ userId, prompt: "产物测试", workflowVersion: "v1" })
  ).id;
});

afterAll(async () => {
  await closeTempDb();
  tmp.cleanup();
});

const save = (name: string, content: string, kind: "html" | "json" | "text" = "json") =>
  fsArtifactStore.save({
    runId,
    kind,
    path: `${runId}/${name}`,
    content,
  });

describe("产物 · 落盘与登记", () => {
  it("save 之后文件真的在磁盘上，内容一字不差", async () => {
    const content = JSON.stringify({ hello: "世界" }, null, 2);
    const artifact = await save("spec.json", content);

    const abs = path.join(tmp.workspace, runId, "spec.json");
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf8")).toBe(content);
    expect(artifact.bytes).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("sha256 与内容对得上（内容寻址：同样的内容永远同一个哈希）", async () => {
    const a = await save("same-a.json", '{"x":1}');
    const b = await save("same-b.json", '{"x":1}');
    const c = await save("diff.json", '{"x":2}');

    expect(a.sha256).toBe(b.sha256); // 内容相同 → 哈希相同
    expect(c.sha256).not.toBe(a.sha256); // 内容不同 → 哈希不同
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("readContent 读回来的就是写进去的（往返一致）", async () => {
    const content = "<html><body>成品</body></html>";
    const artifact = await save("index.html", content, "html");
    expect(await fsArtifactStore.readContent(artifact)).toBe(content);
  });

  it("listByRun 只列这条运行的产物", async () => {
    const mine = await fsArtifactStore.listByRun(runId);
    const names = mine.map((a) => a.path.split("/").pop());
    expect(names).toContain("spec.json");
    expect(names).toContain("index.html");
    expect(mine.every((a) => a.runId === runId)).toBe(true);
  });

  it("findLatest 按 kind 取，并且取**最新**那份", async () => {
    await save("out-1.json", '{"v":1}');
    await new Promise((r) => setTimeout(r, 3)); // createdAt 是毫秒时间戳
    await save("out-2.json", '{"v":2}');

    const latest = await fsArtifactStore.findLatest(runId, "json");
    expect(latest).not.toBeNull();
    expect(await fsArtifactStore.readContent(latest!)).toBe('{"v":2}');
  });

  it("反例：那个 kind 一份都没有 → null（不是随手返回别的 kind）", async () => {
    expect(await fsArtifactStore.findLatest(runId, "text")).toBeNull();
  });
});

describe("产物 · 不一致与清理", () => {
  it("文件被外部删掉 → readContent 返回 null（登记还在，但要如实说读不到）", async () => {
    const artifact = await save("ghost.json", '{"will":"be deleted"}');
    rmSync(path.join(tmp.workspace, runId, "ghost.json"), { force: true });

    expect(await fsArtifactStore.readContent(artifact)).toBeNull();
    // 登记还在 —— "读不到"与"没登记过"是两件事，界面要能分开说
    const listed = await fsArtifactStore.listByRun(runId);
    expect(listed.some((a) => a.path.endsWith("ghost.json"))).toBe(true);
  });

  it("removeByRun 把文件与登记一起清掉，并返回清掉的条数", async () => {
    const before = (await fsArtifactStore.listByRun(runId)).length;
    expect(before).toBeGreaterThan(0);

    expect(await fsArtifactStore.removeByRun(runId)).toBe(before);
    expect(await fsArtifactStore.listByRun(runId)).toHaveLength(0);
    expect(existsSync(path.join(tmp.workspace, runId))).toBe(false);
  });

  it("反例：再清一次是 0（幂等，不许抛错）", async () => {
    expect(await fsArtifactStore.removeByRun(runId)).toBe(0);
  });

  it("反例：别条运行的产物一份都不许受影响", async () => {
    const otherRun = (
      await sqliteRunStore.create({
        userId,
        prompt: "别人的运行",
        workflowVersion: "v1",
      })
    ).id;
    const otherFile = path.join(tmp.workspace, otherRun, "keep.json");
    await fsArtifactStore.save({
      runId: otherRun,
      kind: "json",
      path: `${otherRun}/keep.json`,
      content: '{"keep":true}',
    });
    // 再清 runId（它已经空了），别条不许被带走
    await fsArtifactStore.removeByRun(runId);
    expect(existsSync(otherFile)).toBe(true);
    expect(await fsArtifactStore.listByRun(otherRun)).toHaveLength(1);
    await fsArtifactStore.removeByRun(otherRun);
  });

  it("路径里的 .. 被拒绝（穿越防线）", async () => {
    await expect(
      fsArtifactStore.save({
        runId,
        kind: "json",
        path: `${runId}/../../escape.json`,
        content: "x",
      }),
    ).rejects.toThrow();
  });

  it("反例：正常路径当然要放行（别把防线做成一律拒绝）", async () => {
    const ok = await save("nested/dir/ok.json", '{"ok":1}');
    expect(
      existsSync(path.join(tmp.workspace, runId, "nested", "dir", "ok.json")),
    ).toBe(true);
    await fsArtifactStore.removeByRun(runId);
    expect(ok.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("产物 · 登记表", () => {
  it("写入的 bytes 是**字节数**不是字符数（中文一个字三个字节）", async () => {
    const artifact = await save("cn.json", "中文");
    const rows = db.select().from(artifacts).all();
    const row = rows.find((r) => r.path.endsWith("cn.json"));
    expect(row).toBeDefined();
    expect(row!.bytes).toBe(6); // "中文" = 2 字 × 3 字节
    expect(artifact.bytes).toBe(6);
    // 文件大小也要对得上（别只在库里记对了数）
    expect(readFileSync(path.join(tmp.workspace, runId, "cn.json")).length).toBe(6);
  });

  it("载入用的注册文件不是手抄的：schema 里那份就是实际建出来的表", () => {
    // 这条钉的是"夹具跑的是真迁移"：columns 由迁移生成，而不是手写 CREATE TABLE
    const cols = (
      db.$client.prepare("PRAGMA table_info(artifacts)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "run_id",
        "kind",
        "path",
        "bytes",
        "sha256",
        "created_at",
      ]),
    );
  });
});

describe("产物 · 健壮性", () => {
  it("空内容也能存（0 字节是合法产物，不许当成没写成）", async () => {
    const artifact = await save("empty.json", "");
    expect(artifact.bytes).toBe(0);
    expect(await fsArtifactStore.readContent(artifact)).toBe("");
    await fsArtifactStore.removeByRun(runId);
  });

  it("手写一个未登记的文件进目录，removeByRun 也会把目录一起收走", async () => {
    await save("keep.json", "{}");
    const stray = path.join(tmp.workspace, runId, "stray.txt");
    writeFileSync(stray, "没人登记的野文件");
    expect(existsSync(stray)).toBe(true);

    await fsArtifactStore.removeByRun(runId);
    expect(existsSync(stray)).toBe(false);
  });
});
