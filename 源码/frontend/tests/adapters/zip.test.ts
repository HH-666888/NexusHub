import { unzipSync } from "fflate";
import { describe, expect, it, afterEach } from "vitest";
import { zipRun } from "@/adapters/files/zip";
import { removeRunDir, writeRunFile } from "@/adapters/store/workspace";

const RUN = "r_zip_test";

afterEach(async () => {
  await removeRunDir(RUN);
});

describe("zipRun", () => {
  it("把工作区打成带顶层目录的 zip，解压后路径一致", async () => {
    await writeRunFile(RUN, "db/schema.sql", "create table t (id int);");
    await writeRunFile(RUN, "web/index.html", "<h1>hi</h1>");

    const zipped = await zipRun(RUN);
    const entries = unzipSync(new Uint8Array(zipped.bytes));
    const names = Object.keys(entries).sort();

    expect(zipped.fileCount).toBe(2);
    expect(names).toEqual([`${RUN}/db/schema.sql`, `${RUN}/web/index.html`]);
    expect(new TextDecoder().decode(entries[`${RUN}/web/index.html`])).toBe(
      "<h1>hi</h1>",
    );
  });

  it("空目录也能打包（不会抛错）", async () => {
    const zipped = await zipRun(RUN);

    expect(zipped.fileCount).toBe(0);
    expect(Object.keys(unzipSync(new Uint8Array(zipped.bytes)))).toEqual([]);
  });
});
