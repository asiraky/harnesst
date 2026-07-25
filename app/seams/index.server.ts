/**
 * Runtime registry — the single place that binds the seams (types.ts) to concrete
 * implementations for the current `HARNESST_MODE` (PRD §8, ARCH §1.5). Everything else in the
 * app depends on `getRuntime()`, never on a concrete provider, so OSS and managed stay one
 * codebase with no fork.
 *
 * `HARNESST_MODE=oss` (default) wires the local/BYO reference implementations. `HARNESST_MODE=managed`
 * will wire the KMS/gateway/Stripe/Nomad implementations as they land (M4); until then it
 * falls back to the OSS impls so the control plane still boots.
 */
import { drizzleDataStore } from "~/data/drizzle.server";
import { managedMeteringSink } from "~/managed/metering.stripe.server";
import { managedModelGateway } from "~/managed/gateway.proxy.server";
import { nomadTarget } from "./adapters/deploy.nomad.server";
import { vercelTarget } from "./adapters/deploy.vercel.server";
import { fixtureCatalog } from "./oss/catalog.fixture.server";
import { githubCatalog } from "./oss/catalog.github.server";
import { containerPostgresTarget } from "./oss/deploy.container.server";
import { localDockerTarget } from "./oss/deploy.localdocker.server";
import { directModelGateway } from "./oss/gateway.direct.server";
import { localMeteringSink } from "./oss/metering.local.server";
import { localScheduler } from "./oss/scheduler.local.server";
import { localSecretsProvider } from "./oss/secrets.local.server";
import { localTelemetrySink } from "./oss/telemetry.local.server";
import type {
  CatalogSource,
  DeployTarget,
  HarnesstMode,
  HarnesstRuntime,
} from "./types";

function resolveMode(): HarnesstMode {
  return process.env.HARNESST_MODE === "managed" ? "managed" : "oss";
}

/** Pick the DeployTarget by `HARNESST_DEPLOY_TARGET` (container | nomad | vercel). */
function resolveDeployTarget(): DeployTarget {
  switch (process.env.HARNESST_DEPLOY_TARGET) {
    case "local-docker":
      return localDockerTarget;
    case "nomad":
      return nomadTarget;
    case "vercel":
      return vercelTarget;
    default:
      return containerPostgresTarget;
  }
}

/** Catalog source: the GitHub-raw pointer when `HARNESST_CATALOG_REPO` is set, else the in-repo fixture. */
function resolveCatalog(): CatalogSource {
  return process.env.HARNESST_CATALOG_REPO ? githubCatalog : fixtureCatalog;
}

function buildRuntime(mode: HarnesstMode): HarnesstRuntime {
  // Managed-only implementations (KMS secrets, gateway proxy, Stripe metering, Nomad target)
  // are introduced in M4 and swapped in here by mode. Until then both modes share the OSS
  // reference impls; the seam boundary means that swap is local to this file.
  const managed = mode === "managed";
  return {
    mode,
    data: drizzleDataStore,
    // Deploy target selectable per host (container default; nomad/vercel adapters).
    deployTarget: resolveDeployTarget(),
    secrets: localSecretsProvider,
    scheduler: localScheduler,
    telemetry: localTelemetrySink,
    // Managed swaps in the gateway proxy (keys/metering/caps) and Stripe metering.
    modelGateway: managed ? managedModelGateway : directModelGateway,
    metering: managed ? managedMeteringSink : localMeteringSink,
    // Marketplace catalog: fixture (in-repo seed) by default; GitHub-raw when HARNESST_CATALOG_REPO set.
    catalog: resolveCatalog(),
  };
}

let cached: HarnesstRuntime | undefined;

/** The runtime implementations selected for this process. Cached after first resolution. */
export function getRuntime(): HarnesstRuntime {
  return (cached ??= buildRuntime(resolveMode()));
}
