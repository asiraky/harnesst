import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

export interface SecretInputProps
  extends Omit<React.ComponentProps<typeof Input>, "type"> {
  /** Extra classes for the relative wrapper — put width/layout classes here. */
  wrapperClassName?: string;
  /** Noun used in the show/hide aria-label, e.g. "value". */
  revealLabel?: string;
  /** Render the eye reveal toggle. Defaults to true. */
  showToggle?: boolean;
}

/**
 * Masked secret-entry field (issue #105). Browsers' password managers pattern-match a
 * text input immediately followed by a `type="password"` input inside a <form> as a login
 * form and inject saved credentials — which was leaking the user's harnesst login email/password
 * into secret fields. `autoComplete="new-password"` makes Chrome treat this as a new/generated
 * password rather than a saved-credential target, and the data-*ignore attributes opt out of
 * 1Password / LastPass / Bitwarden. Masking stays a real `type="password"` field so it works in
 * every browser (the CSS `-webkit-text-security` alternative has no Firefox support); the eye
 * toggle reveals it on demand.
 */
export function SecretInput({
  className,
  wrapperClassName,
  revealLabel = "value",
  showToggle = true,
  ...props
}: SecretInputProps) {
  const [revealed, setRevealed] = React.useState(false);
  return (
    <div className={cn("relative", wrapperClassName)}>
      <Input
        {...props}
        type={revealed ? "text" : "password"}
        autoComplete="new-password"
        data-1p-ignore="true"
        data-lpignore="true"
        data-bwignore=""
        data-form-type="other"
        className={cn(showToggle && "pr-8", className)}
      />
      {showToggle && (
        <button
          type="button"
          className="absolute inset-y-0 right-2 text-muted-foreground"
          aria-label={revealed ? `Hide ${revealLabel}` : `Show ${revealLabel}`}
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      )}
    </div>
  );
}
