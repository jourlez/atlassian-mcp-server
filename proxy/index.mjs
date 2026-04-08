#!/usr/bin/env node

/**
 * Atlassian Multi-Tenant MCP Proxy — Seamless Mode
 *
 * ALL configured Atlassian tenants are connected SIMULTANEOUSLY.
 * The AI assistant sees one MCP server and never needs to switch or think
 * about which account to use — routing is automatic and transparent.
 *
 * Routing priority (highest → lowest):
 *   1. cloudId argument          → exact match from tenant discovery
 *   2. Issue key prefix          → "DCC-123" → project DCC → decentralchain
 *   3. Explicit project/space key→ projectKey, project, spaceKey arguments
 *   4. JQL/CQL project clause    → project = "FREE" → jourlez
 *   5. Fan-out to all tenants    → first non-error wins
 *      (getAccessibleAtlassianResources: fan-out + MERGE all results)
 *
 * Config  : proxy/accounts.json
 * Tokens  : ~/.mcp-auth/ (managed by mcp-remote, one slot per tenant)
 *
 * Enterprise features:
 *   - Pinned mcp-remote@0.1.38 (no @latest drift — supply chain safety)
 *   - Config schema validation at startup
 *   - Structured stderr logging with severity levels
 *   - Uncaught exception / unhandled rejection safety net
 *   - Automatic tenant reconnection with exponential backoff (max 3 retries)
 *   - Graceful shutdown with 8 s force-kill deadline
 *   - Configurable timeouts via env vars
 */

import { spawn }                    from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createInterface }          from 'node:readline';
import { fileURLToPath }            from 'node:url';
import path                         from 'node:path';

// ─── Constants ────────────────────────────────────────────────────────────────
const DIR     = path.dirname(fileURLToPath(import.meta.url));
const CONFIG  = path.join(DIR, 'accounts.json');
const MCP_URL = 'https://mcp.atlassian.com/v1/mcp';

// Pin to exact version — never use @latest in production (supply chain risk)
const MCP_REMOTE_VERSION = '0.1.38';

// Timeouts (all overridable via environment variables for operational flexibility)
const TIMEOUT_INIT_MS       = Number(process.env.ATLASSIAN_PROXY_INIT_TIMEOUT_MS)       || 120_000;
const TIMEOUT_TOOL_MS       = Number(process.env.ATLASSIAN_PROXY_TOOL_TIMEOUT_MS)       ||  60_000;
const TIMEOUT_FANOUT_MS     = Number(process.env.ATLASSIAN_PROXY_FANOUT_TIMEOUT_MS)     ||  60_000;
const TIMEOUT_DISCOVER_MS   = Number(process.env.ATLASSIAN_PROXY_DISCOVER_TIMEOUT_MS)   ||  30_000;
const TIMEOUT_LIST_MS       = Number(process.env.ATLASSIAN_PROXY_LIST_TIMEOUT_MS)       ||  15_000;
const TIMEOUT_GENERIC_MS    = Number(process.env.ATLASSIAN_PROXY_GENERIC_TIMEOUT_MS)    ||  30_000;
const TIMEOUT_SHUTDOWN_MS   = Number(process.env.ATLASSIAN_PROXY_SHUTDOWN_TIMEOUT_MS)   ||   8_000;
const RECONNECT_MAX_RETRIES = Number(process.env.ATLASSIAN_PROXY_RECONNECT_MAX_RETRIES) ||  3;
const RECONNECT_BASE_MS     = Number(process.env.ATLASSIAN_PROXY_RECONNECT_BASE_MS)     ||  5_000;

// ─── Structured logging ───────────────────────────────────────────────────────
// Writes JSON lines to stderr (never stdout — stdout is reserved for JSON-RPC).
// Each entry: { ts, level, msg, ...fields }
function emit(level, msg, fields = {}) {
  process.stderr.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n',
  );
}
const log   = (msg, f) => emit('info',  msg, f);
const warn  = (msg, f) => emit('warn',  msg, f);
const error = (msg, f) => emit('error', msg, f);

// ─── Sequence counter ─────────────────────────────────────────────────────────
let _seq = 0;
const uid = () => `__p${++_seq}__`;

// ─── Constants ────────────────────────────────────────────────────────────────
const FANOUT_MERGE_TOOLS = new Set(['getAccessibleAtlassianResources']);

