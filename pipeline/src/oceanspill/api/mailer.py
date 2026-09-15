"""Email for events that should reach someone who is not looking at the screen.

Without SMTP settings the message is written to the log instead, so nothing silently disappears.
"""
from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

from .settings import ApiSettings

log = logging.getLogger("oceanspill.api.mail")


def send(settings: ApiSettings, subject: str, body: str, to: list[str] | None = None) -> bool:
    recipients = to or settings.alert_emails
    if not recipients:
        return False
    if not settings.smtp_host:
        log.info("email not configured; would have sent %r to %s", subject, ", ".join(recipients))
        return False
    message = EmailMessage()
    message["Subject"] = f"[OceanSpill] {subject}"
    message["From"] = settings.smtp_from or settings.smtp_user
    message["To"] = ", ".join(recipients)
    message.set_content(body)
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as smtp:
            smtp.starttls()
            if settings.smtp_user:
                smtp.login(settings.smtp_user, settings.smtp_password)
            smtp.send_message(message)
        return True
    except Exception as exc:  # pragma: no cover - depends on the mail server
        log.warning("could not send %r: %s", subject, exc)
        return False
