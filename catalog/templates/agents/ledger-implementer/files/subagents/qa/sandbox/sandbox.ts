// This subagent needs its own backend and bootstrap; eve does not inherit the parent's sandbox.
import { defaultBackend, defineSandbox } from "eve/sandbox";
const defaults = {
  AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
  AGENT_BROWSER_PROFILE: "/workspace/home/agent-browser/profile",
  AGENT_BROWSER_SCREENSHOT_DIR: "/workspace/home/agent-browser/screenshots",
  AGENT_BROWSER_IDLE_TIMEOUT_MS: "600000",
};
const names = (process.env.HARNESST_SANDBOX_ENV ?? "")
  .split(",")
  .filter(Boolean);
const env = {
  ...defaults,
  ...Object.fromEntries(names.map((name) => [name, process.env[name] ?? ""])),
};
export default defineSandbox({
  backend: () => defaultBackend({ docker: { env }, vercel: { env } }),
  revalidationKey: () => "agent-browser@0.31.1-chromium-debian-trixie-v2",
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.run({
      command: "command -v node >/dev/null && command -v npm >/dev/null",
    });
    await sandbox.run({
      command:
        "sudo -n bash <<'BOOTSTRAP'\n" +
        'if ! command -v chromium >/dev/null; then echo "deb [arch=$(dpkg --print-architecture) trusted=yes] http://deb.debian.org/debian trixie main" > /etc/apt/sources.list.d/debian-trixie.list && printf "Package: *\\nPin: release n=trixie\\nPin-Priority: 100\\n" > /etc/apt/preferences.d/debian-trixie && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*; fi' +
        "\nBOOTSTRAP",
    });
    await sandbox.run({
      command:
        "command -v agent-browser >/dev/null || sudo -n npm install -g agent-browser@0.31.1",
    });
    await sandbox.run({
      command:
        "AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium agent-browser --version",
    });
    await sandbox.run({
      command:
        "AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium agent-browser open https://example.com",
    });
    await sandbox.run({ command: "agent-browser close --all" });
  },
});
