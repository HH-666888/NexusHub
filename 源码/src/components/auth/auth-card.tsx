import Link from "next/link";
import type { ReactNode } from "react";

interface AuthCardProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  /** 卡片底部的跳转提示 */
  footer: ReactNode;
  /** 出错时展示的红色提示条 */
  error?: string;
}

/**
 * 登录 / 注册页共用的卡片外壳
 * ============================================================
 * 两页视觉完全一致，只有表单内容与底部链接不同 ——
 * 把外壳抽出来，就不会出现「改了登录页忘了改注册页」的情况。
 */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
  error,
}: AuthCardProps) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        {/* 品牌区。点它去**欢迎页**而不是根路径 ——
            根路径是需要登录的新首页，从登录页点它会被弹回登录页，
            形成一个点了没反应的死循环。 */}
        <div className="mb-8 text-center">
          <Link href="/welcome" className="inline-block">
            <div className="flex items-center justify-center gap-2">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--app-accent)]"
              />
              <span className="text-2xl font-semibold tracking-tight text-slate-100">
                Nexus
              </span>
            </div>
          </Link>
          <p className="mt-2 text-sm text-slate-500">一个网页里的软件工厂</p>
        </div>

        {/* 卡片 */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 shadow-xl backdrop-blur">
          <h1 className="text-lg font-semibold text-slate-100">{title}</h1>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>

          {error && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3.5 py-2.5 text-sm text-red-300"
            >
              {error}
            </div>
          )}

          <div className="mt-5">{children}</div>
        </div>

        <div className="mt-5 text-center text-sm text-slate-500">{footer}</div>
      </div>
    </div>
  );
}