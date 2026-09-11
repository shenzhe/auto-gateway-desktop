import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  roots: [] as { unmount(): void }[],
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: vi.fn(async () => []),
  onOpenUrl: vi.fn(async () => () => {}),
}));
vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...original,
    createRoot: (...args: Parameters<typeof original.createRoot>) => {
      const root = original.createRoot(...args);
      mocks.roots.push(root);
      return root;
    },
  };
});

afterEach(async () => {
  await act(async () => mocks.roots.splice(0).forEach((root) => root.unmount()));
  document.getElementById("root")?.remove();
  localStorage.clear();
});

it("shows a visible installation error after loading disappears and clears it on successful retry", async () => {
  localStorage.setItem("autogateway.desktop.locale", "en");
  localStorage.setItem("autogateway.desktop.setup-completed:1", "true");
  const host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  let updated = false;
  let rejectInstall: (error: string) => void = () => {};
  let attempts = 0;
  mocks.invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "restore_desktop_state_command":
        return { apiKey: "", session: { token: "test-token", user: { id: 1, username: "Test" } } };
      case "get_codex_status":
        return { configured: true, providerStatus: "autogateway", configBackupCount: 0, authBackupCount: 0 };
      case "get_codex_app_status":
        return { installed: true, localVersion: updated ? "26.818.8289.0" : "26.803.10989.0", latestVersion: "26.818.8289.0", updateAvailable: !updated };
      case "get_desktop_account_summary_command":
        return { balance: "$10.00" };
      case "get_desktop_subscriptions_command":
      case "get_desktop_notifications_command":
        return { items: [] };
      case "get_pending_desktop_urls":
        return [];
      case "get_desktop_app_version":
        return "0.1.53";
      case "is_codex_running":
        return updated;
      case "download_codex_update_command":
        return { downloaded: true, version: "26.818.8289.0" };
      case "apply_codex_update_command":
        if (++attempts === 1) {
          return new Promise((_resolve, reject) => { rejectInstall = reject; });
        }
        updated = true;
        return { installed: true, awaitingInstallation: false };
      default:
        return null;
    }
  });

  await act(async () => { await import("./main"); });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Update Codex" }));
  await waitFor(() => expect(attempts).toBe(1));
  expect(screen.getByRole("progressbar")).toBeInTheDocument();
  await act(async () => rejectInstall("Deployment failed: 0x80073D02"));
  const alert = await screen.findByRole("alert");
  expect(alert).toBeVisible();
  expect(alert).toHaveTextContent("Deployment failed: 0x80073D02");
  expect(alert).toHaveClass("homeActionMessage");
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Update Codex" }));
  await waitFor(() => expect(attempts).toBe(2));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(await screen.findByText("ChatGPT and Codex were updated successfully.")).toBeVisible();
});
