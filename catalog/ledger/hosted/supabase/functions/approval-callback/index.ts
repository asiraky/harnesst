import { callbackHandler } from "../_shared/approvals.ts";
import { backend } from "../_shared/runtime.ts";
declare const Deno: {
  serve(handler: (request: Request) => Promise<Response>): void;
};
Deno.serve(async (request) => {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (!request.headers.get("x-mayi-signature"))
    return new Response("Signature required", { status: 401 });
  try {
    return await callbackHandler(backend, await backend("config"))(request);
  } catch {
    return new Response("Approval backend not configured", { status: 503 });
  }
});
