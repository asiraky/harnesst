import { cn } from "~/lib/utils";
import type { ArtifactBadge, ArtifactTypeFamily } from "./artifact-type";

// Tints per family. Light text is darkened and dark text lifted so a 10px label keeps its contrast
// in both themes.
const FAMILY_TONE: Record<ArtifactTypeFamily, string> = {
  html: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  doc: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  image: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
  media: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  data: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  code: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  other: "bg-muted text-muted-foreground",
};

/**
 * The coloured square with the file type in it — shared by the transcript card and the viewers'
 * file card, so a type looks the same everywhere it appears. Decorative: the name beside it says
 * the same thing to a screen reader.
 */
export function TypeBadge({
  badge,
  className,
}: {
  badge: ArtifactBadge;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-lg font-mono text-[10px] font-semibold tracking-tight",
        badge.label.length > 4 && "text-[8.5px]",
        FAMILY_TONE[badge.family],
        className,
      )}
    >
      {badge.label}
    </span>
  );
}
