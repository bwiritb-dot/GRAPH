/**
 * CryptoDATEX — Alarms UI & Web Audio Sound Synthesizer
 * Built-in zero-dependency sound library for trading alerts.
 */
'use strict';

(function() {
  let audioCtx = null;

  function getAudioContext() {
    if (!audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) audioCtx = new AudioCtx();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  // ══ WEB AUDIO SOUND SYNTHESIZER PRESETS ═════════════════════════════
  const SoundLibrary = {
    // 1. Radar Ping: Soft sine pulse with exponential decay
    ping() {
      const ctx = getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.4);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    },

    // 2. Double Chime: Two ascending notes (E5 -> B5)
    chime() {
      const ctx = getAudioContext();
      if (!ctx) return;
      [659.25, 987.77].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t0 = ctx.currentTime + i * 0.14;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0.25, t0);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.4);
      });
    },

    // 3. High Alert Siren: Warbling dual oscillation
    siren() {
      const ctx = getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(1100, ctx.currentTime + 0.2);
      osc.frequency.linearRampToValueAtTime(600, ctx.currentTime + 0.4);
      osc.frequency.linearRampToValueAtTime(1100, ctx.currentTime + 0.6);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.7);
    },

    // 4. Cash Ding: Crisp high harmonic bell
    ding() {
      const ctx = getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1760, ctx.currentTime); // A6
      gain.gain.setValueAtTime(0.35, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.8);
    },

    // 5. Sub Bass Thud: Deep punch (80Hz -> 30Hz)
    bass() {
      const ctx = getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(110, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(35, ctx.currentTime + 0.35);
      gain.gain.setValueAtTime(0.5, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
    },

    // 6. Digital Pager: Fast double square beep
    pager() {
      const ctx = getAudioContext();
      if (!ctx) return;
      [1400, 1400].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t0 = ctx.currentTime + i * 0.08;
        osc.type = 'square';
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0.15, t0);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.05);
      });
    },

    // 7. Sci-Fi Sweep: Downward laser frequency sweep
    laser() {
      const ctx = getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(2200, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.3);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    },

    // 8. Urgent Pulse: Triple high pitch alert
    pulse() {
      const ctx = getAudioContext();
      if (!ctx) return;
      [1046.5, 1046.5, 1046.5].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t0 = ctx.currentTime + i * 0.12;
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0.3, t0);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.09);
      });
    }
  };

  // ══ ALARMS UI CONTROLLER ═════════════════════════════════════════════
  class AlarmsController {
    constructor() {
      this.alarms = [];
      this.modalEl = document.getElementById('modal-alarms');
      this.listEl = document.getElementById('alarms-list');
      this.formEl = document.getElementById('alarm-create-form');
      this.btnOpen = document.getElementById('btn-alarms');
      this._triggeredLocal = new Set();

      this._init();
    }

    _init() {
      if (this.btnOpen) {
        this.btnOpen.addEventListener('click', () => this.open());
      }
      this.loadAlarms();
    }

    open() {
      if (this.modalEl) {
        this.modalEl.classList.add('open');
        this.loadAlarms();
        // Prefill symbol from current active symbol
        const symInput = document.getElementById('alarm-symbol');
        if (symInput && window.ACTIVE_SYMBOL) symInput.value = window.ACTIVE_SYMBOL;
      }
    }

    close() {
      if (this.modalEl) this.modalEl.classList.remove('open');
      this.hideCreateForm();
    }

    playSound(soundName) {
      const fn = SoundLibrary[soundName] || SoundLibrary.ping;
      try { fn(); } catch(e) { console.warn('Audio play error:', e); }
    }

    previewSound() {
      const sel = document.getElementById('alarm-sound');
      const sound = sel ? sel.value : 'ping';
      this.playSound(sound);
    }

    showCreateForm() {
      if (this.formEl) this.formEl.style.display = 'block';
    }

    hideCreateForm() {
      if (this.formEl) this.formEl.style.display = 'none';
    }

    onTypeChange() {
      const type = document.getElementById('alarm-type')?.value;
      const thInput = document.getElementById('alarm-threshold');
      if (!thInput) return;
      if (type === 'rsi_ob') thInput.placeholder = 'RSI (напр. 70 или 80)';
      else if (type === 'rsi_os') thInput.placeholder = 'RSI (напр. 30 или 20)';
      else if (type === 'adx_trend') thInput.placeholder = 'ADX (напр. 30)';
      else if (type === 'vol_spike') thInput.placeholder = 'Множитель объема к MA20 (напр. 2.5)';
      else thInput.placeholder = 'Ценовой уровень (напр. 95000)';
    }

    async loadAlarms() {
      try {
        const res = await fetch('/api/alarms');
        const d = await res.json();
        this.alarms = d.alarms || [];
        this.renderList();
      } catch (e) {
        if (this.listEl) this.listEl.innerHTML = `<div style="color:var(--red); padding:10px;">Ошибка загрузки алертов</div>`;
      }
    }

    renderList() {
      if (!this.listEl) return;
      if (!this.alarms.length) {
        this.listEl.innerHTML = `<div style="font-size:11px; color:var(--text-dim); text-align:center; padding:15px;">Нет настроенных алертов. Нажмите «+ Новый алерт».</div>`;
        return;
      }

      this.listEl.innerHTML = this.alarms.map(a => {
        const typeLabels = {
          price_cross_above: 'Цена >=',
          price_cross_below: 'Цена <=',
          rsi_ob: 'RSI >=',
          rsi_os: 'RSI <=',
          adx_trend: 'ADX >=',
          vol_spike: 'Объем >=',
          hvn_touch: 'HVN Зона',
          macro_lead: 'Макро'
        };
        const typeTxt = typeLabels[a.type] || a.type;
        const thTxt = a.threshold != null ? a.threshold : '';
        const chTxt = a.channels.join(', ');
        const soundLabel = a.sound || 'ping';

        return `
          <div class="alarm-item${a.enabled ? '' : ' disabled'}">
            <div class="alarm-info">
              <div class="alarm-title">${a.symbol} · ${typeTxt} ${thTxt}</div>
              <div class="alarm-sub">Звук: ${soundLabel} | Каналы: ${chTxt} | Сработал: ${a.triggered_count} раз</div>
            </div>
            <div class="alarm-actions">
              <button class="btn-cdx-sec" style="padding:3px 7px;" onclick="window.AlarmsUI.playSound('${a.sound}')" title="Прослушать">▶</button>
              <button class="btn-cdx-sec" style="padding:3px 7px;" onclick="window.AlarmsUI.toggleAlarm('${a.id}')">${a.enabled ? 'ВКЛ' : 'ВЫКЛ'}</button>
              <button class="btn-cdx-danger" onclick="window.AlarmsUI.deleteAlarm('${a.id}')">✕</button>
            </div>
          </div>
        `;
      }).join('');
    }

    async saveAlarm() {
      const symbol = document.getElementById('alarm-symbol')?.value.trim() || 'BTCUSDT';
      const type = document.getElementById('alarm-type')?.value;
      const thresholdVal = document.getElementById('alarm-threshold')?.value;
      const threshold = thresholdVal !== '' ? parseFloat(thresholdVal) : null;
      const sound = document.getElementById('alarm-sound')?.value || 'ping';
      
      const channels = [];
      if (document.getElementById('alarm-ch-audio')?.checked) channels.push('audio');
      if (document.getElementById('alarm-ch-tg')?.checked) channels.push('telegram');
      if (document.getElementById('alarm-ch-email')?.checked) channels.push('email');

      const payload = {
        symbol,
        type,
        threshold,
        sound,
        channels,
        enabled: true
      };

      try {
        const res = await fetch('/api/alarms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          this.hideCreateForm();
          await this.loadAlarms();
        }
      } catch (e) {
        alert('Ошибка сохранения алерта');
      }
    }

    async toggleAlarm(id) {
      try {
        await fetch(`/api/alarms/${id}/toggle`, { method: 'POST' });
        await this.loadAlarms();
      } catch (e) {}
    }

    async deleteAlarm(id) {
      if (!confirm('Удалить этот алерт?')) return;
      try {
        await fetch(`/api/alarms/${id}`, { method: 'DELETE' });
        await this.loadAlarms();
      } catch (e) {}
    }

    // Evaluate tick for current active symbol (called from main.js)
    evaluateTick(symbol, currentPrice, indicators) {
      if (!this.alarms.length || !currentPrice) return;
      for (const a of this.alarms) {
        if (!a.enabled || a.symbol !== symbol) continue;
        const cooldownKey = `${a.id}_${Math.floor(Date.now() / 60000)}`; // 1 min client cooldown
        if (this._triggeredLocal.has(cooldownKey)) continue;

        let triggered = false;
        let msg = '';

        if (a.type === 'price_cross_above' && currentPrice >= a.threshold) {
          triggered = true;
          msg = `Цена поднялась выше ${a.threshold} (текущая: ${currentPrice})`;
        } else if (a.type === 'price_cross_below' && currentPrice <= a.threshold) {
          triggered = true;
          msg = `Цена опустилась ниже ${a.threshold} (текущая: ${currentPrice})`;
        } else if (indicators) {
          if (a.type === 'rsi_ob' && indicators.rsi && indicators.rsi >= a.threshold) {
            triggered = true;
            msg = `RSI достиг зоны перекупленности ${indicators.rsi.toFixed(1)} >= ${a.threshold}`;
          } else if (a.type === 'rsi_os' && indicators.rsi && indicators.rsi <= a.threshold) {
            triggered = true;
            msg = `RSI достиг зоны перепроданности ${indicators.rsi.toFixed(1)} <= ${a.threshold}`;
          } else if (a.type === 'adx_trend' && indicators.adx && indicators.adx >= a.threshold) {
            triggered = true;
            msg = `ADX зафиксировал сильный тренд ${indicators.adx.toFixed(1)} >= ${a.threshold}`;
          }
        }

        if (triggered) {
          this._triggeredLocal.add(cooldownKey);
          if (a.channels.includes('audio')) {
            this.playSound(a.sound || 'ping');
          }
          // Notify backend of trigger to dispatch Telegram / Email
          fetch(`/api/alarms/${a.id}/trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, price: currentPrice })
          }).catch(() => {});
        }
      }
    }
  }

  window.AlarmsUI = new AlarmsController();
  window.SoundLibrary = SoundLibrary;
})();
