/** Compare fixed-length digests rather than leaking a bearer token prefix. */
export async function authorized(
  request: Request,
  secret: string,
): Promise<boolean> {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [a, b] = await Promise.all([
    digest(header),
    digest(`Bearer ${secret}`),
  ]);
  let different = 0;
  for (let n = 0; n < a.length; n++) different |= a[n] ^ b[n];
  return different === 0;
}
