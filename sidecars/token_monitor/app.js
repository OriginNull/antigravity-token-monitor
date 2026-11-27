(() => {
  const CURRENT_POLL_MS = 1800;
  const OVERVIEW_POLL_MS = 3000;
  const $ = (id) => document.getElementById(id);

  const state = {
    tab: 'current', // 'current' | 'overview'
    range: 'today', // 'today' | '7d' | '30d' | 'all'
    overviewYear: new Date().getFullYear(),
    overviewDate: null, // 'YYYY-MM-DD' | null
    yearMenuOpen: false,
    callFilter: 'all', // 'all' | 'main'
    etag: '',
    overviewEtag: '',
    lastOverviewPollAt: 0,
    lastOverviewData: null,
    lastConv: '',
    lastCurrentData: null,
    seenCallConv: '',
    seenCallIds: new Set(),
    seenOverviewRange: '',
    seenOverviewCallIds: new Set(),
    pricingDraft: null,
    currencyDraft: 'USD',
    currentReqSeq: 0,
    overviewReqSeq: 0,
    pollingCurrent: false,
    pollingOverview: false,
    toastTimer: null,
  };

  const MODEL_COLORS = [
    'var(--tm-c-input)',
    'var(--tm-c-cache)',
    'var(--tm-c-output)',
    'var(--chart-4, #a855f7)',
    'var(--chart-5, #ec4899)',
    'var(--chart-6, #06b6d4)',
  ];

  // ---------- Host theme sync (mirrors builtin swarm_board) ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Sidecar API helpers ----------
  const urlParams = new URLSearchParams(location.search);
  const currentConvId = () => window.sidecar?.conversationId || urlParams.get('conversationId') || '';
  const PAGE_ASSET_VER = typeof window.__TM_ASSET_VER__ === 'string' ? window.__TM_ASSET_VER__ : '';
  let pendingAssetReload = false;

  function triggerAssetReload() {
    try {
      const now = Date.now();
      const last = Number(sessionStorage.getItem('tm_last_auto_reload') || '0');
      if (now - last < 3000) return false;
      sessionStorage.setItem('tm_last_auto_reload', String(now));
    } catch {
      // ignore storage errors in restricted webviews
    }
    location.reload();
    return true;
  }

  function maybeAutoReload(data) {
    if (!PAGE_ASSET_VER || !data?.assetVer || data.assetVer === PAGE_ASSET_VER) return false;
    const settingsOpen = $('settings-backdrop') && !$('settings-backdrop').classList.contains('hidden');
    if (settingsOpen) {
      pendingAssetReload = true;
      return false;
    }
    return triggerAssetReload();
  }

  async function apiFetch(path, options = {}) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, options);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  // ---------- Formatters ----------
  function fmtTokens(n) {
    const num = Number(n) || 0;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 10_000) return `${(num / 1_000).toFixed(1)}K`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
    return num.toLocaleString('en-US');
  }

  function fmtLimit(n) {
    const num = Number(n) || 1_000_000;
    if (num >= 1_000_000) {
      const m = num / 1_000_000;
      return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
    }
    return `${Math.round(num / 1000)}K`;
  }

  function fmtMoney(usd, currency, cnyRate) {
    const val = currency === 'CNY' ? (Number(usd) || 0) * (Number(cnyRate) || 7.25) : Number(usd) || 0;
    const sym = currency === 'CNY' ? '¥' : '$';
    if (val === 0) return `${sym}0.00`;
    if (val < 0.001) return `${sym}${val.toFixed(4)}`;
    if (val < 0.1) return `${sym}${val.toFixed(3)}`;
    return `${sym}${val.toFixed(2)}`;
  }

  function fmtPct(v) {
    const n = Number(v) || 0;
    if (n > 0 && n < 0.1) return '<0.1%';
    return `${n.toFixed(1)}%`;
  }

  function fmtTime(ts, withDateIfNotToday = false) {
    const d = new Date(Number(ts));
    if (!Number.isFinite(d.getTime())) return '--:--:--';
    const pad = (v) => String(v).padStart(2, '0');
    if (withDateIfNotToday) {
      const now = new Date();
      const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      if (!sameDay) {
        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    }
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fmtDelta(delta) {
    if (delta === null || delta === undefined || !Number.isFinite(Number(delta))) return '';
    const n = Math.round(Number(delta));
    if (n === 0) return 'Ctx 0';
    return `${n > 0 ? 'Ctx +' : 'Ctx -'}${fmtTokens(Math.abs(n))}`;
  }

  function fmtDeltaTitle(delta) {
    if (delta === null || delta === undefined || !Number.isFinite(Number(delta))) return '';
    const n = Math.round(Number(delta));
    const signed = n === 0 ? '0' : `${n > 0 ? '+' : '-'}${fmtTokens(Math.abs(n))}`;
    return `较同会话上次请求上下文变化：${signed} Token`;
  }

  function fmtTps(tps, compact = false) {
    if (tps === null || tps === undefined || !Number.isFinite(Number(tps))) return '';
    const n = Number(tps);
    if (n <= 0) return '';
    const numStr = compact || n >= 100 ? String(Math.round(n)) : n.toFixed(1);
    return `${numStr} tok/s`;
  }

  function fmtDuration(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
    const sec = Number(ms) / 1000;
    if (sec < 59.95) return `${sec.toFixed(1)}s`;
    const totalSec = Math.round(sec);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
  }

  function tpsTone(tps, output = 100) {
    if (tps === null || tps === undefined || !Number.isFinite(Number(tps))) return '';
    const n = Number(tps);
    if (n >= 50) return 'fast';
    if (n < 15 && Number(output) >= 80) return 'slow';
    return '';
  }

  function fmtSpeedTitle(durationMs, estimated = false) {
    const dur = durationMs
      ? `耗时${estimated ? '约 ' : ' '}${fmtDuration(durationMs)}${estimated ? '（同秒估算）' : ''} · `
      : '';
    return `${dur}端到端输出速度（含思考与首字等待）`;
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function applyCallFilterButtons() {
    document.querySelectorAll('#calls-filter .mini-seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.filter === state.callFilter);
    });
  }

  function renderRecentCalls(data, animateNew = true) {
    const listEl = $('cur-calls-list');
    const metaEl = $('cur-calls-meta');
    const filterEl = $('calls-filter');
    if (!listEl || !metaEl || !filterEl) return;

    if (!Array.isArray(data.recentCalls)) {
      filterEl.classList.add('hidden');
      metaEl.textContent = '需重载';
      listEl.innerHTML = '<div class="empty-inline">后端进程为旧版本，请在插件管理中关闭再开启以生效</div>';
      return;
    }

    const allCalls = data.recentCalls;
    const hasSubCalls = (data.totals?.subagentCallCount || 0) > 0 || allCalls.some((c) => c.isSubagent);
    filterEl.classList.toggle('hidden', !hasSubCalls);
    if (!hasSubCalls && state.callFilter !== 'all') {
      state.callFilter = 'all';
    }
    applyCallFilterButtons();

    // 识别同一对话中新到达的请求，用于在列表顶部触发微高亮动效
    const convId = data.conversationId || '';
    const isSameConv = Boolean(convId && convId === state.seenCallConv);
    const newlyArrived = new Set();
    if (animateNew && isSameConv) {
      for (const c of allCalls) {
        if (c.id && !state.seenCallIds.has(c.id)) {
          newlyArrived.add(c.id);
        }
      }
    }
    state.seenCallConv = convId;
    state.seenCallIds = new Set(allCalls.map((c) => c.id).filter(Boolean));

    const filtered = state.callFilter === 'main' ? allCalls.filter((c) => !c.isSubagent) : allCalls;
    const totalExpected =
      state.callFilter === 'main'
        ? data.totals?.mainCallCount ?? filtered.length
        : data.totals?.callCount ?? filtered.length;

    metaEl.textContent =
      filtered.length < totalExpected ? `最近 ${filtered.length} / ${totalExpected} 次` : `${totalExpected} 次`;

    if (!filtered.length) {
      const emptyMsg =
        state.callFilter === 'main' && totalExpected > 0
          ? `最近 ${allCalls.length} 条均为子助手调用`
          : '暂无请求记录';
      listEl.innerHTML = `<div class="empty-inline">${emptyMsg}</div>`;
      return;
    }

    const { currency, cnyRate } = data;
    listEl.innerHTML = filtered
      .map((c) => {
        const isNew = newlyArrived.has(c.id);
        const modelLabel = c.modelDisplay || c.model || '';
        const deltaText = fmtDelta(c.contextDelta);
        const deltaClass = c.contextDelta !== null && c.contextDelta < 0 ? 'call-delta down' : 'call-delta';
        const tpsText = fmtTps(c.tps);
        const tone = tpsTone(c.tps, c.output);
        const tpsClass = tone ? `call-tps ${tone}` : 'call-tps';
        const hitPct = Math.round(Number(c.cacheHitRate) || 0);
        const subTitle = c.isSubagent ? `子助手 ${c.convShort || ''} · ${modelLabel}` : modelLabel;

        return `
          <div class="call-item${isNew ? ' call-new' : ''}" title="${esc(subTitle)}">
            <div class="call-row-top">
              <div class="call-left">
                <span class="call-time">${fmtTime(c.ts)}</span>
                ${c.isSubagent ? '<span class="call-badge">子</span>' : ''}
                ${tpsText ? `<span class="${tpsClass}" title="${esc(fmtSpeedTitle(c.durationMs, c.durationEstimated))}">${tpsText}</span>` : ''}
                ${modelLabel ? `<span class="call-model">${esc(modelLabel)}</span>` : ''}
              </div>
              <div class="call-right">
                <span class="call-total">${fmtTokens(c.total)}</span>
                <span class="call-cost">${fmtMoney(c.costUsd, currency, cnyRate)}</span>
              </div>
            </div>
            <div class="call-row-sub">
              <div class="call-breakdown">
                <span class="call-part"><i class="dot seg-input"></i>In ${fmtTokens(c.input)}</span>
                <span class="call-part"><i class="dot seg-cache"></i>Cache ${fmtTokens(c.cache)}${c.cache > 0 ? ` (${hitPct}%)` : ''}</span>
                <span class="call-part"><i class="dot seg-output"></i>Out ${fmtTokens(c.output)}</span>
              </div>
              ${deltaText ? `<span class="${deltaClass}" title="${esc(fmtDeltaTitle(c.contextDelta))}">${deltaText}</span>` : ''}
            </div>
          </div>
        `;
      })
      .join('');
  }

  // ---------- Render: Current Session ----------
  function renderCurrent(data) {
    if (!data || !data.found) {
      state.lastCurrentData = null;
      $('cur-empty').classList.remove('hidden');
      $('cur-content').classList.add('hidden');
      return;
    }
    state.lastCurrentData = data;
    $('cur-empty').classList.add('hidden');
    $('cur-content').classList.remove('hidden');

    const { context, totals, currency, cnyRate } = data;
    const limit = Math.max(1, context.limit || 1_000_000);
    const cachePctOfCtx = Math.min(100, (context.cache / limit) * 100);
    const inputPctOfCtx = Math.min(100 - cachePctOfCtx, (context.input / limit) * 100);

    $('ctx-used').textContent = fmtTokens(context.used);
    $('ctx-limit').textContent = fmtLimit(limit);
    $('ctx-pct').textContent = fmtPct(context.pct);
    $('ctx-bar-cache').style.width = `${cachePctOfCtx.toFixed(2)}%`;
    $('ctx-bar-input').style.width = `${inputPctOfCtx.toFixed(2)}%`;
    $('cur-model').textContent = data.modelDisplay || data.model || '—';

    const statusEl = $('ctx-status');
    statusEl.className = 'status-pill';
    if (context.pct >= 90) {
      statusEl.classList.add('danger');
      statusEl.textContent = '接近上限 · 建议 /compact';
    } else if (context.pct >= 70) {
      statusEl.classList.add('warn');
      statusEl.textContent = '占用较高 · 注意精简';
    } else {
      statusEl.classList.add('ok');
      statusEl.textContent = '空间充足';
    }

    // 单行输出速度栏
    const sp = data.speed || {};
    const lastTpsEl = $('cur-last-tps');
    if (lastTpsEl) {
      const lastTpsText = fmtTps(sp.lastTps);
      lastTpsEl.textContent = lastTpsText || '—';
      lastTpsEl.className = 'speed-val';
      const tone = tpsTone(sp.lastTps, sp.lastOutput);
      if (tone === 'fast') lastTpsEl.classList.add('ok-text');
      else if (tone === 'slow') lastTpsEl.classList.add('warn-text');
    }
    const avgTpsEl = $('cur-avg-tps');
    if (avgTpsEl) {
      avgTpsEl.textContent = sp.avgTps ? (sp.avgTps >= 100 ? String(Math.round(sp.avgTps)) : sp.avgTps.toFixed(1)) : '—';
    }
    const lastDurEl = $('cur-last-dur');
    if (lastDurEl) {
      const durText = fmtDuration(sp.lastDurationMs);
      lastDurEl.textContent = sp.lastEstimated && durText !== '—' ? `~${durText}` : durText;
    }

    $('cur-total').textContent = fmtTokens(totals.totalTokens);
    $('cur-calls').textContent = `${totals.callCount} 次调用`;
    $('cur-cost').textContent = fmtMoney(totals.costUsd, currency, cnyRate);
    $('cur-saved').textContent = `缓存省 ${fmtMoney(totals.savedUsd, currency, cnyRate)}`;
    $('cur-hit-rate').textContent = `${totals.cacheHitRate.toFixed(1)}%`;
    $('cur-cache-abs').textContent = `${fmtTokens(totals.cache)} 命中`;
    $('cur-io').textContent = `${fmtTokens(totals.input)} / ${fmtTokens(totals.output)}`;
    $('cur-subagents').textContent = `含子助手 ${totals.subagentCount} 个`;

    const tot = Math.max(1, totals.totalTokens);
    const pCache = (totals.cache / tot) * 100;
    const pInput = (totals.input / tot) * 100;
    const pOutput = (totals.output / tot) * 100;

    $('comp-cache').style.width = `${pCache.toFixed(2)}%`;
    $('comp-input').style.width = `${pInput.toFixed(2)}%`;
    $('comp-output').style.width = `${pOutput.toFixed(2)}%`;
    $('pct-cache').textContent = `${Math.round(pCache)}%`;
    $('pct-input').textContent = `${Math.round(pInput)}%`;
    $('pct-output').textContent = `${Math.round(pOutput)}%`;

    renderRecentCalls(data, true);
  }

  // ---------- Render: Global Overview & Annual Heatmap ----------
  const pad2 = (n) => String(n).padStart(2, '0');

  function syncRangeButtons() {
    document.querySelectorAll('.range-btn').forEach((btn) => {
      const active = !state.overviewDate && btn.dataset.range === state.range;
      btn.classList.toggle('active', active);
    });
  }

  function setHeatmapReadout(dayKey, rec, currency, cnyRate) {
    const titleEl = $('hm-title');
    const readEl = $('hm-readout');
    if (!titleEl || !readEl) return;
    if (!dayKey) {
      titleEl.textContent = '每日活跃';
      readEl.textContent = '';
      return;
    }
    titleEl.textContent = dayKey;
    readEl.textContent =
      rec && rec.total > 0
        ? `${fmtTokens(rec.total)} · ${fmtMoney(rec.costUsd, currency, cnyRate)}`
        : '无调用';
  }

  function buildHalfWeeks(year, startMonth, endMonth, todayKey, daysMap) {
    const halfStart = new Date(year, startMonth, 1);
    const halfEnd = new Date(year, endMonth + 1, 0);
    const gridStart = new Date(halfStart);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());

    const weeks = [];
    const monthMarks = [];
    let lastMonth = -1;

    for (let cur = new Date(gridStart), w = 0; cur <= halfEnd; w += 1) {
      const col = [];
      for (let r = 0; r < 7; r += 1) {
        const d = new Date(cur);
        const inRange = d >= halfStart && d <= halfEnd;
        const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        const isFuture = Boolean(todayKey && key > todayKey);
        if (inRange && d.getMonth() !== lastMonth && d.getDate() <= 7) {
          monthMarks.push({ weekIdx: w, label: `${d.getMonth() + 1}月` });
          lastMonth = d.getMonth();
        }
        col.push({
          key,
          inRange,
          isFuture,
          rec: inRange && !isFuture ? daysMap[key] || null : null,
        });
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push(col);
    }
    return { weeks, monthMarks };
  }

  function renderOverviewHeatmap(data) {
    const cardEl = $('ov-heatmap-card');
    const halvesEl = $('hm-halves');
    if (!cardEl || !halvesEl) return;

    const hm = data?.heatmap;
    if (!hm || typeof hm !== 'object') {
      cardEl.classList.add('hidden');
      return;
    }
    cardEl.classList.remove('hidden');

    const { currency, cnyRate } = data;
    const year = Number(hm.year) || state.overviewYear;
    const todayKey = hm.today || '';
    const daysMap = hm.days || {};
    const years = Array.isArray(hm.years) ? hm.years : [];
    const multiYear = years.length > 1;

    // 年份选择器：单年静默展示，多年启用 ‹ YYYY ▾ ›（支持 10 年+ 不溢出）
    $('hm-year-label').textContent = String(year);
    const prevBtn = $('btn-prev-year');
    const nextBtn = $('btn-next-year');
    const yearBtn = $('btn-year-menu');
    const caretEl = $('hm-year-caret');
    const popEl = $('hm-year-popover');

    prevBtn.classList.toggle('hidden', !multiYear);
    nextBtn.classList.toggle('hidden', !multiYear);
    caretEl.classList.toggle('hidden', !multiYear);
    yearBtn.classList.toggle('static', !multiYear);
    yearBtn.setAttribute('aria-expanded', String(multiYear && state.yearMenuOpen));

    if (multiYear) {
      const yIdx = years.findIndex((y) => y.year === year);
      prevBtn.disabled = yIdx <= 0;
      nextBtn.disabled = yIdx < 0 || yIdx >= years.length - 1;
    } else {
      state.yearMenuOpen = false;
    }

    popEl.classList.toggle('hidden', !(multiYear && state.yearMenuOpen));
    if (multiYear && state.yearMenuOpen) {
      popEl.innerHTML = [...years]
        .reverse()
        .map((y) => {
          const active = y.year === year;
          const summaryText =
            y.total > 0 ? `${fmtTokens(y.total)} · ${fmtMoney(y.costUsd, currency, cnyRate)}` : '无记录';
          return `
            <button type="button" class="hm-year-opt${active ? ' active' : ''}" data-pick-year="${y.year}" role="option" aria-selected="${active}">
              <span>${y.year}</span>
              <span>${summaryText}</span>
            </button>
          `;
        })
        .join('');
      popEl.querySelectorAll('.hm-year-opt').forEach((opt) => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const picked = Number(opt.dataset.pickYear);
          state.yearMenuOpen = false;
          if (picked && picked !== state.overviewYear) {
            state.overviewYear = picked;
            state.overviewDate = null;
            state.overviewEtag = '';
            syncRangeButtons();
            pollOverview(true).catch(() => {});
          } else {
            renderOverviewHeatmap(data);
          }
        });
      });
    }

    // 分位数色阶（使不同量级用户都能看到清晰层次）
    const activeTotals = Object.values(daysMap)
      .map((d) => Number(d?.total) || 0)
      .filter((t) => t > 0)
      .sort((a, b) => a - b);
    const q = (p) =>
      activeTotals.length ? activeTotals[Math.min(activeTotals.length - 1, Math.floor(activeTotals.length * p))] : 1;
    const t1 = q(0.25);
    const t2 = q(0.55);
    const t3 = q(0.82);

    const levelOf = (tot) => {
      if (tot <= 0) return 0;
      if (tot <= t1) return 1;
      if (tot <= t2) return 2;
      if (tot <= t3) return 3;
      return 4;
    };

    const h1 = buildHalfWeeks(year, 0, 5, todayKey, daysMap);
    const h2 = buildHalfWeeks(year, 6, 11, todayKey, daysMap);
    const cols = Math.max(h1.weeks.length, h2.weeks.length);

    const renderHalf = ({ weeks, monthMarks }) => {
      const padded = [...weeks];
      while (padded.length < cols) {
        padded.push(Array.from({ length: 7 }, () => ({ inRange: false, isFuture: false, rec: null })));
      }
      const monthsHtml = monthMarks
        .map((m) => `<span style="left:${((m.weekIdx / cols) * 100).toFixed(2)}%">${m.label}</span>`)
        .join('');
      const colsHtml = padded
        .map(
          (col) => `
            <div class="hm-week-col">
              ${col
                .map((cell) => {
                  if (!cell.inRange) return '<span class="hm-cell empty-pad"></span>';
                  if (cell.isFuture) return `<span class="hm-cell future-day" title="${esc(cell.key)}"></span>`;
                  const tot = Number(cell.rec?.total) || 0;
                  const lv = levelOf(tot);
                  const isSel = state.overviewDate === cell.key;
                  const isDim = Boolean(state.overviewDate && !isSel);
                  return `<button type="button" data-day="${cell.key}" class="hm-cell hm-${lv}${isSel ? ' selected' : ''}${isDim ? ' dimmed' : ''}" aria-label="${esc(cell.key)}"></button>`;
                })
                .join('')}
            </div>
          `,
        )
        .join('');
      return `
        <div>
          <div class="hm-half-months">${monthsHtml}</div>
          <div class="hm-half-grid" style="grid-template-columns:repeat(${cols}, minmax(0, 1fr))">${colsHtml}</div>
        </div>
      `;
    };

    halvesEl.innerHTML = renderHalf(h1) + renderHalf(h2);

    halvesEl.querySelectorAll('.hm-cell[data-day]').forEach((btn) => {
      const dayKey = btn.dataset.day;
      const rec = daysMap[dayKey] || null;
      btn.addEventListener('mouseenter', () => setHeatmapReadout(dayKey, rec, currency, cnyRate));
      btn.addEventListener('mouseleave', () => {
        const curKey = state.overviewDate;
        setHeatmapReadout(curKey, curKey ? daysMap[curKey] || null : null, currency, cnyRate);
      });
      btn.addEventListener('click', () => {
        state.overviewDate = state.overviewDate === dayKey ? null : dayKey;
        state.yearMenuOpen = false;
        state.overviewEtag = '';
        syncRangeButtons();
        pollOverview(true).catch(() => {});
      });
    });

    $('hm-summary').textContent = `${year} 年活跃 ${hm.activeDays || 0} 天`;
    const activeKey = state.overviewDate;
    setHeatmapReadout(activeKey, activeKey ? daysMap[activeKey] || null : null, currency, cnyRate);
  }

  function renderOverview(data) {
    if (!data) return;
    state.lastOverviewData = data;
    const { totals, models, currency, cnyRate } = data;
    const activeDate = data.date || null;

    syncRangeButtons();
    $('ov-total-label').textContent = activeDate ? `${activeDate} 消耗` : '总消耗 Token';
    $('ov-cost-label').textContent = activeDate ? '当日估算费用' : '总估算费用';
    $('btn-clear-day').classList.toggle('hidden', !activeDate);
    $('ov-models-title').textContent = activeDate ? `${activeDate} · 分模型消耗` : '分模型消耗';
    $('ov-calls-scope').textContent = activeDate || '跨会话';

    $('ov-total').textContent = fmtTokens(totals.totalTokens);
    $('ov-sessions').textContent = `${totals.sessionCount} 个对话 · ${totals.callCount} 次调用`;
    $('ov-cost').textContent = fmtMoney(totals.costUsd, currency, cnyRate);
    $('ov-hit-rate').textContent = `平均缓存率 ${totals.avgCacheHitRate.toFixed(1)}%`;
    $('ov-saved').textContent = `缓存共省 ${fmtMoney(totals.savedUsd, currency, cnyRate)}`;

    renderOverviewHeatmap(data);

    const container = $('ov-models');
    if (!models || !models.length) {
      container.innerHTML = `<div class="empty-inline">${activeDate ? '该日期暂无调用记录' : '该时间段暂无调用记录'}</div>`;
    } else {
      container.innerHTML = models
        .map((m, idx) => {
          const color = MODEL_COLORS[idx % MODEL_COLORS.length];
          const width = Math.max(2, Math.min(100, m.pct));
          const mTps = fmtTps(m.avgTps, true);
          const mTone = tpsTone(m.avgTps, 100);
          const mTpsClass = mTone ? `model-tps ${mTone}` : 'model-tps';
          return `
            <div class="model-item">
              <div class="model-head">
                <div class="model-title-wrap">
                  <span class="model-name" title="${esc(m.model)}">${esc(m.display)}</span>
                  ${mTps ? `<span class="${mTpsClass}" title="周期内加权平均输出速度（含思考与首字等待）">${mTps}</span>` : ''}
                </div>
                <span class="model-nums">${fmtTokens(m.total)} · ${fmtMoney(m.costUsd, currency, cnyRate)} (${Math.round(m.pct)}%)</span>
              </div>
              <div class="model-bar-track">
                <div class="model-bar-fill" style="width:${width.toFixed(1)}%; background:${color}"></div>
              </div>
            </div>
          `;
        })
        .join('');
    }

    renderOverviewCalls(data);
  }

  function renderOverviewCalls(data) {
    const listEl = $('ov-calls-list');
    const metaEl = $('ov-calls-meta');
    if (!listEl || !metaEl) return;

    if (!Array.isArray(data.recentCalls)) {
      metaEl.textContent = '需重载';
      listEl.innerHTML = '<div class="empty-inline">后端进程为旧版本，请在插件管理中关闭再开启以生效</div>';
      return;
    }

    const calls = data.recentCalls;
    const totalExpected = data.totals?.callCount ?? calls.length;
    metaEl.textContent =
      calls.length < totalExpected ? `最近 ${calls.length} / ${totalExpected} 次` : `${totalExpected} 次`;

    const rangeKey = `${data.range || state.range}|${data.date || ''}`;
    const sameRange = rangeKey === state.seenOverviewRange;
    const newlyArrived = new Set();
    if (sameRange) {
      for (const c of calls) {
        if (c.id && !state.seenOverviewCallIds.has(c.id)) {
          newlyArrived.add(c.id);
        }
      }
    }
    state.seenOverviewRange = rangeKey;
    state.seenOverviewCallIds = new Set(calls.map((c) => c.id).filter(Boolean));

    if (!calls.length) {
      listEl.innerHTML = '<div class="empty-inline">该时间段暂无调用记录</div>';
      return;
    }

    const { currency, cnyRate } = data;
    const activeConv = (currentConvId() || '').toLowerCase();
    listEl.innerHTML = calls
      .map((c) => {
        const isNew = newlyArrived.has(c.id);
        const isCur = Boolean(activeConv && c.convId && c.convId.toLowerCase() === activeConv);
        const deltaText = fmtDelta(c.contextDelta);
        const deltaClass = c.contextDelta !== null && c.contextDelta < 0 ? 'call-delta down' : 'call-delta';
        const tpsText = fmtTps(c.tps);
        const tone = tpsTone(c.tps, c.output);
        const tpsClass = tone ? `call-tps ${tone}` : 'call-tps';
        const hitPct = Math.round(Number(c.cacheHitRate) || 0);
        const title = `${c.modelDisplay || c.model} · 会话 ${c.convShort || ''}`;

        return `
          <div class="call-item${isNew ? ' call-new' : ''}" title="${esc(title)}">
            <div class="call-row-top">
              <div class="call-left">
                <span class="call-time">${fmtTime(c.ts, true)}</span>
                ${isCur ? '<span class="call-badge cur">当前</span>' : ''}
                ${tpsText ? `<span class="${tpsClass}" title="${esc(fmtSpeedTitle(c.durationMs, c.durationEstimated))}">${tpsText}</span>` : ''}
                <span class="call-model">${esc(c.modelDisplay || c.model)}</span>
              </div>
              <div class="call-right">
                <span class="call-total">${fmtTokens(c.total)}</span>
                <span class="call-cost">${fmtMoney(c.costUsd, currency, cnyRate)}</span>
              </div>
            </div>
            <div class="call-row-sub">
              <div class="call-breakdown">
                <span class="call-part"><i class="dot seg-input"></i>In ${fmtTokens(c.input)}</span>
                <span class="call-part"><i class="dot seg-cache"></i>Cache ${fmtTokens(c.cache)}${c.cache > 0 ? ` (${hitPct}%)` : ''}</span>
                <span class="call-part"><i class="dot seg-output"></i>Out ${fmtTokens(c.output)}</span>
              </div>
              ${deltaText ? `<span class="${deltaClass}" title="${esc(fmtDeltaTitle(c.contextDelta))}">${deltaText}</span>` : ''}
            </div>
          </div>
        `;
      })
      .join('');
  }

  // ---------- Polling ----------
  async function pollCurrent(force = false) {
    const conv = currentConvId();
    if (conv !== state.lastConv) {
      state.lastConv = conv;
      state.etag = '';
      state.callFilter = 'all';
      force = true;
    }
    if (!force && state.pollingCurrent) return;

    const reqSeq = ++state.currentReqSeq;
    state.pollingCurrent = true;
    try {
      const qs = new URLSearchParams();
      if (conv) qs.set('conversationId', conv);
      if (!force && state.etag) qs.set('etag', state.etag);

      const data = await apiFetch(`/api/current?${qs.toString()}`);
      if (reqSeq !== state.currentReqSeq || conv !== currentConvId()) return;
      $('live-dot').classList.remove('stale');
      if (maybeAutoReload(data)) return;
      if (data.unchanged) return;
      state.etag = data.etag || '';
      renderCurrent(data);
    } finally {
      if (reqSeq === state.currentReqSeq) state.pollingCurrent = false;
    }
  }

  async function pollOverview(force = false) {
    const now = Date.now();
    if (!force && (state.pollingOverview || now - state.lastOverviewPollAt < OVERVIEW_POLL_MS)) return;

    const targetRange = state.range;
    const targetYear = state.overviewYear;
    const targetDate = state.overviewDate;
    const reqSeq = ++state.overviewReqSeq;
    state.pollingOverview = true;
    state.lastOverviewPollAt = now;
    try {
      const qs = new URLSearchParams({ range: targetRange, year: String(targetYear) });
      if (targetDate) qs.set('date', targetDate);
      if (!force && state.overviewEtag) qs.set('etag', state.overviewEtag);

      const data = await apiFetch(`/api/overview?${qs.toString()}`);
      if (
        reqSeq !== state.overviewReqSeq ||
        targetRange !== state.range ||
        targetYear !== state.overviewYear ||
        targetDate !== state.overviewDate
      ) {
        return;
      }
      $('live-dot').classList.remove('stale');
      if (maybeAutoReload(data)) return;
      if (data.unchanged) return;
      state.overviewEtag = data.etag || '';
      renderOverview(data);
    } finally {
      if (reqSeq === state.overviewReqSeq) state.pollingOverview = false;
    }
  }

  async function tick(force = false) {
    if (!force && document.hidden) return;
    try {
      if (state.tab === 'current') {
        await pollCurrent(force);
      } else {
        await pollOverview(force);
      }
    } catch {
      $('live-dot').classList.add('stale');
    }
  }

  // ---------- Tab & Range Controls ----------
  function switchTab(tab) {
    state.tab = tab;
    $('tab-current').classList.toggle('active', tab === 'current');
    $('tab-current').setAttribute('aria-selected', String(tab === 'current'));
    $('tab-overview').classList.toggle('active', tab === 'overview');
    $('tab-overview').setAttribute('aria-selected', String(tab === 'overview'));
    $('view-current').classList.toggle('active', tab === 'current');
    $('view-overview').classList.toggle('active', tab === 'overview');
    tick(true);
  }

  $('tab-current').addEventListener('click', () => switchTab('current'));
  $('tab-overview').addEventListener('click', () => switchTab('overview'));

  document.querySelectorAll('#calls-filter .mini-seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.filter === 'main' ? 'main' : 'all';
      if (next === state.callFilter) return;
      state.callFilter = next;
      if (state.lastCurrentData) {
        renderRecentCalls(state.lastCurrentData, false);
      } else {
        applyCallFilterButtons();
      }
    });
  });

  document.querySelectorAll('.range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.range = btn.dataset.range || 'today';
      state.overviewDate = null;
      state.yearMenuOpen = false;
      state.overviewEtag = '';
      syncRangeButtons();
      pollOverview(true).catch(() => {});
    });
  });

  $('btn-clear-day')?.addEventListener('click', () => {
    if (!state.overviewDate) return;
    state.overviewDate = null;
    state.overviewEtag = '';
    syncRangeButtons();
    pollOverview(true).catch(() => {});
  });

  $('btn-prev-year')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const years = state.lastOverviewData?.heatmap?.years || [];
    const idx = years.findIndex((y) => y.year === state.overviewYear);
    if (idx > 0) {
      state.overviewYear = years[idx - 1].year;
      state.overviewDate = null;
      state.yearMenuOpen = false;
      state.overviewEtag = '';
      syncRangeButtons();
      pollOverview(true).catch(() => {});
    }
  });

  $('btn-next-year')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const years = state.lastOverviewData?.heatmap?.years || [];
    const idx = years.findIndex((y) => y.year === state.overviewYear);
    if (idx >= 0 && idx < years.length - 1) {
      state.overviewYear = years[idx + 1].year;
      state.overviewDate = null;
      state.yearMenuOpen = false;
      state.overviewEtag = '';
      syncRangeButtons();
      pollOverview(true).catch(() => {});
    }
  });

  $('btn-year-menu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const years = state.lastOverviewData?.heatmap?.years || [];
    if (years.length <= 1) return;
    state.yearMenuOpen = !state.yearMenuOpen;
    if (state.lastOverviewData) renderOverviewHeatmap(state.lastOverviewData);
  });

  document.addEventListener('click', () => {
    if (state.yearMenuOpen) {
      state.yearMenuOpen = false;
      if (state.lastOverviewData) renderOverviewHeatmap(state.lastOverviewData);
    }
  });

  // ---------- Settings Drawer ----------
  function renderPricingCard(m) {
    const limitK = Math.round((Number(m.contextLimit) || 1_000_000) / 1000);
    return `
      <div class="pricing-card" data-model-id="${esc(m.id)}">
        <div class="pricing-card-head">
          <span class="pricing-model-name">${esc(m.display)}</span>
          ${m.usedLocally ? '<span class="badge-local">本机已用</span>' : ''}
        </div>
        <div class="pricing-inputs">
          <div class="field">
            <label>上限 (K)</label>
            <input type="number" step="10" min="8" class="num-input" data-field="contextLimitK" value="${limitK}">
          </div>
          <div class="field">
            <label>输入 $/1M</label>
            <input type="number" step="0.01" min="0" class="num-input" data-field="input" value="${m.input}">
          </div>
          <div class="field">
            <label>缓存 $/1M</label>
            <input type="number" step="0.005" min="0" class="num-input" data-field="cache" value="${m.cache}">
          </div>
          <div class="field">
            <label>输出 $/1M</label>
            <input type="number" step="0.05" min="0" class="num-input" data-field="output" value="${m.output}">
          </div>
        </div>
      </div>
    `;
  }

  function applyCurrencyButtons(cur) {
    state.currencyDraft = cur === 'CNY' ? 'CNY' : 'USD';
    $('cur-usd').classList.toggle('active', state.currencyDraft === 'USD');
    $('cur-cny').classList.toggle('active', state.currencyDraft === 'CNY');
  }

  function renderPricingDrawer(cfg) {
    state.pricingDraft = cfg;
    applyCurrencyButtons(cfg.currency);
    $('rate-input').value = cfg.cnyRate ?? 7.25;

    const used = cfg.modelList.filter((m) => m.usedLocally);
    const others = cfg.modelList.filter((m) => !m.usedLocally);

    const primaryList = used.length ? used : cfg.modelList.slice(0, 4);
    const secondaryList = used.length ? others : cfg.modelList.slice(4);

    $('pricing-models').innerHTML = primaryList.map(renderPricingCard).join('');
    $('pricing-models-other').innerHTML = secondaryList.map(renderPricingCard).join('');
    $('other-models-wrap').classList.toggle('hidden', secondaryList.length === 0);
  }

  async function openSettings() {
    $('settings-backdrop').classList.remove('hidden');
    $('save-toast').classList.add('hidden');
    try {
      const cfg = await apiFetch('/api/pricing');
      renderPricingDrawer(cfg);
    } catch {
      // ignore transient error
    }
  }

  function closeSettings() {
    $('settings-backdrop').classList.add('hidden');
    if (pendingAssetReload) {
      pendingAssetReload = false;
      triggerAssetReload();
    }
  }

  function showToast(msg, isError = false) {
    const toast = $('save-toast');
    if (!toast) return;
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    toast.textContent = msg;
    toast.classList.toggle('warn-text', isError);
    toast.classList.remove('hidden');
    state.toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
      toast.classList.remove('warn-text');
      state.toastTimer = null;
    }, 1800);
  }

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('settings-backdrop').addEventListener('click', (e) => {
    if (e.target === $('settings-backdrop')) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.yearMenuOpen) {
      state.yearMenuOpen = false;
      if (state.lastOverviewData) renderOverviewHeatmap(state.lastOverviewData);
    }
    if (!$('settings-backdrop').classList.contains('hidden')) {
      closeSettings();
    }
  });

  $('cur-usd').addEventListener('click', () => applyCurrencyButtons('USD'));
  $('cur-cny').addEventListener('click', () => applyCurrencyButtons('CNY'));

  $('btn-save-pricing').addEventListener('click', async () => {
    const models = {};
    document.querySelectorAll('.pricing-card[data-model-id]').forEach((card) => {
      const id = card.dataset.modelId;
      const getVal = (field) => {
        const raw = card.querySelector(`[data-field="${field}"]`)?.value?.trim() ?? '';
        if (raw === '') return undefined;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
      };
      const limitK = getVal('contextLimitK');
      models[id] = {
        contextLimit: limitK !== undefined && limitK >= 1 ? Math.round(limitK * 1000) : undefined,
        input: getVal('input'),
        cache: getVal('cache'),
        output: getVal('output'),
      };
    });

    const rawRate = $('rate-input').value.trim();
    const rateVal = rawRate === '' ? undefined : Number(rawRate);
    const payload = {
      currency: state.currencyDraft,
      cnyRate: Number.isFinite(rateVal) && rateVal > 0 ? rateVal : undefined,
      models,
    };

    try {
      const updated = await apiFetch('/api/pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      renderPricingDrawer(updated);
      state.etag = '';
      state.overviewEtag = '';
      showToast('已保存');
      tick(true);
    } catch {
      showToast('保存失败', true);
    }
  });

  $('btn-reset-pricing').addEventListener('click', async () => {
    try {
      const updated = await apiFetch('/api/pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      });
      renderPricingDrawer(updated);
      state.etag = '';
      state.overviewEtag = '';
      showToast('已恢复默认');
      tick(true);
    } catch {
      showToast('恢复失败', true);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick(true);
  });

  // Initial load + live polling
  tick(true);
  setInterval(() => tick(false), CURRENT_POLL_MS);
})();
