import type { ProvisionerId } from "./descriptors";
import type { ConnectionLink } from "./link";

/** Props for a provisioner's Setup UI. Forms post intent=provision, provisioner, op. */
export interface ProvisionerStepProps {
  provisioner: ProvisionerId;
  /** The provisioner's own `setupDetails` result. */
  details: unknown;
  link: ConnectionLink;
  /** A run owns the row (installing or activating). */
  busy: boolean;
  needsUpdate: boolean;
  /** Signed-in user's email: a default for contact fields. */
  email: string;
  memberNames: string[];
}
