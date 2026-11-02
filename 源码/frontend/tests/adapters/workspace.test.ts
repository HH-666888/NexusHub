/**
 * 工作区的文件读写。
 *
 * 重点测两类东西：正常读写往返，以及所有"路径穿越"入口都被挡住。
 * 后者是这一层唯一真正危险的地方。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listRunFiles,
  readRunFile,
  removeRunDir,
  runDir,
  safeRelativePath,
  writeRunFile,
} from "@/adapters/store/workspace";

const RUN = "r_test_workspace";

afterEach(async () => {
  await removeRunDir(RUN);
});

describe("runDir", () => {
  it("拼出工作区下的目录", () => {
    expect(runDir(RUN).endsWith(path.join("workspace", RUN))).toBe(true);
  });

  it("拒绝带路径分隔符的 runId", () => {
    expect(() => runDir("../etc")).toThrow();
    expect(() => runDir("a/b")).toThrow();
    expect(() => runDir("a\\b")).toThrow();
  });
});

describe("safeRelativePath", () => {
  it("反斜杠规整成正斜杠", () => {
    expect(safeRelativePath("db\\schema.sql")).toBe("db/schema.sql");
  });

  it("拒绝穿越与绝对路径", () => {
    for (const bad of [
      "../x",
      "a/../../b",
      "/etc/passwd",
      "C:\\Windows\\x",
      "a//b",
      "./a",
    ]) {
      expect(() => safeRelativePath(bad), bad).toThrow();
    }
  });
});

describe("文件读写", () => {
  it("写入后能读回，并返回字节数与哈希", async () => {
    const written = await writeRunFile(RUN, "web/index.html", "<h1>hi</h1>");

    expect(written.path).toBe("web/index.html");
    expect(written.bytes).toBe(11);
    expect(written.sha256).toHaveLength(64);
    expect(await readRunFile(RUN, "web/index.html")).toBe("<h1>hi</h1>");
  });

  it("自动创建父目录", async () => {
    await writeRunFile(RUN, "a/b/c/deep.txt", "x");

    const stat = await fs.stat(path.join(runDir(RUN), "a/b/c/deep.txt"));
    expect(stat.isFile()).toBe(true);
  });

  it("读取不存在的文件会抛错（而不是返回空串）", async () => {
    await expect(readRunFile(RUN, "nope.txt")).rejects.toThrow();
  });

  it("列出所有文件并按路径排序", async () => {
    await writeRunFile(RUN, "web/index.html", "<div>");
    await writeRunFile(RUN, "api/main.py", "print(1)");
    await writeRunFile(RUN, "db/schema.sql", "create table t");

    const files = await listRunFiles(RUN);

    expect(files.map((f) => f.path)).toEqual([
      "api/main.py",
      "db/schema.sql",
      "web/index.html",
    ]);
    expect(files.every((f) => f.bytes > 0)).toBe(true);
  });

  it("目录不存在时列文件返回空数组", async () => {
    await expect(listRunFiles("r_never_created")).resolves.toEqual([]);
  });

  it("删除目录后读不到，且重复删除不报错", async () => {
    await writeRunFile(RUN, "web/index.html", "x");

    await removeRunDir(RUN);
    await expect(readRunFile(RUN, "web/index.html")).rejects.toThrow();
    await expect(removeRunDir(RUN)).resolves.toBeUndefined();
  });
});
