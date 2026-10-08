"""Real localhost Python merchant/client against a remote SVM batch facilitator."""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from threading import Thread

import httpx
from flask import Flask, jsonify
from solana.rpc.api import Client
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from werkzeug.serving import WSGIRequestHandler, make_server
from x402 import x402ClientSync, x402ResourceServerSync
from x402.http import (
    FacilitatorConfig,
    HTTPFacilitatorClientSync,
    PaymentOption,
    RouteConfig,
    decode_payment_required_header,
    decode_payment_response_header,
    encode_payment_signature_header,
)
from x402.http.middleware.flask import payment_middleware, set_settlement_overrides
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.batch_settlement import (
    BatchServerSignedChannelsPolicy,
    BatchSvmClientConfig,
    BatchSvmClientScheme,
    BatchSvmServerConfig,
    BatchSvmServerScheme,
    ServerSignedChannelsAsset,
)
from x402.mechanisms.svm.batch_settlement.constants import MIN_WITHDRAW_DELAY
from x402.mechanisms.svm.constants import (
    SOLANA_DEVNET_CAIP2,
    SOLANA_MAINNET_CAIP2,
    TOKEN_PROGRAM_ADDRESS,
    USDC_DEVNET_ADDRESS,
    USDC_MAINNET_ADDRESS,
)
from x402.mechanisms.svm.payment_channels import (
    PAYMENT_CHANNELS_PROGRAM_ID,
    ChannelStatus,
    decode_channel_account,
    find_ata,
)
from x402.schemas import AssetAmount, PaymentPayload, PaymentRequirements
from x402.schemas.hooks import PaymentResponseContext

from persistence import (
    ChannelStore,
    ClientStore,
    Database,
    JournalFacilitator,
    OperationStore,
    ReplayJournal,
    SmokeError,
    wire,
)

NETWORKS = {
    "mainnet": (SOLANA_MAINNET_CAIP2, USDC_MAINNET_ADDRESS),
    "devnet": (SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS),
}


def require(condition, message):
    if not condition:
        raise SmokeError(message)


def confirmed_retry(check):
    """Retry only read-side assertions while confirmed RPC state catches up."""
    for attempt in range(10):
        try:
            return check()
        except SmokeError:
            if attempt == 9:
                raise
            time.sleep(1)


def config_from_file(path):
    config = json.loads(Path(path).expanduser().read_text())
    label = config.get("network", "devnet")
    require(label in NETWORKS, "network must be devnet or mainnet")
    config["network"], config["asset"] = NETWORKS[label]
    for name, default in (
        ("deposit", 10000),
        ("price", 100),
        ("requests", 3),
        ("max_deposit", 10000),
    ):
        config.setdefault(name, default)
        require(
            type(config[name]) is int and config[name] > 0,
            name + " must be a positive atomic integer",
        )
    config.setdefault("actual", config["price"])
    config.setdefault("mode", "client")
    config.setdefault("facilitator", "https://facilitator.payai.network")
    require(config["mode"] in ("client", "server"), "mode must be client or server")
    require(
        type(config["actual"]) is int and 0 < config["actual"] <= config["price"],
        "actual must be positive and at most price",
    )
    require(
        config["mode"] == "server" or config["actual"] == config["price"],
        "Client vouchers charge the advertised price",
    )
    require(
        config["price"] * config["requests"] <= config["deposit"] <= config["max_deposit"],
        "Requests must fit one deposit within max_deposit; this smoke never tops up",
    )
    return config


def preflight(config, supported):
    kinds = [
        k
        for k in supported.kinds
        if k.x402_version == 2 and k.scheme == "batch-settlement" and k.network == config["network"]
    ]
    require(
        len(kinds) == 1,
        "Facilitator does not advertise exactly one v2 batch-settlement kind for this network; no payment created",
    )
    extra = kinds[0].extra or {}
    policy = extra.get("batchPolicy", {})
    require(
        int(policy.get("maxWithdrawDelay", "0")) >= MIN_WITHDRAW_DELAY,
        "Facilitator maxWithdrawDelay is below the SDK channel minimum",
    )
    require(
        policy.get("asset") == config["asset"],
        "Facilitator batch policy does not advertise this USDC mint",
    )
    require(
        int(policy.get("minInitialDeposit", "0")) <= config["deposit"],
        "Deposit is below facilitator minInitialDeposit",
    )
    require(
        config["deposit"] <= int(policy.get("maxInitialDeposit", str(config["max_deposit"]))),
        "Deposit exceeds facilitator maxInitialDeposit",
    )
    require(bool(extra.get("feePayer")), "Facilitator omitted feePayer")
    Pubkey.from_string(extra["feePayer"])
    return {
        "network": config["network"],
        "asset": config["asset"],
        "feePayer": extra["feePayer"],
        "batchPolicy": policy,
    }


