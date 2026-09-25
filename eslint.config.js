// ESLint flat config（ESLint 9+）
// 治理类项目的底线：所有 src 下源码必须过 lint，不允许再回退到 echo 占位。
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-electron/**",
      "release/**",
      "coverage/**",
      "src/desktop/renderer/dist/**",
      // 本地运行/测试遗留的插件缓存目录（已被 .gitignore 忽略，正常 clone 不存在；
      // 但本地环境里存在时 npx eslint . 会误扫其中第三方副本）
      ".eag/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs", "*.config.js", "*.config.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // 仓库历史代码存在少量 any / 空函数，先降级为警告，逐步清零；
      // 新增代码不得新增警告（CI 可后续加 --max-warnings 收敛）。
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-empty-function": "warn",
    },
  },
);
