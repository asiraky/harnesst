/**
 * Reading an artifact's text (and a page bundle's file listing) from the source endpoint
 * (`api.foh.artifact-source.ts`). The endpoint already caps a file at 1 MiB on a UTF-8 boundary and
 * says so in `X-Artifact-Truncated`, so the client reads the whole response as-is.
 *
 * A small cache keeps the last few reads so flipping between preview and source, or back to a
 * bundle file just looked at, is instant. Only VERSION-PINNED URLs are cached: those bytes can never
 * change, while an unpinned URL means "whatever is newest" and would go stale on a republish.
 */
import { useEffect, useState } from "react";

import {
  ARTIFACT_SOURCE_TRUNCATED_HEADER,
  type ArtifactSourceListing,
} from "~/foh/artifact-source";

export interface ArtifactText {
  text: string;
  /** The file goes on past what the endpoint returned. */
  truncated: boolean;
}

export type Loadable<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; value: T };

const CACHE_ENTRIES = 8;

function makeCache<T>() {
  const entries = new Map<string, T>();
  return {
    get: (key: string) => entries.get(key),
    has: (key: string) => entries.has(key),
    set(key: string, value: T) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > CACHE_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

const textCache = makeCache<ArtifactText>();
const listingCache = makeCache<ArtifactSourceListing>();

function failure(status: number): Error {
  return new Error(
    status === 404
      ? "This file isn't available any more."
      : `harnesst couldn't load this file (${status}).`,
  );
}

export async function readArtifactText(
  url: string,
  signal?: AbortSignal,
): Promise<ArtifactText> {
  const res = await fetch(url, { signal, credentials: "same-origin" });
  if (!res.ok) throw failure(res.status);
  return {
    text: await res.text(),
    truncated: res.headers.get(ARTIFACT_SOURCE_TRUNCATED_HEADER) === "1",
  };
}

export async function readArtifactListing(
  url: string,
  signal?: AbortSignal,
): Promise<ArtifactSourceListing> {
  const res = await fetch(url, { signal, credentials: "same-origin" });
  if (!res.ok) throw failure(res.status);
  return (await res.json()) as ArtifactSourceListing;
}

/**
 * One fetch per URL, aborted on unmount or URL change, with a retry. Race-safe without a data
 * library: a read that lands after its effect is gone (a retry, a newer URL, unmount) is dropped
 * rather than written over the state that replaced it.
 */
function useCachedFetch<T>(
  url: string | null,
  cacheable: boolean,
  cache: ReturnType<typeof makeCache<T>>,
  read: (url: string, signal: AbortSignal) => Promise<T>,
): Loadable<T> & { retry: () => void } {
  const [state, setState] = useState<{ url: string; value: Loadable<T> }>({
    url: "",
    value: { status: "idle" },
  });
  const [attempt, setAttempt] = useState(0);
  const cached = url && cacheable ? cache.get(url) : undefined;

  useEffect(() => {
    if (!url || (cacheable && cache.has(url))) return;
    const ctl = new AbortController();
    setState({ url, value: { status: "loading" } });
    read(url, ctl.signal)
      .then((value) => {
        // Right for this URL whoever asked, so worth keeping even when too late to show.
        if (cacheable) cache.set(url, value);
        if (ctl.signal.aborted) return;
        setState({ url, value: { status: "ready", value } });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setState({
          url,
          value: {
            status: "error",
            error:
              e instanceof Error && e.name !== "TypeError"
                ? e.message
                : "harnesst couldn't reach the server. Check your connection and retry.",
          },
        });
      });
    return () => ctl.abort();
  }, [url, cacheable, cache, read, attempt]);

  const retry = () => setAttempt((n) => n + 1);
  if (!url) return { status: "idle", retry };
  if (cached) return { status: "ready", value: cached, retry };
  // State left over from another URL is not this one's.
  if (state.url !== url) return { status: "loading", retry };
  return { ...state.value, retry };
}

/** A file's text from the source endpoint; `url` null means "don't fetch". */
export function useArtifactText(url: string | null, cacheable: boolean) {
  return useCachedFetch(url, cacheable, textCache, readArtifactText);
}

/** A version's file listing (a bundle's members, or a single file's one entry). */
export function useArtifactListing(url: string | null, cacheable: boolean) {
  return useCachedFetch(url, cacheable, listingCache, readArtifactListing);
}
