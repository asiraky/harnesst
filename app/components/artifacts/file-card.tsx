import type { ReactNode } from "react";
import { Download, ExternalLink } from "lucide-react";

import { Button } from "~/components/ui/button";
import { formatBytes } from "~/components/chat/composer";
import type { ArtifactBadge } from "./artifact-type";
import { TypeBadge } from "./type-badge";

/** A file shown as what it is — badge, name, size, type — with actions under it. */
export function FileCard({
  badge,
  name,
  contentType,
  byteSize,
  note,
  children,
}: {
  badge: ArtifactBadge;
  name: string;
  contentType: string;
  byteSize: number;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <TypeBadge badge={badge} className="size-16 rounded-xl text-[13px]" />
      <div className="flex max-w-full flex-col gap-1">
        <p className="text-sm font-medium break-all">{name}</p>
        <p className="text-xs text-muted-foreground">
          {formatBytes(byteSize)} · {contentType}
        </p>
      </div>
      {note && <p className="max-w-72 text-xs text-muted-foreground">{note}</p>}
      <div className="flex flex-wrap justify-center gap-2">{children}</div>
    </div>
  );
}

export function DownloadButton({
  href,
  name,
  variant = "outline",
}: {
  href: string;
  name: string;
  variant?: "default" | "outline";
}) {
  return (
    <Button asChild variant={variant} className="min-w-32">
      <a href={href} download={name}>
        <Download /> Download
      </a>
    </Button>
  );
}

export function OpenInTabButton({
  href,
  label = "Open in new tab",
  variant = "outline",
}: {
  href: string;
  label?: string;
  variant?: "default" | "outline";
}) {
  return (
    <Button asChild variant={variant} className="min-w-32">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <ExternalLink /> {label}
      </a>
    </Button>
  );
}

/** Any type with no viewer: say so, and offer the bytes. */
export function FallbackView({
  badge,
  name,
  contentType,
  byteSize,
  rawUrl,
  downloadUrl,
}: {
  badge: ArtifactBadge;
  name: string;
  contentType: string;
  byteSize: number;
  rawUrl: string;
  downloadUrl: string;
}) {
  return (
    <FileCard
      badge={badge}
      name={name}
      contentType={contentType}
      byteSize={byteSize}
      note="There's no in-app preview for this type."
    >
      <DownloadButton href={downloadUrl} name={name} variant="default" />
      <OpenInTabButton href={rawUrl} />
    </FileCard>
  );
}
