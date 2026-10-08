"""Facilitator lifecycle, sponsor, and crash-recovery tests with real signatures."""

import base64
import struct
import time
from dataclasses import replace
from unittest.mock import Mock

import pytest
from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import to_bytes_versioned
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction

from x402.mechanisms.svm.batch_settlement.close_authorization import sign_close_authorization
from x402.mechanisms.svm.batch_settlement.errors import BatchError
from x402.mechanisms.svm.batch_settlement.facilitator import (
    BatchDelegatedReceiverAuth,
    BatchSvmFacilitatorConfig,
    BatchSvmScheme,
)
from x402.mechanisms.svm.batch_settlement.facilitator_storage import (
    MemoryBatchPendingSettlementStore,
    MemoryPaymentChannelStorage,
    PaymentChannelRecord,
    PendingSettlement,
)
from x402.mechanisms.svm.batch_settlement.receiver_binding import encode_receiver_binding_memo
from x402.mechanisms.svm.constants import SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS
from x402.mechanisms.svm.payment_channels import (
    PAYMENT_CHANNELS_PROGRAM_ID,
    Channel,
    ChannelSplit,
    ChannelStatus,
    build_open_transaction,
    build_request_close_transaction,
    distribution_hash,
    find_ata,
    find_payment_channel_pda,
    sign_voucher,
)
from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse

PAYER, SPONSOR, RECEIVER, AUTH, MINT = [Keypair.from_seed(bytes([n]) * 32) for n in range(1, 6)]
NETWORK = SOLANA_DEVNET_CAIP2


def account_bytes(channel):
    data = bytearray(256)
    data[:4] = bytes([1, channel.version, channel.bump, channel.status])
    struct.pack_into(
        "<QQQQqqI",
        data,
        4,
        channel.salt,
        channel.deposit,
        channel.settled,
        channel.payout_watermark,
        channel.closure_started_at,
        channel.payer_withdrawn_at,
        channel.grace_period,
    )
    data[56:88] = channel.distribution_hash
    for i, key in enumerate(
        (channel.payer, channel.payee, channel.authorized_signer, channel.mint, channel.rent_payer)
    ):
        data[88 + 32 * i : 120 + 32 * i] = bytes(Pubkey.from_string(key))
    struct.pack_into("<Q", data, 248, channel.open_slot)
    return bytes(data)


class Transport:
    def __init__(self, channel_id, channel, req):
        self.channel_id, self.template, self.req = channel_id, channel, req
        self.channel = None
        self.status = {"err": None, "confirmation_status": "confirmed", "slot": 1000}
        self.sent, self.simulations, self.signed = [], [], []
        self.on_send = lambda: None
        self.height, self.hash_valid = 1, True
        self.token_state = 1
        self.evidence = None

    def get_addresses(self):
        return [str(SPONSOR.pubkey())]

    def get_latest_blockhash(self, network):
        return {
            "blockhash": str(Hash.default()),
            "last_valid_block_height": 500,
            "context_slot": 1000,
        }

    def get_slot(self, network):
        return 123

    def get_block_height(self, network):
        return self.height

    def is_blockhash_valid(self, blockhash, network, *, min_context_slot=None):
        return self.hash_valid

    def get_signature_status(self, signature, network):
        return self.status

    def confirm_transaction(self, signature, network):
        if self.status is None:
            raise RuntimeError("timeout")
        return self.status["slot"]

    def get_transaction(self, signature, network):
        return self.evidence

    def simulate_transaction(self, wire, network, *, sig_verify=True):
        self.simulations.append((wire, sig_verify))
        return 1000

    def get_account_info(self, address, network, *, min_context_slot=None):
        if address == self.channel_id:
            return (
                None
                if self.channel is None
                else {
                    "owner": PAYMENT_CHANNELS_PROGRAM_ID,
                    "data": account_bytes(self.channel),
                    "executable": False,
                    "context_slot": 1000,
                }
            )
        if address == self.req.asset:
            data = bytearray(82)
            data[45] = 1
        else:
            from x402.mechanisms.svm.payment_channels import get_payment_channels_treasury_owner

            data = bytearray(165)
            data[:32] = bytes(Pubkey.from_string(self.req.asset))
            owners = [
                str(PAYER.pubkey()),
                self.req.pay_to,
                get_payment_channels_treasury_owner(network),
            ]
            owner = next(
                o for o in owners if find_ata(o, self.req.asset, TOKEN_PROGRAM_ADDRESS) == address
            )
            data[32:64] = bytes(Pubkey.from_string(owner))
            data[108] = self.token_state
            struct.pack_into("<Q", data, 64, 1_000_000)
        return {
            "owner": TOKEN_PROGRAM_ADDRESS,
            "data": bytes(data),
            "executable": False,
            "context_slot": 1000,
        }

    def sign_transaction(self, wire, fee_payer, network):
        self.signed.append(wire)
        tx = VersionedTransaction.from_bytes(base64.b64decode(wire))
        signatures = list(tx.signatures)
        signatures[0] = SPONSOR.sign_message(to_bytes_versioned(tx.message))
        return base64.b64encode(
            bytes(VersionedTransaction.populate(tx.message, signatures))
        ).decode()

    def send_transaction(self, wire, network):
        self.sent.append(wire)
        self.on_send()
        return str(VersionedTransaction.from_bytes(base64.b64decode(wire)).signatures[0])


