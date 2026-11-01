import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/features/auth/components/register-form";
import { getCurrentUser } from "@/server/auth-context";

export const metadata: Metadata = {
  title: "注册 · Nexus",
  description: "创建 Nexus 账号，你的构建记录会被保存下来。",
};

export default async function RegisterPage() {
  // 已登录时直接进画布，与登录页一致
  if (await getCurrentUser()) redirect("/canvas");
  return <RegisterForm />;
}
