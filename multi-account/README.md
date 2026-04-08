# Multi-Account Setup

Connect multiple Atlassian Cloud accounts (tenants) simultaneously so you can work across different Jira projects, Confluence spaces, and Compass services without logging out and back in.

## How it works

The Atlassian Rovo MCP Server uses **OAuth 2.1** for authentication. Under the hood this feature uses the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) proxy with its `--resource` flag, which implements [RFC 8707 Resource Indicators](https://datatracker.ietf.org/doc/html/rfc8707). Each unique `(serverURL + resource)` pair gets its own isolated OAuth session stored in `~/.mcp-auth/`, so all accounts stay authenticated in parallel with no interference.

## Prerequisites

- **Node.js v18+** — required to run `mcp-remote`
- An Atlassian Cloud account on each tenant you want to connect

## Quick setup (automated)

Run the interactive setup script from the repository root:

```bash
node scripts/manage-accounts.mjs
```

The script will walk you through adding accounts and writing the correct configuration for your MCP client.

## Manual setup

### 1. Find your tenant URL(s)

Your Atlassian tenant URL is the domain you use to access Jira or Confluence, e.g.:

```
https://my-company.atlassian.net
```

### 2. Pick a config file for your client

| Client | Config file |
|---|---|
| VS Code | `.vscode/mcp.json` (workspace) or `~/Library/Application Support/Code/User/mcp.json` (global) |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |

### 3. Add one entry per account

Replace or augment the default `atlassian` entry with one entry per account. See `mcp.template.json` in this directory for the full template, or copy the example below:

```json
{
  "mcpServers": {
    "atlassian-account-1": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@0.1.38",
        "https://mcp.atlassian.com/v1/mcp",
        "--resource",
        "https://YOUR-FIRST-TENANT.atlassian.net/"
      ]
    },
    "atlassian-account-2": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@0.1.38",
        "https://mcp.atlassian.com/v1/mcp",
        "--resource",
        "https://YOUR-SECOND-TENANT.atlassian.net/"
      ]
    }
  }
}
```

> [!IMPORTANT]
> The `--resource` URL **must exactly match** the root of your Atlassian tenant, including the trailing slash. Use `https://yoursite.atlassian.net/` — not a project or board URL.

### 4. Restart your MCP client

Your client will attempt to launch each server. A browser window will open for each new account requesting OAuth consent. Sign in with the correct Atlassian account for each tenant.

After that, all accounts run in parallel and persist across restarts (tokens are stored in `~/.mcp-auth/`).

## Naming convention

Choose server names that clearly identify the account. Avoid spaces — use hyphens or underscores:

```
atlassian-company-a
atlassian-company-b
atlassian-personal
```

Within your AI assistant you can direct requests like:

> "Using `atlassian-company-a`, find all open P1 bugs in project INFRA."

## Revoking a single account

To log out a specific account without affecting the others:

```bash
node scripts/manage-accounts.mjs logout
```

Or manually delete the token directory:

```bash
# List stored sessions
ls ~/.mcp-auth/

# Remove a specific session hash (the --debug flag prints the hash for each server)
rm -rf ~/.mcp-auth/<session-hash>
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser does not open for OAuth | Ensure Node.js v18+ is on `PATH`; run `node -v` to confirm |
| Wrong account authenticated | Delete `~/.mcp-auth/` and re-authenticate: `rm -rf ~/.mcp-auth` |
| Token exchange fails (HTTP 400) | Run `rm -rf ~/.mcp-auth` then restart the MCP client |
| Tools from wrong tenant appear | Verify the `--resource` URL exactly matches `https://yoursite.atlassian.net/` |
| Port conflict during OAuth | `mcp-remote` auto-selects an available port; no action needed |

For detailed debug logs for a specific account, add `"--debug"` to its `args` array. Logs are written to `~/.mcp-auth/{session_hash}_debug.log`.

## Security notes

- OAuth tokens are stored locally in `~/.mcp-auth/` and never leave your machine.
- Each session is scoped to its specific Atlassian tenant via the `resource` parameter.
- To fully revoke access, delete `~/.mcp-auth/` **and** revoke the app in your [Atlassian profile settings](https://id.atlassian.com/manage-profile/apps).
- Never commit `~/.mcp-auth/` or any exported token files to version control.
