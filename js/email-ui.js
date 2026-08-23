/**
 * CryptoDATEX — Email Settings UI Controller
 */
'use strict';

(function() {
  class EmailSettingsController {
    constructor() {
      this.modalEl = document.getElementById('modal-email');
      this.btnOpen = document.getElementById('btn-email');
      this.statusMsgEl = document.getElementById('email-status-msg');

      this._init();
    }

    _init() {
      if (this.btnOpen) {
        this.btnOpen.addEventListener('click', () => this.open());
      }
    }

    async open() {
      if (this.modalEl) {
        this.modalEl.classList.add('open');
        await this.loadConfig();
      }
    }

    close() {
      if (this.modalEl) this.modalEl.classList.remove('open');
      if (this.statusMsgEl) this.statusMsgEl.textContent = '';
    }

    async loadConfig() {
      try {
        const res = await fetch('/api/email/config');
        const cfg = await res.json();

        const g = id => document.getElementById(id);
        if (g('email-enabled')) g('email-enabled').checked = !!cfg.enabled;
        if (g('email-smtp-host')) g('email-smtp-host').value = cfg.smtp_host || '';
        if (g('email-smtp-port')) g('email-smtp-port').value = cfg.smtp_port || 587;
        if (g('email-user')) g('email-user').value = cfg.user || '';
        if (g('email-to')) g('email-to').value = cfg.to || '';
        if (g('email-notify-volume')) g('email-notify-volume').checked = cfg.notify_volume !== false;
        if (g('email-notify-macro')) g('email-notify-macro').checked = cfg.notify_macro !== false;
        if (g('email-notify-alarms')) g('email-notify-alarms').checked = cfg.notify_alarms !== false;
      } catch (e) {
        if (this.statusMsgEl) this.statusMsgEl.innerHTML = '<span style="color:var(--red)">Ошибка загрузки настроек Email</span>';
      }
    }

    async save() {
      const g = id => document.getElementById(id);
      const patch = {
        enabled: g('email-enabled')?.checked || false,
        smtp_host: g('email-smtp-host')?.value.trim() || '',
        smtp_port: parseInt(g('email-smtp-port')?.value || '587', 10),
        user: g('email-user')?.value.trim() || '',
        to: g('email-to')?.value.trim() || '',
        notify_volume: g('email-notify-volume')?.checked || false,
        notify_macro: g('email-notify-macro')?.checked || false,
        notify_alarms: g('email-notify-alarms')?.checked || false,
      };

      const pwd = g('email-password')?.value;
      if (pwd && pwd !== '••••••••') {
        patch.password = pwd;
      }

      try {
        const res = await fetch('/api/email/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch)
        });
        if (res.ok) {
          if (this.statusMsgEl) this.statusMsgEl.innerHTML = '<span style="color:var(--green)">✅ Настройки Email сохранены!</span>';
          setTimeout(() => this.close(), 1200);
        } else {
          if (this.statusMsgEl) this.statusMsgEl.innerHTML = '<span style="color:var(--red)">Ошибка сохранения</span>';
        }
      } catch (e) {
        if (this.statusMsgEl) this.statusMsgEl.innerHTML = '<span style="color:var(--red)">Ошибка запроса</span>';
      }
    }

    async sendTest() {
      if (this.statusMsgEl) this.statusMsgEl.innerHTML = '<span style="color:var(--blue)">Отправка тестового письма...</span>';
      try {
        const res = await fetch('/api/email/test', { method: 'POST' });
        const d = await res.json();
        if (d.ok) {
          if (this.statusMsgEl) this.statusMsgEl.innerHTML = `<span style="color:var(--green)">✅ Тестовое письмо успешно отправлено на ${d.to || 'email'}!</span>`;
        } else {
          if (this.statusMsgEl) this.statusMsgEl.innerHTML = `<span style="color:var(--red)">❌ Ошибка: ${d.error || 'Не удалось отправить'}</span>`;
        }
      } catch (e) {
        if (this.statusMsgEl) this.statusMsgEl.innerHTML = `<span style="color:var(--red)">❌ Ошибка: ${e.message}</span>`;
      }
    }
  }

  window.EmailUI = new EmailSettingsController();
})();
