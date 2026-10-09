import { authorized } from "../_shared/auth.ts";
import { dispatch } from "../_shared/approvals.ts";
import { backend, env } from "../_shared/runtime.ts";
declare const Deno: {
  serve(handler: (request: Request) => Promise<Response>): void;
};
Deno.serve(async (request) => {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (!(await authorized(request, env("LEDGER_DISPATCH_TOKEN"))))
    return new Response("Unauthorized", { status: 401 });
  try {
    return Response.json({ submitted: await dispatch(backend) });
  } catch {
    return new Response(
      "Approval dispatch unavailable; check backend configuration or reauthorize May I",
      { status: 503 },
    );
  }
});
