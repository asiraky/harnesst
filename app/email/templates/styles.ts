import type { CSSProperties } from "react";

// Brand blue (--primary, oklch(0.625 0.201 265)) approximated in sRGB for
// email clients, which don't support oklch().
export const EDEN_BLUE = "#3b6deb";

export const emailStyles = {
  main: {
    backgroundColor: "#f7f7f5",
    color: "#171717",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    margin: 0,
    padding: "40px 16px",
  } satisfies CSSProperties,
  container: {
    backgroundColor: "#ffffff",
    border: "1px solid #e5e5e5",
    borderRadius: "12px",
    margin: "0 auto",
    maxWidth: "480px",
    padding: "40px",
  } satisfies CSSProperties,
  // The "harnesst" wordmark, drawn in text: blue leading `h`, ink for the rest —
  // mirrors the in-app logo without shipping an image attachment.
  brand: {
    color: "#171717",
    fontSize: "22px",
    fontWeight: 700,
    letterSpacing: "-0.02em",
    lineHeight: "28px",
    margin: "0 0 28px",
  } satisfies CSSProperties,
  brandAccent: {
    color: EDEN_BLUE,
  } satisfies CSSProperties,
  heading: {
    color: "#171717",
    fontSize: "20px",
    fontWeight: 600,
    letterSpacing: "-0.01em",
    lineHeight: "28px",
    margin: "0 0 16px",
  } satisfies CSSProperties,
  text: {
    color: "#404040",
    fontSize: "15px",
    lineHeight: "24px",
    margin: "0 0 16px",
  } satisfies CSSProperties,
  button: {
    backgroundColor: "#171717",
    borderRadius: "8px",
    color: "#ffffff",
    display: "block",
    fontSize: "15px",
    fontWeight: 600,
    margin: "24px 0",
    padding: "12px 20px",
    textAlign: "center",
    textDecoration: "none",
  } satisfies CSSProperties,
  muted: {
    color: "#737373",
    fontSize: "14px",
    lineHeight: "22px",
    margin: "0 0 8px",
  } satisfies CSSProperties,
  rule: {
    borderColor: "#e5e5e5",
    margin: "28px 0 20px",
  } satisfies CSSProperties,
  footer: {
    color: "#737373",
    fontSize: "12px",
    lineHeight: "18px",
    margin: "0 0 6px",
  } satisfies CSSProperties,
  link: {
    color: "#525252",
    fontSize: "12px",
    lineHeight: "18px",
    margin: 0,
    overflowWrap: "anywhere",
    textDecoration: "underline",
  } satisfies CSSProperties,
};
