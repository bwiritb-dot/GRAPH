/**
 * Telegram notification settings.
 *
 * Outbound only — this dashboard sends alerts, it never reads Telegram.
 *
 * The bot token is write-only from the browser's side: the server returns
 * just a masked tail and a "set / not set" flag, so the token cannot be read
 * back out of a page that anyone on the LAN can open (the backend binds to
 * 0.0.0.0). Leaving the token field blank on save keeps the stored one.
 */
'use strict';

window.TelegramUI = (function () {
  const API = ((window.location.protocol === 'file:')
    ? 'http://127.0.0.1:5050' : window.location.origin) + '/api/telegram';

  let cfg = null;
  let modal = null;

  const $ = id => document.getElementById(id);

  function buildModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'tg-backdrop';
    modal.innerHTML = `
      <div class="tg-modal" role="dialog" aria-label="Telegram notifications">
        <div class="tg-head">
          <span>📨 TELEGRAM · УВЕДОМЛЕНИЯ</span>
          <button class="tg-x" id="tg-close">✕</button>
        </div>
        <div class="tg-body">
          <div class="tg-banner" id="tg-banner"></div>
          <label class="tg-row tg-toggle">
            <input type="checkbox" id="tg-enabled">
            <span>Уведомления включены</span>
          </label>

          <div class="tg-sep">Подключение</div>

          <label class="tg-row">
            <span class="tg-label">Bot token</span>
            <input type="password" id="tg-token" placeholder="от @BotFather" autocomplete="off">
          </label>
          <div class="tg-hint" id="tg-token-hint"></div>

          <label class="tg-row">
            <span class="tg-label">Chat ID</span>
            <input type="text" id="tg-chat" placeholder="напиши боту /start и нажми ↓">
          </label>
          <div class="tg-row tg-btns">
            <button class="btn-sm" id="tg-detect">↓ Определить chat_id</button>
            <button class="btn-sm" id="tg-test">Тест-сообщение</button>
          </div>
          <div class="tg-hint" id="tg-detect-out"></div>

          <div class="tg-sep">Что присылать</div>

          <label class="tg-row tg-toggle">
            <input type="checkbox" id="tg-nv"><span>Цветной бар объёма</span>
          </label>
          <div class="tg-grid">
            <label><span>Объём ≥ ×MA</span>
              <input type="number" id="tg-mult" step="0.1" min="1" max="10"></label>
            <label><span>Доля агрессии</span>
              <input type="number" id="tg-ratio" step="0.05" min="0.5" max="0.99"></label>
          </div>

          <label class="tg-row tg-toggle">
            <input type="checkbox" id="tg-nm"><span>Скоро макро-событие</span>
          </label>
          <div class="tg-grid">
            <label><span>За сколько минут</span>
              <input type="number" id="tg-lead" step="1" min="1" max="240"></label>
          </div>

          <div class="tg-status" id="tg-status"></div>
        </div>
        <div class="tg-foot">
          <span class="tg-hint" id="tg-saved"></span>
          <button class="btn-sm tg-save" id="tg-save">Сохранить</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    $('tg-close').onclick = close;
    $('tg-save').onclick = save;
    $('tg-detect').onclick = detect;
    $('tg-test').onclick = test;
    return modal;
  }

  function fill() {
    if (!cfg) return;
    $('tg-enabled').checked = !!cfg.enabled;
    $('tg-chat').value = cfg.chat_id || '';
    $('tg-nv').checked = !!cfg.notify_volume;
    $('tg-nm').checked = !!cfg.notify_macro;
    $('tg-mult').value = cfg.vol_multiple;
    $('tg-ratio').value = cfg.vol_buy_ratio;
    $('tg-lead').value = cfg.macro_lead_minutes;
    $('tg-token').value = '';
    $('tg-token-hint').textContent = cfg.token_set
      ? `сохранён ${cfg.token_hint}${cfg.bot_id ? ` · bot id ${cfg.bot_id}` : ''} — оставь поле пустым, чтобы не менять`
      : 'не задан';

    const s = cfg.status || {};
    const bits = [];
    if (s.lastSent) bits.push(`последняя отправка ${new Date(s.lastSent * 1000).toLocaleTimeString()}`);
    if (s.lastError) bits.push(`ошибка: ${s.lastError}`);
    $('tg-status').textContent = bits.join(' · ');
    $('tg-status').style.color = s.lastError ? 'var(--red)' : 'var(--text-dim)';

    // The single fact that matters, stated where it cannot be missed: a
    // working test button with alerts off looks identical to a working setup.
    const b = $('tg-banner');
    if (!cfg.token_set) {
      b.className = 'tg-banner warn';
      b.textContent = '⚠️ Токен не задан — ничего не отправляется';
    } else if (!cfg.chat_id) {
      b.className = 'tg-banner warn';
      b.textContent = '⚠️ Chat ID не задан — напиши боту /start и нажми «Определить»';
    } else if (!cfg.enabled) {
      b.className = 'tg-banner off';
      b.textContent = '⛔ ВЫКЛЮЧЕНО — сигналы не отправляются. Кнопка «Тест» работает в обход этого флага.';
    } else {
      b.className = 'tg-banner on';
      b.textContent = '✅ Включено — сигналы отправляются в чат ' + cfg.chat_id;
    }
    paintDot();
  }

  function paintDot() {
    const dot = $('tg-dot');
    if (!dot || !cfg) return;
    const live = cfg.enabled && cfg.token_set && cfg.chat_id;
    dot.style.background = live ? 'var(--green)'
      : cfg.token_set ? 'var(--btc-orange)' : 'var(--text-dim)';
  }

  async function load() {
    try {
      const r = await fetch(`${API}/config`);
      cfg = await r.json();
      fill();
    } catch (_) {}
  }

  function collect() {
    const p = {
      enabled: $('tg-enabled').checked,
      chat_id: $('tg-chat').value.trim(),
      notify_volume: $('tg-nv').checked,
      notify_macro: $('tg-nm').checked,
      vol_multiple: parseFloat($('tg-mult').value),
      vol_buy_ratio: parseFloat($('tg-ratio').value),
      macro_lead_minutes: parseInt($('tg-lead').value, 10),
    };
    const tok = $('tg-token').value.trim();
    if (tok) p.token = tok;      // blank means "keep what's stored"
    return p;
  }

  async function save() {
    const out = $('tg-saved');
    out.textContent = 'сохраняем…';
    try {
      const r = await fetch(`${API}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collect()),
      });
      cfg = await r.json();
      fill();
      out.textContent = 'сохранено';
      out.style.color = 'var(--green)';
      // Keep the on-chart colouring in step with the alert thresholds.
      if (window.VOL_RULE) {
        window.VOL_RULE.multiple = cfg.vol_multiple;
        window.VOL_RULE.buyRatio = cfg.vol_buy_ratio;
        window.dashboard?.refreshAll?.();
      }
    } catch (e) {
      out.textContent = `ошибка: ${e.message}`;
      out.style.color = 'var(--red)';
    }
    setTimeout(() => { out.textContent = ''; }, 4000);
  }

  async function detect() {
    const out = $('tg-detect-out');
    out.textContent = 'читаем getUpdates…';
    try {
      // Save the token first, otherwise the server has nothing to call with.
      const tok = $('tg-token').value.trim();
      if (tok) {
        await fetch(`${API}/config`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: tok }),
        });
      }
      const r = await fetch(`${API}/detect-chat`, { method: 'POST' });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      if (!d.chats || !d.chats.length) {
        out.textContent = 'ничего не найдено — напиши боту /start в Telegram и нажми снова';
        out.style.color = 'var(--btc-orange)';
        return;
      }
      $('tg-chat').value = d.chats[0].id;
      out.innerHTML = d.chats.map(c =>
        `${c.id} · ${c.type}${c.name ? ' · ' + c.name : ''}`).join('<br>');
      out.style.color = 'var(--green)';
    } catch (e) {
      out.textContent = `ошибка: ${e.message}`;
      out.style.color = 'var(--red)';
    }
  }

  async function test() {
    const out = $('tg-detect-out');
    out.textContent = 'отправляем…';
    try {
      await fetch(`${API}/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collect()),
      });
      const r = await fetch(`${API}/test`, { method: 'POST' });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      if (d.enabled === false) {
        // The test path bypasses the notifier loop, so it succeeds even when
        // alerts are off. Saying only "delivered" here would be a lie by
        // omission — nothing else would ever arrive.
        out.innerHTML = `отправлено ботом @${d.bot}, НО уведомления ВЫКЛЮЧЕНЫ —`
                      + ` реальные сигналы не придут.<br>Поставь галочку «Уведомления включены» и сохрани.`;
        out.style.color = 'var(--btc-orange)';
      } else {
        out.textContent = `отправлено ботом @${d.bot} — проверь Telegram`;
        out.style.color = 'var(--green)';
      }
    } catch (e) {
      out.textContent = `ошибка: ${e.message}`;
      out.style.color = 'var(--red)';
    }
  }

  function open() { buildModal(); load(); modal.classList.add('show'); }
  function close() { modal && modal.classList.remove('show'); }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btn-telegram');
    if (btn) btn.onclick = open;
    buildModal();
    load();
  });

  return { open, close, reload: load };
})();