def load_key(path):
    raw = Path(path).expanduser().read_text().strip()
    return (
        Keypair.from_bytes(bytes(json.loads(raw)))
        if raw.startswith("[")
        else Keypair.from_base58_string(raw)
    )


def operator_key(directory):
    path = directory / "operator.json"
    if not path.exists():
        with path.open("x") as handle:
            json.dump(list(bytes(Keypair())), handle)
            handle.flush()
            import os

            os.fsync(handle.fileno())
    return load_key(path)


def merchant(config, facilitator, db, operator):
    scheme = BatchSvmServerScheme(
        BatchSvmServerConfig(
            receiver_authorizer=operator,
            operator=operator if config["mode"] == "server" else None,
            store=ChannelStore(db),
            operation_store=OperationStore(db),
            enforce_min_deposit=True,
        )
    )
    server = x402ResourceServerSync(facilitator).register(config["network"], scheme)
    app = Flask(__name__)
    app.logger.disabled = True

    @app.get("/paid")
    def paid():
        response = jsonify({"ok": True, "mode": config["mode"], "charged": str(config["actual"])})
        if config["mode"] == "server":
            set_settlement_overrides(response, {"amount": str(config["actual"])})
        return response

    routes = {
        "GET /paid": RouteConfig(
            accepts=[
                PaymentOption(
                    scheme="batch-settlement",
                    network=config["network"],
                    pay_to=config["payee"],
                    price=AssetAmount(amount=str(config["price"]), asset=config["asset"]),
                    max_timeout_seconds=120,
                    extra={"minDeposit": str(config["deposit"]), "voucherSigner": config["mode"]},
                )
            ]
        )
    }
    payment_middleware(app, routes, server)
    app.wsgi_app = ReplayJournal(app.wsgi_app, db)
    return app, scheme


class QuietHandler(WSGIRequestHandler):
    def log(self, *args, **kwargs):
        pass


