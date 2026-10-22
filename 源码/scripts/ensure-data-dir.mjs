/**
 * 确保运行时数据目录存在。
 *
 * 为什么需要这个：drizzle-kit 不会自动创建目录，
 * 目录不存在时会直接报 "Cannot open database because the directory does not exist"。
 * 让「克隆仓库 → 装依赖 → 建库」这条路径无需人工干预。
 */
import fs from "node:fs";
import path from "node:path";

const targets = ["data", path.join("data", "workspace")];

for (const dir of targets) {
  fs.mkdirSync(dir, { recursive: true });
}

console.log(`已确保数据目录存在：${targets.join(", ")}`);