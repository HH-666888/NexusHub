/**
 * 演示数据准备
 * ============================================================
 * 用法：npm run demo:seed
 *
 * 它做三件事：
 *   1. 建一个演示账号（已存在则复用）
 *   2. 建一条构建记录
 *   3. 真的跑一次生成，让工作台里有一个能点的成品
 *   4. 打印会话 Cookie —— 供开发期给截图工具使用
 *
 * ⚠️ 会真实调用模型，产生费用（约 ¥0.015）。
 *
 * 这个脚本在比赛演示时也用得上：
 *   评委打开页面时如果现场生成要等十几秒，
 *   预先跑好一条能让演示立刻有东西可看。
 */

import { fsArtifactStore } from "@/adapters/store/artifact-repo";
import { sqliteCostStore } from "@/adapters/store/cost-repo";
import { sqliteRunStore } from "@/adapters/store/run-repo";
import { createDeepSeekPort } from "@/adapters/model/deepseek";
import { env } from "@/config/env";
import { registerUser, loginUser } from "@/core/auth/service";
import { sqliteAuthStore } from "@/adapters/store/auth-repo";
import { generateApp } from "@/core/generate/service";
import { resolveModelEndpoint } from "@/adapters/model/resolve-endpoint";

const DEMO_USER = "demo";
const DEMO_PASS = "demo123";
const DEMO_PROMPT =
  "做一个团队任务看板，能拖拽卡片改变状态、能标记完成、刷新后数据还在";

const ok = (s: string) => console.log(`  ✅ ${s}`);
const info = (s: string) => console.log(`     ${s}`);

async function main() {
  console.log("══════════════════════════════════════════════");
  console.log(" 演示数据准备");
  console.log("══════════════════════════════════════════════");

  /* ---------- 1. 账号 ---------- */
  const existing = await sqliteAuthStore.findUserByUsername(DEMO_USER);
  let token: string;

  if (existing) {
    const login = await loginUser(sqliteAuthStore, {
      username: DEMO_USER,
      password: DEMO_PASS,
    });
    if (!login.ok) {
      throw new Error(
        `演示账号已存在但密码不是默认值，无法登录：${login.reason}。` +
          `请先删除该账号或改用其他用户名。`,
      );
    }
    token = login.value.token;
    ok(`复用已有演示账号 ${DEMO_USER}`);
  } else {
    const reg = await registerUser(sqliteAuthStore, {
      username: DEMO_USER,
      password: DEMO_PASS,
    });
    if (!reg.ok) throw new Error(`建号失败：${reg.reason}`);
    token = reg.value.token;
    ok(`已创建演示账号 ${DEMO_USER} / ${DEMO_PASS}`);
  }
  const user = await sqliteAuthStore.findUserByUsername(DEMO_USER);
  if (!user) throw new Error("找不到演示账号");

  /* ---------- 2. 构建记录 ---------- */
  const run = await sqliteRunStore.create({
    userId: user.id,
    prompt: DEMO_PROMPT,
    workflowVersion: env.run.workflowVersion,
  });
  ok(`已创建构建记录 ${run.id.slice(0, 18)}…`);

  /* ---------- 3. 真的跑一次生成 ---------- */
  const resolved = await resolveModelEndpoint();
  if (!resolved.ready) {
    throw new Error(`模型接入配置不完整：${resolved.reason}`);
  }
  info(`接入方式：${resolved.source === "custom" ? "自定义" : "平台默认"}`);
  info("正在生成（约 10-20 秒）…");

  const spent = await sqliteCostStore.totalByRun(run.id);
  let lastLabel = "";
  let cost = 0;
  let artifactId: number | null = null;

  for await (const event of generateApp(
    {
      model: createDeepSeekPort(resolved.endpoint),
      artifacts: fsArtifactStore,
      runs: sqliteRunStore,
      costs: sqliteCostStore,
    },
    {
      runId: run.id,
      prompt: run.prompt,
      costLimitCny: env.run.costLimitCny,
      spentCny: spent,
    },
  )) {
    if (event.kind === "phase") lastLabel = event.label;
    if (event.kind === "usage") cost = event.costCny;
    if (event.kind === "artifact") artifactId = event.artifact.id;
    if (event.kind === "error") info(`提示：${event.message}`);
  }

  ok(`生成完成 · ${lastLabel}`);
  info(`成本 ¥${cost.toFixed(6)}`);
  if (artifactId === null) {
    throw new Error("没有产出成品，请查看上面的提示");
  }

  /* ---------- 4. 输出 ---------- */
  console.log();
  console.log("══════════════════════════════════════════════");
  console.log(" 完成");
  console.log("══════════════════════════════════════════════");
  console.log(`  账号      ${DEMO_USER} / ${DEMO_PASS}`);
  console.log(`  工作台    http://localhost:3000/studio?run=${run.id}`);
  console.log(`  会话令牌  ${token}`);
  console.log();
  console.log("  给截图工具用（开发期）：");
  console.log(`  node scripts/shot.mjs "http://localhost:3000/studio?run=${run.id}" out.png "${token}" 900`);
}

main().catch((err) => {
  console.error("\n失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});