/**
 * Client lookup from provisioner id to its Setup components. The Setup page renders the generic
 * connection picker and step frame; everything provisioner-specific comes from here.
 */
import type { ComponentType } from "react";

import type { ProvisionerId } from "./descriptors";
import { LedgerInstall, LedgerVerify } from "./supabase-ledger/setup";
import type { ProvisionerStepProps } from "./ui-types";

export const PROVISIONER_UI: Record<
  ProvisionerId,
  {
    Install: ComponentType<ProvisionerStepProps>;
    Verify?: ComponentType<ProvisionerStepProps>;
  }
> = {
  "supabase-ledger": { Install: LedgerInstall, Verify: LedgerVerify },
};
