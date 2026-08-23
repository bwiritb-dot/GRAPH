#!/usr/bin/env python3
"""
Email notifications for CryptoDATEX.
Supports standard SMTP with SSL/TLS (Gmail, Outlook, custom SMTP)
Mirrors telegram_notify.py triggers: Volume Spikes, Macro releases, and Custom Alarms.
"""

import os
import json
import time
import smtplib
import logging
import threading
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

log = logging.getLogger(__name__)

DEFAULT_CONFIG = {
    "enabled": False,
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 587,
    "use_tls": True,
    "use_ssl": False,
    "user": "",
    "password": "",
    "to": "",
    "notify_volume": True,
    "notify_macro": True,
    "notify_macro_actual": True,
    "notify_alarms": True,
}


class EmailNotifier:
    def __init__(self, config_path: str):
        self.config_path = config_path
        self._lock = threading.Lock()
        self.config = dict(DEFAULT_CONFIG)
        self.last_error = None
        self.last_sent = None
        self.load()

    def load(self):
        try:
            if os.path.exists(self.config_path):
                with open(self.config_path, encoding="utf-8") as fh:
                    saved = json.load(fh)
                merged = dict(DEFAULT_CONFIG)
                merged.update({k: v for k, v in saved.items() if k in DEFAULT_CONFIG})
                self.config = merged
        except Exception as e:
            log.warning("[email] Config load failed: %s", e)

    def save(self):
        try:
            with open(self.config_path, "w", encoding="utf-8") as fh:
                json.dump(self.config, fh, indent=2)
        except Exception as e:
            log.warning("[email] Config save failed: %s", e)

    def update(self, patch: dict) -> dict:
        with self._lock:
            for k, v in patch.items():
                if k in self.config:
                    self.config[k] = v
            self.save()
            return self.public_config()

    def public_config(self) -> dict:
        cfg = dict(self.config)
        if cfg.get("password"):
            cfg["has_password"] = True
            cfg["password"] = "••••••••"
        else:
            cfg["has_password"] = False
        return cfg

    def send_notification(self, subject: str, html_content: str, text_content: str = "") -> bool:
        if not self.config.get("enabled"):
            return False
        if not self.config.get("smtp_host") or not self.config.get("user") or not self.config.get("to"):
            log.warning("[email] Missing required SMTP parameters")
            return False

        host = self.config["smtp_host"]
        port = int(self.config.get("smtp_port", 587))
        user = self.config["user"]
        pwd = self.config["password"]
        recipient = self.config["to"]

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"CryptoDATEX <{user}>"
        msg["To"] = recipient

        if text_content:
            msg.attach(MIMEText(text_content, "plain", "utf-8"))
        if html_content:
            msg.attach(MIMEText(html_content, "html", "utf-8"))

        try:
            if self.config.get("use_ssl") or port == 465:
                server = smtplib.SMTP_SSL(host, port, timeout=10)
            else:
                server = smtplib.SMTP(host, port, timeout=10)
                if self.config.get("use_tls", True):
                    server.starttls()

            if user and pwd:
                server.login(user, pwd)

            server.sendmail(user, [recipient], msg.as_string())
            server.quit()
            self.last_sent = time.time()
            self.last_error = None
            log.info("[email] Sent email: %s to %s", subject, recipient)
            return True
        except Exception as e:
            self.last_error = str(e)
            log.warning("[email] Failed to send email: %s", e)
            raise

    def send_test(self) -> dict:
        subject = "✅ CryptoDATEX Email Notification Test"
        html = """
        <div style="font-family: Arial, sans-serif; background:#0d1117; color:#e6edf3; padding:20px; border-radius:8px;">
            <h2 style="color:#f7931a;">CryptoDATEX Notifications Active</h2>
            <p>This is a test notification confirming your email alert integration is working.</p>
            <hr style="border:0; border-top:1px solid #30363d;">
            <p style="font-size:12px; color:#8b949e;">Volume spikes, macro updates, and custom alarms will be delivered here.</p>
        </div>
        """
        ok = self.send_notification(subject, html, "CryptoDATEX Email Notifications are active.")
        return {"ok": ok, "to": self.config.get("to")}
