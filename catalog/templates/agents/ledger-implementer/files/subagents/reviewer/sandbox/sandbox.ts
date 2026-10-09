// This subagent needs its own backend and bootstrap; eve does not inherit the parent's sandbox.
import { defaultBackend, defineSandbox } from "eve/sandbox";
const defaults = {};
const names = (process.env.HARNESST_SANDBOX_ENV ?? "")
  .split(",")
  .filter(Boolean);
const env = {
  ...defaults,
  ...Object.fromEntries(names.map((name) => [name, process.env[name] ?? ""])),
};
export default defineSandbox({
  backend: () => defaultBackend({ docker: { env }, vercel: { env } }),
  revalidationKey: () => "reviewer-toolchain@2026-09-17",
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.run({
      command:
        "if [ \"$(id -u)\" -eq 0 ]; then bash -lc 'apt-get update && apt-get install -y --no-install-recommends ca-certificates curl wget git jq unzip zip rsync openssh-client build-essential pkg-config python3 python3-pip python3-venv sqlite3 ripgrep fd-find shellcheck tree file less nano && rm -rf /var/lib/apt/lists/*'; else sudo -n bash -lc 'apt-get update && apt-get install -y --no-install-recommends ca-certificates curl wget git jq unzip zip rsync openssh-client build-essential pkg-config python3 python3-pip python3-venv sqlite3 ripgrep fd-find shellcheck tree file less nano && rm -rf /var/lib/apt/lists/*'; fi",
    });
    await sandbox.run({
      command:
        'if [ "$(id -u)" -eq 0 ]; then bash -lc \'command -v fd >/dev/null || (command -v fdfind >/dev/null && ln -s "$(command -v fdfind)" /usr/local/bin/fd) || true\'; else sudo -n bash -lc \'command -v fd >/dev/null || (command -v fdfind >/dev/null && ln -s "$(command -v fdfind)" /usr/local/bin/fd) || true\'; fi',
    });
    await sandbox.run({
      command:
        'if [ "$(id -u)" -eq 0 ]; then bash -lc \'command -v gh >/dev/null || (mkdir -p -m 755 /etc/apt/keyrings && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*)\'; else sudo -n bash -lc \'command -v gh >/dev/null || (mkdir -p -m 755 /etc/apt/keyrings && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*)\'; fi',
    });
    await sandbox.run({ command: "corepack enable || true" });
    await sandbox.run({
      command:
        "set -e; command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@latest; command -v yarn >/dev/null 2>&1 || npm install -g yarn@latest",
    });
    await sandbox.run({
      command: "git --version && gh --version && jq --version && rg --version",
    });
  },
});
