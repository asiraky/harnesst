import { defaultBackend, defineSandbox } from "eve/sandbox";

// harnesst convention: EDEN_SANDBOX_ENV is a comma-separated allowlist of env var NAMES
// forwarded from the instance into the sandbox. Everything else stays sealed out.
const names = (process.env.EDEN_SANDBOX_ENV ?? "").split(",").filter(Boolean);
const env = Object.fromEntries(names.map((n) => [n, process.env[n] ?? ""]));

export default defineSandbox({
  backend: () => defaultBackend({ docker: { env }, vercel: { env } }),
});
