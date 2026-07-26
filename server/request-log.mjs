const REDACTED_PATHS = [
  {
    prefix: "/api/auth/reset-password/",
    replacement: "/api/auth/reset-password/[redacted]",
  },
  {
    prefix: "/accept-invitation/",
    replacement: "/accept-invitation/[redacted]",
  },
];

/** Return a query-free, token-redacted path safe for durable production logs. */
export function safeRequestPath(requestTarget) {
  let pathname;
  try {
    pathname = new URL(requestTarget, "http://harnesst.invalid").pathname;
  } catch {
    return "/[invalid-request-target]";
  }

  const sensitive = REDACTED_PATHS.find(({ prefix }) =>
    pathname.startsWith(prefix),
  );
  return sensitive?.replacement ?? pathname;
}

export function formatRequestLog({
  durationMs,
  method,
  requestTarget,
  status,
}) {
  return `${method} ${safeRequestPath(requestTarget)} ${status} ${durationMs.toFixed(1)}ms`;
}

export function requestLogger(request, response, next) {
  const startedAt = performance.now();
  response.once("finish", () => {
    console.info(
      formatRequestLog({
        method: request.method,
        requestTarget: request.originalUrl,
        status: response.statusCode,
        durationMs: performance.now() - startedAt,
      }),
    );
  });
  next();
}
