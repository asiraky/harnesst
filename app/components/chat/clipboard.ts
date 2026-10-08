/**
 * Clipboard writes that work everywhere harnesst is actually served — including plain-HTTP LAN
 * hosts, where `navigator.clipboard` doesn't exist (insecure context). The legacy fallback copies
 * through an off-screen textarea and restores focus afterwards so the composer doesn't lose it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

function copyWithExecCommand(value: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    position: "fixed",
    top: "0",
    left: "0",
    opacity: "0",
    fontSize: "16px",
  });
  const previouslyFocused = document.activeElement as HTMLElement | null;
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    previouslyFocused?.focus?.({ preventScroll: true });
  }
}

export async function copyText(value: string): Promise<boolean> {
  if (!value) return false;
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Permission denied / document not focused — fall through to the legacy path.
    }
  }
  return copyWithExecCommand(value);
}

/** `copy(text)` + a transient `copied` flag for swapping the icon to a check. */
export function useCopy({
  timeout = 1500,
  toastLabel,
}: { timeout?: number; toastLabel?: string } = {}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (value: string) => {
      const ok = await copyText(value);
      if (!ok) {
        toast.error("Couldn't copy to the clipboard.");
        return false;
      }
      if (toastLabel) toast.success(toastLabel, { duration: 1200 });
      if (timer.current) clearTimeout(timer.current);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), timeout);
      return true;
    },
    [timeout, toastLabel],
  );
  return { copy, copied };
}
