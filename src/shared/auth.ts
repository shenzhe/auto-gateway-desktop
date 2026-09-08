// PKCE generation and pending authorization storage shared by both sign-in paths.
export type PendingAuthorization = {
  verifier: string;
  state: string;
};

const pendingAuthorizationStorageKey = "autogateway.desktop.pending-authorization";

export function savePendingAuthorization(value: PendingAuthorization): void {
  window.sessionStorage.setItem(pendingAuthorizationStorageKey, JSON.stringify(value));
}

export function clearPendingAuthorization(): void {
  window.sessionStorage.removeItem(pendingAuthorizationStorageKey);
}

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export function createVerifier(): string {
  const bytes = new Uint8Array(64);
  window.crypto.getRandomValues(bytes);
  return base64URL(bytes);
}

export async function createChallenge(verifier: string): Promise<string> {
  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64URL(new Uint8Array(digest));
}

export function createState(): string {
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return base64URL(bytes);
}

export function buildDesktopSignInUrl(
  baseUrl: string,
  challenge: string,
  state: string,
  locale?: "en" | "zh",
): string {
  const url = new URL("/login", baseUrl);
  url.searchParams.set("desktopCodeChallenge", challenge);
  url.searchParams.set("desktopState", state);
  if (locale) url.searchParams.set("locale", locale);
  return url.toString();
}

export function readPendingAuthorization(): PendingAuthorization | null {
  try {
    const raw = window.sessionStorage.getItem(pendingAuthorizationStorageKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingAuthorization> | null;
    return typeof value?.verifier === "string" && value.verifier.length > 0 &&
      typeof value.state === "string" && value.state.length > 0
      ? { verifier: value.verifier, state: value.state }
      : null;
  } catch {
    return null;
  }
}
