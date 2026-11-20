(() => {
  const POLL_MS = 1800;
  const $ = (id) => document.getElementById(id);

  const state = {
    tab: 'current', // 'current' | 'overview'
    range: 'today', // 'today' | '7d' | '30d' | 'all'
    etag: '',
    lastConv: '',
    pricingDraft: null,
    currencyDraft: 'USD',
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

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Render: Current Session ----------
  function renderCurrent(data) {
    if (!data || !data.found) {
      $('cur-empty').classList.remove('hidden');
      $('cur-content').classList.add('hidden');
      return;
    }
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
  }

  // ---------- Render: Global Overview ----------
  function renderOverview(data) {
    if (!data) return;
    const { totals, models, currency, cnyRate } = data;
    $('ov-total').textContent = fmtTokens(totals.totalTokens);
    $('ov-sessions').textContent = `${totals.sessionCount} 个对话 · ${totals.callCount} 次调用`;
    $('ov-cost').textContent = fmtMoney(totals.costUsd, currency, cnyRate);
    $('ov-hit-rate').textContent = `平均缓存率 ${totals.avgCacheHitRate.toFixed(1)}%`;
    $('ov-saved').textContent = `缓存共省 ${fmtMoney(totals.savedUsd, currency, cnyRate)}`;

    const container = $('ov-models');
    if (!models || !models.length) {
      container.innerHTML = '<div class="empty-inline">该时间段暂无调用记录</div>';
      return;
    }

    container.innerHTML = models
      .map((m, idx) => {
        const color = MODEL_COLORS[idx % MODEL_COLORS.length];
        const width = Math.max(2, Math.min(100, m.pct));
        return `
          <div class="model-item">
            <div class="model-head">
              <span class="model-name" title="${esc(m.model)}">${esc(m.display)}</span>
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

  // ---------- Polling ----------
  async function pollCurrent(force = false) {
    const conv = currentConvId();
    if (conv !== state.lastConv) {
      state.lastConv = conv;
      state.etag = '';
      force = true;
    }
    const qs = new URLSearchParams();
    if (conv) qs.set('conversationId', conv);
    if (!force && state.etag) qs.set('etag', state.etag);

    const data = await apiFetch(`/api/current?${qs.toString()}`);
    $('live-dot').classList.remove('stale');
    if (data.unchanged) return;
    state.etag = data.etag || '';
    renderCurrent(data);
  }

  async function pollOverview() {
    const data = await apiFetch(`/api/overview?range=${encodeURIComponent(state.range)}`);
    $('live-dot').classList.remove('stale');
    renderOverview(data);
  }

  async function tick(force = false) {
    try {
      if (state.tab === 'current') {
        await pollCurrent(force);
      } else {
        await pollOverview();
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

  document.querySelectorAll('.range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.range = btn.dataset.range || 'today';
      document.querySelectorAll('.range-btn').forEach((b) => b.classList.toggle('active', b === btn));
      pollOverview().catch(() => {});
    });
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
  }

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-close-settings').addEventListener('click', closeSettings);
  $('settings-backdrop').addEventListener('click', (e) => {
    if (e.target === $('settings-backdrop')) closeSettings();
  });

  $('cur-usd').addEventListener('click', () => applyCurrencyButtons('USD'));
  $('cur-cny').addEventListener('click', () => applyCurrencyButtons('CNY'));

  $('btn-save-pricing').addEventListener('click', async () => {
    const models = {};
    document.querySelectorAll('.pricing-card[data-model-id]').forEach((card) => {
      const id = card.dataset.modelId;
      const getVal = (field) => Number(card.querySelector(`[data-field="${field}"]`)?.value);
      models[id] = {
        contextLimit: Math.round((getVal('contextLimitK') || 1000) * 1000),
        input: getVal('input'),
        cache: getVal('cache'),
        output: getVal('output'),
      };
    });

    const payload = {
      currency: state.currencyDraft,
      cnyRate: Number($('rate-input').value) || 7.25,
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
      $('save-toast').classList.remove('hidden');
      tick(true);
      setTimeout(() => $('save-toast').classList.add('hidden'), 1800);
    } catch {
      // ignore
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
      $('save-toast').textContent = '已恢复默认';
      $('save-toast').classList.remove('hidden');
      tick(true);
      setTimeout(() => {
        $('save-toast').classList.add('hidden');
        $('save-toast').textContent = '已保存';
      }, 1800);
    } catch {
      // ignore
    }
  });

  // Initial load + live polling
  tick(true);
  setInterval(() => tick(false), POLL_MS);
})();
