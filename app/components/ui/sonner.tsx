/**
 * shadcn/ui Toaster over sonner, minus next-themes: toast colors come from the app's
 * CSS tokens (app.css), which already flip with the `.dark` class — no theme prop needed.
 */
import { Toaster as Sonner, type ToasterProps } from "sonner";

export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
