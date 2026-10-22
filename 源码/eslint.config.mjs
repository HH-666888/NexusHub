import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

/**
 * ESLint 扁平配置
 * ============================================================
 * eslint-config-next 16 原生导出扁平配置数组，直接展开即可，
 * 不要用 FlatCompat 转换（会引入循环引用）。
 */
const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "data/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      // 内核里的类型与接口是本项目的核心资产，未使用变量一律报错而不是警告
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // 禁止 any —— 阶段产物契约的可靠性依赖类型
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
];

export default eslintConfig;