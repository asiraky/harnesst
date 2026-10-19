---
description: Use when you need to know which command-line tools are preinstalled in your sandbox, or when a tool you expected is missing. Inventory of the developer toolchain and how tool installs persist (or don't) across sessions.
---

# Developer toolchain

Your sandbox template is built with a broad developer toolchain already installed — reach
for these directly instead of installing them per session:

- **Version control & GitHub:** `git`, `gh` (authentication is a separate concern — see the
  GitHub App auth skill if it's installed)
- **Search & files:** `rg` (ripgrep), `fd`, `tree`, `file`, `less`
- **Data wrangling:** `jq`, `sqlite3`
- **Archives & transfer:** `unzip`, `zip`, `rsync`, `curl`, `wget`, `openssh-client`
- **Build & languages:** `build-essential` (gcc, make), `pkg-config`, `python3`, `pip`,
  `python3 -m venv`
- **JavaScript package managers:** `npm`, `pnpm`, `yarn` (via corepack), plus whatever the
  repository's lockfile implies — always use the repo's own package manager
- **Editing & checks:** `nano`, `shellcheck`

If something you need is missing, you can `apt-get install` it in-session, but know the
persistence rule: the preinstalled set above is snapshotted into the sandbox *template*, so
it exists from the first second of every session; anything you install yourself lives only
in the current session container and may be gone next session. Install ad hoc when you need
a tool once; ask the user to add it to the sandbox bootstrap when you find yourself
installing it every session.
