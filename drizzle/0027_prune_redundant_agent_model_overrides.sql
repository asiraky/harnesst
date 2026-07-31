-- An override identical to the workspace default is not an exception. Remove historical rows
-- created by Agent Settings so those agents inherit future default changes and stay out of the
-- Org Settings override overview.
DELETE FROM "agent_model_overrides" AS "override"
USING "workspace_settings" AS "workspace"
WHERE "override"."org_id" = "workspace"."org_id"
  AND "override"."model" = "workspace"."assistant_model"
  AND "override"."effort" IS NOT DISTINCT FROM "workspace"."assistant_effort";
