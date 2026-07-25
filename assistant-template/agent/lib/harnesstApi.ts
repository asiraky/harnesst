// Shared client for harnesst's assistant callback API. Every harnesst_* tool is a
// thin wrapper over this. All variability arrives via env: HARNESST_API_URL + HARNESST_ASSISTANT_TOKEN
// (injected by harnesst's deploy). Never throws — every failure path returns { ok: false, error } so
// the model reads the text, exactly like the delegation relay.

type harnesstResult = Record<string, unknown> & { ok?: boolean; error?: string };

export async function harnesstCall(
  action: string,
  body: Record<string, unknown> = {},
): Promise<harnesstResult> {
  const baseUrl = process.env.HARNESST_API_URL;
  const token = process.env.HARNESST_ASSISTANT_TOKEN;
  if (!baseUrl || !token) {
    return { ok: false, error: "The harnesst assistant API is not configured for this instance." };
  }
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, "") + "/api/assistant/" + action, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const data = (await res.json().catch(() => null)) as harnesstResult | null;
    if (!res.ok) {
      return {
        ok: false,
        error:
          data && typeof data.error === "string"
            ? data.error
            : "harnesst API error (HTTP " + res.status + ").",
      };
    }
    return data ?? { ok: false, error: "harnesst returned an empty response." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: "Couldn't reach harnesst: " + message };
  }
}