// Management tools — always exposed regardless of how many tenants are connected.
const MGMT_TOOLS = [
  {
    name: 'atlassian_list_accounts',
    description: 'List all configured Atlassian accounts and their connection status. Use this to see which workspaces are available.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'atlassian_add_account',
    description:
      'Add a new Atlassian account (workspace) to this MCP server. ' +
      'Provide the site URL (e.g. https://mycompany.atlassian.net). ' +
      'The user will be prompted to authenticate in their browser. ' +
      'Optionally list project keys and space keys to enable direct routing without fan-out.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantUrl: {
          type: 'string',
          description: 'Atlassian site URL, e.g. https://mycompany.atlassian.net',
        },
        label: {
          type: 'string',
          description: 'Human-readable label for this account (optional)',
        },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Jira project keys hosted on this site, e.g. ["DCC", "WORK"]',
        },
        spaces: {
          type: 'array',
          items: { type: 'string' },
          description: 'Confluence space keys hosted on this site, e.g. ["ENG", "DOCS"]',
        },
      },
      required: ['tenantUrl'],
    },
  },
  {
    name: 'atlassian_remove_account',
    description: 'Remove an Atlassian account from this MCP server and disconnect it.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Account key as shown by atlassian_list_accounts (e.g. "decentralchain")',
        },
      },
      required: ['key'],
    },
  },
];
const MGMT_TOOL_NAMES = new Set(MGMT_TOOLS.map(t => t.name));

// ─── Config schema validation ─────────────────────────────────────────────────
function validateConfig(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('accounts.json must be a JSON object');
  if (typeof raw.accounts !== 'object' || raw.accounts === null) throw new Error('accounts.json must have an "accounts" object');
  const entries = Object.entries(raw.accounts);
  for (const [key, acct] of entries) {
    if (typeof acct.tenantUrl !== 'string' || !acct.tenantUrl.startsWith('https://')) {
      throw new Error(`accounts["${key}"].tenantUrl must be an https:// URL`);
    }
    if (!Array.isArray(acct.projects)) throw new Error(`accounts["${key}"].projects must be an array`);
    if (!Array.isArray(acct.spaces))   throw new Error(`accounts["${key}"].spaces must be an array`);
  }
  return raw;
}

// ─── ChildMcp ─────────────────────────────────────────────────────────────────
class ChildMcp {
  constructor(key, tenantUrl) {
    this.key       = key;
    this.tenantUrl = tenantUrl;
    this._proc     = null;
    this._rl       = null;
    this._pending  = new Map();
  }

