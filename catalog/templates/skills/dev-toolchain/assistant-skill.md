---
description: Load when an agent has the Developer toolchain skill installed and the request
  involves shell tooling in the agent's sandbox.
---

# Developer toolchain (installed skill)

Preinstalls a broad toolchain in the agent's sandbox — git, gh, jq, ripgrep, build tools,
python3, pnpm/yarn and friends — with a skill inventorying it. When designing sandbox work,
assume these exist instead of adding per-session `apt-get` bootstrap steps.
