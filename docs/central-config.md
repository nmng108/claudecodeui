# Central MCP servers and skills

Settings > Agents lets you define an MCP server or a skill once and apply it to several providers.

## MCP servers

- **Shared servers** (button on each provider's MCP tab). A shared server is stored in the app database
  (`mcp_central_servers`, `mcp_central_targets`) and written into each linked provider's own config
  (`~/.claude.json` or `.mcp.json`, `~/.kiro/settings/mcp.json`, `~/.codex/config.toml`,
  `~/.cursor/mcp.json`, `opencode.json`) under the same name. Scope is `user` or `project`; only `stdio`
  and `http` are supported. Env values and headers are stored in plaintext, like the provider files.
- **Ownership.** The app only changes entries it created. An existing entry with the same name is
  reported as a conflict and left alone unless you choose to adopt it.
- **Provider tabs edit only their own entry.** A provider tab shows "Differs from shared" when its
  entry no longer matches the shared definition. "Re-apply" pushes the shared values back; "Use as shared"
  makes the provider's values the shared ones.
- **On/off.** Kiro (`disabled`), Codex (`enabled`) and OpenCode (`enabled`) keep the entry and flip a field.
  Claude and Cursor have no such field, so a shared server switched off for them has its entry removed
  (shown as "Paused") and is written back when switched on.
- **Edit config** opens the provider's raw MCP config. Saving replaces the file (comments kept), or
  merges pasted servers into it. A one-time backup is written next to the file as `*.cloudcli.bak`, and a
  save is refused if the file changed since it was loaded. For Claude user/local scope only the
  `mcpServers` section of `~/.claude.json` is shown and saved.

## Skills

- The shared folder is `~/.agents/skills`. Codex and OpenCode read it directly. Claude (`~/.claude/skills`),
  Cursor (`~/.cursor/skills`) and Kiro (`~/.kiro/skills`) get a link to each shared skill folder.
- **Link mode.** A symlink is used (a junction on Windows). If the link cannot be created, the folder is copied
  instead and recorded in `skill_central_links`. A copy shows as "Copy differs" after the shared skill
  changes; "Re-apply" refreshes it.
- **Conflicts.** A folder that was not created by the app is never replaced or removed. "Share" on a skill card
  moves that provider's folder into the shared folder and links it back, unless the shared folder already has
  that name.
- Linked skills in Docker only resolve if the shared folder is inside the same mounted volume as the provider
  folders.
