<p align="center">
  <img src="images/atlassian_logo_brand_RGB.svg">
</p>

# @jourlez/atlassian-mcp-server

A multi-tenant MCP proxy that connects **all your Atlassian Cloud workspaces simultaneously** to any MCP-compatible AI client. Built on top of the [official Atlassian MCP endpoint](https://mcp.atlassian.com/v1/mcp) — all auth, permissions, and data access go through Atlassian's own infrastructure.

- **Simultaneous multi-account** — all tenants connect at startup, routing is automatic
- **Zero config switching** — the AI never needs to know which account to use
- **OAuth 2.1** via browser, tokens stored in `~/.mcp-auth/`
- **Config stored in `~/.atlassian-mcp/accounts.json`** — survives package updates and `npx` cache clears

> **Requirements:** Node.js v22+ · An Atlassian Cloud site (Jira, Confluence, and/or Compass)

---

## Quick start

### 1. Add your first account

```bash
npx @jourlez/atlassian-mcp-server manage-accounts add
```

You'll be prompted for your tenant URL (e.g. `https://my-company.atlassian.net`). A browser window opens for OAuth consent. Config is saved to `~/.atlassian-mcp/accounts.json`.

### 2. Configure your MCP client

**VS Code** — create or edit `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "atlassian": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@jourlez/atlassian-mcp-server"]
    }
  }
}
```

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "atlassian": {
      "command": "npx",
      "args": ["-y", "@jourlez/atlassian-mcp-server"]
    }
  }
}
```

**Cursor** — add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "atlassian": {
      "command": "npx",
      "args": ["-y", "@jourlez/atlassian-mcp-server"]
    }
  }
}
```

Restart your client. OAuth login runs once — subsequent starts are instant.

---

## Managing accounts

```bash
npx @jourlez/atlassian-mcp-server manage-accounts          # interactive menu
npx @jourlez/atlassian-mcp-server manage-accounts list     # show all configured tenants + status
npx @jourlez/atlassian-mcp-server manage-accounts add      # add a new tenant
npx @jourlez/atlassian-mcp-server manage-accounts remove   # remove a tenant
npx @jourlez/atlassian-mcp-server manage-accounts logout   # clear stored OAuth tokens
```

Config is stored in `~/.atlassian-mcp/accounts.json`. You can also set `ATLASSIAN_MCP_CONFIG=/path/to/accounts.json` to override the location.

### Example `accounts.json`

```json
{
  "accounts": {
    "my-company": {
      "tenantUrl": "https://my-company.atlassian.net/",
      "label": "My Company",
      "projects": ["PROJ", "BACKEND"],
      "spaces": ["DEV", "OPS"]
    },
    "client-workspace": {
      "tenantUrl": "https://client-workspace.atlassian.net/",
      "label": "Client Workspace",
      "projects": ["DEMO"],
      "spaces": []
    }
  }
}
```

`projects` and `spaces` enable direct routing without fan-out — list the Jira project keys and Confluence space keys that live on each site.

---

## How routing works

The proxy connects all tenants simultaneously. For each tool call it resolves the target tenant using this priority chain:

1. `cloudId` argument → exact match
2. Issue key prefix → `DCC-123` maps to whichever tenant owns project `DCC`
3. Explicit `projectKey` / `spaceKey` argument
4. JQL/CQL `project = "KEY"` clause
5. Fan-out to all tenants → first non-error wins  
   (`getAccessibleAtlassianResources` merges results from all tenants)

---

## MCP tools exposed

In addition to the full Atlassian MCP tool suite, the proxy exposes three management tools the AI can use directly:

| Tool | Description |
|---|---|
| `atlassian_list_accounts` | Show all configured tenants and their connection status |
| `atlassian_add_account` | Add a new tenant and trigger OAuth consent |
| `atlassian_remove_account` | Remove a tenant and disconnect it |

---

## Tips

### Speed up tool calls with explicit routing hints

Add this to your `AGENTS.md` or system prompt to eliminate discovery overhead:

```md
## Atlassian MCP
- Default Jira project: YOURPROJ
- Default Confluence space: ENG
- cloudId: https://yoursite.atlassian.net (skip getAccessibleAtlassianResources)
- Use maxResults: 10 for all JQL/CQL searches
```

### Skills

Pre-built prompt skills for common workflows (status reports, triage, backlog generation) are in the [`skills/`](skills/) directory.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `could not determine executable to run` | `rm -rf ~/.npm/_npx` then restart |
| `Config error` on startup | Run `manage-accounts add` — config file doesn't exist yet |
| OAuth browser window doesn't open | Check client logs for the auth URL and open it manually |
| Only one tenant's tools visible | Run `atlassian_list_accounts` — additional tenants connect on first use |
| `403 Forbidden` on tool calls | Your Atlassian admin may need to enable Rovo MCP for your org |

---

## Security

All traffic goes through `https://mcp.atlassian.com` over TLS. OAuth tokens are stored locally in `~/.mcp-auth/` and never leave your machine. Data access respects your existing Atlassian project/space permissions.

LLMs are vulnerable to [prompt injection](https://owasp.org/www-community/attacks/PromptInjection). Only connect trusted MCP clients and review high-impact actions before confirming. See [Atlassian's MCP risk guidance](https://www.atlassian.com/blog/artificial-intelligence/mcp-risk-awareness).

---

## License

Apache 2.0 — forked from [atlassian/atlassian-mcp-server](https://github.com/atlassian/atlassian-mcp-server)
