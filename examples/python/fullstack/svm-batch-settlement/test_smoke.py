"""No live endpoints or funds: real localhost middleware and Ed25519 payloads."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from solders.hash import Hash
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from werkzeug.test import Client as WSGIClient
from werkzeug.wrappers import Response
from x402.mechanisms.svm.constants import TOKEN_PROGRAM_ADDRESS
from x402.mechanisms.svm.payment_channels import ChannelStatus
from x402.schemas import SettleResponse, SupportedKind, SupportedResponse, VerifyResponse

from persistence import Database, JournalFacilitator, ReplayJournal, SmokeError
from smoke import NETWORKS, Smoke, config_from_file, confirmed_retry, preflight, public_report

PAYER, PAYEE, SPONSOR = [Keypair.from_seed(bytes([i]) * 32) for i in range(1, 4)]


def supported(config):
    return SupportedResponse(
        kinds=[
            SupportedKind(
                x402_version=2,
                scheme="batch-settlement",
                network=config["network"],
                extra={
                    "feePayer": str(SPONSOR.pubkey()),
                    "batchPolicy": {
                        "asset": config["asset"],
                        "minInitialDeposit": "10000",
                        "maxWithdrawDelay": 86400,
                    },
                    "recentBlockhash": str(Hash.default()),
                    "recentSlot": 42,
                },
            )
        ]
    )


def config(tmp_path, mode="client", actual=100):
    key = tmp_path / "payer.json"
    key.write_text(json.dumps(list(bytes(PAYER))))
    settings = tmp_path / "config.json"
    settings.write_text(
        json.dumps(
            {
                "network": "devnet",
                "payer_key_file": str(key),
                "payee": str(PAYEE.pubkey()),
                "rpc_url": "https://rpc.invalid",
                "mode": mode,
                "actual": actual,
            }
        )
    )
    return config_from_file(settings)


def test_preflight_rejects_unsupported_network_and_deposit_below_minimum(tmp_path):
    cfg = config(tmp_path)
    advertised = supported(cfg)
    assert preflight(cfg, advertised)["batchPolicy"]["minInitialDeposit"] == "10000"
    cfg["deposit"] = 9999
    with pytest.raises(SmokeError, match="minInitialDeposit"):
        preflight(cfg, advertised)
    cfg["deposit"] = 10000
    cfg["network"] = NETWORKS["mainnet"][0]
    with pytest.raises(SmokeError, match="does not advertise"):
        preflight(cfg, advertised)


def test_mainnet_total_deposit_cap_and_withdraw_delay(tmp_path):
    cfg = config(tmp_path)
    path = tmp_path / "config.json"
    raw = json.loads(path.read_text())
    raw.update(network="mainnet", deposit=10001)
    path.write_text(json.dumps(raw))
    with pytest.raises(SmokeError, match="max_deposit"):
        config_from_file(path)
    advertised = supported(cfg)
    advertised.kinds[0].extra["batchPolicy"]["maxWithdrawDelay"] = 899
    with pytest.raises(SmokeError, match="maxWithdrawDelay"):
        preflight(cfg, advertised)


def test_confirmed_state_assertions_retry_without_repeating_payments(monkeypatch):
    read = MagicMock(side_effect=[SmokeError("stale"), "confirmed"])
    sleep = MagicMock()
    monkeypatch.setattr("smoke.time.sleep", sleep)
    assert confirmed_retry(read) == "confirmed"
    assert read.call_count == 2
    sleep.assert_called_once_with(1)


def test_http_replay_is_exact_and_unknown_execution_is_not_retried(tmp_path):
    db = Database(tmp_path)
    calls = []

    def app(environ, start_response):
        calls.append(True)
        start_response("200 OK", [("PAYMENT-RESPONSE", "receipt")])
        return [b"paid"]

    client = WSGIClient(ReplayJournal(app, db), Response)
    headers = {"PAYMENT-SIGNATURE": "proof", "X-Smoke-Operation": "one"}
    assert client.get("/paid", headers=headers).data == b"paid"
    assert client.get("/paid", headers=headers).headers["PAYMENT-RESPONSE"] == "receipt"
    assert len(calls) == 1
    assert client.get("/paid", headers={**headers, "PAYMENT-SIGNATURE": "other"}).status_code == 409
    db.set("responses", "one", {"fingerprint": db.get("responses", "one")["fingerprint"]})
    assert client.get("/paid", headers=headers).status_code == 409
    assert len(calls) == 1
    db.close()


def test_unknown_remote_settlement_blocks_all_later_submissions(tmp_path):
    db = Database(tmp_path)
    remote = MagicMock()
    db.set("settlements", "unknown", {"paymentPayload": {}})
    adapter = JournalFacilitator(remote, None, db)
    payload = MagicMock()
    payload.model_dump.return_value = {"payload": {"type": "claim"}}
    with pytest.raises(SmokeError, match="unresolved"):
        adapter.settle(payload, payload)
    remote.settle.assert_not_called()
    db.close()


class Remote:
    def __init__(self, cfg):
        self.config, self.calls = cfg, []
        self.deposit = self.settled = self.distributed = 0
        self.closed = False

    def verify(self, payload, requirements):
        credential = payload.payload.get("voucher") or payload.payload["authorization"]
        return VerifyResponse(
            is_valid=True, payer=str(PAYER.pubkey()), extra={"channelId": credential["channelId"]}
        )

    def settle(self, payment, requirements):
        raw = payment.payload
        kind = raw["type"]
        self.calls.append(kind)
        extra, amount = {}, ""
        if kind == "deposit":
            self.deposit = int(raw["deposit"]["amount"])
            credential = raw.get("voucher") or raw["authorization"]
            self.channel_id = credential["channelId"]
            amount = str(self.deposit)
            extra = {
                "channelState": {
                    "channelId": self.channel_id,
                    "balance": amount,
                    "totalClaimed": "0",
                    "withdrawRequestedAt": 0,
                }
            }
        elif kind == "claim":
            self.settled = int(raw["claims"][0]["voucher"]["maxClaimableAmount"])
            extra = {"accepts": [{"channelId": self.channel_id, "totalClaimed": str(self.settled)}]}
        elif kind == "settle":
            self.distributed = self.settled
            amount = str(self.distributed)
            extra = {"channels": [self.channel_id]}
        elif kind == "refund":
            self.closed = True
            amount = str(self.deposit - self.settled)
            extra = {
                "channelState": {
                    "channelId": self.channel_id,
                    "balance": str(self.deposit),
                    "totalClaimed": str(self.settled),
                    "withdrawRequestedAt": 0,
                }
            }
        else:
            raise AssertionError(kind)
        return SettleResponse(
            success=True,
            network=requirements.network,
            transaction="signature-" + kind,
            payer=str(PAYER.pubkey()),
            amount=amount,
            extra=extra,
        )


@pytest.mark.parametrize("mode,actual", [("client", 100), ("server", 100), ("server", 60)])
def test_full_localhost_lifecycle_and_restart_with_real_sdk(tmp_path, monkeypatch, mode, actual):
    cfg = config(tmp_path, mode, actual)
    remote = Remote(cfg)
    rpc = MagicMock()
    rpc.get_genesis_hash.return_value.value = cfg["network"].split(":")[1]
    rpc.get_account_info.return_value.value = None
    monkeypatch.setattr("smoke.Client", lambda *a, **k: rpc)
    client_rpc = MagicMock()
    client_rpc.get_account_info.return_value = SimpleNamespace(
        value=SimpleNamespace(
            owner=Pubkey.from_string(TOKEN_PROGRAM_ADDRESS), data=bytes(44) + bytes([6]) + bytes(37)
        )
    )
    monkeypatch.setattr(
        "x402.mechanisms.svm.batch_settlement.client.BatchSvmScheme._get_client",
        lambda *a: client_rpc,
    )

    def balances(self):
        return {
            "payer": 100000 - (remote.settled if remote.closed else remote.deposit),
            "payee": remote.distributed,
        }

    def channel(self):
        return self.server_scheme.store.list()[0], SimpleNamespace(
            deposit=remote.deposit,
            settled=remote.settled,
            payout_watermark=remote.distributed,
            status=ChannelStatus.DISTRIBUTED if remote.closed else ChannelStatus.OPEN,
        )

    monkeypatch.setattr(Smoke, "balances", balances)
    monkeypatch.setattr(Smoke, "channel", channel)
    monkeypatch.setattr(
        "x402.mechanisms.svm.batch_settlement.channel_manager.BatchChannelManager._read",
        lambda self, cid, field: remote.settled if field == "settled" else remote.distributed,
    )
    state_dir = tmp_path / "state"
    db = Database(state_dir)
    session = Smoke(cfg, state_dir, db, remote, supported(cfg))
    try:
        session.run("payments")
        assert remote.calls == ["deposit"]
        assert len(db.items("outbox")) == 3
        # Even an unexpected client output cannot create a second funded channel.
        from x402.schemas import PaymentPayload

        previous = PaymentPayload.model_validate(db.get("outbox", "payment-1")["payment"])
        with monkeypatch.context() as patch:
            patch.setattr(session.client, "create_payment_payload", lambda required: previous)
            with pytest.raises(SmokeError, match="second deposit"):
                session.payment("payment-4")
        assert len(db.items("outbox")) == 3
        assert remote.calls == ["deposit"]
    finally:
        session.close()
        db.close()
    # New merchant and client objects, same persisted journal; no new deposit.
    db = Database(state_dir)
    session = Smoke(cfg, state_dir, db, remote, supported(cfg))
    try:
        session.run("refund")
        report = public_report(db)
        assert report["complete"]
        assert report["assertions"]["refund_verified"]["amount"] == str(10000 - actual * 3)
        assert remote.calls == ["deposit", "claim", "settle", "refund"]
        refund_body = json.loads(db.get("outbox", "refund")["response"]["body"])
        assert refund_body["message"] == "Refund initiated"
        assert not db.items("client")
        session.run("refund")
        assert remote.calls == ["deposit", "claim", "settle", "refund"]
        assert "rpc.invalid" not in json.dumps(report)
        assert "paymentPayload" not in json.dumps(report)
    finally:
        session.close()
        db.close()
