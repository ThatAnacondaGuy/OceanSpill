"""Password hashing (Argon2id), signed session tokens (JWT tied to a revocable session row),
TOTP second factor and HMAC signatures for exported evidence."""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import jwt
import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

_hasher = PasswordHasher()

MIN_PASSWORD_LENGTH = 12
MAX_FAILED_LOGINS = 5
LOCKOUT = timedelta(minutes=15)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        return _hasher.verify(stored, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def password_problem(password: str) -> str | None:
    """Why a password is too weak, or None when it is acceptable."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Use at least {MIN_PASSWORD_LENGTH} characters"
    kinds = sum(bool(any(f(c) for c in password)) for f in (str.islower, str.isupper, str.isdigit, lambda c: not c.isalnum()))
    if kinds < 3:
        return "Mix at least three of: lower case, upper case, digits, symbols"
    return None


def new_session_id() -> str:
    return secrets.token_urlsafe(32)


def issue_token(secret: str, user_id: str, session_id: str, minutes: int) -> tuple[str, datetime]:
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=minutes)
    token = jwt.encode({"sub": user_id, "sid": session_id, "iat": now, "exp": expires}, secret, algorithm="HS256")
    return token, expires


def read_token(secret: str, token: str) -> dict | None:
    try:
        return jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


def new_totp_secret() -> str:
    return pyotp.random_base32()


def totp_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name="OceanSpill")


def verify_totp(secret: str | None, code: str) -> bool:
    return bool(secret) and pyotp.TOTP(secret).verify(code.strip(), valid_window=1)


def sign_digest(secret: str, digest: str) -> str:
    """Sign a SHA-256 hex digest that was computed elsewhere."""
    return hmac.new(secret.encode(), digest.encode(), hashlib.sha256).hexdigest()


def sign(secret: str, data: bytes) -> tuple[str, str]:
    digest = hashlib.sha256(data).hexdigest()
    return digest, sign_digest(secret, digest)


def signature_matches(secret: str, digest: str, signature: str) -> bool:
    expected = hmac.new(secret.encode(), digest.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
