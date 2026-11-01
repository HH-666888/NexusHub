/**
 * 唯一的 HTTP 入口。
 *
 * 契约（docs/03 §4.2）规定所有非 2xx 都是 `{ error: { code, message, hint? } }`，
 * 所以错误信封只在这里解析一次 —— 组件里不许再出现 `res.ok` 判断。
 */

import type { HealthApiV1HealthGetResponses } from "./generated/types.gen";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint?: string;

  constructor(code: string, message: string, status: number, hint?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

/** 请求并解析 JSON。失败一律抛 ApiError，调用方按 code 分支。 */
export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}

/** 只关心成功/失败、不读响应体的写操作（DELETE / POST）。 */
export async function apiSend(path: string, init: RequestInit = {}): Promise<void> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) throw await readError(response);
}

/**
 * 把错误响应变成 ApiError。
 *
 * 后端理论上永远给信封，但网关、代理、框架报错也会插一脚（比如 502 的 HTML），
 * 所以这里必须能退化：解析不出来就用 HTTP 状态兜底，而不是把解析异常抛给界面。
 */
async function readError(response: Response): Promise<ApiError> {
  const fallback = new ApiError(
    "INTERNAL",
    `请求失败（HTTP ${response.status}）`,
    response.status,
  );
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; hint?: string };
    };
    const error = body?.error;
    if (!error?.code) return fallback;
    return new ApiError(
      error.code,
      error.message ?? fallback.message,
      response.status,
      error.hint,
    );
  } catch {
    return fallback;
  }
}

export type HealthResponse = HealthApiV1HealthGetResponses[200];

/** GET /api/v1/health。db 为 "down" 时说明数据库连不上，界面要如实显示。 */
export function getHealth(): Promise<HealthResponse> {
  return apiJson<HealthResponse>("/api/v1/health");
}
