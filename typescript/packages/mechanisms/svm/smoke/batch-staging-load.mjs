// Devnet-only client -> HTTP resource servers -> public facilitator soak.
// Run in the deployed facilitator image. Secrets stay in process memory/IPC.
// Synthetic application: response + execution counter commit atomically with
// voucher acceptance in Redis. This does not make external LLM effects atomic.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
const require = createRequire("/app/package.json");
const { createKeyPairSignerFromBytes, getAddressDecoder } = require("@solana/kit");
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const Redis = require("ioredis");
const { x402Client } = require("@x402/core/client");
const { HTTPFacilitatorClient, x402ResourceServer } = require("@x402/core/server");
const { BatchSvmScheme: ClientScheme } = require("@x402/svm/batch-settlement/client");
const {
  BatchSvmScheme: ServerScheme,
  BatchChannelManager,
  RedisChannelStore,
} = require("@x402/svm/batch-settlement/server");
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const FEE = "DJwbH2X5VuUycmN9iw42gTppNG71Bze8w79Tpm63BdQT";
// The release image bundles SPL helpers into the API, not node_modules. These
// three standard SPL instructions keep the test runnable without installing
// packages into a live image.
const tokenProgram = new PublicKey(TOKEN),
  ataProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const spl = {
  getAssociatedTokenAddress: async (mint, owner) =>
    PublicKey.findProgramAddressSync(
      [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
      ataProgram,
    )[0],
  createAssociatedTokenAccountIdempotentInstruction: (payer, ata, owner, mint) =>
    new TransactionInstruction({
      programId: ataProgram,
      keys: [
        meta(payer, true, true),
        meta(ata, true),
        meta(owner),
        meta(mint),
        meta(SystemProgram.programId),
        meta(tokenProgram),
      ],
      data: Buffer.from([1]),
    }),
  createTransferCheckedInstruction: (source, mint, destination, owner, amount, decimals) => {
    const data = Buffer.alloc(10);
    data[0] = 12;
    data.writeBigUInt64LE(amount, 1);
    data[9] = decimals;
    return new TransactionInstruction({
      programId: tokenProgram,
      keys: [meta(source, true), meta(mint), meta(destination, true), meta(owner, false, true)],
      data,
    });
  },
  createCloseAccountInstruction: (account, destination, owner) =>
    new TransactionInstruction({
      programId: tokenProgram,
      keys: [meta(account, true), meta(destination, true), meta(owner, false, true)],
      data: Buffer.from([9]),
    }),
};
const FAC = "https://dev-facilitator.payai.network";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = value =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? { $bigint: String(v) } : v));
const parse = value =>
  JSON.parse(value, (_, v) =>
    v && typeof v === "object" && "$bigint" in v ? BigInt(v.$bigint) : v,
  );
const output = console.log.bind(console);
for (const level of ["log", "info", "warn", "error", "debug"]) console[level] = () => {};
const safeError = e => ({
  code: e?.code === "ERR_ASSERTION" ? "assertion" : "operation_failed",
  detail: String(e?.message ?? "")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/[A-Za-z0-9_+/=-]{48,}/g, "[identifier]")
    .slice(0, 180),
});
let config,
  redis,
  store,
  role,
  phase = "startup";
function emit(event, data = {}) {
  const value = { event, role, ...data };
  if (process.send) process.send(value);
  else output(JSON.stringify(value));
}
function quantiles(values) {
  const a = [...values].sort((a, b) => a - b);
  const q = n => a[Math.min(a.length - 1, Math.floor(a.length * n))] ?? 0;
  return { count: a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) };
}
const key = suffix => `${config.prefix}:${suffix}`;
const metric = (kind, data) =>
  redis.rpush(key("metrics"), JSON.stringify({ at: Date.now(), role, kind, ...data }));
