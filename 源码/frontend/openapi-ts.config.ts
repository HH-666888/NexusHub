/**
 * 由后端 OpenAPI 生成前端类型。
 *
 * 契约（docs/03 §9）规定：后端 Pydantic 模型是唯一来源，前端不许手写重复的 interface。
 * 这里只生成类型、不生成客户端 —— 请求封装在 src/api/client.ts，错误信封只有一处解析。
 *
 * 用法：npm run gen:types
 */
import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../backend/openapi.json",
  output: {
    path: "src/api/generated",
    postProcess: ["prettier"],
  },
  plugins: ["@hey-api/typescript"],
});
