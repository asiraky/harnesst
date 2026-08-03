/**
 * May I? human-approval channel (harnesst marketplace connector, issue #167).
 *
 * `mayiChannel()` registers the durable approval/human-input channel plus its callback route
 * (`POST /eve/v1/mayi/approval-resolved`) in the deployed eve service. The adapter owns the
 * callback URL, encrypted state, correlation, and signature verification (May I?'s EdDSA JWS
 * against its JWKS) — authors never build any of that. The only wiring is the credential
 * binding: harnesst brokers the OAuth grant and returns a current access token from
 * `credentials.getAccessToken("mayi")` (see ../credentials.server.ts).
 *
 * Approval-gate tools with eve's ordinary `approval: always()` (or a policy); start any work
 * that may need an approval ON this channel with eve's `receive(mayi, ...)`. Task-mode schedules
 * cannot park for a human — use the handler form of a schedule and hand the run to this channel:
 *
 *   export default defineSchedule({
 *     cron: "0 * * * *",
 *     run({ receive, waitUntil, appAuth }) {
 *       waitUntil(receive(mayi, { message: "Check production and deploy if needed.", auth: appAuth }));
 *     },
 *   });
 */
import { mayiChannel } from "@mayiapp/eve";

import { credentials } from "../credentials.server.js";

export default mayiChannel({
  getAccessToken: () => credentials.getAccessToken("mayi"),
});