@pytest.fixture
def fixture():
    req = PaymentRequirements(
        scheme="batch-settlement",
        network=NETWORK,
        amount="10",
        asset=str(MINT.pubkey()),
        pay_to=str(RECEIVER.pubkey()),
        max_timeout_seconds=60,
        extra={
            "feePayer": str(SPONSOR.pubkey()),
            "receiverAuthorizer": str(AUTH.pubkey()),
            "withdrawDelay": 900,
            "tokenProgram": TOKEN_PROGRAM_ADDRESS,
            "memo": "order",
        },
    )
    cfg = {
        "payer": str(PAYER.pubkey()),
        "payerAuthorizer": str(PAYER.pubkey()),
        "receiver": req.pay_to,
        "receiverAuthorizer": str(AUTH.pubkey()),
        "token": req.asset,
        "withdrawDelay": 900,
        "salt": "7",
        "openSlot": 123,
    }
    channel_id = find_payment_channel_pda(
        payer=cfg["payer"],
        payee=req.extra["feePayer"],
        mint=req.asset,
        authorized_signer=cfg["payerAuthorizer"],
        salt=7,
        open_slot=123,
    )
    channel = Channel(
        payer=cfg["payer"],
        payee=req.extra["feePayer"],
        authorized_signer=cfg["payerAuthorizer"],
        mint=req.asset,
        rent_payer=req.extra["feePayer"],
        salt=7,
        open_slot=123,
        deposit=100,
        settled=0,
        payout_watermark=0,
        grace_period=900,
        distribution_hash=distribution_hash([ChannelSplit(req.pay_to, 10000)]),
    )
    transport = Transport(channel_id, channel, req)
    store, pending = MemoryPaymentChannelStorage(), MemoryBatchPendingSettlementStore()
    config = BatchSvmFacilitatorConfig(channel_storage=store, pending_settlement_store=pending)
    scheme = BatchSvmScheme(transport, config)
    return scheme, transport, req, cfg, channel_id, channel


def voucher(channel_id, amount=10):
    return {
        "channelId": channel_id,
        "maxClaimableAmount": str(amount),
        "expiresAt": 0,
        "signature": sign_voucher(PAYER, channel_id, amount),
    }


def payment(req, raw):
    return PaymentPayload(x402_version=2, accepted=req, payload=raw)


def deposit(req, cfg, channel_id):
    wire = build_open_transaction(
        payer=PAYER,
        fee_payer=req.extra["feePayer"],
        payee=req.extra["feePayer"],
        mint=req.asset,
        authorized_signer=cfg["payerAuthorizer"],
        token_program=TOKEN_PROGRAM_ADDRESS,
        deposit=100,
        salt=7,
        open_slot=123,
        grace_period=900,
        blockhash=str(Hash.default()),
        memo="order",
        binding_memo=encode_receiver_binding_memo(cfg["receiverAuthorizer"]),
        recipients=[ChannelSplit(req.pay_to, 10000)],
    )
    return payment(
        req,
        {
            "type": "deposit",
            "channelConfig": cfg,
            "voucher": voucher(channel_id),
            "deposit": {"amount": "100", "transaction": wire},
        },
    )


