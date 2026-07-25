import { defaultBackend, defineSandbox } from "eve/sandbox";

// The assistant's sandbox is where the MODEL works: it
// edits a real per-conversation git checkout on the shared home volume (/workspace/home/checkouts,
// mounted by harnesst's eve-docker shim) with native bash — cat/ls/edit, `git`, `npm ci`, typecheck.
// That needs git + node + npm in the sandbox image; the default eve sandbox image is not guaranteed
// to carry git, so we pin an image that does. Override with HARNESST_SANDBOX_IMAGE for a custom base.
const names = (process.env.HARNESST_SANDBOX_ENV ?? "").split(",").filter(Boolean);
const env = Object.fromEntries(names.map((n) => [n, process.env[n] ?? ""]));
const image = process.env.HARNESST_SANDBOX_IMAGE ?? "node:24";

export default defineSandbox({
  backend: () => defaultBackend({ docker: { env, image }, vercel: { env } }),
});
