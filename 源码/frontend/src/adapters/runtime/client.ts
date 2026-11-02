/**
 * 后端运行时服务的客户端（只从 Next 服务端调用）。
 *
 * 内部接口不是浏览器 API：这里带 x-internal-token，地址来自 env.runtime。
 * 错误统一抛 RuntimeCallError，调用方据此给出人能看懂的提示。
 */

import { env } from "@/config/env";

export interface VerdictCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface VerdictLayer {
  layer: "db" | "api" | "ui";
  checks: VerdictCheck[];
  passed: number;
  total: number;
}

export interface Verdict {
  layers: VerdictLayer[];
  passed: number;
  total: number;
  screenshots: string[];
}

export interface StartedRuntime {
  containerId: string;
  hostPort: number;
  previewUrl: string;
  status: string;
}

export class RuntimeCallError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "RuntimeCallError";
    this.code = code;
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${env.runtime.baseUrl.replace(/\/$/, "")}/api/v1/runtime${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-internal-token": env.runtime.internalToken,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const fallback = new RuntimeCallError(
      "RUNTIME_UNAVAILABLE",
      `运行时返回 HTTP ${response.status}`,
      response.status,
    );
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body?.error?.code) {
        throw new RuntimeCallError(
          body.error.code,
          body.error.message ?? fallback.message,
          response.status,
        );
      }
    } catch (err) {
      if (err instanceof RuntimeCallError) throw err;
    }
    throw fallback;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** 起产物容器；同一 run 已在跑会返回同一条记录（后端保证幂等） */
export function startRuntime(runId: string, filesDir: string): Promise<StartedRuntime> {
  return call<StartedRuntime>(`/${encodeURIComponent(runId)}/start`, {
    method: "POST",
    body: JSON.stringify({ filesDir }),
  });
}

/** 三层验证；有失败项也返回 200 与完整报告 */
export function verifyRuntime(runId: string): Promise<Verdict> {
  return call<Verdict>(`/${encodeURIComponent(runId)}/verify`, { method: "POST" });
}

export function stopRuntime(runId: string): Promise<void> {
  return call<void>(`/${encodeURIComponent(runId)}/stop`, { method: "POST" });
}
