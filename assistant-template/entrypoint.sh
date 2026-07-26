#!/bin/sh
# Assistant instance boot. Materialize the published user config layer,
# then — only if a user layer exists — recompile with `eve build` (eve discovers
# instructions/skills/schedules at build time), then hand off to `eve start` (which also prewarms
# the sandbox template). A missing/empty user layer takes the fast path: the fixed layer is
# already compiled into this image, so we boot straight into `eve start`.
set -e

node bootstrap.mjs || true

# Per-project model override (bundle assistant.json) takes precedence over the deploy-env default.
if [ -f .harnesst-assistant-env ]; then
  . ./.harnesst-assistant-env
  export HARNESST_ASSISTANT_MODEL
  export HARNESST_ASSISTANT_EFFORT
fi

# `eve build` EVALUATES agent.ts and freezes its resolved model into the compiled artifact. The
# image is compiled inside `docker build`, where HARNESST_ASSISTANT_MODEL is never set, so the image's
# artifact runs the build-safe default (z-ai/glm-5.2) — NOT the configured model. Rebuild whenever
# the model/effort this container should run differs from what the current artifact was compiled
# with (recorded in .harnesst-built-model), or when a user config layer arrived. The marker persists on
# the container filesystem, so restarts with an unchanged selection keep the fast path.
WANT_MODEL="${HARNESST_ASSISTANT_MODEL:-}|${HARNESST_ASSISTANT_EFFORT:-}"
HAVE_MODEL="$(cat .harnesst-built-model 2>/dev/null || true)"
if [ -f .harnesst-user-layer ] || [ "$WANT_MODEL" != "$HAVE_MODEL" ]; then
  echo "[assistant] recompiling (user config layer present or model selection changed)…"
  node_modules/.bin/eve build
  printf '%s' "$WANT_MODEL" > .harnesst-built-model
fi

# Checkout sidecar: owns the per-conversation git
# checkouts on the shared home volume and answers the control plane's ensure/tree calls on a second
# port. Backgrounded before `eve start` takes over PID 1; --init (deploy target) reaps it on stop.
node checkout-sidecar.mjs &

exec node_modules/.bin/eve start
