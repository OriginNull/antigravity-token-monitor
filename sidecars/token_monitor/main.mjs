/**
 * Antigravity Token Monitor Sidecar Backend
 *
 * Read-only scanner for Antigravity conversation transcripts:
 *   <appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 *
 * Persists user-customized model pricing & currency settings in:
 *   <ANTIGRAVITY_EXECUTABLE_DATA_DIR>/pricing.json (or alongside main.mjs standalone)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_GLOBAL_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DELEGATION_TOOLS = new Set(['invoke_subagent', 'send_message', 'manage_subagents', 'swarm', 'run_workflow']);
const DELEGATION_RESPONSE_HINT_RE = /conversationId|conversation_id|conversation:\/\/|subagent|swarm|worker|workflow/i;
const MAX_TRANSCRIPT_CACHE = 1000;
const MAX_OVERVIEW_CACHE = 8;

const STATIC_FILES = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

// Default pricing (USD per 1M tokens) & context limits.
// Users can override any model or currency in the settings drawer.
const DEFAULT_PRICING = {
  currency: 'USD', // 'USD' | 'CNY'
  cnyRate: 7.25,
  fallback: {
    contextLimit: 1000000,
    input: 1.25,
    cache: 0.3125,
    output: 10.0,
  },
  models: {
    'gemini-4-neon-high': { contextLimit: 1000000, input: 1.25, cache: 0.3125, output: 10.0 },
    'gemini-4-neon': { contextLimit: 1000000, input: 1.25, cache: 0.3125, output: 10.0 },
    'gemini-3-pro': { contextLimit: 1000000, input: 1.25, cache: 0.3125, output: 10.0 },
    'gemini-3-flash': { contextLimit: 1000000, input: 0.15, cache: 0.0375, output: 0.6 },
    'gemini-2.5-pro': { contextLimit: 1000000, input: 1.25, cache: 0.3125, output: 10.0 },
    'gemini-2.5-flash': { contextLimit: 1000000, input: 0.15, cache: 0.0375, output: 0.6 },
    'gemini-2.5-flash-lite': { contextLimit: 1000000, input: 0.075, cache: 0.01875, output: 0.3 },
    'claude-opus-4': { contextLimit: 200000, input: 15.0, cache: 1.5, output: 75.0 },
    'claude-sonnet-4': { contextLimit: 200000, input: 3.0, cache: 0.3, output: 15.0 },
  },
};

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function statOf(filePath) {
  try {
    const s = statSync(filePath);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return { mtime: 0, size: -1 };
  }
}

function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
  }
  const root = join(homedir(), '.gemini');
  return safeReaddir(root)
    .sort()
    .map((name) => join(root, name))
    .filter((candidate) => existsSync(join(candidate, 'brain')));
}

function pricingFilePath() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    try {
      mkdirSync(dataDir, { recursive: true });
      return join(dataDir, 'pricing.json');
    } catch {
      // fall through
    }
  }
  return join(__dirname, 'pricing.json');
}

function sanitizeModelRule(rule, base) {
  const num = (v, fb) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fb;
  };
  const limit = Number(rule?.contextLimit);
  return {
    contextLimit: Number.isFinite(limit) && limit >= 1000 ? Math.round(limit) : base.contextLimit,
    input: num(rule?.input, base.input),
    cache: num(rule?.cache, base.cache),
    output: num(rule?.output, base.output),
  };
}

function loadPricing() {
  const fp = pricingFilePath();
  let saved = null;
  try {
    if (existsSync(fp)) {
      saved = JSON.parse(readFileSync(fp, 'utf-8'));
    }
  } catch {
    saved = null;
  }

  const currency = saved?.currency === 'CNY' ? 'CNY' : 'USD';
  const rateNum = Number(saved?.cnyRate);
  const cnyRate = Number.isFinite(rateNum) && rateNum > 0 ? rateNum : DEFAULT_PRICING.cnyRate;
  const fallback = sanitizeModelRule(saved?.fallback, DEFAULT_PRICING.fallback);
  const models = {};
  for (const [k, v] of Object.entries(DEFAULT_PRICING.models)) {
    models[k] = { ...v };
  }
  if (saved?.models && typeof saved.models === 'object') {
    for (const [k, v] of Object.entries(saved.models)) {
      if (!k || typeof k !== 'string') continue;
      models[k] = sanitizeModelRule(v, models[k] || fallback);
    }
  }
  return { currency, cnyRate, fallback, models };
}

function savePricing(payload) {
  const current = loadPricing();
  const next = {
    currency: payload?.currency === 'CNY' ? 'CNY' : payload?.currency === 'USD' ? 'USD' : current.currency,
    cnyRate:
      Number.isFinite(Number(payload?.cnyRate)) && Number(payload.cnyRate) > 0
        ? Number(payload.cnyRate)
        : current.cnyRate,
    fallback: payload?.fallback ? sanitizeModelRule(payload.fallback, current.fallback) : current.fallback,
    models: { ...current.models },
  };
  if (payload?.models && typeof payload.models === 'object') {
    for (const [k, v] of Object.entries(payload.models)) {
      if (!k || typeof k !== 'string') continue;
      next.models[k] = sanitizeModelRule(v, next.models[k] || next.fallback);
    }
  }
  writeFileSync(pricingFilePath(), JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return next;
}

function resetPricing() {
  const fp = pricingFilePath();
  const next = structuredClone(DEFAULT_PRICING);
  writeFileSync(fp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return next;
}

function formatModelName(raw) {
  if (!raw || typeof raw !== 'string') return 'Unknown Model';
  const parts = raw.trim().split(/[-_]+/).filter(Boolean);
  if (!parts.length) return raw;
  const qualifiers = new Set(['high', 'low', 'medium', 'fast', 'thinking', 'preview', 'exp']);
  const main = [];
  const tags = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (qualifiers.has(lower)) {
      tags.push(lower.charAt(0).toUpperCase() + lower.slice(1));
    } else if (/^\d+(\.\d+)?$/.test(p)) {
      main.push(p);
    } else {
      main.push(lower.charAt(0).toUpperCase() + lower.slice(1));
    }
  }
  return tags.length ? `${main.join(' ')} (${tags.join(' ')})` : main.join(' ');
}

function ruleForModel(modelId, pricing) {
  const id = String(modelId || '').toLowerCase();
  if (id && pricing.models[id]) return pricing.models[id];
  if (modelId && pricing.models[modelId]) return pricing.models[modelId];
  // Fuzzy prefix/keyword match
  for (const [k, v] of Object.entries(pricing.models)) {
    if (id && (id.startsWith(k.toLowerCase()) || k.toLowerCase().startsWith(id))) return v;
  }
  if (id.includes('flash-lite') || id.includes('lite')) {
    return { contextLimit: 1000000, input: 0.075, cache: 0.01875, output: 0.3 };
  }
  if (id.includes('flash')) {
    return { contextLimit: 1000000, input: 0.15, cache: 0.0375, output: 0.6 };
  }
  if (id.includes('opus')) {
    return { contextLimit: 200000, input: 15.0, cache: 1.5, output: 75.0 };
  }
  if (id.includes('sonnet')) {
    return { contextLimit: 200000, input: 3.0, cache: 0.3, output: 15.0 };
  }
  return pricing.fallback;
}

function calcCostUsd(input, cache, output, rule) {
  const cost = (input * rule.input + cache * rule.cache + output * rule.output) / 1_000_000;
  const saved = (cache * Math.max(0, rule.input - rule.cache)) / 1_000_000;
  return { cost, saved };
}

function shortHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function pricingHash(pricing) {
  return shortHash(
    JSON.stringify({
      currency: pricing.currency,
      cnyRate: pricing.cnyRate,
      fallback: pricing.fallback,
      models: pricing.models,
    }),
  );
}

// ---------------------------------------------------------------------------
// Transcript parser with mtime+size LRU cache
// ---------------------------------------------------------------------------

const transcriptCache = new Map(); // filePath -> { key, parsed }
const overviewCache = new Map(); // range -> { etag, snapshot }

function transcriptPath(appData, convId) {
  return join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
}

function getCachedTranscript(fp, key) {
  const cached = transcriptCache.get(fp);
  if (!cached || cached.key !== key) return null;
  // 刷新至 Map 尾部，维护 LRU 顺序
  transcriptCache.delete(fp);
  transcriptCache.set(fp, cached);
  return cached.parsed;
}

function setCachedTranscript(fp, key, parsed) {
  if (transcriptCache.has(fp)) {
    transcriptCache.delete(fp);
  }
  transcriptCache.set(fp, { key, parsed });
  while (transcriptCache.size > MAX_TRANSCRIPT_CACHE) {
    const oldestKey = transcriptCache.keys().next().value;
    transcriptCache.delete(oldestKey);
  }
}

function extractUuids(value, selfLower, targetSet) {
  if (typeof value !== 'string' || !value) return;
  const matches = value.match(UUID_GLOBAL_RE) || [];
  for (const id of matches) {
    const norm = id.toLowerCase();
    if (norm !== selfLower) {
      targetSet.add(norm);
    }
  }
}

function parseTranscript(appData, convId) {
  if (!appData || !convId) return null;
  const fp = transcriptPath(appData, convId);
  const st = statOf(fp);
  if (st.size < 0) return null;

  const key = `${st.mtime}:${st.size}`;
  const cached = getCachedTranscript(fp, key);
  if (cached) return cached;

  let text = '';
  try {
    text = readFileSync(fp, 'utf-8');
  } catch {
    return null;
  }

  const selfLower = convId.toLowerCase();
  const calls = [];
  const subagentIds = new Set();
  // 记录当前 PLANNER_RESPONSE 派发后待匹配的工具响应队列（每项表示该响应是否属于委派类工具）
  let pendingToolFlags = [];

  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (obj.type === 'PLANNER_RESPONSE') {
      const input = Number(obj.input_tokens) || 0;
      const cache = Number(obj.cache_read_tokens) || 0;
      const output = Number(obj.output_tokens) || 0;
      const model = typeof obj.model === 'string' && obj.model ? obj.model : 'unknown';
      const ts = typeof obj.created_at === 'string' ? Date.parse(obj.created_at) : NaN;
      if (input > 0 || cache > 0 || output > 0) {
        calls.push({
          step: Number(obj.step_index) || 0,
          ts: Number.isFinite(ts) ? ts : st.mtime,
          model,
          input,
          cache,
          output,
        });
      }
      pendingToolFlags = [];
      if (Array.isArray(obj.tool_calls)) {
        for (const tc of obj.tool_calls) {
          const name = tc?.name;
          const isDelegation = typeof name === 'string' && DELEGATION_TOOLS.has(name);
          pendingToolFlags.push(isDelegation);
          if (!isDelegation) continue;
          // 从 send_message / manage_subagents 等工具入参直接提取关联子会话 ID
          const args = tc?.args;
          if (args && typeof args === 'object') {
            if (name === 'send_message' && typeof args.Recipient === 'string') {
              extractUuids(args.Recipient, selfLower, subagentIds);
            } else if (name === 'manage_subagents' && args.ConversationIds !== undefined) {
              extractUuids(
                typeof args.ConversationIds === 'string' ? args.ConversationIds : JSON.stringify(args.ConversationIds),
                selfLower,
                subagentIds,
              );
            }
          }
        }
      }
    } else if (obj.type === 'SYSTEM_MESSAGE' && typeof obj.content === 'string') {
      // 匹配系统转发的 subagent / swarm / workflow 回传消息（例如 sender=<uuid>）
      const senderMatches = obj.content.matchAll(/\bsender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi);
      for (const m of senderMatches) {
        const norm = m[1].toLowerCase();
        if (norm !== selfLower) subagentIds.add(norm);
      }
      if (DELEGATION_RESPONSE_HINT_RE.test(obj.content)) {
        const refMatches = obj.content.matchAll(/(?:conversation:\/\/|conversationId["']?\s*[:=]\s*["']?)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi);
        for (const m of refMatches) {
          const norm = m[1].toLowerCase();
          if (norm !== selfLower) subagentIds.add(norm);
        }
      }
    } else if (pendingToolFlags.length > 0 && obj.type !== 'USER_INPUT') {
      const isDelegationResp = pendingToolFlags.shift();
      if (isDelegationResp && typeof obj.content === 'string' && DELEGATION_RESPONSE_HINT_RE.test(obj.content)) {
        extractUuids(obj.content, selfLower, subagentIds);
      }
    } else if (obj.type === 'USER_INPUT') {
      pendingToolFlags = [];
    }
  }

  // 仅保留磁盘上真实存在 transcript.jsonl 的子会话，避免误关联
  const validSubagents = [];
  for (const sid of subagentIds) {
    if (existsSync(transcriptPath(appData, sid))) {
      validSubagents.push(sid);
    }
  }

  const parsed = {
    convId: selfLower,
    key,
    mtime: st.mtime,
    calls,
    subagents: validSubagents,
  };

  setCachedTranscript(fp, key, parsed);
  return parsed;
}

function locateConversation(convId) {
  const dirs = findAppDataDirs();
  if (convId && ID_RE.test(convId)) {
    for (const appData of dirs) {
      if (existsSync(transcriptPath(appData, convId))) {
        return { appData, convId };
      }
    }
  }
  return { appData: dirs[0] || null, convId: convId || '' };
}

function findLatestConversation() {
  const dirs = findAppDataDirs();
  let best = null;
  for (const appData of dirs) {
    const brainDir = join(appData, 'brain');
    for (const entry of safeReaddir(brainDir)) {
      if (!ID_RE.test(entry)) continue;
      const st = statOf(transcriptPath(appData, entry));
      if (st.size > 0 && (!best || st.mtime > best.mtime)) {
        best = { appData, convId: entry, mtime: st.mtime };
      }
    }
  }
  return best;
}

function buildCurrentSnapshot(requestedConvId, pricing) {
  let { appData, convId } = locateConversation(requestedConvId);
  let fallbackUsed = false;

  if ((!appData || !convId || !existsSync(transcriptPath(appData, convId))) && !requestedConvId) {
    const latest = findLatestConversation();
    if (latest) {
      appData = latest.appData;
      convId = latest.convId;
      fallbackUsed = true;
    }
  }

  const pHash = pricingHash(pricing);

  if (!appData || !convId) {
    return { found: false, conversationId: requestedConvId || null, etag: `empty:${pHash}` };
  }

  const main = parseTranscript(appData, convId);
  if (!main) {
    return { found: false, conversationId: convId, etag: `missing:${convId.toLowerCase()}:${pHash}` };
  }

  // Gather transitive subagents safely (case-insensitive dedupe)
  const visited = new Set([convId.toLowerCase()]);
  const queue = [...main.subagents];
  const subParsed = [];
  while (queue.length) {
    const rawSid = queue.shift();
    const sid = typeof rawSid === 'string' ? rawSid.toLowerCase() : '';
    if (!sid || visited.has(sid)) continue;
    visited.add(sid);
    const sp = parseTranscript(appData, sid);
    if (!sp) continue;
    subParsed.push(sp);
    for (const nextId of sp.subagents) {
      const nextNorm = typeof nextId === 'string' ? nextId.toLowerCase() : '';
      if (nextNorm && !visited.has(nextNorm)) queue.push(nextNorm);
    }
  }

  let input = 0;
  let cache = 0;
  let output = 0;
  let callCount = 0;
  let costUsd = 0;
  let savedUsd = 0;
  const modelsSeen = new Set();

  const accumulate = (tr) => {
    for (const c of tr.calls) {
      input += c.input;
      cache += c.cache;
      output += c.output;
      callCount += 1;
      modelsSeen.add(c.model);
      const rule = ruleForModel(c.model, pricing);
      const { cost, saved } = calcCostUsd(c.input, c.cache, c.output, rule);
      costUsd += cost;
      savedUsd += saved;
    }
  };

  accumulate(main);
  for (const sp of subParsed) {
    accumulate(sp);
  }

  const lastCall = main.calls.length ? main.calls[main.calls.length - 1] : null;
  const activeModel = lastCall?.model || [...modelsSeen][0] || 'unknown';
  const activeRule = ruleForModel(activeModel, pricing);
  const contextCache = lastCall ? lastCall.cache : 0;
  const contextInput = lastCall ? lastCall.input : 0;
  const contextUsed = contextCache + contextInput;
  const contextLimit = activeRule.contextLimit;
  const contextPct = contextLimit > 0 ? Math.min(100, (contextUsed / contextLimit) * 100) : 0;

  const totalInputAll = input + cache;
  const cacheHitRate = totalInputAll > 0 ? (cache / totalInputAll) * 100 : 0;
  const totalTokens = input + cache + output;

  const subKeys = subParsed.map((s) => `${s.convId}:${s.key}`).join(',');
  const etag = `${convId.toLowerCase()}|${main.key}|${subKeys}|${pHash}`;

  return {
    found: true,
    conversationId: convId,
    fallbackUsed,
    etag,
    model: activeModel,
    modelDisplay: formatModelName(activeModel),
    context: {
      used: contextUsed,
      cache: contextCache,
      input: contextInput,
      limit: contextLimit,
      pct: contextPct,
    },
    totals: {
      totalTokens,
      input,
      cache,
      output,
      callCount,
      subagentCount: subParsed.length,
      cacheHitRate,
      costUsd,
      savedUsd,
    },
    currency: pricing.currency,
    cnyRate: pricing.cnyRate,
  };
}

function rangeStartMs(range) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (range === 'today') return startOfToday;
  if (range === '7d') return startOfToday - 6 * 24 * 60 * 60 * 1000;
  if (range === '30d') return startOfToday - 29 * 24 * 60 * 60 * 1000;
  return 0;
}

function buildOverviewSnapshot(range, pricing, requestedEtag = '') {
  const validRange = ['today', '7d', '30d', 'all'].includes(range) ? range : 'today';
  const minTs = rangeStartMs(validRange);
  const dirs = findAppDataDirs();

  // 先扫描文件元数据生成轻量指纹，未变化时直接命中 ETag 或内存缓存
  const entries = [];
  const seenConvs = new Set();
  const statParts = [];
  for (const appData of dirs) {
    const brainDir = join(appData, 'brain');
    for (const entry of safeReaddir(brainDir)) {
      if (!ID_RE.test(entry)) continue;
      const norm = entry.toLowerCase();
      if (seenConvs.has(norm)) continue;
      seenConvs.add(norm);
      const st = statOf(transcriptPath(appData, entry));
      if (st.size <= 0) continue;
      entries.push({ appData, entry });
      statParts.push(`${norm}:${st.mtime}:${st.size}`);
    }
  }
  statParts.sort();

  const pHash = pricingHash(pricing);
  const etag = shortHash(`${validRange}|${minTs}|${pHash}|${statParts.join(',')}`);
  if (requestedEtag && requestedEtag === etag) {
    return { unchanged: true, etag };
  }

  const cachedOverview = overviewCache.get(validRange);
  if (cachedOverview && cachedOverview.etag === etag) {
    return cachedOverview.snapshot;
  }

  let totalInput = 0;
  let totalCache = 0;
  let totalOutput = 0;
  let totalCostUsd = 0;
  let totalSavedUsd = 0;
  let totalCalls = 0;
  let sessionCount = 0;

  const byModel = new Map(); // modelId -> { model, display, input, cache, output, total, costUsd, calls }
  const discoveredModels = new Set();

  for (const { appData, entry } of entries) {
    const tr = parseTranscript(appData, entry);
    if (!tr || !tr.calls.length) continue;

    let convMatched = false;
    for (const c of tr.calls) {
      discoveredModels.add(c.model);
      if (minTs > 0 && c.ts < minTs) continue;
      convMatched = true;

      const rule = ruleForModel(c.model, pricing);
      const { cost, saved } = calcCostUsd(c.input, c.cache, c.output, rule);

      totalInput += c.input;
      totalCache += c.cache;
      totalOutput += c.output;
      totalCostUsd += cost;
      totalSavedUsd += saved;
      totalCalls += 1;

      let bucket = byModel.get(c.model);
      if (!bucket) {
        bucket = {
          model: c.model,
          display: formatModelName(c.model),
          input: 0,
          cache: 0,
          output: 0,
          total: 0,
          costUsd: 0,
          calls: 0,
        };
        byModel.set(c.model, bucket);
      }
      bucket.input += c.input;
      bucket.cache += c.cache;
      bucket.output += c.output;
      bucket.total += c.input + c.cache + c.output;
      bucket.costUsd += cost;
      bucket.calls += 1;
    }

    if (convMatched) sessionCount += 1;
  }

  const totalTokens = totalInput + totalCache + totalOutput;
  const totalInAll = totalInput + totalCache;
  const avgCacheHitRate = totalInAll > 0 ? (totalCache / totalInAll) * 100 : 0;

  const models = [...byModel.values()]
    .sort((a, b) => b.total - a.total)
    .map((m) => ({
      ...m,
      pct: totalTokens > 0 ? (m.total / totalTokens) * 100 : 0,
    }));

  const snapshot = {
    range: validRange,
    etag,
    totals: {
      totalTokens,
      input: totalInput,
      cache: totalCache,
      output: totalOutput,
      sessionCount,
      callCount: totalCalls,
      avgCacheHitRate,
      costUsd: totalCostUsd,
      savedUsd: totalSavedUsd,
    },
    models,
    discoveredModels: [...discoveredModels].sort(),
    currency: pricing.currency,
    cnyRate: pricing.cnyRate,
  };

  if (overviewCache.has(validRange)) {
    overviewCache.delete(validRange);
  }
  overviewCache.set(validRange, { etag, snapshot });
  while (overviewCache.size > MAX_OVERVIEW_CACHE) {
    const oldestKey = overviewCache.keys().next().value;
    overviewCache.delete(oldestKey);
  }

  return snapshot;
}

function buildPricingResponse() {
  const pricing = loadPricing();
  // Also include every model seen in local transcripts so the user can edit their prices directly
  const overview = buildOverviewSnapshot('all', pricing);
  const allModelIds = new Set([...Object.keys(pricing.models), ...overview.discoveredModels]);
  const modelList = [...allModelIds]
    .filter((id) => id && id !== 'unknown')
    .sort()
    .map((id) => ({
      id,
      display: formatModelName(id),
      usedLocally: overview.discoveredModels.includes(id),
      ...ruleForModel(id, pricing),
    }));

  return {
    currency: pricing.currency,
    cnyRate: pricing.cnyRate,
    fallback: pricing.fallback,
    modelList,
  };
}

// ---------------------------------------------------------------------------
// Server bootstrap (SidecarApp in Antigravity, HTTP fallback standalone)
// ---------------------------------------------------------------------------

async function start() {
  let sdk = null;
  try {
    sdk = await import('sidecar_sdk');
  } catch {
    sdk = null;
  }

  if (sdk?.SidecarApp) {
    const { SidecarApp, Response } = sdk;
    const app = new SidecarApp();

    app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

    for (const [route, [file, contentType]] of Object.entries(STATIC_FILES)) {
      app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }), 'GET');
    }

    app.api(
      '/api/current',
      (data) => {
        const pricing = loadPricing();
        const conv = data?.conversationId || app.config?.conversationId || '';
        const snap = buildCurrentSnapshot(conv, pricing);
        if (data?.etag && data.etag === snap.etag) {
          return { unchanged: true, etag: snap.etag };
        }
        return snap;
      },
      'GET',
    );

    app.api(
      '/api/overview',
      (data) => {
        const pricing = loadPricing();
        return buildOverviewSnapshot(data?.range || 'today', pricing, data?.etag || '');
      },
      'GET',
    );

    app.api('/api/pricing', () => buildPricingResponse(), 'GET');

    app.api(
      '/api/pricing',
      (data) => {
        const body = typeof data === 'string' ? JSON.parse(data) : data || {};
        if (body?.reset === true) {
          resetPricing();
        } else {
          savePricing(body);
        }
        return buildPricingResponse();
      },
      'POST',
    );

    console.log(`[antigravity-token-monitor] started via sidecar_sdk; app data dirs: ${findAppDataDirs().join(', ')}`);
    app.run();
    return;
  }

  // Standalone Node HTTP fallback for local preview / testing
  const port = Number(process.env.PORT || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 3456);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const send = (status, body, contentType = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/') {
      return send(200, readFileSync(join(__dirname, 'index.html'), 'utf-8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/preload.js') {
      return send(200, '/* standalone stub */\n', 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
      const [file, type] = STATIC_FILES[url.pathname];
      return send(200, readFileSync(join(__dirname, file), 'utf-8'), type);
    }
    if (req.method === 'GET' && url.pathname === '/api/current') {
      const pricing = loadPricing();
      const conv = url.searchParams.get('conversationId') || '';
      const snap = buildCurrentSnapshot(conv, pricing);
      if (url.searchParams.get('etag') && url.searchParams.get('etag') === snap.etag) {
        return send(200, { unchanged: true, etag: snap.etag });
      }
      return send(200, snap);
    }
    if (req.method === 'GET' && url.pathname === '/api/overview') {
      const pricing = loadPricing();
      const range = url.searchParams.get('range') || 'today';
      const etag = url.searchParams.get('etag') || '';
      return send(200, buildOverviewSnapshot(range, pricing, etag));
    }
    if (req.method === 'GET' && url.pathname === '/api/pricing') {
      return send(200, buildPricingResponse());
    }
    if (req.method === 'POST' && url.pathname === '/api/pricing') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        try {
          const body = raw ? JSON.parse(raw) : {};
          if (body?.reset === true) {
            resetPricing();
          } else {
            savePricing(body);
          }
          send(200, buildPricingResponse());
        } catch (err) {
          send(400, { error: String(err) });
        }
      });
      return;
    }
    send(404, { error: 'Not found' });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[antigravity-token-monitor] standalone server running at http://127.0.0.1:${port}`);
  });
}

export {
  buildCurrentSnapshot,
  buildOverviewSnapshot,
  buildPricingResponse,
  loadPricing,
  parseTranscript,
  resetPricing,
  savePricing,
  start,
};

if (process.env.TOKEN_MONITOR_NO_START !== '1') {
  start();
}