  start() {
    this._proc = spawn(
      'npx',
      // Pinned version — never @latest — prevents silent drift and supply chain attacks.
      // --silent placed after the positional URL so commander.js parses it as a flag,
      // not as a second positional argument.  (Added in mcp-remote v0.1.35.)
      ['-y', `mcp-remote@${MCP_REMOTE_VERSION}`, MCP_URL, '--resource', this.tenantUrl, '--silent'],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    // Absorb EPIPE / write-after-close errors on the child's stdin so they
    // don't surface as uncaughtExceptions.  The exitCode guard in request()
    // prevents writes after the child has fully exited; this handles the
    // narrow race where the child starts closing while a write is in flight.
    this._proc.stdin.on('error', err => {
      if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
        error('child stdin write error', { key: this.key, code: err.code, err: err.message });
      }
    });
    this._rl = createInterface({ input: this._proc.stdout, crlfDelay: Infinity });
    this._rl.on('line', raw => {
      const line = raw.trim();
      if (!line) return;
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.id !== undefined && this._pending.has(m.id)) {
        const { resolve, timer } = this._pending.get(m.id);
        clearTimeout(timer);
        this._pending.delete(m.id);
        resolve(m);
      }
    });
    this._proc.on('error', err => error('spawn error', { key: this.key, err: err.message }));
    this._proc.on('exit', (code, signal) => {
      for (const { reject, timer } of this._pending.values()) {
        clearTimeout(timer);
        reject(new Error(`${this.key}: child exited (code=${code}, signal=${signal})`));
      }
      this._pending.clear();
      if (code !== 0 && code !== null) {
        warn('child exited unexpectedly — scheduling reconnect', { key: this.key, code, signal });
        scheduleReconnect(this.key);
      }
    });
  }

  request(msg, timeoutMs = TIMEOUT_GENERIC_MS) {
    return new Promise((resolve, reject) => {
      if (!this._proc || this._proc.exitCode !== null) {
        return reject(new Error(`${this.key}: not running`));
      }
      const timer = setTimeout(() => {
        this._pending.delete(msg.id);
        reject(new Error(`${this.key}: timeout after ${timeoutMs}ms on ${msg.method}`));
      }, timeoutMs);
      this._pending.set(msg.id, { resolve, reject, timer });
      this._proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  notify(msg) {
    if (this._proc?.exitCode === null) {
      this._proc.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  stop() {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new Error(`${this.key}: stopped`));
    }
    this._pending.clear();
    try { this._rl?.close(); }           catch {}
    try { this._proc?.stdin.end(); }     catch {}
    try { this._proc?.kill('SIGTERM'); } catch {}
    this._proc = null;
    this._rl   = null;
  }

  get alive() {
    return !!this._proc && this._proc.exitCode === null;
  }
}

// ─── Proxy state ──────────────────────────────────────────────────────────────
const tenants         = new Map(); // key → { tenantUrl, label, projects, spaces, child, cloudIds, connected, retries }
const cloudIdMap      = new Map(); // cloudId   → accountKey
const projMap         = new Map(); // PROJ_UPPER → accountKey
const reconnectTimers = new Map(); // key → timeout handle (setTimeout)
const connectingNow   = new Map(); // key → Promise — prevents duplicate lazy-connect races
let   initParams = null;
let   _shuttingDown = false; // declared here — before scheduleReconnect — for clarity

const sendUp = msg => process.stdout.write(JSON.stringify(msg) + '\n');

// ─── Reconnection with exponential backoff ────────────────────────────────────
function scheduleReconnect(key) {
  if (_shuttingDown) return; // never reconnect during graceful shutdown
  if (!initParams) return;  // not yet initialized — skip
  const acct = tenants.get(key);
  if (!acct) return;
  if (reconnectTimers.has(key)) return; // already scheduled

  const retries = acct.retries ?? 0;
  if (retries >= RECONNECT_MAX_RETRIES) {
    error('max reconnect retries reached — tenant offline', { key, retries });
    return;
  }

  const delayMs = RECONNECT_BASE_MS * (2 ** retries); // 5s → 10s → 20s
  warn('scheduling reconnect', { key, retries, delayMs });

  const t = setTimeout(async () => {
    reconnectTimers.delete(key);
    acct.retries = retries + 1;
    acct.connected = false;
    try {
      await connectTenant(key, acct, initParams);
      acct.retries = 0; // reset on successful reconnect
      await discoverCloudIds(key, acct);
      log('tenant reconnected', { key });
    } catch (err) {
      error('reconnect failed', { key, err: err.message });
      scheduleReconnect(key); // try again (will increment retries)
    }
  }, delayMs);

  reconnectTimers.set(key, t);
  // Unref the timer so it does not prevent the event loop from exiting
  // naturally if the process is shutting down by other means.
  if (typeof t.unref === 'function') t.unref();
}

// ─── Lazy connect (on first use) ─────────────────────────────────────────────
// Connects a single tenant only when a tool call is first routed to it.
// Subsequent calls return immediately once the child is alive.
async function ensureConnected(key) {
  const acct = tenants.get(key);
  if (!acct || !initParams) return null;
  if (acct.child?.alive) return acct;
  // If a connect is already in-flight for this key, wait for it instead of
  // spawning a second mcp-remote child (race-safe).
  if (connectingNow.has(key)) {
    try { await connectingNow.get(key); } catch {}
    return acct.child?.alive ? acct : null;
  }
  const p = (async () => {
    await connectTenant(key, acct, initParams);
    await discoverCloudIds(key, acct);
  })();
  connectingNow.set(key, p);
  try {
    await p;
  } catch (err) {
    error('lazy connect failed', { key, err: err.message });
  } finally {
    connectingNow.delete(key);
  }
  return acct.child?.alive ? acct : null;
}

// ─── Connect one tenant ────────────────────────────────────────────────────────
async function connectTenant(key, acct, params) {
  const child = new ChildMcp(key, acct.tenantUrl);
  child.start();
  const resp = await child.request(
    { jsonrpc: '2.0', id: uid(), method: 'initialize', params },
    TIMEOUT_INIT_MS,
  );
  child.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  if (resp.error) {
    child.stop();
    throw new Error(resp.error.message ?? 'initialize failed');
  }
  acct.child     = child;
  acct.connected = true;
  log('tenant connected', { key });
  return resp.result;
}

// ─── Discover cloudIds ────────────────────────────────────────────────────────
async function discoverCloudIds(key, acct) {
  if (!acct.child?.alive) return;
  try {
    const resp = await acct.child.request({
      jsonrpc: '2.0', id: uid(),
      method: 'tools/call',
      params: { name: 'getAccessibleAtlassianResources', arguments: {} },
    }, TIMEOUT_DISCOVER_MS);
    for (const r of parseResourceArray(resp?.result)) {
      const cid = r.id ?? r.cloudId;
      if (cid) {
        acct.cloudIds.add(cid);
        cloudIdMap.set(cid, key);
      }
    }
    log('cloudId discovery complete', { key, cloudIds: [...acct.cloudIds] });
  } catch (err) {
    warn('cloudId discovery skipped', { key, err: err.message });
  }
}

function parseResourceArray(result) {
  try {
    const text = result?.content?.[0]?.text;
    if (!text) return [];
    const p = JSON.parse(text);
    return Array.isArray(p) ? p : [p];
  } catch {
    return [];
  }
}

// ─── Routing ──────────────────────────────────────────────────────────────────
// routeKey: returns the account key for a given tool-call params object.
// Does NOT require the child to be alive (used for lazy connect decisions).
function routeKey(params) {
  const args = params?.arguments ?? {};
  if (args.cloudId) {
    const key = cloudIdMap.get(args.cloudId);
    if (key) return key;
    // Fallback: match by tenant URL (Copilot passes full URL instead of UUID)
    if (args.cloudId.startsWith('https://')) {
      const norm = args.cloudId.endsWith('/') ? args.cloudId : args.cloudId + '/';
      for (const [k, a] of tenants) { if (a.tenantUrl === norm) return k; }
    }
  }
  for (const f of ['issueKey', 'issue', 'issueIdOrKey', 'sourceIssue', 'targetIssue', 'epicKey']) {
    const v = args[f];
    if (v) {
      const m = String(v).match(/^([A-Z][A-Z0-9]+)-\d+/);
      if (m) { const k = projMap.get(m[1]); if (k) return k; }
    }
  }
  for (const f of ['projectKey', 'project', 'projectId', 'spaceKey', 'spaceId']) {
    const v = args[f];
    if (v) { const k = projMap.get(String(v).toUpperCase()); if (k) return k; }
  }
  if (args.jql) {
    const m = String(args.jql).match(/\bproject\s*(?:=|~|in\s*\()\s*"?'?([A-Z][A-Z0-9]*)"?'?/i);
    if (m) { const k = projMap.get(m[1].toUpperCase()); if (k) return k; }
  }
  if (args.cql) {
    const m = String(args.cql).match(/\bspace\s*=\s*"?'?([A-Z][A-Z0-9]*)"?'?/i);
    if (m) { const k = projMap.get(m[1].toUpperCase()); if (k) return k; }
  }
  return null;
}

function liveChildren() {
  return [...tenants.values()].filter(a => a.child?.alive);
}

async function fanOutAndMerge(method, params) {
  const results = await Promise.allSettled(
    liveChildren().map(a => a.child.request({ jsonrpc: '2.0', id: uid(), method, params }, TIMEOUT_FANOUT_MS))
  );
  const merged = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && !r.value?.error) merged.push(...parseResourceArray(r.value.result));
  }
  return { content: [{ type: 'text', text: JSON.stringify(merged) }] };
}

function fanOutFirst(method, params, parentId) {
  return new Promise(resolve => {
    const live = liveChildren();
    if (!live.length) {
      resolve({ jsonrpc: '2.0', id: parentId, error: { code: -32603, message: 'No Atlassian tenants connected.' } });
      return;
    }
    let left = live.length, done = false;
    const errors = [];
    for (const a of live) {
      a.child.request({ jsonrpc: '2.0', id: uid(), method, params }, TIMEOUT_FANOUT_MS)
        .then(resp => {
          left--;
          if (!done && !resp.error) {
            done = true;
            resolve({ ...resp, id: parentId });
          } else {
            // Tenant responded but with a JSON-RPC error — collect the message
            if (resp.error?.message) errors.push(resp.error.message);
            if (!done && left === 0) {
              resolve({ jsonrpc: '2.0', id: parentId, error: { code: -32603, message: errors.join('; ') || 'All tenants failed.' } });
            }
          }
        })
        .catch(err => {
          left--; errors.push(err.message);
          if (!done && left === 0) {
            resolve({ jsonrpc: '2.0', id: parentId, error: { code: -32603, message: errors.join('; ') } });
          }
        });
    }
  });
}

// ─── Config persistence ───────────────────────────────────────────────────────
async function writeConfig() {
  const data = { accounts: {} };
  for (const [key, a] of tenants) {
    data.accounts[key] = {
      tenantUrl: a.tenantUrl,
      label:     a.label ?? key,
      projects:  a.projects ?? [],
      spaces:    a.spaces   ?? [],
    };
  }
  const tmp = CONFIG + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, CONFIG);
}

// ─── Management tool handlers ─────────────────────────────────────────────────
function handleListAccounts() {
  if (!tenants.size) {
    return { content: [{ type: 'text', text: JSON.stringify({ accounts: [], summary: { total: 0, connected: 0, disconnected: 0 } }) }] };
  }

  const accounts = [];
  for (const [key, a] of tenants) {
    const alive   = a.child?.alive;
    const retries = a.retries ?? 0;
    const status  = !a.connected ? 'not_connected'
                  : !alive       ? (retries > 0 ? 'reconnecting' : 'disconnected')
                  : 'connected';

    accounts.push({
      key,
      label:      a.label ?? key,
      url:        a.tenantUrl,
      status,
      reconnectAttempt: retries > 0 ? { current: retries, max: RECONNECT_MAX_RETRIES } : null,
      cloudIds:   [...a.cloudIds],
      projects:   a.projects ?? [],
      spaces:     a.spaces   ?? [],
    });
  }

  const connected    = accounts.filter(a => a.status === 'connected').length;
  const disconnected = accounts.filter(a => a.status !== 'connected').length;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        summary: { total: accounts.length, connected, disconnected },
        accounts,
      }, null, 2),
    }],
  };
}

