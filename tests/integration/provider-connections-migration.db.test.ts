/**
 * Destructive-shape migration smoke test in an isolated Postgres schema. Run with:
 * `HARNESST_DB_SMOKE=1 npx vitest run tests/integration/provider-connections-migration.db.test.ts`
 * after sourcing `.env.local`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";

describe.runIf(LIVE)("Phase 2 provider migration against Postgres", () => {
  it("moves legacy keys and qualifies defaults plus playground sessions without losing Codex", async () => {
    const databaseUrl =
      process.env.HARNESST_DB_MIGRATION_URL ?? process.env.DATABASE_URL;
    if (!databaseUrl)
      throw new Error("DATABASE_URL is required for DB smoke tests.");
    const schema = `provider_migration_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const sql = postgres(databaseUrl, { max: 1 });

    try {
      await sql.unsafe(`CREATE SCHEMA "${schema}"`);
      await sql.unsafe(`SET search_path TO "${schema}"`);
      await sql.unsafe(`
        CREATE TABLE workspace_settings (
          org_id text PRIMARY KEY,
          model_key_ciphertext text,
          model_key_iv text,
          model_key_auth_tag text,
          assistant_model text,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE model_provider_connections (
          id varchar(12) PRIMARY KEY,
          org_id text NOT NULL,
          provider varchar(32) NOT NULL,
          label text NOT NULL,
          status varchar(16) NOT NULL DEFAULT 'active'
        );
        CREATE TABLE projects (id varchar(12) PRIMARY KEY, org_id text NOT NULL);
        CREATE TABLE playground_sessions (
          id varchar(12) PRIMARY KEY,
          project_id varchar(12) NOT NULL,
          model_id text,
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        INSERT INTO workspace_settings VALUES
          ('org-key-bare', 'ct-bare', 'iv-bare', 'tag-bare', 'openai/vendor/model', now()),
          ('org-key-null', 'ct-null', 'iv-null', 'tag-null', NULL, now()),
          ('org-codex', NULL, NULL, NULL, 'codex/abcdefghijkl/gpt-5.5', now()),
          ('org-stale', NULL, NULL, NULL, 'codex/mnopqrstuvwx/gpt-5.5', now());
        INSERT INTO model_provider_connections VALUES
          ('abcdefghijkl', 'org-codex', 'codex', 'Codex', 'active'),
          ('mnopqrstuvwx', 'org-other', 'codex', 'Other Codex', 'active');
        INSERT INTO projects VALUES
          ('aaaaaaaaaaaa', 'org-key-bare'),
          ('bbbbbbbbbbbb', 'org-key-null'),
          ('cccccccccccc', 'org-codex'),
          ('dddddddddddd', 'org-stale'),
          ('eeeeeeeeeeee', 'org-no-settings');
        INSERT INTO playground_sessions VALUES
          ('ffffffffffff', 'aaaaaaaaaaaa', 'anthropic/vendor/model', now()),
          ('gggggggggggg', 'aaaaaaaaaaaa', 'codex/zzzzzzzzzzzz/gpt-5.5', now()),
          ('hhhhhhhhhhhh', 'cccccccccccc', 'codex/abcdefghijkl/gpt-5.5', now()),
          ('iiiiiiiiiiii', 'dddddddddddd', 'codex/mnopqrstuvwx/gpt-5.5', now()),
          ('jjjjjjjjjjjj', 'eeeeeeeeeeee', 'openai/gpt-4o', now());
      `);

      const migration = await readFile(
        path.join(process.cwd(), "drizzle/0005_breezy_boomer.sql"),
        "utf8",
      );
      for (const statement of migration
        .split("--> statement-breakpoint")
        .map((value) => value.trim())
        .filter(Boolean)) {
        await sql.unsafe(statement);
      }

      const connections = await sql.unsafe<
        {
          id: string;
          org_id: string;
          api_key_ciphertext: string | null;
        }[]
      >(`
        SELECT id, org_id, api_key_ciphertext
        FROM model_provider_connections
        WHERE provider = 'openrouter'
        ORDER BY org_id
      `);
      expect(connections).toHaveLength(2);
      for (const connection of connections) {
        expect(connection.id).toMatch(/^[a-z]{12}$/);
      }
      const byOrg = new Map(connections.map((row) => [row.org_id, row]));
      expect(byOrg.get("org-key-bare")?.api_key_ciphertext).toBe("ct-bare");
      expect(byOrg.get("org-key-null")?.api_key_ciphertext).toBe("ct-null");

      const settings = await sql.unsafe<
        { org_id: string; assistant_model: string | null }[]
      >(
        `SELECT org_id, assistant_model FROM workspace_settings ORDER BY org_id`,
      );
      const settingsByOrg = new Map(
        settings.map((row) => [row.org_id, row.assistant_model]),
      );
      expect(settingsByOrg.get("org-key-bare")).toBe(
        `openrouter/${byOrg.get("org-key-bare")!.id}/openai/vendor/model`,
      );
      expect(settingsByOrg.get("org-key-null")).toBe(
        `openrouter/${byOrg.get("org-key-null")!.id}/z-ai/glm-5.2`,
      );
      expect(settingsByOrg.get("org-codex")).toBe("codex/abcdefghijkl/gpt-5.5");
      expect(settingsByOrg.get("org-stale")).toBeNull();

      const sessions = await sql.unsafe<
        { id: string; model_id: string | null }[]
      >(`SELECT id, model_id FROM playground_sessions ORDER BY id`);
      const bySession = new Map(sessions.map((row) => [row.id, row.model_id]));
      expect(bySession.get("ffffffffffff")).toBe(
        `openrouter/${byOrg.get("org-key-bare")!.id}/anthropic/vendor/model`,
      );
      expect(bySession.get("gggggggggggg")).toBeNull();
      expect(bySession.get("hhhhhhhhhhhh")).toBe("codex/abcdefghijkl/gpt-5.5");
      expect(bySession.get("iiiiiiiiiiii")).toBeNull();
      expect(bySession.get("jjjjjjjjjjjj")).toBeNull();

      const oldColumns = await sql.unsafe<{ column_name: string }[]>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = '${schema}'
          AND table_name = 'workspace_settings'
          AND column_name LIKE 'model_key_%'
      `);
      expect(oldColumns).toEqual([]);
    } finally {
      await sql
        .unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        .catch(() => {});
      await sql.end();
    }
  });
});
