import { oauthHandler } from "../_shared/oauth.ts";
import { rpc, env } from "../_shared/runtime.ts";
declare const Deno: {
  serve(handler: (request: Request) => Promise<Response>): void;
};
Deno.serve(
  oauthHandler(
    (operation, args) => rpc("ledger_oauth", operation, args),
    env("SUPABASE_URL"),
    env("LEDGER_SETUP_TOKEN"),
  ),
);
