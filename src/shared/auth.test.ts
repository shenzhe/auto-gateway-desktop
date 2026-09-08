import { afterEach, describe, expect, it } from "vitest";
import {
  buildDesktopSignInUrl,
  createState,
  readPendingAuthorization,
  savePendingAuthorization,
  clearPendingAuthorization,
} from "./auth";

describe("desktop sign-in helpers", () => {
  afterEach(() => window.sessionStorage.clear());

  it("reads authorization written by the v0.1.48 login flow", () => {
    const pending = { verifier: "test-verifier", state: "test-state" };
    window.sessionStorage.setItem(
      "autogateway.desktop.pending-authorization", JSON.stringify(pending),
    );
    expect(readPendingAuthorization()).toEqual(pending);
  });

  it("retains authorization for browser fallback and clears it after login", () => {
    const pending = { verifier: "test-verifier", state: "test-state" };
    savePendingAuthorization(pending);
    expect(readPendingAuthorization()).toEqual(pending);
    clearPendingAuthorization();
    expect(readPendingAuthorization()).toBeNull();
  });
  it("preserves the PKCE parameters in the browser fallback URL", () => {
    expect(
      buildDesktopSignInUrl(
        "https://autogateway.cc",
        "challenge-value",
        "state-value-123456",
        "zh",
      ),
    ).toBe(
      "https://autogateway.cc/login?desktopCodeChallenge=challenge-value&desktopState=state-value-123456&locale=zh",
    );
  });

  it("does not accept pending authorization data without both fields", () => {
    window.sessionStorage.setItem(
      "autogateway.desktop.pending-authorization",
      JSON.stringify({ verifier: createState() }),
    );
    expect(readPendingAuthorization()).toBeNull();
  });
});
