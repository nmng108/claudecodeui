import { getConnection } from '@/modules/database/connection.js';
import type { CentralMcpServer, CentralMcpServerFields, CentralMcpScope, LLMProvider } from '@/shared/types.js';

type ServerRow = {
  id: number;
  name: string;
  scope: CentralMcpScope;
  workspace_path: string;
  transport: CentralMcpServer['transport'];
  command: string | null;
  args: string | null;
  env: string | null;
  url: string | null;
  headers: string | null;
  created_at: string;
  updated_at: string;
};

type TargetRow = {
  server_id: number;
  provider: LLMProvider;
  enabled: number;
};

const parseJson = <T>(value: string | null): T | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const encodeJson = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));

const toServer = (row: ServerRow): CentralMcpServer => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  workspacePath: row.workspace_path || undefined,
  transport: row.transport,
  command: row.command ?? undefined,
  args: parseJson<string[]>(row.args),
  env: parseJson<Record<string, string>>(row.env),
  url: row.url ?? undefined,
  headers: parseJson<Record<string, string>>(row.headers),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Used by the Providers module to store central MCP servers and the provider entries each one owns. */
export const mcpCentralDb = {
  /** Returns every central server, oldest first. */
  listServers(): CentralMcpServer[] {
    const rows = getConnection()
      .prepare('SELECT * FROM mcp_central_servers ORDER BY id')
      .all() as ServerRow[];
    return rows.map(toServer);
  },

  getServer(id: number): CentralMcpServer | null {
    const row = getConnection()
      .prepare('SELECT * FROM mcp_central_servers WHERE id = ?')
      .get(id) as ServerRow | undefined;
    return row ? toServer(row) : null;
  },

  /** Finds the server with this identity; `workspacePath` is empty for user scope. */
  findServer(name: string, scope: CentralMcpScope, workspacePath: string): CentralMcpServer | null {
    const row = getConnection()
      .prepare('SELECT * FROM mcp_central_servers WHERE name = ? AND scope = ? AND workspace_path = ?')
      .get(name, scope, workspacePath) as ServerRow | undefined;
    return row ? toServer(row) : null;
  },

  /** Inserts a server. Throws on a duplicate (name, scope, workspace) identity. */
  createServer(
    identity: { name: string; scope: CentralMcpScope; workspacePath: string },
    fields: CentralMcpServerFields,
  ): CentralMcpServer {
    const result = getConnection()
      .prepare(
        `INSERT INTO mcp_central_servers (name, scope, workspace_path, transport, command, args, env, url, headers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        identity.name,
        identity.scope,
        identity.workspacePath,
        fields.transport,
        fields.command ?? null,
        encodeJson(fields.args),
        encodeJson(fields.env),
        fields.url ?? null,
        encodeJson(fields.headers),
      );
    return mcpCentralDb.getServer(Number(result.lastInsertRowid)) as CentralMcpServer;
  },

  /** Replaces the connection fields of a server (all of them, so unset ones are cleared). */
  updateServerFields(id: number, fields: CentralMcpServerFields): CentralMcpServer | null {
    getConnection()
      .prepare(
        `UPDATE mcp_central_servers
         SET transport = ?, command = ?, args = ?, env = ?, url = ?, headers = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(
        fields.transport,
        fields.command ?? null,
        encodeJson(fields.args),
        encodeJson(fields.env),
        fields.url ?? null,
        encodeJson(fields.headers),
        id,
      );
    return mcpCentralDb.getServer(id);
  },

  /** Deletes a server and its target rows. */
  deleteServer(id: number): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare('DELETE FROM mcp_central_targets WHERE server_id = ?').run(id);
      db.prepare('DELETE FROM mcp_central_servers WHERE id = ?').run(id);
    })();
  },

  /** Returns the target rows of one server, or of all servers when no id is given. */
  listTargets(serverId?: number): Array<{ serverId: number; provider: LLMProvider; enabled: boolean }> {
    const db = getConnection();
    const rows = (serverId === undefined
      ? db.prepare('SELECT * FROM mcp_central_targets ORDER BY server_id, provider').all()
      : db.prepare('SELECT * FROM mcp_central_targets WHERE server_id = ? ORDER BY provider').all(serverId)
    ) as TargetRow[];
    return rows.map((row) => ({ serverId: row.server_id, provider: row.provider, enabled: row.enabled === 1 }));
  },

  /** Records that the server owns the provider's entry, with the intended on/off state. */
  setTarget(serverId: number, provider: LLMProvider, enabled: boolean): void {
    getConnection()
      .prepare(
        `INSERT INTO mcp_central_targets (server_id, provider, enabled) VALUES (?, ?, ?)
         ON CONFLICT(server_id, provider) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(serverId, provider, enabled ? 1 : 0);
  },

  removeTarget(serverId: number, provider: LLMProvider): void {
    getConnection()
      .prepare('DELETE FROM mcp_central_targets WHERE server_id = ? AND provider = ?')
      .run(serverId, provider);
  },
};
