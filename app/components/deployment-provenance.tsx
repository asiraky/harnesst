import type { ArtifactProvenanceSummary } from "~/data/ports";
import { Badge } from "~/components/ui/badge";

/** Evidence captured from the container before this deployment went live. */
export function DeploymentProvenance({
  gitSha,
  artifactProvenance,
}: {
  gitSha: string;
  artifactProvenance: ArtifactProvenanceSummary | null;
}) {
  const verified = artifactProvenance?.gitSha === gitSha;
  const evidence = artifactProvenance;

  return (
    <details className="mt-2 min-w-0 rounded-md border px-3 py-2 text-xs">
      <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
        <span className="mr-2">Artifact provenance</span>
        <Badge variant={verified ? "success" : evidence ? "destructive" : "warning"}>
          {verified ? "Verified" : evidence ? "Verification mismatch" : "Unverified"}
        </Badge>
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-muted-foreground">
          {verified
            ? "The container image and configuration were checked against this release before it went live."
            : evidence
              ? "The recorded artifact does not match this release commit. Redeploy to verify the configuration."
              : "This deployment has no recorded artifact verification. Its version and image tag alone do not prove which configuration is running. Redeploy to build and verify it."}
        </p>
        <dl className="grid min-w-0 gap-x-4 gap-y-2 sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Release commit</dt>
          <dd className="min-w-0 break-all font-mono">{gitSha}</dd>
          {evidence && (
            <>
              {!verified && (
                <>
                  <dt className="text-muted-foreground">Artifact commit</dt>
                  <dd className="min-w-0 break-all font-mono">{evidence.gitSha}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Running image digest</dt>
              <dd className="min-w-0 break-all font-mono">{evidence.runtimeDigest}</dd>
              <dt className="text-muted-foreground">Source digest</dt>
              <dd className="min-w-0 break-all font-mono">{evidence.sourceDigest}</dd>
              <dt className="text-muted-foreground">Build context digest</dt>
              <dd className="min-w-0 break-all font-mono">{evidence.contextDigest}</dd>
              <dt className="text-muted-foreground">Agent source root</dt>
              <dd className="min-w-0 break-all font-mono">{evidence.agentRoot || "."}</dd>
            </>
          )}
        </dl>
        {evidence && (
          <details>
            <summary className="cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
              Platform-generated additions ({evidence.platformFiles.length})
            </summary>
            {evidence.platformFiles.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {evidence.platformFiles.map((path) => (
                  <li key={path} className="break-all font-mono">{path}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-muted-foreground">None recorded.</p>
            )}
          </details>
        )}
      </div>
    </details>
  );
}