function jwt() {
  const now = Math.floor(Date.now() / 1000),
    enc = v => Buffer.from(JSON.stringify(v)).toString("base64url");
  const value = `${enc({ alg: "EdDSA", typ: "JWT", kid: config.apiId })}.${enc({ sub: config.apiId, iss: "payai", iat: now, exp: now + 120 })}`;
  return `${value}.${sign(null, Buffer.from(value), createPrivateKey({ key: Buffer.from(config.apiPrivate, "base64"), format: "der", type: "pkcs8" })).toString("base64url")}`;
}
function facilitator() {
  const http = new HTTPFacilitatorClient({
    url: FAC,
    timeoutMs: 120000,
    createAuthHeaders: async () => {
      const h = { Authorization: `Bearer ${jwt()}` };
      return { supported: h, verify: h, settle: h };
    },
  });
  return Object.fromEntries(
    ["getSupported", "verify", "settle"].map(op => [
      op,
      async (...args) => {
        const start = performance.now();
        let success = false;
        try {
          const v = await http[op](...args);
          success = v.success ?? v.isValid ?? true;
          return v;
        } finally {
          const p = args[0]?.payload;
          await metric("http", {
            op,
            type: p?.type,
            batchSize: p?.claims?.length ?? p?.channels?.length,
            ms: performance.now() - start,
            success,
          });
        }
      },
    ]),
  );
}
async function rpc(method, params) {
  const start = performance.now();
  const res = await fetch(process.env.RPC_URL_SOLANA_DEVNET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json();
  await metric("rpc", { method, ms: performance.now() - start });
  if (!res.ok || body.error) throw new Error(`RPC ${method} failed`);
  return body.result;
}
function decode(value) {
  if (!value) return undefined;
  const b = Buffer.from(value.data[0], "base64");
  assert.equal(b.length, 256);
  const d = getAddressDecoder(),
    addr = n => d.decode(b.subarray(n, n + 32));
  return {
    version: b[1],
    bump: b[2],
    status: b[3],
    salt: b.readBigUInt64LE(4),
    deposit: b.readBigUInt64LE(12),
    settlement: { settled: b.readBigUInt64LE(20), payoutWatermark: b.readBigUInt64LE(28) },
    closureStartedAt: b.readBigInt64LE(36),
    payerWithdrawnAt: b.readBigInt64LE(44),
    gracePeriod: b.readUInt32LE(52),
    distributionHash: Uint8Array.from(b.subarray(56, 88)),
    payer: addr(88),
    payee: addr(120),
    authorizedSigner: addr(152),
    mint: addr(184),
    rentPayer: addr(216),
    openSlot: b.readBigUInt64LE(248),
  };
}
let mintOwner;
async function snapshot({ channelId }) {
  const values = (
    await rpc("getMultipleAccounts", [
      [channelId, ...(mintOwner ? [] : [MINT])],
      { commitment: "confirmed", encoding: "base64" },
    ])
  ).value;
  if (!mintOwner) mintOwner = values[1]?.owner;
  const channel = decode(values[0]);
  return channel ? { channel, mintOwner, observedAt: Date.now() } : undefined;
}
function requirements(amount = "10") {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    amount,
    asset: MINT,
    payTo: config.receiver,
    maxTimeoutSeconds: 300,
    extra: { feePayer: FEE, paymentFlow: "authorization", tokenProgram: TOKEN, withdrawDelay: 900 },
  };
}
async function initialize(c, r) {
  config = c;
  role = r;
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  redis.on("error", () => {});
  const adapter = {
    get: k => redis.get(k),
    set: (k, v, o) => redis.set(k, v, ...(o?.PX ? ["PX", o.PX] : []), ...(o?.NX ? ["NX"] : [])),
    async *scanIterator(o) {
      let cursor = "0";
      do {
        const page = await redis.scan(cursor, "MATCH", o.MATCH, "COUNT", o.COUNT ?? 100);
        cursor = page[0];
        yield page[1];
      } while (cursor !== "0");
    },
    async eval(script, o) {
      // Extend ONLY successful acceptance CAS with synthetic response/effect.
      let keys = o.keys,
        args = o.arguments;
      if (args.length === 3 && args[2]?.startsWith("{")) {
        const next = parse(args[2]),
          old = args[1] ? parse(args[1]) : undefined;
        if (
          next.chargedCumulativeAmount > (old?.chargedCumulativeAmount ?? 0n) &&
          !next.pendingRequest
        ) {
          const id = `${next.channelId}:${next.chargedCumulativeAmount}`;
          const response = await redis.get(key(`stage:${id}`));
          if (!response) throw new Error("missing staged synthetic response");
          script = script.replace(
            "return 1",
            'redis.call("SET", KEYS[2], ARGV[4])\nredis.call("INCR", KEYS[3])\nreturn 1',
          );
          keys = [...keys, key(`response:${id}`), key("executions")];
          args = [...args, response];
        }
      }
      return redis.eval(script, keys.length, ...keys, ...args);
    },
  };
  store = new RedisChannelStore({ client: adapter, keyPrefix: key("channels") });
}
async function resourceServer(port) {
  const scheme = new ServerScheme({
    store,
    requireDurableStore: true,
    withdrawDelay: 900,
    channelSnapshotMaxAgeMs: 1000,
    readChannel: snapshot,
    getReplayResponse: async ({ commitmentId }) => {
      const result = await redis.get(key(`response:${commitmentId}`));
      return result ? { body: JSON.parse(result) } : undefined;
    },
  });
  const server = new x402ResourceServer(facilitator());
  server.register(NETWORK, scheme);
  await server.initialize();
  const http = createServer(async (req, res) => {
    try {
      if (req.url === "/health") {
        res.end("ok");
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      const { payload, amount = "10", delay = 10, id, drop = false } = input;
      const reqs = requirements(amount),
        start = performance.now();
      const verified = await server.verifyPayment(payload, reqs);
      if (!verified.isValid) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: verified.invalidReason }));
        return;
      }
      await metric("verify", { ms: performance.now() - start, type: payload.payload.type });
      let body = verified.skipHandler?.body;
      if (!verified.skipHandler) {
        await sleep(delay);
        body = { ok: true, id };
        const commit = `${payload.payload.voucher.channelId}:${payload.payload.voucher.maxClaimableAmount}`;
        await redis.set(key(`stage:${commit}`), JSON.stringify(body));
      }
      const settled = await server.settlePayment(payload, reqs);
      if (!settled.success) throw new Error(`settle rejected: ${settled.errorReason}`);
      if (drop) {
        res.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ body, settled, replay: !!verified.skipHandler }));
    } catch (e) {
      await metric("server_error", safeError(e));
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"server_failed"}');
    }
  });
  await new Promise(resolve => http.listen(port, "127.0.0.1", resolve));
  emit("ready", { port });
}
async function clientRole(index) {
  const signer = await createKeyPairSignerFromBytes(
    Uint8Array.from(Buffer.from(config.clients[index], "base64")),
  );
  const storage = {
    get: async k => {
      const v = await redis.get(key(`client:${index}:${k}`));
      return v ? JSON.parse(v) : undefined;
    },
    set: (k, v) => redis.set(key(`client:${index}:${k}`), JSON.stringify(v)),
    delete: k => redis.del(key(`client:${index}:${k}`)),
  };
  const scheme = new ClientScheme(signer, {
    channelStorage: storage,
    discoverChannels: false,
    depositAmount: "100000",
    rpcUrl: process.env.RPC_URL_SOLANA_DEVNET,
  });
  const client = new x402Client().register(NETWORK, scheme);
  let lastPayload;
  async function pay(options = {}) {
    const start = performance.now(),
      reqs = requirements(options.amount ?? "10");
    const signing = performance.now();
    const payload = await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: "http://127.0.0.1/paid" },
      accepts: [reqs],
    });
    lastPayload = payload;
    const clientMs = performance.now() - signing;
    const port = 3100 + ((options.sequence ?? index) % 2);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/paid`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payload,
          amount: reqs.amount,
          id: options.id ?? randomUUID(),
          delay: options.delay ?? 10,
          drop: options.drop,
        }),
        signal: AbortSignal.timeout(120000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`resource HTTP ${response.status}: ${result.error}`);
      await scheme.schemeHooks.onPaymentResponse({
        paymentPayload: payload,
        requirements: reqs,
        settleResponse: result.settled,
      });
      return {
        ms: performance.now() - start,
        clientMs,
        type: payload.payload.type,
        channelId: payload.payload.voucher?.channelId,
        result,
      };
    } catch (e) {
      await scheme.schemeHooks.onPaymentResponse({
        paymentPayload: payload,
        requirements: reqs,
        error: e,
      });
      throw e;
    }
  }
  process.on("message", async msg => {
    if (!msg.command) return;
    try {
      let result;
      if (msg.command === "pay") result = await pay(msg.options);
      if (msg.command === "pending") result = { payload: lastPayload };
      if (msg.command === "refund") {
        const reqs = requirements();
        const built = await scheme.createRefundPayload(2, reqs),
          payload = { accepted: reqs, ...built };
        const fac = facilitator();
        assert.equal((await fac.verify(payload, reqs)).isValid, true);
        result = await fac.settle(payload, reqs);
        assert.equal(result.success, true);
      }
      if (msg.command === "load") {
        const { rps, seconds, delay } = msg.options;
        const n = Math.round(rps * seconds),
          start = performance.now(),
          pending = [],
          latencies = [],
          clientMs = [],
          errors = {};
        let finished = 0,
          maxInFlight = 0;
        for (let i = 0; i < n; i++) {
          await sleep(Math.max(0, start + (i * 1000) / rps - performance.now()));
          maxInFlight = Math.max(maxInFlight, i - finished + 1);
          pending.push(
            pay({ delay, sequence: i })
              .then(v => {
                latencies.push(v.ms);
                clientMs.push(v.clientMs);
              })
              .catch(e => {
                const reason = safeError(e).detail;
                errors[reason] = (errors[reason] ?? 0) + 1;
              })
              .finally(() => finished++),
          );
          if (i - finished > 200) {
            errors["backlog cap"] = n - i - 1;
            break;
          }
        }
        await Promise.all(pending);
        result = {
          offeredRps: rps,
          seconds,
          delay,
          offered: n,
          successes: latencies.length,
          errors,
          elapsedSeconds: (performance.now() - start) / 1000,
          maxInFlight,
          latency: quantiles(latencies),
          client: quantiles(clientMs),
        };
      }
      process.send({ reply: msg.id, result });
    } catch (e) {
      process.send({ reply: msg.id, error: safeError(e) });
    }
  });
  emit("ready", { index });
}
async function workerRole() {
  const manager = new BatchChannelManager({
    store,
    requirements: requirements(),
    maxChannelsPerBatch: 4,
    leaseTtlMs: 10000,
    settle: facilitator().settle,
  });
  process.on("message", async msg => {
    if (msg.command === "redeem") {
      try {
        const result = await manager.redeem();
        process.send({ reply: msg.id, result });
      } catch (e) {
        process.send({ reply: msg.id, error: safeError(e) });
      }
    }
  });
  emit("ready");
}
const children = [];
async function spawn(r, extra = {}) {
  const child = fork(process.argv[1], [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      RPC_URL_SOLANA_DEVNET: process.env.RPC_URL_SOLANA_DEVNET,
      REDIS_URL: process.env.REDIS_URL,
      PATH: process.env.PATH,
      BATCH_CHILD: "1",
    },
  });
  children.push(child);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.on("message", msg => {
      if (msg.event === "ready") resolve();
      if (msg.event === "fatal") reject(new Error(JSON.stringify(msg)));
    });
    child.send({ init: true, config, role: r, ...extra });
  });
  return child;
}
function call(child, command, options = {}) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const listener = msg => {
      if (msg.reply !== id) return;
      child.off("message", listener);
      clearTimeout(timeout);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    };
    const timeout = setTimeout(() => {
      child.off("message", listener);
      reject(new Error(`timeout ${command}`));
    }, 300000);
    child.on("message", listener);
    child.send({ id, command, options });
  });
}
async function tokenBalance(owner) {
  const r = await rpc("getTokenAccountsByOwner", [
    owner,
    { mint: MINT },
    { commitment: "confirmed", encoding: "jsonParsed" },
  ]);
  return r.value.reduce(
    (sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
}
async function parent() {
  assert.equal(process.env.METRICS_NAMESPACE, "dev");
  assert.equal(process.env.SVM_BATCH_ALLOWED_NETWORKS, NETWORK);
  const { PrismaClient } = require("@prisma/client"),
    { PrismaPg } = require("@prisma/adapter-pg");
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const userId = randomUUID(),
    apiId = `batch-load-${userId}`,
    api = generateKeyPairSync("ed25519"),
    payers = [Keypair.generate(), Keypair.generate()],
    receiver = Keypair.generate();
  config = {
    prefix: `batch-load:${userId}`,
    apiId,
    apiPrivate: api.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    clients: payers.map(k => Buffer.from(k.secretKey).toString("base64")),
    receiver: receiver.publicKey.toBase58(),
  };
  await initialize(config, "driver");
  const channels = [],
    results = [];
  let workers = [],
    clients = [],
    servers = [],
    claimTimer,
    claimPass = Promise.resolve(),
    monitorTimer;
  const report = {
    image: "fc405e0",
    startedAt: new Date().toISOString(),
    prefix: config.prefix,
    scenarios: results,
  };
  const checkpoint = () =>
    writeFileSync("/tmp/batch-load-status.json", JSON.stringify({ phase, ...report }), {
      mode: 0o600,
    });
  const advance = p => {
    phase = p;
    checkpoint();
    emit("phase", { phase });
  };
  await prisma.user.create({
    data: {
      id: userId,
      authProviderId: apiId,
      name: "Temporary batch load",
      apiKeys: {
        create: {
          id: apiId,
          name: "Temporary batch load",
          publicKey: api.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        },
      },
    },
  });
  try {
    advance("preflight");
    const supported = await facilitator().getSupported();
    const kind = supported.kinds.find(k => k.scheme === "batch-settlement");
    assert.equal(kind?.network, NETWORK);
    assert.equal(kind?.extra?.feePayer, FEE);
    assert.equal(kind?.extra?.experimental, true);
    const raw = process.env.SVM_PRIVATE_KEYS.split(",").map(s => s.trim())[2];
    const bs58 = require("bs58").default ?? require("bs58");
    const fee = Keypair.fromSecretKey(
      /[+/=]/.test(raw) ? Buffer.from(raw, "base64") : bs58.decode(raw),
    );
    assert.equal(fee.publicKey.toBase58(), FEE);
    const conn = new Connection(process.env.RPC_URL_SOLANA_DEVNET, "confirmed");
    report.feeBefore = await conn.getBalance(fee.publicKey);
    assert(report.feeBefore <= 50000000 && report.feeBefore >= 18000000);
    assert((await tokenBalance(FEE)) <= 5000000n);
    advance("fund-clients");
    const mint = new PublicKey(MINT),
      source = await spl.getAssociatedTokenAddress(mint, fee.publicKey),
      tx = new Transaction();
    for (const payer of payers) {
      const ata = await spl.getAssociatedTokenAddress(mint, payer.publicKey);
      tx.add(
        spl.createAssociatedTokenAccountIdempotentInstruction(
          fee.publicKey,
          ata,
          payer.publicKey,
          mint,
        ),
        spl.createTransferCheckedInstruction(source, mint, ata, fee.publicKey, 200000n, 6),
      );
    }
    report.fundingSignature = await sendAndConfirmTransaction(conn, tx, [fee], {
      commitment: "confirmed",
      maxRetries: 0,
    });
    report.fundedAtomic = "400000";
    report.receiver = config.receiver;
    servers = [await spawn("server", { port: 3100 }), await spawn("server", { port: 3101 })];
    clients = [await spawn("client", { index: 0 }), await spawn("client", { index: 1 })];
    workers = [await spawn("worker"), await spawn("worker")];
    advance("open-two-channels");
    for (const client of clients) {
      const opened = await call(client, "pay");
      assert.equal(opened.type, "deposit");
      channels.push(opened.channelId);
    }
    report.channels = channels;
    checkpoint();
    advance("dropped-response-client-server-restarts");
    const before = Number(await redis.get(key("executions")));
    await assert.rejects(() => call(clients[0], "pay", { drop: true, id: "lost-response" }));
    const pending = (await call(clients[0], "pending")).payload;
    clients[0].kill("SIGKILL");
    clients[0] = await spawn("client", { index: 0 });
    servers[0].kill("SIGKILL");
    servers[0] = await spawn("server", { port: 3100 });
    const replay = await call(clients[0], "pay", { id: "retry" });
    assert.equal(replay.result.replay, true);
    assert.equal(replay.result.body.id, "lost-response");
    assert.deepEqual((await call(clients[0], "pending")).payload, pending);
    assert.equal(Number(await redis.get(key("executions"))), before + 1);
    report.lostResponseRestartReplay = true;
    advance("two-worker-lease");
    const redeemed = await Promise.all(workers.map(w => call(w, "redeem")));
    assert.equal(redeemed.flatMap(r => r.claimed).length, 2);
    report.multiWorker = true;
    workers[0].kill("SIGKILL");
    workers[0] = await spawn("worker");
    report.workerRestart = true;
    advance("deployment-restart-window");
    await sleep(70000);
    assert.equal((await call(clients[0], "pay")).type, "voucher");
    report.afterDeploymentRestart = true;
    // Ten-second timer is shared by both independent workers. No per-request claims.
    const redeem = () =>
      Promise.all(workers.map(w => call(w, "redeem"))).catch(async e => {
        await metric("worker_error", safeError(e));
      });
    claimTimer = setInterval(() => {
      claimPass = claimPass.then(redeem);
    }, 10000);
    monitorTimer = setInterval(
      () =>
        void store
          .list()
          .then(rows =>
            metric("exposure", {
              unclaimed: String(
                rows.reduce((n, s) => n + s.chargedCumulativeAmount - s.settled, 0n),
              ),
              undistributed: String(rows.reduce((n, s) => n + s.settled - s.payoutWatermark, 0n)),
            }),
          ),
      1000,
    );
    for (const s of [
      { name: "30rps", rps: 30, seconds: 120, delay: 10 },
      { name: "50rps", rps: 50, seconds: 120, delay: 10 },
      { name: "100rps-burst", rps: 100, seconds: 20, delay: 10 },
      { name: "50rps-100ms-two-channel-limit", rps: 50, seconds: 8, delay: 100 },
    ]) {
      advance(`load-${s.name}`);
      const startedAt = new Date().toISOString();
      const parts = await Promise.all(clients.map(c => call(c, "load", { ...s, rps: s.rps / 2 })));
      results.push({ ...s, startedAt, endedAt: new Date().toISOString(), parts });
      checkpoint();
      if (parts.some(p => Object.keys(p.errors).length)) throw new Error(`load errors ${s.name}`);
    }
    clearInterval(claimTimer);
    clearInterval(monitorTimer);
    await claimPass;
    advance("top-up");
    const topped = await call(clients[0], "pay", { amount: "100000" });
    assert.equal(topped.type, "deposit");
    report.topUp = true;
    await redeem();
    advance("watermark-invariants");
    const states = await store.list();
    let charged = 0n,
      payout = 0n;
    for (const s of states) {
      const c = (await snapshot({ channelId: s.channelId })).channel;
      assert.equal(s.chargedCumulativeAmount, c.settlement.settled);
      assert.equal(s.chargedCumulativeAmount, c.settlement.payoutWatermark);
      assert(s.deposit >= s.chargedCumulativeAmount);
      charged += s.chargedCumulativeAmount;
      payout += c.settlement.payoutWatermark;
    }
    assert.equal(await tokenBalance(config.receiver), payout);
    report.watermarks = {
      charged: String(charged),
      settled: String(charged),
      payout: String(payout),
      divergentChannels: 0,
    };
    advance("store-loss-fails-closed");
    // Probe against a separate empty namespace, never delete the live store.
    const empty = new ServerScheme({
      store: new RedisChannelStore({
        client: { get: k => redis.get(k), set: (k, v) => redis.set(k, v) },
        keyPrefix: key("empty"),
      }),
      requireDurableStore: true,
    });
    const lastPayment = (await call(clients[1], "pending")).payload;
    const rejected = await empty.schemeHooks.onBeforeVerify({
      paymentPayload: lastPayment,
      requirements: lastPayment.accepted,
    });
    assert.equal(rejected.abort, true);
    report.storeLossFailsClosed = true;
    advance("request-close");
    for (const c of clients) await call(c, "refund");
    report.closeRequested = true;
    advance("grace-period-and-reclaim");
    const deadline = Date.now() + 1200000;
    let remaining = channels.length;
    while (Date.now() < deadline) {
      remaining = (await Promise.all(channels.map(channelId => snapshot({ channelId })))).filter(
        Boolean,
      ).length;
      if (!remaining) break;
      await sleep(30000);
    }
    assert.equal(remaining, 0, "cleanup did not reclaim both channels");
    report.reclaimed = true;
    const remainingClient = await Promise.all(
      payers.map(p => tokenBalance(p.publicKey.toBase58())),
    );
    assert.equal(remainingClient.reduce((a, b) => a + b, 0n) + payout, 400000n);
    report.clientRefundedBalances = remainingClient.map(String);
    advance("return-test-funds");
    const returnTx = new Transaction();
    for (const owner of [...payers, receiver]) {
      const ata = await spl.getAssociatedTokenAddress(mint, owner.publicKey),
        amount = await tokenBalance(owner.publicKey.toBase58());
      if (amount > 0n)
        returnTx.add(
          spl.createTransferCheckedInstruction(ata, mint, source, owner.publicKey, amount, 6),
        );
      returnTx.add(spl.createCloseAccountInstruction(ata, fee.publicKey, owner.publicKey));
    }
    returnTx.feePayer = fee.publicKey;
    report.returnSignature = await sendAndConfirmTransaction(
      conn,
      returnTx,
      [fee, ...payers, receiver],
      { commitment: "confirmed", maxRetries: 0 },
    );
    report.feeAfter = await conn.getBalance(fee.publicKey);
    assert.equal(await tokenBalance(FEE), 5000000n);
    report.success = true;
    advance("complete");
  } catch (e) {
    report.success = false;
    report.failure = { phase, ...safeError(e) };
    advance("failed-retain-pod-for-recovery");
  } finally {
    clearInterval(claimTimer);
    clearInterval(monitorTimer);
    await claimPass;
    const metrics = (await redis.lrange(key("metrics"), 0, -1)).map(JSON.parse);
    writeFileSync("/tmp/batch-load-metrics.json", JSON.stringify(metrics));
    report.http = Object.fromEntries(
      ["getSupported", "verify", "settle"].map(op => [
        op,
        quantiles(metrics.filter(m => m.kind === "http" && m.op === op).map(m => m.ms)),
      ]),
    );
    report.httpTypes = metrics
      .filter(m => m.kind === "http")
      .reduce((a, m) => {
        const k = `${m.op}:${m.type ?? "none"}`;
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {});
    report.rpc = metrics
      .filter(m => m.kind === "rpc")
      .reduce((a, m) => {
        a[m.method] = (a[m.method] ?? 0) + 1;
        return a;
      }, {});
    report.claimBatchSizes = metrics
      .filter(m => m.kind === "http" && m.type === "claim")
      .map(m => m.batchSize);
    report.maxUnclaimedAtomic = Math.max(
      0,
      ...metrics.filter(m => m.kind === "exposure").map(m => Number(m.unclaimed)),
    );
    report.maxUndistributedAtomic = Math.max(
      0,
      ...metrics.filter(m => m.kind === "exposure").map(m => Number(m.undistributed)),
    );
    report.errors = metrics.filter(m => m.kind.endsWith("_error"));
    report.applicationExecutions = Number(await redis.get(key("executions")));
    report.completedAt = new Date().toISOString();
    checkpoint();
    if (report.success) {
      for (const child of children) child.kill();
      await prisma.apiKey.delete({ where: { id: apiId } });
      await prisma.user.delete({ where: { id: userId } });
      report.testIdentityRemoved = true;
      checkpoint();
    }
    await prisma.$disconnect();
    emit("result", report);
    // Keep isolated pod available on failure: payer keys remain in memory for
    // recovery; no secret-bearing stdout/stderr is ever collected.
    if (!report.success) await new Promise(() => {});
    await redis.quit();
  }
}
if (process.env.BATCH_CHILD) {
  process.once("message", async msg => {
    try {
      await initialize(msg.config, msg.role);
      if (msg.role === "server") await resourceServer(msg.port);
      if (msg.role === "client") await clientRole(msg.index);
      if (msg.role === "worker") await workerRole();
    } catch (e) {
      emit("fatal", safeError(e));
      process.exit(1);
    }
  });
} else
  parent().catch(e => {
    const summary = JSON.stringify({ success: false, phase, ...safeError(e) });
    writeFileSync("/tmp/batch-load-status.json", summary);
    writeFileSync("/dev/termination-log", summary);
    process.exitCode = 1;
  });
