/**
 * HTTP 客户端：错误信封只解析一次（契约 §4.2）。
 *
 * 这些测试锁的是"别人改坏了会被发现"的部分：
 * 信封被解析成 ApiError、非信封响应能退化、以及不认识的状态不冒充成功。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiJson } from "@/api/client";

function mockFetchOnce(
  body: unknown,
  init: { status?: number; jsonThrows?: boolean } = {},
) {
  const status = init.status ?? 200;
  const spy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (init.jsonThrows) throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiJson", () => {
  it("2xx 时直接返回 JSON", async () => {
    mockFetchOnce({ ok: true, version: "0.1.0", db: "ok" });

    const body = await apiJson<{ db: string }>("/api/v1/health");

    expect(body.db).toBe("ok");
  });

  it("把错误信封转成 ApiError（code / message / status / hint）", async () => {
    mockFetchOnce(
      { error: { code: "NOT_FOUND", message: "找不到该构建", hint: "刷新列表" } },
      { status: 404 },
    );

    const error = await apiJson("/api/v1/runs/x").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe("NOT_FOUND");
    expect(apiError.message).toBe("找不到该构建");
    expect(apiError.hint).toBe("刷新列表");
    expect(apiError.status).toBe(404);
  });

  it("响应不是 JSON（网关 502 的 HTML）时退化，不把解析异常抛给界面", async () => {
    mockFetchOnce(null, { status: 502, jsonThrows: true });

    const error = (await apiJson("/api/v1/runs/x").catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("INTERNAL");
    expect(error.status).toBe(502);
    expect(error.message).toContain("502");
  });

  it("HTTP 非 2xx 但没有信封（code 缺失）时也不当作成功", async () => {
    mockFetchOnce({ detail: "Not Found" }, { status: 404 });

    const error = (await apiJson("/api/v1/runs/x").catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("INTERNAL");
  });
});
