import { getInstallationOctokit } from "~/github/client.server";

/**
 * Reads used before destructive model rewrites must distinguish a missing file from a failed
 * read. The general editor reader is best-effort; using its null on API failures would scaffold
 * over existing user code. A Contents 404 counts as absent only while its repo/ref is readable.
 */
export async function readModelResetFile(
  installationId: string | number,
  { owner, repo, ref }: { owner: string; repo: string; ref?: string },
  path: string,
): Promise<string | null> {
  const octokit = await getInstallationOctokit(installationId);
  const branch =
    ref ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
  let response;
  try {
    response = await octokit.rest.repos.getContent({
      owner,
      repo,
      ref: branch,
      path,
    });
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("status" in error) ||
      error.status !== 404
    )
      throw error;
    // GitHub also uses 404 for lost repo access and nonexistent refs. Do not call those a
    // missing path: verify the exact revision is still accessible before allowing scaffolding.
    await octokit.rest.repos.getCommit({ owner, repo, ref: branch });
    return null;
  }

  const data = response.data;
  const unreadable = () =>
    new Error(
      `Cannot reset model: ${path} is not a readable UTF-8 text file. Existing source was not changed.`,
    );
  if (
    Array.isArray(data) ||
    data.type !== "file" ||
    !("content" in data) ||
    typeof data.content !== "string" ||
    data.encoding !== "base64"
  )
    throw unreadable();
  const encoded = data.content.replace(/\s/g, "");
  const bytes = Buffer.from(encoded, "base64");
  // Buffer's base64 decoder silently tolerates malformed input. Refuse partial content instead.
  if (
    bytes.toString("base64") !== encoded ||
    bytes.length !== data.size ||
    bytes.includes(0)
  )
    throw unreadable();
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
      throw unreadable();
    return text;
  } catch {
    throw unreadable();
  }
}
