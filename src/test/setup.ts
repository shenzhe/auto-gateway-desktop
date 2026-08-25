import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// 每个测试之间卸载残留的 DOM。
afterEach(() => {
  cleanup();
});

// matchMedia 在 jsdom 下未实现，主题相关代码依赖它。
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// 阻止测试里意外的 console.error（如 React act 警告）噪音；如需排查可注释掉。
const originalError = console.error;
console.error = (...args: unknown[]) => {
  // 过滤掉已知的 jsdom 未实现警告。
  const first = args[0];
  if (typeof first === "string" && first.includes("Not implemented:")) return;
  originalError(...args);
};
