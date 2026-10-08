/**
 * Attachments of the in-flight (optimistic) user turn, and re-sending a turn's files.
 *
 * The live bubble previews images from object URLs; those hold the image bytes until revoked, so
 * `useReleaseLivePreviews` frees each turn's previews once it's replaced by the persisted entry.
 * Retry/Regenerate must resend the turn's files, not just its text: live turns still hold their
 * `File`s, persisted ones are re-fetched from the same-origin upload URL.
 */
import { useEffect } from "react";

import type { ChatAttachment } from "~/chat/types";

export type LiveAttachment = ChatAttachment & {
  previewUrl: string | null;
  /** The original bytes, so a live retry can resend them. */
  file?: File;
};

export function liveAttachments(files: readonly File[]): LiveAttachment[] {
  return files.map((f, i) => ({
    id: `live-${i}-${f.name}`,
    name: f.name,
    mediaType: f.type || "application/octet-stream",
    size: f.size,
    url: null,
    previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
    file: f,
  }));
}

/** Revoke a live turn's object-URL previews when it's replaced or the view unmounts. */
export function useReleaseLivePreviews(
  attachments: readonly LiveAttachment[] | undefined,
): void {
  useEffect(() => {
    if (!attachments?.length) return;
    return () => {
      for (const a of attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    };
  }, [attachments]);
}

/**
 * The `File`s to resend for a turn, or `null` when any of them can't be recovered (no stored
 * copy, or the fetch failed) — the caller must not silently resend without them.
 */
export async function filesForResend(
  attachments: readonly (ChatAttachment & { file?: File })[] | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<File[] | null> {
  if (!attachments?.length) return [];
  try {
    return await Promise.all(
      attachments.map(async (a) => {
        if (a.file) return a.file;
        if (!a.url) throw new Error("not stored");
        const res = await fetchImpl(a.url, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new File([await res.blob()], a.name, { type: a.mediaType });
      }),
    );
  } catch {
    return null;
  }
}
