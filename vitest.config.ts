import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 独立于 vite.config.ts：Tauri 的 dev/build 走 vite.config.ts，
// 单元测试走这里，互不干扰。
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify("1970-01-01T00:00:00.000Z"),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // @tauri-apps/* 与 phosphor-icons 等在 jsdom 下无需真实执行，由测试自行 mock。
    server: {
      deps: {
        inline: [/@tauri-apps/],
      },
    },
  },
});
