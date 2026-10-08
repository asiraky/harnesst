/**
 * Browser-side attachment prep: admit files against the shared rules, shrink big photos before
 * upload (models downscale past ~1568px anyway, so the extra pixels are pure upload time), and mint
 * preview URLs.
 */
import {
  admitAttachments,
  isImageMediaType,
  resolveAttachmentMediaType,
  type AttachmentRejection,
} from "~/chat/attachment-rules";
import type { DraftAttachment } from "./drafts";

export const DOWNSCALE_MAX_EDGE = 2048;
/** Below this, re-encoding isn't worth the quality loss. */
export const DOWNSCALE_MIN_BYTES = 400 * 1024;

/** Target size preserving aspect ratio, or null when no resize is needed. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge = DOWNSCALE_MAX_EDGE,
): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return null;
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function downscaleImage(file: File): Promise<File> {
  // GIFs may be animated; re-encoding would flatten them.
  if (file.type === "image/gif" || file.size < DOWNSCALE_MIN_BYTES) return file;
  if (typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const target = fitWithin(bitmap.width, bitmap.height);
    if (!target) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    bitmap.close();
    // PNG keeps transparency (screenshots); photos go JPEG.
    const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outType, 0.85),
    );
    if (!blob || blob.size >= file.size) return file;
    const name =
      outType === "image/jpeg" && !/\.jpe?g$/i.test(file.name)
        ? file.name.replace(/\.[^.]+$/, "") + ".jpg"
        : file.name;
    return new File([blob], name, { type: outType, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

let seq = 0;
function nextId() {
  seq += 1;
  return `att-${Date.now().toString(36)}-${seq}`;
}

/** Pasted screenshots arrive as "image.png" — give them a distinguishable name. */
function nameFor(file: File): string {
  if (file.name && file.name !== "image.png") return file.name;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const ext = file.type.split("/")[1] ?? "png";
  return `pasted-${stamp}.${ext}`;
}

export async function prepareAttachments(
  existing: readonly DraftAttachment[],
  files: readonly File[],
): Promise<{ added: DraftAttachment[]; rejected: AttachmentRejection[] }> {
  const shrunk = await Promise.all(
    files.map(async (f) => {
      const named = f.name && f.name !== "image.png" ? f : new File([f], nameFor(f), { type: f.type });
      const media = resolveAttachmentMediaType(named.name, named.type);
      return media && isImageMediaType(media) ? downscaleImage(named) : named;
    }),
  );
  const { accepted, rejected } = admitAttachments(
    existing.map((a) => ({ name: a.name, type: a.mediaType, size: a.size })),
    shrunk,
  );
  const added = accepted.map((file): DraftAttachment => {
    const mediaType = resolveAttachmentMediaType(file.name, file.type)!;
    return {
      id: nextId(),
      file,
      name: file.name,
      mediaType,
      size: file.size,
      previewUrl: isImageMediaType(mediaType) ? URL.createObjectURL(file) : null,
    };
  });
  return { added, rejected };
}

export function releaseAttachment(a: DraftAttachment) {
  if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
}

/** Pull files out of a paste/drop DataTransfer (ignores dragged text/links). */
export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items?.length) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== "file") continue;
      const f = item.getAsFile();
      if (f) out.push(f);
    }
    return out;
  }
  return Array.from(dt.files ?? []);
}
