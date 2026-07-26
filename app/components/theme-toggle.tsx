/**
 * Theme selector: System (default, follows the OS) / Light / Dark.
 *
 * The choice persists in the `harnesst-theme` cookie (1yr, SameSite=Lax), read
 * before first paint by the inline script in app/root.tsx so there's no flash.
 * Setting it here applies the class immediately — no navigation/round-trip.
 */
import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

const THEME_COOKIE = "harnesst-theme";
type Theme = "system" | "light" | "dark";

function readTheme(): Theme {
  if (typeof document === "undefined") return "system";
  const m = document.cookie.match(/(?:^|; )harnesst-theme=([^;]+)/);
  const v = m ? decodeURIComponent(m[1]) : "system";
  return v === "light" || v === "dark" ? v : "system";
}

/** Apply `pref` to <html> and persist it; mirrors the pre-paint script in root.tsx. */
function applyTheme(pref: Theme) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = pref === "dark" || (pref === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", dark);
  document.cookie = `${THEME_COOKIE}=${pref}; path=/; max-age=31536000; SameSite=Lax`;
  emit();
}

// Tiny external store over the theme cookie: the server snapshot is "system" (matching SSR
// markup) and the client snapshot re-reads the cookie whenever applyTheme() emits.
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emit() {
  for (const cb of listeners) cb();
}

const OPTIONS: { value: Theme; label: string; icon: typeof Monitor }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/**
 * The same selector as a submenu, for embedding inside an existing dropdown (the FOH
 * account menu). Must render within a <DropdownMenu> root.
 */
export function ThemeMenuSub() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);
  const Active = OPTIONS.find((o) => o.value === theme)?.icon ?? Monitor;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Active className="mr-2 h-4 w-4 text-muted-foreground" />
        Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent>
          {OPTIONS.map(({ value, label, icon: Icon }) => (
            <DropdownMenuItem
              key={value}
              onSelect={() => applyTheme(value)}
              className={theme === value ? "font-medium" : undefined}
            >
              <Icon className="mr-2 h-4 w-4" />
              {label}
              {theme === value && <span className="ml-auto text-xs">✓</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

export function ThemeToggle() {
  // Cookie state via useSyncExternalStore: hydration-safe (server snapshot is
  // "system") without an extra state+effect round trip.
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);

  const Active = OPTIONS.find((o) => o.value === theme)?.icon ?? Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Change theme">
          <Active className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => applyTheme(value)}
            className={theme === value ? "font-medium" : undefined}
          >
            <Icon className="mr-2 h-4 w-4" />
            {label}
            {theme === value && <span className="ml-auto text-xs">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
