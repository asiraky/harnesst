import { defaultBackend, defineSandbox } from "eve/sandbox";

const names = (process.env.HARNESST_SANDBOX_ENV ?? "").split(",").filter(Boolean);
const env = Object.fromEntries(names.map((name) => [name, process.env[name] ?? ""]));

export default defineSandbox({
  backend: () => defaultBackend({ docker: { env }, vercel: { env } }),
});