class Smoke:
    def __init__(self, config, directory, db, remote, supported):
        self.config, self.db = config, db
        require(
            "payer_key_file" in config and "payee" in config and "rpc_url" in config,
            "run needs payer_key_file, payee, and rpc_url in private config",
        )
        self.payer = KeypairSigner(load_key(config["payer_key_file"]))
        Pubkey.from_string(config["payee"])
        require(
            self.payer.address != config["payee"],
            "Use a distinct payee so payer and merchant balance assertions are meaningful",
        )
        self.operator = operator_key(directory)
        manifest = {k: v for k, v in config.items() if k != "payer_key_file"}
        manifest.update(payer=self.payer.address, operator=str(self.operator.pubkey()))
        old = db.get("run", "manifest")
        require(
            old is None or old == manifest,
            "Configuration or wallet changed; use the original config to resume",
        )
        db.set("run", "manifest", manifest)
        self.rpc = Client(config["rpc_url"], timeout=45)
        require(
            str(self.rpc.get_genesis_hash().value).startswith(config["network"].split(":")[1]),
            "RPC genesis does not match requested network",
        )
        self.facilitator = JournalFacilitator(remote, supported, db)
        self.client_scheme = BatchSvmClientScheme(
            self.payer,
            BatchSvmClientConfig(
                rpc_url=config["rpc_url"],
                deposit_amount=config["deposit"],
                channel_storage=ClientStore(db),
                discover_channels=False,
                server_signed_channels_policy=BatchServerSignedChannelsPolicy(
                    allowed_operators=[str(self.operator.pubkey())],
                    allowed_assets=[
                        ServerSignedChannelsAsset(
                            config["network"], config["asset"], str(config["max_deposit"])
                        )
                    ],
                )
                if config["mode"] == "server"
                else None,
            ),
        )
        self.client = x402ClientSync().register(config["network"], self.client_scheme)
        self.client.register_policy(self.client_scheme.payment_policy)
        self.client.set_spend_controls(
            {
                "allowed_assets": [
                    {
                        "network": config["network"],
                        "asset": config["asset"],
                        "max_amount_per_payment": str(config["max_deposit"]),
                    }
                ]
            }
        )
        app, self.server_scheme = merchant(config, self.facilitator, db, self.operator)
        self.server = make_server("127.0.0.1", 0, app, request_handler=QuietHandler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/paid"
        self.http = httpx.Client(timeout=180, trust_env=False)

    def close(self):
        self.http.close()
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        self.rpc.close()

    def balances(self):
        result = {}
        for label, owner in (("payer", self.payer.address), ("payee", self.config["payee"])):
            ata = find_ata(owner, self.config["asset"], TOKEN_PROGRAM_ADDRESS)
            account = self.rpc.get_account_info(
                Pubkey.from_string(ata), commitment="confirmed"
            ).value
            if account is None:
                result[label] = 0
            else:
                data = bytes(account.data)
                require(
                    str(account.owner) == TOKEN_PROGRAM_ADDRESS
                    and not account.executable
                    and len(data) == 165,
                    "Unexpected USDC token account layout",
                )
                require(
                    str(Pubkey.from_bytes(data[:32])) == self.config["asset"]
                    and str(Pubkey.from_bytes(data[32:64])) == owner,
                    "USDC token account mint/owner mismatch",
                )
                result[label] = int.from_bytes(data[64:72], "little")
        return result

    def channel(self):
        channels = self.server_scheme.store.list()
        require(len(channels) == 1, "Expected exactly one persisted channel")
        local = channels[0]
        account = self.rpc.get_account_info(
            Pubkey.from_string(local.channel_id), commitment="confirmed"
        ).value
        if account is None:
            return local, None
        require(
            str(account.owner) == str(PAYMENT_CHANNELS_PROGRAM_ID) and not account.executable,
            "Unexpected payment channel owner",
        )
        return local, decode_channel_account(bytes(account.data))

    def probe(self):
        response = self.http.get(self.url)
        require(
            response.status_code == 402 and "payment-required" in response.headers,
            "Local merchant must return PAYMENT-REQUIRED on an unpaid request",
        )
        required = decode_payment_required_header(response.headers["payment-required"])
        require(len(required.accepts) == 1, "Expected one payment option")
        accept = required.accepts[0]
        require(
            accept.network == self.config["network"]
            and accept.asset == self.config["asset"]
            and accept.pay_to == self.config["payee"]
            and int(accept.amount) == self.config["price"],
            "Merchant advertised unexpected payment terms",
        )
        self.db.set("run", "requirements", wire(accept))
        return required

    def payment(self, operation, refund=False):
        outbox = self.db.get("outbox", operation)
        if outbox is None:
            required = self.probe()
            if refund:
                payment = PaymentPayload(
                    x402_version=2,
                    accepted=required.accepts[0],
                    resource=required.resource,
                    payload=self.client_scheme.create_refund_payload(required.accepts[0]),
                )
            else:
                payment = self.client.create_payment_payload(required)
            kind = payment.payload.get("type")
            require(
                refund or kind != "deposit" or operation == "payment-1",
                "Refusing a second deposit/top-up in this smoke run",
            )
            if kind == "deposit":
                require(
                    int(payment.payload["deposit"]["amount"]) == self.config["deposit"],
                    "Unexpected signed deposit amount",
                )
            outbox = {"payment": wire(payment)}
            self.db.set("outbox", operation, outbox)
        payment = PaymentPayload.model_validate(outbox["payment"])
        if "response" not in outbox:
            response = self.http.get(
                self.url,
                headers={
                    "PAYMENT-SIGNATURE": encode_payment_signature_header(payment),
                    "X-Smoke-Operation": operation,
                },
            )
            outbox["response"] = {
                "status": response.status_code,
                "headers": dict(response.headers),
                "body": response.text,
            }
            self.db.set("outbox", operation, outbox)
        raw = outbox["response"]
        header = raw["headers"].get("payment-response")
        settled = decode_payment_response_header(header) if header else None
        corrective = raw["headers"].get("payment-required")
        self.client.handle_payment_response(
            PaymentResponseContext(
                payment_payload=payment,
                requirements=payment.accepted,
                settle_response=settled,
                payment_required=decode_payment_required_header(corrective) if corrective else None,
            )
        )
        require(
            raw["status"] == 200 and settled is not None and settled.success,
            "Paid HTTP operation failed; private journal retains response and payload; no automatic funding retry",
        )
        if not refund:
            require(
                bool(settled.transaction) == (operation == "payment-1"),
                "Only the first paid request should submit an onchain deposit",
            )
        self.db.set(
            "run",
            operation,
            {"success": True, "transaction": settled.transaction, "amount": settled.amount},
        )
        return settled

    def run(self, stop_after):
        baseline = self.db.get("run", "baseline")
        if baseline is None:
            require(
                not self.db.items("outbox") and not self.db.items("client"),
                "Missing baseline with existing payment state; inspect manually",
            )
            baseline = self.balances()
            require(
                baseline["payer"] >= self.config["deposit"], "Payer USDC balance is below deposit"
            )
            self.db.set("run", "baseline", baseline)
        if not self.db.get("run", "payments_verified"):
            for index in range(1, self.config["requests"] + 1):
                self.payment(f"payment-{index}")

            def verify():
                local, chain = self.channel()
                charged = self.config["actual"] * self.config["requests"]
                require(
                    local.charged_cumulative_amount == charged,
                    "Merchant cumulative amount differs from expected charges",
                )
                require(
                    chain is not None
                    and chain.deposit == self.config["deposit"]
                    and chain.settled == 0
                    and chain.payout_watermark == 0,
                    "Deposited channel does not match expected pre-redemption state",
                )
                balances = self.balances()
                require(
                    baseline["payer"] - balances["payer"] == self.config["deposit"]
                    and balances["payee"] == baseline["payee"],
                    "Deposit token balance deltas are incorrect",
                )
                self.db.set(
                    "run",
                    "payments_verified",
                    {
                        "channelId": local.channel_id,
                        "deposit": chain.deposit,
                        "charged": charged,
                        "settled": chain.settled,
                        "payoutWatermark": chain.payout_watermark,
                        "balances": balances,
                    },
                )

            confirmed_retry(verify)
        if stop_after == "payments":
            return
        if not self.db.get("run", "redemption_verified"):
            errors = []
            manager = self.server_scheme.create_channel_manager(
                self.facilitator,
                PaymentRequirements.model_validate(self.db.get("run", "requirements")),
                rpc_url=self.config["rpc_url"],
                on_error=errors.append,
            )
            manager.redeem()
            require(
                not errors,
                "Manager redemption failed; inspect saved settlement journal before retry",
            )

            def verify():
                local, chain = self.channel()
                charged = local.charged_cumulative_amount
                require(
                    chain is not None
                    and chain.settled == charged
                    and chain.payout_watermark == charged,
                    "Claim/distribution watermarks do not equal merchant charges",
                )
                balances = self.balances()
                payout = sum(
                    int(row["response"].get("amount") or 0)
                    for _, row in self.db.items("settlements")
                    if row["paymentPayload"]["payload"]["type"] == "settle"
                    and row.get("response", {}).get("success")
                )
                require(
                    balances["payee"] - baseline["payee"] == payout and 0 < payout <= charged,
                    "Merchant USDC delta differs from confirmed distribution receipt",
                )
                require(
                    baseline["payer"] - balances["payer"] == self.config["deposit"],
                    "Payer balance changed before refund",
                )
                self.db.set(
                    "run",
                    "redemption_verified",
                    {
                        "settled": chain.settled,
                        "payoutWatermark": chain.payout_watermark,
                        "merchantReceived": payout,
                        "balances": balances,
                    },
                )

            confirmed_retry(verify)
        if stop_after == "redeem":
            return
        if not self.db.get("run", "refund_verified"):
            settled = self.payment("refund", refund=True)

            def verify():
                local, chain = self.channel()
                charged = local.charged_cumulative_amount
                require(
                    chain is None or chain.status == ChannelStatus.DISTRIBUTED,
                    "Refund did not cooperatively close the channel",
                )
                balances = self.balances()
                require(
                    int(settled.amount) == self.config["deposit"] - charged,
                    "Refund receipt differs from unspent escrow",
                )
                require(
                    baseline["payer"] - balances["payer"] == charged,
                    "Payer final USDC delta differs from charged amount",
                )
                require(
                    balances["payee"]
                    == self.db.get("run", "redemption_verified")["balances"]["payee"],
                    "Refund unexpectedly changed merchant USDC balance",
                )
                escrow = find_ata(local.channel_id, self.config["asset"], TOKEN_PROGRAM_ADDRESS)
                require(
                    self.rpc.get_account_info(
                        Pubkey.from_string(escrow), commitment="confirmed"
                    ).value
                    is None,
                    "Closed channel escrow token account was not reclaimed",
                )
                self.db.set(
                    "run",
                    "refund_verified",
                    {
                        "amount": settled.amount,
                        "transaction": settled.transaction,
                        "channelStatus": "reclaimed" if chain is None else "distributed",
                        "escrowClosed": True,
                        "balances": balances,
                    },
                )
                for key, _ in self.db.items("client"):
                    self.db.delete("client", key)

            confirmed_retry(verify)


def public_report(db):
    manifest = db.get("run", "manifest", {})
    report = {
        key: manifest[key]
        for key in (
            "network",
            "asset",
            "mode",
            "payer",
            "payee",
            "operator",
            "price",
            "actual",
            "deposit",
            "requests",
        )
        if key in manifest
    }
    report["assertions"] = {
        key: value for key, value in db.items("run") if key.endswith("_verified")
    }
    report["settlements"] = [
        {
            "kind": row["paymentPayload"]["payload"]["type"],
            **{
                k: row.get("response", {}).get(k)
                for k in ("success", "transaction", "amount", "errorReason")
            },
            "outcomeKnown": "response" in row,
        }
        for _, row in db.items("settlements")
    ]
    report["complete"] = bool(db.get("run", "refund_verified"))
    report["operations"] = [
        {"id": key, "responseSaved": "response" in value} for key, value in db.items("outbox")
    ]
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["preflight", "run", "resume", "status"])
    parser.add_argument("--config", help="Private JSON config (required except status)")
    parser.add_argument(
        "--state-dir", type=Path, help="Private persistent directory outside this checkout"
    )
    parser.add_argument("--stop-after", choices=["payments", "redeem", "refund"], default="refund")
    args = parser.parse_args()
    logging.disable(
        logging.CRITICAL
    )  # Exceptions may contain bearer proofs or credentialed RPC URLs.
    db = remote = smoke = None
    result, exit_code = {}, 0
    try:
        if args.command == "status":
            require(args.state_dir is not None, "status requires --state-dir")
            db = Database(args.state_dir.expanduser())
        else:
            require(args.config is not None, "--config is required")
            config = config_from_file(args.config)
            remote = HTTPFacilitatorClientSync(
                FacilitatorConfig(url=config["facilitator"], timeout=120)
            )
            supported = remote.get_supported()
            result["preflight"] = preflight(config, supported)
            if args.command != "preflight":
                require(args.state_dir is not None, "run/resume requires --state-dir")
                directory = args.state_dir.expanduser()
                db = Database(directory)
                exists = db.get("run", "manifest") is not None
                require(
                    exists == (args.command == "resume"),
                    "Use resume for existing state; run requires a fresh directory",
                )
                smoke = Smoke(config, directory, db, remote, supported)
                smoke.run(args.stop_after)
    except Exception as error:
        result["error"] = (
            str(error)
            if isinstance(error, SmokeError)
            else f"{type(error).__name__}: details withheld; inspect private state and configuration"
        )
        exit_code = 1
    finally:
        if smoke:
            smoke.close()
        if remote:
            remote.close()
        if db:
            result.update(public_report(db))
            db.close()
    print(json.dumps(result, indent=2))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
