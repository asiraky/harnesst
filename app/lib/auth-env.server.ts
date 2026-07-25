const LOCAL_PART_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const MINIMUM_SECRET_ENTROPY_BITS = 120;

function estimateSecretEntropy(secret: string): number {
  const uniqueCharacters = new Set(secret).size;
  if (uniqueCharacters === 0) return 0;

  // Keep this aligned with Better Auth's own conservative entropy estimate.
  return secret.length * Math.log2(uniqueCharacters);
}

function isPlausibleMailbox(value: string): boolean {
  const trimmed = value.trim();
  const namedAddress = trimmed.match(/^[^<>\r\n]+<([^<>\r\n]+)>$/);
  const mailbox = (namedAddress?.[1] ?? trimmed).trim();
  const separator = mailbox.lastIndexOf("@");
  if (separator <= 0 || separator !== mailbox.indexOf("@")) return false;

  const localPart = mailbox.slice(0, separator);
  const domain = mailbox.slice(separator + 1);
  const domainLabels = domain.split(".");

  return (
    mailbox.length <= 254 &&
    localPart.length <= 64 &&
    LOCAL_PART_PATTERN.test(localPart) &&
    !localPart.startsWith(".") &&
    !localPart.endsWith(".") &&
    !localPart.includes("..") &&
    domain.length <= 253 &&
    domainLabels.length >= 2 &&
    domainLabels.every(
      (label) => label.length <= 63 && DOMAIN_LABEL_PATTERN.test(label),
    )
  );
}

function isHttpsOrigin(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https:\/\/[^/?#]+\/?$/i.test(trimmed)) return false;
  const authority = trimmed.slice("https://".length).replace(/\/$/, "");
  if (authority.includes("@")) return false;

  try {
    const url = new URL(trimmed);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isBareHostname(value: string): boolean {
  if (value.length > 253) return false;
  const labels = value.split(".");
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      DOMAIN_LABEL_PATTERN.test(label),
  );
}

export function assertProductionAuthEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== "production") return;

  const errors: string[] = [];
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32) {
    errors.push("BETTER_AUTH_SECRET must be at least 32 characters.");
  }
  if (estimateSecretEntropy(secret) < MINIMUM_SECRET_ENTROPY_BITS) {
    errors.push(
      "BETTER_AUTH_SECRET must have at least 120 bits of estimated entropy.",
    );
  }

  const authUrl = env.BETTER_AUTH_URL?.trim() ?? "";
  if (!isHttpsOrigin(authUrl)) {
    errors.push(
      "BETTER_AUTH_URL must be an absolute HTTPS origin without credentials, a path, query parameters, or a fragment.",
    );
  }

  // Optional marketing host (FOH host split, D11): a bare hostname — no scheme, port, path,
  // or credentials — and never the app host itself (the redirect rules would loop).
  const marketingHost = env.MARKETING_HOST?.trim() ?? "";
  if (marketingHost) {
    if (!isBareHostname(marketingHost)) {
      errors.push(
        "MARKETING_HOST must be a bare host such as www.example.com — no scheme, port, path, or credentials.",
      );
    } else if (
      isHttpsOrigin(authUrl) &&
      new URL(authUrl).hostname === marketingHost.toLowerCase()
    ) {
      errors.push("MARKETING_HOST must differ from the BETTER_AUTH_URL host.");
    }
  }

  if (!env.POSTMARK_SERVER_TOKEN?.trim()) {
    errors.push("POSTMARK_SERVER_TOKEN is required.");
  }

  const fromEmail = env.FROM_EMAIL?.trim() ?? "";
  if (!isPlausibleMailbox(fromEmail)) {
    errors.push(
      "FROM_EMAIL must be a mailbox such as noreply@example.com or harnesst <noreply@example.com>.",
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid production auth and email configuration:\n- ${errors.join("\n- ")}`,
    );
  }
}
