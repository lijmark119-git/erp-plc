import hashlib
import secrets

from pwdlib import PasswordHash


password_hasher = PasswordHash.recommended()
_dummy_password_hash = password_hasher.hash(secrets.token_urlsafe(32))


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    candidate_hash = password_hash or _dummy_password_hash
    valid, _updated_hash = password_hasher.verify_and_update(password, candidate_hash)
    return valid and password_hash is not None


def create_secret_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
