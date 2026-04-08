#!/usr/bin/env node

/**
 * Atlassian MCP Account Manager
 *
 * Manages proxy/accounts.json — the config for the seamless multi-tenant proxy.
 * All accounts are always connected simultaneously; there is no "active" account.
 *
 * Usage:
 *   node scripts/manage-accounts.mjs              # interactive menu
 *   node scripts/manage-accounts.mjs list         # list all accounts
 *   node scripts/manage-accounts.mjs add          # add an account
 *   node scripts/manage-accounts.mjs remove       # remove an account
 *   node scripts/manage-accounts.mjs logout       # clear OAuth tokens
 */

import { promises as fs } from 'node:fs';
import * as os   from 'node:os';
import * as path from 'node:path';
import * as rl   from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const DIR         = path.resolve(import.meta.dirname, '..', 'proxy');
const CONFIG_FILE = path.join(DIR, 'accounts.json');
const MCP_AUTH    = path.join(os.homedir(), '.mcp-auth');

// ─── Config ───────────────────────────────────────────────────────────────────
const EXAMPLE_FILE = path.join(DIR, 'accounts.example.json');

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // accounts.json is gitignored — bootstrap from the example file if absent.
    console.log(`\n  ${CONFIG_FILE} not found.`);
    console.log(`  Creating it from ${EXAMPLE_FILE} — add your real tenant details with "add".\n`);
    try {
      const example = await fs.readFile(EXAMPLE_FILE, 'utf8');
      const parsed = JSON.parse(example);
      // Strip the _comment field (informational only) before writing the live config.
      delete parsed._comment;
      // Start with an empty accounts map so users consciously add their own.
      parsed.accounts = {};
      await writeConfig(parsed);
      return parsed;
    } catch {
      throw new Error(`Config not found and could not bootstrap from example: ${EXAMPLE_FILE}`);
    }
  }
}

async function writeConfig(cfg) {
  // Atomic write: write to a temp file first, then rename into place.
  // This guarantees the config is never left in a partial/corrupt state
  // if the process is killed mid-write (POSIX rename is atomic).
  const tmp = CONFIG_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, CONFIG_FILE);
}

// ─── Prompt helpers ───────────────────────────────────────────────────────────
async function prompt(iface, question) {
  return (await iface.question(question)).trim();
}