async function handleAddAccount(args) {
  let { tenantUrl, label, projects = [], spaces = [] } = args ?? {};
  if (!tenantUrl || typeof tenantUrl !== 'string') {
    return { content: [{ type: 'text', text: 'Error: tenantUrl is required (e.g. https://mycompany.atlassian.net)' }] };
  }
  // Normalise URL
  if (!tenantUrl.startsWith('https://')) {
    return { content: [{ type: 'text', text: 'Error: tenantUrl must start with https://' }] };
  }
  if (!tenantUrl.endsWith('/')) tenantUrl += '/';

  // Derive a stable key from the hostname
  let key;
  try { key = new URL(tenantUrl).hostname.split('.')[0]; } catch {
    return { content: [{ type: 'text', text: `Error: invalid URL — ${tenantUrl}` }] };
  }
  if (!key) return { content: [{ type: 'text', text: 'Error: could not derive account key from URL' }] };

  // Avoid duplicates
  if (tenants.has(key)) {
    return { content: [{ type: 'text', text: `Account "${key}" is already configured. Use atlassian_list_accounts to see its status.` }] };
  }

  const acct = {
    tenantUrl,
    label: label ?? key,
    projects: Array.isArray(projects) ? projects : [],
    spaces:   Array.isArray(spaces)   ? spaces   : [],
    child: null, cloudIds: new Set(), connected: false, retries: 0,
  };
  tenants.set(key, acct);
  for (const p of acct.projects) projMap.set(p.toUpperCase(), key);
  for (const s of acct.spaces)   projMap.set(s.toUpperCase(), key);

  log('connecting new account', { key, tenantUrl });
  const connected = await ensureConnected(key);
  if (!connected) {
    // Remove the partially-added tenant
    tenants.delete(key);
    for (const p of acct.projects) projMap.delete(p.toUpperCase());
    for (const s of acct.spaces)   projMap.delete(s.toUpperCase());
    return { content: [{ type: 'text', text: `Failed to connect to ${tenantUrl}. Check the URL and try again.` }] };
  }

  // Persist to accounts.json
  try { await writeConfig(); } catch (err) {
    warn('failed to persist new account to accounts.json', { key, err: err.message });
  }

  const ids = acct.cloudIds.size ? [...acct.cloudIds].join(', ') : '(discovering...)';
  return { content: [{ type: 'text', text:
    `✓ Account "${key}" connected successfully.\n` +
    `  URL     : ${tenantUrl}\n` +
    `  CloudId : ${ids}\n` +
    `  Projects: ${acct.projects.join(', ') || '— (none specified, routing by fan-out)'}\n\n` +
    `You can now use all Atlassian tools against this workspace.`
  }] };
}