def test_deposit_verifies_readiness_before_handler_and_confirms_snapshot(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    payload = deposit(req, cfg, cid)
    result = scheme.verify(payload, req)
    assert result.is_valid, result.invalid_message
    assert result.extra == {"channelId": cid}
    assert len(rpc.simulations) == 2
    assert rpc.signed == rpc.sent == []
    rpc.on_send = lambda: setattr(rpc, "channel", channel)
    result = scheme.settle(payload, req)
    assert result.success, result.error_message
    assert result.amount == "100" and result.extra["channelState"]["balance"] == "100"
    assert scheme.channel_storage.get(NETWORK, cid).receiver_authorizer == cfg["receiverAuthorizer"]
    assert scheme.settle(payload, req) == result
    assert len(rpc.sent) == 1
    altered = req.model_copy(
        update={"extra": {**req.extra, "receiverAuthorizer": str(PAYER.pubkey())}}
    )
    changed = payload.model_copy(update={"accepted": altered})
    assert scheme.settle(changed, altered).error_reason == BatchError.RECEIVER_AUTHORIZER_MISMATCH
    assert len(rpc.sent) == 1


def test_lost_confirmation_recovers_after_restart_without_reopening(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    payload = deposit(req, cfg, cid)
    rpc.on_send = lambda: setattr(rpc, "channel", channel)
    rpc.status = None
    first = scheme.settle(payload, req)
    assert first.error_reason == "settlement_pending"
    assert first.transaction
    record = scheme.pending_store.find_pending(NETWORK, [cid])
    assert record.signature == first.transaction and record.wire_transaction == rpc.sent[0]
    rpc.status = {"err": None, "confirmation_status": "confirmed", "slot": 1000}
    restarted = BatchSvmScheme(rpc, scheme.config)
    result = restarted.settle(payload, req)
    assert result.success and result.transaction == first.transaction
    assert len(rpc.sent) == 1


@pytest.mark.parametrize("failure", ["write", "readback", "pending"])
def test_storage_failure_never_broadcasts(fixture, failure):
    scheme, rpc, req, cfg, cid, _ = fixture
    if failure == "write":
        scheme.channel_storage.record = Mock(side_effect=OSError("database offline"))
    elif failure == "readback":
        scheme.channel_storage.get = Mock(return_value=None)
    else:
        scheme.pending_store.reserve = Mock(side_effect=OSError("database offline"))
    result = scheme.settle(deposit(req, cfg, cid), req)
    assert not result.success and not rpc.sent


def test_frozen_recipient_is_rejected_before_signature(fixture):
    scheme, rpc, req, cfg, cid, _ = fixture
    rpc.token_state = 2
    result = scheme.verify(deposit(req, cfg, cid), req)
    assert not result.is_valid and result.invalid_reason == BatchError.SETTLEMENT_SIMULATION
    assert not rpc.signed and not rpc.sent


def test_claim_and_payout_use_confirmed_token_delta_and_replay(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    claim = payment(
        req,
        {
            "type": "claim",
            "claims": [{"channelId": cid, "channelConfig": cfg, "voucher": voucher(cid, 30)}],
        },
    )
    rpc.on_send = lambda: setattr(rpc, "channel", replace(channel, settled=30))
    claimed = scheme.settle(claim, req)
    assert claimed.success, claimed.error_message
    assert claimed.extra["accepts"] == [{"channelId": cid, "totalClaimed": "30"}]
    assert scheme.settle(claim, req) == claimed
    distribute = payment(
        req, {"type": "settle", "channels": [{"channelId": cid, "channelConfig": cfg}]}
    )
    recipient = find_ata(req.pay_to, req.asset, TOKEN_PROGRAM_ADDRESS)
    escrow = find_ata(cid, req.asset, TOKEN_PROGRAM_ADDRESS)

    def balance(index, amount, owner):
        return {
            "accountIndex": index,
            "mint": req.asset,
            "owner": owner,
            "uiTokenAmount": {"amount": str(amount)},
        }

    rpc.evidence = {
        "meta": {
            "err": None,
            "preTokenBalances": [balance(0, 100, req.pay_to), balance(1, 100, cid)],
            "postTokenBalances": [balance(0, 128, req.pay_to), balance(1, 70, cid)],
        },
        "transaction": {"message": {"accountKeys": [recipient, escrow]}},
        "slot": 1000,
    }
    rpc.on_send = lambda: setattr(rpc, "channel", replace(channel, settled=30, payout_watermark=30))
    paid = scheme.settle(distribute, req)
    assert paid.success, paid.error_message
    assert paid.amount == "28"  # Actual receipt, not settled delta 30.
    assert scheme.settle(distribute, req) == paid
    assert len(rpc.sent) == 2
    # New earnings with the same recent blockhash must produce different wire bytes.
    rpc.channel = replace(channel, settled=40, payout_watermark=30)
    rpc.evidence["meta"]["preTokenBalances"][0]["uiTokenAmount"]["amount"] = "128"
    rpc.evidence["meta"]["postTokenBalances"][0]["uiTokenAmount"]["amount"] = "137"
    rpc.on_send = lambda: setattr(rpc, "channel", replace(channel, settled=40, payout_watermark=40))
    scheme.config.on_distribution_confirmed = Mock(
        side_effect=OSError("accounting database offline")
    )
    pending = scheme.settle(distribute, req)
    assert pending.error_reason == "settlement_pending"
    assert len(rpc.sent) == 3 and rpc.sent[1] != rpc.sent[2]
    scheme.config.on_distribution_confirmed = Mock()
    recovered = BatchSvmScheme(rpc, scheme.config).settle(distribute, req)
    assert recovered.success and recovered.amount == "9" and len(rpc.sent) == 3
    assert scheme.config.on_distribution_confirmed.call_count == 1


def test_expiry_requires_actual_hash_invalid_and_processed_errors_remain_pending(fixture):
    scheme, rpc, req, cfg, cid, _ = fixture
    rpc.status = {"err": "temporary fork failure", "confirmation_status": "processed", "slot": 1000}
    payload = deposit(req, cfg, cid)
    result = scheme.settle(payload, req)
    assert result.error_reason == "settlement_pending"
    rpc.status, rpc.height = None, 501
    assert scheme.settle(payload, req).error_reason == "settlement_pending"
    rpc.hash_valid = False
    assert scheme.settle(payload, req).error_reason == "transaction_expired"
    assert scheme.pending_store.find_pending(NETWORK, [cid]) is None
    assert len(rpc.sent) == 1


def test_cooperative_refund_authenticates_final_watermark_and_returns_unused_escrow(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = replace(channel, settled=20, payout_watermark=10)
    scheme.channel_storage.record(
        PaymentChannelRecord(
            NETWORK,
            cid,
            req.pay_to,
            TOKEN_PROGRAM_ADDRESS,
            receiver_authorizer=cfg["receiverAuthorizer"],
        )
    )
    raw = {"type": "refund", "channelConfig": cfg, "voucher": voucher(cid, 30)}
    assert scheme.settle(payment(req, raw), req).error_reason == BatchError.CLOSE_AUTHORIZATION
    raw["closeAuthorization"] = sign_close_authorization(
        AUTH,
        network=NETWORK,
        fee_payer=req.extra["feePayer"],
        channel_id=cid,
        max_claimable_amount=30,
        valid_before=int(time.time()) + 30,
    )
    rpc.on_send = lambda: setattr(rpc, "channel", None)
    result = scheme.settle(payment(req, raw), req)
    assert result.success, result.error_message
    assert result.amount == "70" and result.extra["channelState"]["totalClaimed"] == "30"


def test_lost_receiver_binding_only_sponsors_payer_signed_request_close(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    raw = {"type": "refund", "channelConfig": cfg, "voucher": voucher(cid, 0)}
    assert (
        scheme.settle(payment(req, raw), req).error_reason
        == BatchError.RECEIVER_BINDING_UNAVAILABLE
    )
    raw["transaction"] = build_request_close_transaction(
        payer=PAYER,
        channel_id=cid,
        fee_payer=req.extra["feePayer"],
        blockhash=str(Hash.default()),
        memo="order",
    )
    rpc.on_send = lambda: setattr(
        rpc, "channel", replace(channel, status=ChannelStatus.CLOSING, closure_started_at=100)
    )
    result = scheme.settle(payment(req, raw), req)
    assert result.success, result.error_message
    assert result.amount == "" and result.extra["channelState"]["withdrawRequestedAt"] == 100


def test_lost_delegated_identity_retains_payer_signed_escape_hatch(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    scheme.config.delegated_receiver_auth = BatchDelegatedReceiverAuth(
        cfg["receiverAuthorizer"], lambda ctx: None
    )
    scheme.channel_storage.record(
        PaymentChannelRecord(
            NETWORK,
            cid,
            req.pay_to,
            TOKEN_PROGRAM_ADDRESS,
            receiver_authorizer=cfg["receiverAuthorizer"],
            caller_identity="",
        )
    )
    wire = build_request_close_transaction(
        payer=PAYER,
        channel_id=cid,
        fee_payer=req.extra["feePayer"],
        blockhash=str(Hash.default()),
        memo="order",
    )
    raw = {"type": "refund", "channelConfig": cfg, "voucher": voucher(cid, 0), "transaction": wire}
    rpc.on_send = lambda: setattr(
        rpc, "channel", replace(channel, status=ChannelStatus.CLOSING, closure_started_at=100)
    )
    result = scheme.settle(payment(req, raw), req)
    assert result.success and result.amount == ""
    assert rpc.channel.status == ChannelStatus.CLOSING


def test_delegated_open_requires_authenticated_caller(fixture):
    scheme, rpc, req, cfg, cid, _ = fixture
    scheme.config.delegated_receiver_auth = BatchDelegatedReceiverAuth(
        cfg["receiverAuthorizer"], lambda ctx: None
    )
    result = scheme.settle(deposit(req, cfg, cid), req)
    assert result.error_reason == BatchError.DELEGATED_UNAUTHENTICATED
    assert not rpc.sent and not rpc.signed


def test_zero_price_voucher_still_must_advance_settled_and_immutable_terms_match(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = replace(channel, settled=10)
    req = req.model_copy(update={"amount": "0"})
    payload = payment(req, {"type": "voucher", "channelConfig": cfg, "voucher": voucher(cid, 10)})
    result = scheme.verify(payload, req)
    assert result.invalid_reason == BatchError.CUMULATIVE_AMOUNT_MISMATCH
    altered = req.model_copy(update={"max_timeout_seconds": 30})
    assert not scheme.verify(payload, altered).is_valid


def test_completed_operation_cannot_release_another_operations_reservation():
    store = MemoryBatchPendingSettlementStore()
    a = PendingSettlement("a", NETWORK, ("channel",), "sig", "wire", 500, "claim", "payer", {})
    b = replace(a, key="b")
    done = SettleResponse(success=True, network=NETWORK, transaction="sig")
    assert store.reserve(a)
    store.complete("a", done)
    assert store.reserve(b)
    store.complete("a", done)
    assert store.find_pending(NETWORK, ["channel"]).key == "b"


def test_proven_failed_claim_gets_fresh_attempt_and_can_then_recover(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    rpc.channel = channel
    claim = payment(
        req,
        {
            "type": "claim",
            "claims": [{"channelId": cid, "channelConfig": cfg, "voucher": voucher(cid, 30)}],
        },
    )
    rpc.status = {"err": "program failure", "confirmation_status": "confirmed", "slot": 1000}
    failed = scheme.settle(claim, req)
    assert failed.error_reason == "transaction_failed"
    rpc.status = None
    rpc.on_send = lambda: setattr(rpc, "channel", replace(channel, settled=30))
    retried = scheme.settle(claim, req)
    assert retried.error_reason == "settlement_pending"
    assert len(rpc.sent) == 2 and retried.transaction != failed.transaction
    rpc.status = {"err": None, "confirmation_status": "confirmed", "slot": 1000}
    final = BatchSvmScheme(rpc, scheme.config).settle(claim, req)
    assert final.success and final.transaction == retried.transaction
    assert len(rpc.sent) == 2


def test_sealed_payout_alias_is_reported_with_confirmed_signature_not_invented_amount(fixture):
    scheme, rpc, req, cfg, cid, channel = fixture
    req = req.model_copy(update={"pay_to": cfg["payer"]})
    cfg = {**cfg, "receiver": cfg["payer"]}
    rpc.req = req
    rpc.channel = replace(
        channel,
        status=ChannelStatus.SEALED,
        settled=30,
        payout_watermark=10,
        distribution_hash=distribution_hash([ChannelSplit(req.pay_to, 10000)]),
    )
    recipient = find_ata(req.pay_to, req.asset, TOKEN_PROGRAM_ADDRESS)
    escrow = find_ata(cid, req.asset, TOKEN_PROGRAM_ADDRESS)
    rpc.evidence = {
        "meta": {
            "err": None,
            "preTokenBalances": [
                {
                    "accountIndex": 0,
                    "mint": req.asset,
                    "owner": req.pay_to,
                    "uiTokenAmount": {"amount": "100"},
                }
            ],
            "postTokenBalances": [
                {
                    "accountIndex": 0,
                    "mint": req.asset,
                    "owner": req.pay_to,
                    "uiTokenAmount": {"amount": "190"},
                }
            ],
        },
        "transaction": {"message": {"accountKeys": [recipient, escrow]}},
    }
    rpc.on_send = lambda: setattr(rpc, "channel", None)
    scheme.config.on_distribution_confirmed = Mock()
    payload = payment(
        req, {"type": "settle", "channels": [{"channelId": cid, "channelConfig": cfg}]}
    )
    result = scheme.settle(payload, req)
    assert result.error_reason == BatchError.PAYOUT_ATTRIBUTION_AMBIGUOUS
    assert result.transaction and result.amount is None
    assert scheme.pending_store.find_pending(NETWORK, [cid]) is None
    assert not scheme.config.on_distribution_confirmed.called
    assert scheme.settle(payload, req) == result
