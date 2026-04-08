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

import { spawn }           from 'node:child_process';
import { readFile }        from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath }   from 'node:url';
import path                from 'node:path';

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

const MGMT_TOOL = {
  name: 'get_atlassian_connections',
  description:
    'Show connection status and discovered cloudIds of all configured Atlassian tenants. ' +
    'Normal tool calls are routed automatically — you do not need to call this first.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

// ─── Config schema validation ─────────────────────────────────────────────────
function validateConfig(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('accounts.json must be a JSON object');
  if (typeof raw.accounts !== 'object' || raw.accounts === null) throw new Error('accounts.json must have an "accounts" object');
  const entries = Object.entries(raw.accounts);
  if (entries.length === 0) throw new Error('accounts.json "accounts" must have at least one entry');
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
const tenants    = new Map(); // key → { tenantUrl, label, projects, spaces, child, cloudIds, connected, retries }
const cloudIdMap = new Map(); // cloudId   → accountKey
const projMap    = new Map(); // PROJ_UPPER → accountKey
const reconnectTimers = new Map(); // key → timeout handle (setTimeout)
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
      if (r.cloudId) {
        acct.cloudIds.add(r.cloudId);
        cloudIdMap.set(r.cloudId, key);
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
function routeToTenant(params) {
  const args = params?.arguments ?? {};

  // 1. cloudId — strongest signal
  if (args.cloudId) {
    const key = cloudIdMap.get(args.cloudId);
    if (key) { const t = tenants.get(key); if (t?.child?.alive) return t; }
  }

  // 2. Issue key prefix — "DCC-123" → "DCC"
  for (const f of ['issueKey', 'issue', 'issueIdOrKey', 'sourceIssue', 'targetIssue', 'epicKey']) {
    const v = args[f];
    if (v) {
      const m = String(v).match(/^([A-Z][A-Z0-9]+)-\d+/);
      if (m) { const t = tenants.get(projMap.get(m[1])); if (t?.child?.alive) return t; }
    }
  }

  // 3. Explicit project / space key
  for (const f of ['projectKey', 'project', 'projectId', 'spaceKey', 'spaceId']) {
    const v = args[f];
    if (v) { const t = tenants.get(projMap.get(String(v).toUpperCase())); if (t?.child?.alive) return t; }
  }

  // 4. JQL project clause
  if (args.jql) {
    const m = String(args.jql).match(/\bproject\s*(?:=|~|in\s*\()\s*"?'?([A-Z][A-Z0-9]*)"?'?/i);
    if (m) { const t = tenants.get(projMap.get(m[1].toUpperCase())); if (t?.child?.alive) return t; }
  }

  // 5. CQL space clause
  if (args.cql) {
    const m = String(args.cql).match(/\bspace\s*=\s*"?'?([A-Z][A-Z0-9]*)"?'?/i);
    if (m) { const t = tenants.get(projMap.get(m[1].toUpperCase())); if (t?.child?.alive) return t; }
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

// ─── Management tool ──────────────────────────────────────────────────────────
function handleGetConnections() {
  const lines = [];
  for (const [key, a] of tenants) {
    const status  = !a.connected ? 'failed' : (a.child?.alive ? 'connected' : 'disconnected');
    const ids     = a.cloudIds.size ? [...a.cloudIds].join(', ') : '(pending)';
    const retries = a.retries ?? 0;
    lines.push(`${key}  [${status}]${retries > 0 ? `  (reconnect attempt ${retries}/${RECONNECT_MAX_RETRIES})` : ''}`);
    lines.push(`  Tenant  : ${a.tenantUrl}`);
    lines.push(`  Label   : ${a.label}`);
    lines.push(`  CloudId : ${ids}`);
    lines.push(`  Projects: ${(a.projects ?? []).join(', ') || '—'}`);
    lines.push(`  Spaces  : ${(a.spaces   ?? []).join(', ') || '—'}`);
    lines.push('');
  }
  return { content: [{ type: 'text', text: lines.join('\n').trim() || 'No tenants configured.' }] };
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

    const connectResults = await Promise.allSettled(
      [...tenants.entries()].map(([k, a]) => connectTenant(k, a, params))
    );
    const firstOk = connectResults.find(r => r.status === 'fulfilled');
    if (!firstOk) {
      sendUp({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Failed to connect to any Atlassian tenant.' } });
      return;
    }

    // Block until cloudId discovery is complete so routing is ready from the first call
    await Promise.allSettled([...tenants.entries()].map(([k, a]) => discoverCloudIds(k, a)));

    const n = liveChildren().length;
    log('proxy ready', { connected: n, total: tenants.size, cloudIds: cloudIdMap.size });
    sendUp({ jsonrpc: '2.0', id, result: firstOk.value });
    return;
  }

  if (method === 'tools/list') {
    const live = liveChildren();
    if (!live.length) { sendUp({ jsonrpc: '2.0', id, result: { tools: [MGMT_TOOL] } }); return; }
    try {
      const r = await live[0].child.request({ jsonrpc: '2.0', id: uid(), method: 'tools/list', params }, TIMEOUT_LIST_MS);
      sendUp({ jsonrpc: '2.0', id, result: { tools: [MGMT_TOOL, ...(r.result?.tools ?? [])] } });
    } catch {
      sendUp({ jsonrpc: '2.0', id, result: { tools: [MGMT_TOOL] } });
    }
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;

    if (name === 'get_atlassian_connections') {
      sendUp({ jsonrpc: '2.0', id, result: handleGetConnections() });
      return;
    }

    if (FANOUT_MERGE_TOOLS.has(name)) {
      sendUp({ jsonrpc: '2.0', id, result: await fanOutAndMerge(method, params) });
      return;
    }

    const target = routeToTenant(params);
    if (target?.child?.alive) {
      try {
        const r = await target.child.request({ jsonrpc: '2.0', id: uid(), method, params }, TIMEOUT_TOOL_MS);
        sendUp({ ...r, id });
      } catch (err) {
        sendUp({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
      }
      return;
    }

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