async function handleRemoveAccount(args) {
  const { key } = args ?? {};
  if (!key || typeof key !== 'string') {
    return { content: [{ type: 'text', text: 'Error: key is required. Use atlassian_list_accounts to see account keys.' }] };
  }
  const acct = tenants.get(key);
  if (!acct) {
    return { content: [{ type: 'text', text: `No account found with key "${key}". Use atlassian_list_accounts to see available accounts.` }] };
  }
  // Disconnect and clean up
  acct.child?.stop();
  if (reconnectTimers.has(key)) { clearTimeout(reconnectTimers.get(key)); reconnectTimers.delete(key); }
  for (const cid of acct.cloudIds) cloudIdMap.delete(cid);
  for (const p of acct.projects ?? []) projMap.delete(p.toUpperCase());
  for (const s of acct.spaces   ?? []) projMap.delete(s.toUpperCase());
  tenants.delete(key);

  try { await writeConfig(); } catch (err) {
    warn('failed to persist account removal to accounts.json', { key, err: err.message });
  }

  return { content: [{ type: 'text', text: `✓ Account "${key}" removed and disconnected.` }] };
}

// ─── Main router ──────────────────────────────────────────────────────────────
async function route(msg) {
  const { id, method, params } = msg;

  if (id === undefined) {
    if (method !== 'notifications/initialized') for (const a of liveChildren()) a.child.notify(msg);
    return;
  }

  if (method === 'initialize') {
    initParams = params;
    tenants.clear(); cloudIdMap.clear(); projMap.clear();
    for (const t of reconnectTimers.values()) clearTimeout(t);
    reconnectTimers.clear();

    let cfg;
    try {
      cfg = validateConfig(JSON.parse(await readFile(CONFIG, 'utf8')));
    } catch (err) {
      error('failed to load config', { path: CONFIG, err: err.message });
      sendUp({ jsonrpc: '2.0', id, error: { code: -32603, message: `Config error: ${err.message}` } });
      return;
    }

    for (const [key, acct] of Object.entries(cfg.accounts)) {
      tenants.set(key, { ...acct, child: null, cloudIds: new Set(), connected: false, retries: 0 });
      for (const p of acct.projects ?? []) projMap.set(p.toUpperCase(), key);
      for (const s of acct.spaces   ?? []) projMap.set(s.toUpperCase(), key);
    }

    // Connect the primary (first) tenant eagerly — same UX as the official Atlassian MCP.
    // Additional tenants are connected on demand via atlassian_add_account or first use.
    const primaryKey = [...tenants.keys()][0];
    if (primaryKey) {
      try {
        await connectTenant(primaryKey, tenants.get(primaryKey), params);
        await discoverCloudIds(primaryKey, tenants.get(primaryKey));
        log('primary tenant connected', { key: primaryKey });
      } catch (err) {
        warn('primary tenant connect failed — will retry on first use', { key: primaryKey, err: err.message });
      }
    }

    const n = liveChildren().length;
    log('proxy ready', { connected: n, total: tenants.size });
    sendUp({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'atlassian-mcp-proxy', version: '1.0.0' },
    }});
    return;
  }

  if (method === 'tools/list') {
    const live = liveChildren();
    if (!live.length) {
      sendUp({ jsonrpc: '2.0', id, result: { tools: MGMT_TOOLS } });
      return;
    }
    try {
      const r = await live[0].child.request({ jsonrpc: '2.0', id: uid(), method: 'tools/list', params }, TIMEOUT_LIST_MS);
      sendUp({ jsonrpc: '2.0', id, result: { tools: [...MGMT_TOOLS, ...(r.result?.tools ?? [])] } });
    } catch {
      sendUp({ jsonrpc: '2.0', id, result: { tools: MGMT_TOOLS } });
    }
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;

    if (name === 'atlassian_list_accounts') {
      sendUp({ jsonrpc: '2.0', id, result: handleListAccounts() });
      return;
    }
    if (name === 'atlassian_add_account') {
      sendUp({ jsonrpc: '2.0', id, result: await handleAddAccount(params?.arguments) });
      return;
    }
    if (name === 'atlassian_remove_account') {
      sendUp({ jsonrpc: '2.0', id, result: await handleRemoveAccount(params?.arguments) });
      return;
    }

    if (FANOUT_MERGE_TOOLS.has(name)) {
      // Merge across all tenants — lazy-connect each one first.
      await Promise.allSettled([...tenants.keys()].map(k => ensureConnected(k)));
      sendUp({ jsonrpc: '2.0', id, result: await fanOutAndMerge(method, params) });
      return;
    }

    // Try to route to a specific tenant (lazy-connect if needed).
    const targetKey = routeKey(params);
    if (targetKey) {
      const acct = await ensureConnected(targetKey);
      if (acct?.child?.alive) {
        try {
          const r = await acct.child.request({ jsonrpc: '2.0', id: uid(), method, params }, TIMEOUT_TOOL_MS);
          sendUp({ ...r, id });
        } catch (err) {
          sendUp({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
        }
        return;
      }
    }

    // No specific route — fan-out to all (lazy-connect each first).
    await Promise.allSettled([...tenants.keys()].map(k => ensureConnected(k)));
    sendUp(await fanOutFirst(method, params, id));
    return;
  }

  // All other MCP methods — forward to first live tenant
  const live = liveChildren();
  if (!live.length) { sendUp({ jsonrpc: '2.0', id, error: { code: -32603, message: 'No Atlassian tenants connected.' } }); return; }
  try {
    const r = await live[0].child.request({ ...msg, id: uid() }, TIMEOUT_GENERIC_MS);
    sendUp({ ...r, id });
  } catch (err) {
    sendUp({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  log('shutting down', { signal });

  for (const t of reconnectTimers.values()) clearTimeout(t);
  reconnectTimers.clear();
  for (const a of tenants.values()) a.child?.stop();

  // Force exit after deadline in case any child hangs
  const killer = setTimeout(() => {
    warn('force-exit after shutdown timeout', { timeoutMs: TIMEOUT_SHUTDOWN_MS });
    process.exit(1);
  }, TIMEOUT_SHUTDOWN_MS);
  // Unref so the timeout does not prevent natural exit if everything cleaned up
  if (typeof killer.unref === 'function') killer.unref();

  process.exit(0);
}

// ─── Process safety net ───────────────────────────────────────────────────────
// stdout EPIPE: the MCP host closed the pipe while we were still writing.
// Trigger graceful shutdown instead of letting uncaughtException swallow it.
process.stdout.on('error', err => {
  if (err.code === 'EPIPE') {
    warn('stdout EPIPE — MCP host disconnected', { err: err.message });
    shutdown('stdout-epipe');
  } else {
    error('stdout error', { code: err.code, err: err.message });
  }
});
// Prevent uncaught exceptions / rejections from silently killing the proxy.
// Log them and continue — the per-request .catch() in the stdin handler
// already sends a JSON-RPC error back to the client for in-flight requests.
process.on('uncaughtException', err => {
  error('uncaughtException', { err: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  error('unhandledRejection', { reason: String(reason) });
});

// ─── Stdin ────────────────────────────────────────────────────────────────────
const stdinRL = createInterface({ input: process.stdin, crlfDelay: Infinity });

stdinRL.on('line', raw => {
  const line = raw.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  route(msg).catch(err => error('route error', { err: err.message }));
});

stdinRL.on('close', () => shutdown('stdin-close'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

log('proxy started', { config: CONFIG, mcpRemoteVersion: MCP_REMOTE_VERSION });
