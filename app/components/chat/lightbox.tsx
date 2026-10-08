/**
 * Full-screen image viewer for first-party images (artifacts, uploaded attachments, composer
 * previews). A tiny module store so any thumbnail can open it without prop-drilling; `<LightboxHost>`
 * is mounted once by the transcript. Esc closes, ←/→ step through the gallery, click zooms 1×/2×.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";

import { cn } from "~/lib/utils";

export interface LightboxImage {
  src: string;
  alt: string;
}

type State = { images: LightboxImage[]; index: number } | null;
let state: State = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openLightbox(images: LightboxImage[], index = 0) {
  if (images.length === 0) return;
  state = { images, index: Math.max(0, Math.min(index, images.length - 1)) };
  emit();
}

function closeLightbox() {
  state = null;
  emit();
}

function step(delta: number) {
  if (!state) return;
  const n = state.images.length;
  state = { ...state, index: (state.index + delta + n) % n };
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function LightboxHost() {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => null,
  );
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    setZoom(false);
  }, [current?.index, current?.images]);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeLightbox();
      } else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [current]);

  if (!current || typeof document === "undefined") return null;
  const image = current.images[current.index]!;
  const many = current.images.length > 1;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.alt}
      className="fixed inset-0 z-[100] flex animate-in flex-col bg-black/85 backdrop-blur-sm fade-in-0"
      onClick={closeLightbox}
    >
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-white/80"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 truncate">
          {image.alt}
          {many && (
            <span className="ml-2 text-white/50 tabular-nums">
              {current.index + 1}/{current.images.length}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1">
          <a
            href={image.src}
            download={image.alt}
            className="flex size-9 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 hover:text-white"
            aria-label="Download"
          >
            <Download className="size-4" />
          </a>
          <button
            type="button"
            autoFocus
            onClick={closeLightbox}
            className="flex size-9 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </span>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img
          src={image.src}
          alt={image.alt}
          onClick={(e) => {
            e.stopPropagation();
            setZoom((z) => !z);
          }}
          className={cn(
            "rounded-md shadow-2xl transition-transform duration-200 select-none",
            zoom
              ? "max-w-none cursor-zoom-out"
              : "max-h-full max-w-full cursor-zoom-in object-contain",
          )}
        />
        {many && (
          <>
            <button
              type="button"
              aria-label="Previous image"
              onClick={(e) => {
                e.stopPropagation();
                step(-1);
              }}
              className="absolute left-3 flex size-10 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60"
            >
              <ChevronLeft className="size-5" />
            </button>
            <button
              type="button"
              aria-label="Next image"
              onClick={(e) => {
                e.stopPropagation();
                step(1);
              }}
              className="absolute right-3 flex size-10 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60"
            >
              <ChevronRight className="size-5" />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
