import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { getCurrentUser } from "@/server/auth-context";

export const metadata: Metadata = {
  title: "登录 · Nexus",
  description: "登录 Nexus，继续你上一次没做完的构建。",
};

export default async function LoginPage() {
  // 已登录的人不应该再看到登录页，直接送进工作台
  if (await getCurrentUser()) redirect("/studio");
  return <LoginForm />;
}