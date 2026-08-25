// 自定义右键菜单 hook：WebView 屏蔽了原生 contextmenu，这里实现"仅允许复制"
// 的右键菜单。App、NotificationDetailWindow、TrayPopup 共用。
import { useEffect } from "react";

const copyMenuID = "__autogateway_copy_menu";

async function copySelection(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall back to the legacy WebView clipboard path below.
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;opacity:0;";
  (document.body || document.documentElement).appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function closeCopyMenu(): void {
  document.getElementById(copyMenuID)?.remove();
}

export function useCopyOnlyContextMenu(): void {
  useEffect(() => {
    function handleContextMenu(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest(`#${copyMenuID}`)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closeCopyMenu();
      const selectedText = window.getSelection()?.toString() ?? "";

      const menu = document.createElement("div");
      menu.id = copyMenuID;
      menu.setAttribute("role", "menu");
      menu.style.cssText = [
        "position:fixed",
        "z-index:2147483647",
        "min-width:96px",
        "padding:5px",
        "border:1px solid rgba(110,90,70,.25)",
        "border-radius:8px",
        "color:#2a211c",
        "background:#fffaf4",
        "box-shadow:0 8px 24px rgba(42,33,28,.18)",
        'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        "visibility:hidden",
      ].join(";");

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.textContent = "Copy";
      copyButton.setAttribute("role", "menuitem");
      copyButton.style.cssText = [
        "display:block",
        "width:100%",
        "padding:7px 12px",
        "border:0",
        "border-radius:5px",
        "color:inherit",
        "background:transparent",
        "font:inherit",
        "text-align:left",
        "cursor:pointer",
      ].join(";");

      if (!selectedText.trim()) {
        copyButton.disabled = true;
        copyButton.style.opacity = ".45";
        copyButton.style.cursor = "default";
      } else {
        copyButton.addEventListener("click", async () => {
          await copySelection(selectedText);
          copyButton.textContent = "Copied";
          copyButton.disabled = true;
          copyButton.style.cursor = "default";
          window.setTimeout(closeCopyMenu, 500);
        });
        copyButton.addEventListener("mouseenter", () => {
          copyButton.style.background = "#f3e7da";
        });
        copyButton.addEventListener("mouseleave", () => {
          copyButton.style.background = "transparent";
        });
      }

      menu.appendChild(copyButton);
      (document.body || document.documentElement).appendChild(menu);
      const left = Math.min(
        event.clientX,
        window.innerWidth - menu.offsetWidth - 8,
      );
      const top = Math.min(
        event.clientY,
        window.innerHeight - menu.offsetHeight - 8,
      );
      menu.style.left = `${Math.max(8, left)}px`;
      menu.style.top = `${Math.max(8, top)}px`;
      menu.style.visibility = "visible";
    }

    function handlePointerDown(event: PointerEvent) {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(`#${copyMenuID}`)
      ) {
        closeCopyMenu();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeCopyMenu();
    }

    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("scroll", closeCopyMenu, true);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("scroll", closeCopyMenu, true);
      closeCopyMenu();
    };
  }, []);
}
