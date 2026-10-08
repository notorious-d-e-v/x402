"""Private, single-process smoke journals. These are not production adapters."""

from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
import sqlite3
from dataclasses import asdict
from pathlib import Path
from threading import RLock

from x402.mechanisms.svm.batch_settlement.errors import BatchError
from x402.mechanisms.svm.batch_settlement.types import (
    BatchOperation,
    ChannelReservation,
    ChannelState,
)
from x402.schemas import SettleResponse


class SmokeError(RuntimeError):
    """Safe, curated error suitable for the public report."""


def wire(model):
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


class Database:
    def __init__(self, directory: Path):
        os.umask(0o077)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if directory.is_symlink() or directory.stat().st_mode & 0o077:
            raise SmokeError("State directory must be private (chmod 700), without symlinks")
        self.lockfile = (directory / "run.lock").open("a+")
        try:
            fcntl.flock(self.lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SmokeError("Another process owns this state directory") from None
        self.lock = RLock()
        self.db = sqlite3.connect(directory / "state.sqlite3", check_same_thread=False)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS kv (space TEXT, key TEXT, value TEXT, PRIMARY KEY(space,key))"
        )
        self.db.commit()

    def get(self, space, key, default=None):
        with self.lock:
            row = self.db.execute(
                "SELECT value FROM kv WHERE space=? AND key=?", (space, key)
            ).fetchone()
            return json.loads(row[0]) if row else default

    def set(self, space, key, value):
        with self.lock, self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO kv VALUES (?,?,?)", (space, key, json.dumps(value))
            )

    def delete(self, space, key):
        with self.lock, self.db:
            self.db.execute("DELETE FROM kv WHERE space=? AND key=?", (space, key))

    def items(self, space):
        with self.lock:
            return [
                (key, json.loads(value))
                for key, value in self.db.execute(
                    "SELECT key,value FROM kv WHERE space=? ORDER BY rowid", (space,)
                )
            ]

    def close(self):
        self.db.close()
        self.lockfile.close()


class ClientStore:
    def __init__(self, db):
        self.db = db

    def get(self, key):
        return self.db.get("client", key)

    def set(self, key, record):
        self.db.set("client", key, record)

    def delete(self, key):
        self.db.delete("client", key)


class ChannelStore:
    def __init__(self, db):
        self.db = db

    def get(self, channel_id):
        raw = self.db.get("channels", channel_id)
        if raw is None:
            return None
        raw["reservations"] = {k: ChannelReservation(**v) for k, v in raw["reservations"].items()}
        return ChannelState(**raw)

    def list(self):
        return [self.get(key) for key, _ in self.db.items("channels")]

    def put(self, state):
        self.db.set("channels", state.channel_id, asdict(state))

    def update(self, channel_id, updater):
        with self.db.lock:
            state = updater(self.get(channel_id))
            if state.channel_id != channel_id:
                raise ValueError("Channel identity changed")
            self.put(state)
            return state


class OperationStore:
    def __init__(self, db):
        self.db = db

    def get(self, channel_id, request_id):
        raw = self.db.get("operations", channel_id + ":" + request_id)
        return BatchOperation(**raw) if raw else None

    def reserve(self, channel_id, request_id, ceiling):
        with self.db.lock:
            existing = self.get(channel_id, request_id)
            if existing:
                if existing.ceiling != ceiling:
                    raise BatchError(BatchError.OPERATION_CEILING_CHANGED)
                return False
            self.db.set(
                "operations",
                channel_id + ":" + request_id,
                asdict(BatchOperation(channel_id, request_id, ceiling)),
            )
            return True

    def complete(self, operation):
        with self.db.lock:
            existing = self.get(operation.channel_id, operation.request_id)
            if (
                not existing
                or existing.status != "reserved"
                or existing.ceiling != operation.ceiling
            ):
                raise BatchError(BatchError.CHANNEL_BUSY)
            if operation.status != "completed":
                raise ValueError("Expected a completed operation")
            self.db.set(
                "operations", operation.channel_id + ":" + operation.request_id, asdict(operation)
            )

    def release(self, channel_id, request_id):
        pass  # A failed request ID remains consumed.


class JournalFacilitator:
    def __init__(self, remote, supported, db):
        self.remote, self.supported, self.db = remote, supported, db

    def get_supported(self):
        return self.supported

    def verify(self, payload, requirements):
        return self.remote.verify(payload, requirements)

    def settle(self, payload, requirements):
        request = {"paymentPayload": wire(payload), "paymentRequirements": wire(requirements)}
        key = digest(request)
        old = self.db.get("settlements", key)
        if old:
            if "response" not in old:
                raise SmokeError(
                    "Remote settlement outcome is unknown; inspect saved payload and onchain state before recovery"
                )
            return SettleResponse.model_validate(old["response"])
        if any("response" not in value for _, value in self.db.items("settlements")):
            raise SmokeError(
                "An earlier remote settlement is unresolved; refusing another transaction"
            )
        self.db.set("settlements", key, request)
        response = self.remote.settle(payload, requirements)
        self.db.set("settlements", key, {**request, "response": wire(response)})
        return response


class ReplayJournal:
    """Buffer the real payment middleware's response before releasing it over HTTP."""

    def __init__(self, app, db):
        self.app, self.db = app, db

    def __call__(self, environ, start_response):
        operation = environ.get("HTTP_X_SMOKE_OPERATION")
        payment = environ.get("HTTP_PAYMENT_SIGNATURE")
        if not operation or not payment:
            return self.app(environ, start_response)
        fingerprint = digest([environ["REQUEST_METHOD"], environ["PATH_INFO"], payment])
        saved = self.db.get("responses", operation)
        if saved:
            if saved["fingerprint"] != fingerprint or "status" not in saved:
                start_response("409 Conflict", [("Content-Type", "application/json")])
                return [
                    b'{"error":"Saved operation is ambiguous or mismatched; manual recovery required"}'
                ]
        else:
            saved = {"fingerprint": fingerprint}
            self.db.set("responses", operation, saved)
            chunks = []

            def capture(status, headers, exc_info=None):
                saved.update(status=status, headers=headers)
                return chunks.append

            result = self.app(environ, capture)
            try:
                chunks.extend(result)
            finally:
                if hasattr(result, "close"):
                    result.close()
            saved["body"] = base64.b64encode(b"".join(chunks)).decode()
            self.db.set("responses", operation, saved)
        start_response(saved["status"], saved["headers"])
        return [base64.b64decode(saved["body"])]