async function menu(iface, title, options) {
  console.log(`\n${title}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  while (true) {
    const n = parseInt(await prompt(iface, `Choose (1-${options.length}): `), 10);
    if (n >= 1 && n <= options.length) return n - 1;
    console.log('  Invalid choice, try again.');
  }
}

// ─── URL helpers ──────────────────────────────────────────────────────────────
function normalizeTenantUrl(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!url.endsWith('/')) url += '/';
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Tenant URL must use HTTPS');
  return parsed.href;
}

function subdomain(url) {
  try { return new URL(url).hostname.split('.')[0]; } catch { return url; }
}

function toKey(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ─── Commands ─────────────────────────────────────────────────────────────────
async function cmdList() {
  const cfg = await readConfig();
  console.log('\n=== Configured Atlassian accounts (all connected simultaneously) ===\n');
  for (const [k, a] of Object.entries(cfg.accounts)) {
    const projects = (a.projects ?? []).join(', ') || '—';
    const spaces   = (a.spaces   ?? []).join(', ') || '—';
    console.log(`  ${k}`);
    console.log(`    Label    : ${a.label}`);
    console.log(`    URL      : ${a.tenantUrl}`);
    console.log(`    Projects : ${projects}`);
    console.log(`    Spaces   : ${spaces}`);
  }
  console.log();
}

async function cmdAdd(iface) {
  console.log('\n=== Add an Atlassian account ===\n');

  let tenantUrl;
  while (true) {
    const raw = await prompt(iface, 'Tenant URL (e.g. https://my-company.atlassian.net): ');
    try { tenantUrl = normalizeTenantUrl(raw); break; }
    catch (e) { console.log(`  Error: ${e.message}`); }
  }

  const defaultKey = toKey(subdomain(tenantUrl));
  const rawKey     = await prompt(iface, `Account key        [${defaultKey}]: `);
  const rawLabel   = await prompt(iface, `Display label      [${new URL(tenantUrl).hostname}]: `);
  const rawProj    = await prompt(iface, 'Jira project keys  (comma-separated, e.g. MYPROJ,OTHER): ');
  const rawSpaces  = await prompt(iface, 'Confluence spaces  (comma-separated, leave blank if none): ');

  const key      = rawKey.trim()    || defaultKey;
  const label    = rawLabel.trim()  || new URL(tenantUrl).hostname;
  const projects = rawProj.trim()   ? rawProj.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)  : [];
  const spaces   = rawSpaces.trim() ? rawSpaces.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : [];

  const cfg = await readConfig();
  if (cfg.accounts[key]) {
    const over = await prompt(iface, `"${key}" already exists. Overwrite? (y/N): `);
    if (over.toLowerCase() !== 'y') { console.log('  Aborted.'); return; }
  }

  cfg.accounts[key] = { tenantUrl, label, projects, spaces };
  await writeConfig(cfg);
  console.log(`\n✓ Added "${key}" → ${tenantUrl}`);
  console.log('  Reload your MCP client window for the new tenant to connect.\n');
}

async function cmdRemove(iface) {
  const cfg  = await readConfig();
  const keys = Object.keys(cfg.accounts);
  if (!keys.length) { console.log('\n  No accounts configured.\n'); return; }

  const idx = await menu(
    iface,
    'Which account do you want to remove?',
    keys.map(k => `${k}  —  ${cfg.accounts[k].label}`)
  );
  const key = keys[idx];

  const confirm = await prompt(iface, `Remove "${key}"? (y/N): `);
  if (confirm.toLowerCase() !== 'y') { console.log('  Aborted.'); return; }

  delete cfg.accounts[key];
  await writeConfig(cfg);
  console.log(`\n✓ Removed "${key}". Reload your MCP client window.\n`);
}

async function cmdLogout(iface) {
  let sessions = [];
  try {
    sessions = await fs.readdir(MCP_AUTH, { withFileTypes: true });
  } catch {
    console.log(`\n  No stored sessions found (${MCP_AUTH} does not exist).\n`);
    return;
  }

  if (!sessions.length) { console.log('\n  No stored sessions found.\n'); return; }

  const choice = await menu(iface, 'What do you want to clear?', [
    `All sessions (entire ${MCP_AUTH})`,
    'Specific session directory',
  ]);

  if (choice === 0) {
    const confirm = await prompt(iface, `Delete ALL of ${MCP_AUTH}? Logs out every tenant. (y/N): `);
    if (confirm.toLowerCase() !== 'y') { console.log('  Aborted.'); return; }
    await fs.rm(MCP_AUTH, { recursive: true, force: true });
    console.log(`\n✓ Cleared all sessions from ${MCP_AUTH}\n`);
  } else {
    const dirs = sessions.filter(e => e.isDirectory());
    if (!dirs.length) { console.log('  No session directories found.'); return; }
    const idx = await menu(iface, 'Which session?', dirs.map(d => d.name));
    await fs.rm(path.join(MCP_AUTH, dirs[idx].name), { recursive: true, force: true });
    console.log(`\n✓ Cleared session: ${dirs[idx].name}\n`);
  }

  console.log('  Reload your MCP client window to re-authenticate.\n');
}

// ─── Entry point ─────────────────────────────────────────────────────────────
async function main() {
  const [, , command] = process.argv;
  const iface = rl.createInterface({ input, output, terminal: true });

  try {
    switch (command) {
      case 'list':   await cmdList();         break;
      case 'add':    await cmdAdd(iface);     break;
      case 'remove': await cmdRemove(iface);  break;
      case 'logout': await cmdLogout(iface);  break;
      default: {
        console.log('\nAtlassian MCP Account Manager');
        console.log('==============================');
        const idx = await menu(iface, 'What would you like to do?', [
          'List accounts',
          'Add an account',
          'Remove an account',
          'Logout (clear stored OAuth tokens)',
          'Exit',
        ]);
        const fns = [cmdList, cmdAdd, cmdRemove, cmdLogout, () => {}];
        await fns[idx](iface);
        break;
      }
    }
  } finally {
    iface.close();
  }
}

main().catch(err => { console.error(`\nError: ${err.message}\n`); process.exit(1); });
