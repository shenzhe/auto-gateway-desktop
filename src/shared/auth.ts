// PKCE / OAuth 授权辅助函数：verifier/challenge/state 生成 + pending 授权存储。
// 从 main.tsx 提取的纯工具函数，无 React 依赖。
export type PendingAuthorization = {
  verifier: string;
  state: string;
};

const pendingAuthorizationStorageKey = "autogateway.desktop.pending-auth";

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

export function readPendingAuthorization(): PendingAuthorization | null {
  try {
    const raw = window.sessionStorage.getItem(pendingAuthorizationStorageKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as PendingAuthorization;
    return value.verifier && value.state ? value : null;
  } catch {
    return null;
  }
}
