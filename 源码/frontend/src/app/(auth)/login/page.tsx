import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/features/auth/components/login-form";
import { getCurrentUser } from "@/server/auth-context";

export const metadata: Metadata = {
  title: "登录 · Nexus",
  description: "登录 Nexus，继续你上一次没做完的构建。",
};

export default async function LoginPage() {
  // 已登录时直接进画布，不再经过登录页
  if (await getCurrentUser()) redirect("/canvas");
  return <LoginForm />;
}
