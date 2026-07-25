FROM node:24-alpine AS development-dependencies-env
COPY . /app
WORKDIR /app
RUN npm ci

FROM node:24-alpine AS production-dependencies-env
# .npmrc matters: the repo installs with legacy-peer-deps (react-router 8.0/8.1 peer skew).
COPY ./package.json package-lock.json .npmrc /app/
WORKDIR /app
RUN npm ci --omit=dev

FROM node:24-alpine AS build-env
COPY . /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
WORKDIR /app
RUN npm run build

FROM node:24-alpine
# The control plane shells out to `docker` (agent image builds, deploys, publish build-checks —
# app/deploy/eve-image.server.ts, app/seams/oss/deploy.localdocker.server.ts) and to GNU `tar`
# (source extraction with --strip-components). In the self-host stack the host's Docker socket
# is mounted in, so only the CLI client is needed here. buildx matters: without it the CLI
# falls back to the deprecated legacy builder, whose step output goes to stdout in a format
# extractBuildError can't parse — build failures then surface without the compiler's lines.
RUN apk add --no-cache docker-cli docker-cli-buildx tar
COPY ./package.json package-lock.json .npmrc /app/
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
COPY server /app/server
# First-party marketplace catalog (the fixture CatalogSource reads <cwd>/catalog). Bundled into
# the image so a self-hosted deploy works offline; the GitHub-raw source (HARNESST_CATALOG_REPO) is
# only for pointing at a public catalog repo.
COPY catalog /app/catalog
# The built-in assistant's eve project (docs/ASSISTANT.md). Bundled so the control plane can
# build the shared harnesst-assistant:<hash> image from a local directory (no GitHub tarball).
COPY assistant-template /app/assistant-template
WORKDIR /app
ENV NODE_ENV=production
CMD ["npm", "run", "start"]
