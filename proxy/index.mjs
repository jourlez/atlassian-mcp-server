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
 */

import { spawn }           from 'node:child_process';
import { readFile }        from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath }   from 'node:url';
import path                from 'node:path';

const DIR     = path.dirname(fileURLToPath(import.meta.url));
const CONFIG  = path.join(DIR, 'accounts.json');
const MCP_URL = 'https://mcp.atlassian.com/v1/mcp';

const log = (...a) => process.stderr.write('[atlassian-proxy] ' + a.join(' ') + '\n');

let _seq = 0;
const uid = () => `__p${++_seq}__`;

const FANOUT_MERGE_TOOLS = new Set(['getAccessibleAtlassianResources']);

const MGMT_TOOL = {
  name: 'get_atlassian_connections',
  description:
    'Show connection status and discovered cloudIds of all configured Atlassian tenants. ' +
    'Normal tool calls are routed automatically — you do not need to call this first.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

// ─── ChildMcp ─────────────────────────────────────────────────────────────────
class ChildMcp {
  constructor(key, tenantUrl) {
    this.key      = key;
    this.tenantUrl = tenantUrl;
    this._proc    = null;
    this._rl      = null;
    this._pending = new Map();
  }

  start() {
    this._proc = spawn(
      'npx',
      ['-y', 'mcp-remote@latest', MCP_URL, '--resource', this.tenantUrl],
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
    this._proc.on('error', err => log(`${this.key}: spawn error: ${err.message}`));
    this._proc.on('exit', code => {
      for (const { reject, timer } of this._pending.values()) {
        clearTimeout(timer);
        reject(new Error(`${this.key}: exited (code=${code})`));
      }
      this._pending.clear();
    });
  }

  request(msg, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      if (!this._proc || this._proc.exitCode !== null) {
        return reject(new Error(`${this.key}: not running`));
      }
      const timer = setTimeout(() => {
        this._pending.delete(msg.id);
        reject(new Error(`${this.key}: timeout on ${msg.method}`));
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
const tenants    = new Map(); // key → { tenantUrl, label, projects, spaces, child, cloudIds, connected }
const cloudIdMap = new Map(); // cloudId   → accountKey
const projMap    = new Map(); // PROJ_UPPER → accountKey
let   initParams = null;

const sendUp = msg => process.stdout.write(JSON.stringify(msg) + '\n');

// ─── Connect one tenant ────────────────────────────────────────────────────────
async function connectTenant(key, acct, params) {
  const child = new ChildMcp(key, acct.tenantUrl);
  child.start();
  const resp = await child.request(
    { jsonrpc: '2.0', id: uid(), method: 'initialize', params },
    120_000,
  );
  child.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  if (resp.error) {
    child.stop();
    throw new Error(resp.error.message ?? 'initialize failed');
  }
  acct.child     = child;
  acct.connected = true;
  log(`connected: ${key}`);
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
    }, 30_000);
    for (const r of parseResourceArray(resp?.result)) {
      if (r.cloudId) {
        acct.cloudIds.add(r.cloudId);
        cloudIdMap.set(r.cloudId, key);
      }
    }
    log(`${key}: cloudIds=[${[...acct.cloudIds].join(', ')}]`);
  } catch (err) {
    log(`${key}: cloudId discovery skipped: ${err.message}`);
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
    liveChildren().map(a => a.child.request({ jsonrpc: '2.0', id: uid(), method, params }, 30_000))
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
      a.child.request({ jsonrpc: '2.0', id: uid(), method, params }, 60_000)
        .then(resp => {
          left--;
          if (!done && !resp.error) { done = true; resolve({ ...resp, id: parentId }); }
          else if (!done && left === 0) resolve({ jsonrpc: '2.0', id: parentId, error: { code: -32603, message: errors.join('; ') || 'All tenants failed.' } });
        })
        .catch(err => {
          left--; errors.push(err.message);
          if (!done && left === 0) resolve({ jsonrpc: '2.0', id: parentId, error: { code: -32603, message: errors.join('; ') } });
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
    lines.push(`${key}  [${status}]`);
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

    const cfg = JSON.parse(await readFile(CONFIG, 'utf8'));
    for (const [key, acct] of Object.entries(cfg.accounts)) {
      tenants.set(key, { ...acct, child: null, cloudIds: new Set(), connected: false });
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
    log(`ready: ${n}/${tenants.size} tenants connected, ${cloudIdMap.size} cloudId(s) mapped`);
    sendUp({ jsonrpc: '2.0', id, result: firstOk.value });
    return;
  }

  if (method === 'tools/list') {
    const live = liveChildren();
    if (!live.length) { sendUp({ jsonrpc: '2.0', id, result: { tools: [MGMT_TOOL] } }); return; }
    try {
      const r = await live[0].child.request({ jsonrpc: '2.0', id: uid(), method: 'tools/list', params }, 15_000);
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
        const r = await target.child.request({ jsonrpc: '2.0', id: uid(), method, params }, 60_000);
        sendUp({ ...r, id });
      } catch (err) {
        sendUp({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
      }
      return;
    }

    sendUp(await fanOutFirst(method, params, id));
    return;
  }

  // All other MCP methods
  const live = liveChildren();
  if (!live.length) { sendUp({ jsonrpc: '2.0', id, error: { code: -32603, message: 'No Atlassian tenants connected.' } }); return; }
  try {
    const r = await live[0].child.request({ ...msg, id: uid() }, 30_000);
    sendUp({ ...r, id });
  } catch (err) {
    sendUp({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
  }
}

// ─── Stdin ────────────────────────────────────────────────────────────────────
const stdinRL = createInterface({ input: process.stdin, crlfDelay: Infinity });

stdinRL.on('line', raw => {
  const line = raw.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  route(msg).catch(err => log('route error:', err.message));
});

stdinRL.on('close', () => { for (const a of tenants.values()) a.child?.stop(); process.exit(0); });
process.on('SIGTERM',  () => { for (const a of tenants.values()) a.child?.stop(); process.exit(0); });

log('started — config:', CONFIG);
