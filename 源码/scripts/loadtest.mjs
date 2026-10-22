/**
 * 简易压测：持续施压并记录内存曲线
 * 用法：node scripts/loadtest.mjs <网址> <秒数> <并发数> [进程名]
 *
 * 进程名默认 node（测本项目）。测 Java 时传 java。
 * 之所以要能换进程名：只有用**同一种测法**测两个技术栈，
 * 内存数字才有可比性。拿「Next.js 持续压测」去比
 * 「Java 瞬时压测」是不诚实的。
 */

const [, , url, secArg, concArg, procArg] = process.argv;
const seconds = Number(secArg) || 10;
const concurrency = Number(concArg) || 20;
const procName = procArg || "node";

import { execSync } from "node:child_process";

/** 读出目标进程组的总物理内存（MB） */
function rss() {
  try {
    // node 进程按路径过滤（排除机器上其他 node 进程），java 直接按名字取
    // 注意不能拼出空管道 —— 之前写成 `... |  | Measure-Object` 直接语法报错
    const ps =
      procName === "node"
        ? `(Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*Dev\\Node*' } | Measure-Object WorkingSet64 -Sum).Sum`
        : `(Get-Process ${procName} -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum`;
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, {
      encoding: "utf8",
    });
    return Number(out.trim()) / 1024 / 1024;
  } catch {
    return 0;
  }
}

const t0 = Date.now();
let ok = 0;
let total = 0;
let lastReport = 0;

const samples = [];

while (Date.now() - t0 < seconds * 1000) {
  const batch = await Promise.all(
    Array.from({ length: concurrency }, () =>
      fetch(url)
        .then((r) => {
          if (r.status === 200) ok++;
          return 1;
        })
        .catch(() => 0),
    ),
  );
  total += batch.length;

  const elapsed = (Date.now() - t0) / 1000;
  if (elapsed - lastReport >= 2) {
    lastReport = elapsed;
    const mb = rss();
    samples.push(mb);
    console.log(`  ${elapsed.toFixed(0)}s   已发 ${total}   成功 ${ok}   内存 ${mb.toFixed(1)} MB`);
  }
}

const ms = Date.now() - t0;
console.log("");
console.log(`  ── 共 ${total} 次请求，成功 ${ok}，耗时 ${ms} ms`);
console.log(`  ── 吞吐 ${(total / (ms / 1000)).toFixed(0)} 请求/秒`);
if (samples.length) {
  console.log(`  ── 压测期间内存 ${Math.min(...samples).toFixed(1)} ~ ${Math.max(...samples).toFixed(1)} MB`);
}

// 静置后再看一次，确认内存会不会回落
await new Promise((r) => setTimeout(r, 15000));
console.log(`  ── 静置 15 秒后 ${rss().toFixed(1)} MB`);