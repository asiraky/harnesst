import { createHash } from "node:crypto";
/** Seed valid downloadable documents and an HTML preview through the real artifact store. */
export async function seedArtifacts(server, db, schema) {
  const store = await server.ssrLoadModule("/app/foh/artifact-store.server.ts");
  const sessions = await db.select().from(schema.playgroundSessions);
  const all = await db.select().from(schema.artifacts);
  for (const artifact of all.filter((a) => a.kind === "document")) {
    const bytes = Buffer.from(
      "# Customer feedback\n\n24 customer conversations reviewed.\n",
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    const storagePath = await store.writeArtifactBytes(hash, bytes);
    await store.recordArtifact({
      ...artifact,
      entryPath: null,
      deploymentId: "preview",
      sha256: hash,
      storagePath,
      byteSize: bytes.length,
      keepVersions: 5,
      maxVersions: 20,
    });
  }
  const session = sessions.find((s) => s.surface === "foh" && !s.archivedAt);
  if (!session) return;
  const bytes = Buffer.from(
    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Customer feedback report</title><style>body{font:16px system-ui;margin:0;padding:24px;background:#faf8f4;color:#222}h1{font-size:28px}article{padding:16px;background:white;border-radius:12px}</style><h1>Customer feedback</h1><p>September weekly report</p><article><h2>24 conversations reviewed</h2><p>Top priorities: onboarding, reporting, and integrations.</p></article></html>',
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  const storagePath = await store.writeArtifactBytes(hash, bytes);
  await store.recordArtifact({
    projectId: session.projectId,
    agentId: session.agentId,
    sessionId: session.id,
    deploymentId: "preview",
    name: "customer-feedback.html",
    title: "Customer feedback report",
    kind: "html",
    entryPath: "index.html",
    contentType: "text/html",
    byteSize: bytes.length,
    sha256: hash,
    storagePath,
    streamIndex: 0,
    keepVersions: 5,
    maxVersions: 20,
    files: [
      {
        relPath: "index.html",
        contentType: "text/html",
        byteSize: bytes.length,
        sha256: hash,
        storagePath,
      },
    ],
  });
}
