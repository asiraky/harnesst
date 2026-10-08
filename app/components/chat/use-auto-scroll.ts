/**
 * Stick-to-bottom for a chat scroller, modelled on omniplex's `useAutoScroll` and t3code's
 * timeline follow logic:
 *
 * - "following" is an INTENT flag, not a position check. The user moving the viewport UP — by any
 *   means: wheel, touch, scrollbar drag, keys, momentum, find-in-page — detaches it. Content growth
 *   that briefly leaves us a few px above the bottom never does (that's what made the old
 *   transcript drop out of follow mid-stream and stop scrolling).
 * - Moving back DOWN into the bottom band (≤ REARM_PX) re-arms following. Only downward movement
 *   re-arms: a small upward scroll that is still inside the band must not snap back.
 * - A ResizeObserver on the content and the viewport re-pins on every growth (streamed tokens,
 *   images loading, a disclosure opening) and on the viewport shrinking (composer growing, mobile
 *   keyboard), so there's no "dep" to thread through.
 * - `follow()` is the send-time override: force-pin and jump, whatever the user was doing.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Gap to the bottom that still counts as "at the end" for re-arming. */
export const REARM_PX = 40;

export function distanceFromBottom(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}

type ScrollSample = { scrollTop: number; scrollHeight: number; clientHeight: number };

/**
 * What a scroll event between two samples says about the user's intent. Upward movement detaches
 * unless the browser caused it by clamping (content shrank or the viewport grew); downward
 * movement that lands in the bottom band re-arms.
 */
export function scrollIntent(prev: ScrollSample, next: ScrollSample): "detach" | "rearm" | null {
  if (next.scrollTop < prev.scrollTop - 1) {
    const clamped =
      next.scrollHeight < prev.scrollHeight || next.clientHeight > prev.clientHeight;
    return clamped ? null : "detach";
  }
  if (next.scrollTop > prev.scrollTop && distanceFromBottom(next) <= REARM_PX) return "rearm";
  return null;
}

/**
 * Whether a wheel/key gesture at `target` would scroll the transcript itself rather than a nested
 * scroller (a long code block, a tool output) that can still move in that direction.
 */
export function gestureTargetsScroller(
  target: EventTarget | null,
  scroller: HTMLElement,
  deltaY: number,
): boolean {
  if (!(target instanceof Element) || !scroller.contains(target)) return true;
  for (
    let el: Element | null = target;
    el && el !== scroller;
    el = el.parentElement
  ) {
    const style = getComputedStyle(el);
    if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
    const canScroll =
      deltaY < 0
        ? el.scrollTop > 0
        : el.scrollTop < el.scrollHeight - el.clientHeight - 1;
    if (canScroll) return false;
  }
  return true;
}

const UP_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);

export function useAutoScroll() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const [following, setFollowingState] = useState(true);
  const [hasUnseen, setHasUnseen] = useState(false);
  const lastHeightRef = useRef(0);

  const setFollowing = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowingState(value);
    if (value) setHasUnseen(false);
  }, []);

  const jump = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  /** Force-follow: called on send and by the jump pill. */
  const follow = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      setFollowing(true);
      jump(behavior);
      // Layout for the just-sent bubble may land a frame later; pin again once it has.
      requestAnimationFrame(() => {
        if (followingRef.current) jump("auto");
      });
    },
    [jump, setFollowing],
  );

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;

    const detach = () => {
      if (followingRef.current && distanceFromBottom(scroller) >= 0) {
        // Content that fits can't scroll away — nothing to detach from.
        if (scroller.scrollHeight <= scroller.clientHeight + 1) return;
        setFollowing(false);
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.deltaY >= 0) return;
      if (!gestureTargetsScroller(e.target, scroller, e.deltaY)) return;
      detach();
    };
    let touchStartY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      // Finger moving DOWN scrolls content UP (towards history).
      if (touchStartY != null && y != null && y - touchStartY > 6) detach();
    };
    const onPointerDown = (e: PointerEvent) => {
      // Scrollbar drags are the only pointerdowns whose target is the scroller itself.
      if (e.target === scroller) detach();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!UP_KEYS.has(e.key) || e.altKey || e.metaKey || e.ctrlKey) return;
      const target = e.target as HTMLElement | null;
      // Arrow keys inside the composer belong to the composer.
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT")
      )
        return;
      if (target && scroller.contains(target) === false && target !== document.body)
        return;
      detach();
    };
    const sample = (): ScrollSample => ({
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    });
    let last = sample();
    const onScroll = () => {
      const next = sample();
      const intent = scrollIntent(last, next);
      last = next;
      if (intent === "detach") detach();
      else if (intent === "rearm" && !followingRef.current) setFollowing(true);
    };

    const observer = new ResizeObserver(() => {
      const height = content.scrollHeight;
      const grew = height > lastHeightRef.current;
      lastHeightRef.current = height;
      if (followingRef.current) jump("auto");
      else if (grew) setHasUnseen(true);
    });
    observer.observe(content);
    observer.observe(scroller);

    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    scroller.addEventListener("pointerdown", onPointerDown, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    // Land at the bottom on mount (opening a session).
    jump("auto");
    return () => {
      observer.disconnect();
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("scroll", onScroll);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [jump, setFollowing]);

  return { scrollRef, contentRef, following, hasUnseen, follow };
}
