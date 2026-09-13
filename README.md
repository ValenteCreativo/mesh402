# Agent-native 3D infrastructure — Milestone 0

Minimal server-side Tripo v3 spike. No payment integration or UI.

Requires Node 22.6+ and `TRIPO_API_KEY` in `.env.local` (ignored by Git).

```sh
npm install
npm run typecheck
npm run test:tripo
```

The script submits one real generation (consumes credits), polls every two seconds
with a four-minute generation deadline, then immediately downloads and validates
the GLB container. Downloads have a separate two-minute timeout. It prints the
result and saves API response evidence alongside `generated/<taskId>.glb`.
No automatic submission retries. Local abort/timeout stops waiting, but does not
cancel a remote task or guarantee a refund.

`src/tripo/client.ts` exports `generateAsset(prompt, options)` with progress,
timeout, AbortSignal support, and optional `onResponse` diagnostics for inspecting
the actual response schema. It reads only v3 `output.model_url` and
`output.rendered_image_url`; optional `credits_consumed` maps to `consumedCredit`.

References studied before implementation:
- [PromptMon client](https://github.com/Gastonfoncea/Promptmon/blob/main/tripo/src/client.ts): isolated adapter, polling, terminal failures, progress and timeout pattern.
- [PromptMon documentation](https://github.com/Gastonfoncea/Promptmon/blob/main/tripo/README.md).
- [Official Tripo v3 quick start](https://developers.tripo3d.ai/es/docs/quick-start): endpoints, model, output schema and five-minute URL expiry.

Generated files and response evidence are local and ignored by Git.

## Milestone 2 — one paid Tripo generation

Configure `TRIPO_API_KEY` and the three Hedera variables shown in `.env.example`, then run:

```sh
npm run typecheck
npm run test:e2e
```

This command starts a temporary loopback-only `POST /api/generate-3d` endpoint,
discovers Blocky402's live `/supported` capabilities and fee payer, requests the
endpoint (402), signs exactly 100,000 tinybars (0.001 HBAR), and retries with the
x402 v2 `PAYMENT-SIGNATURE` header. The endpoint submits `/verify`, then `/settle`,
then calls `generateAsset(prompt)`, waits for success, immediately downloads and
validates the GLB, and persists it before returning HTTP 200. The JSON response
includes payment evidence, Tripo task ID, temporary model/preview URLs, credits
consumed, and the absolute local GLB path. This local spike delivers the asset via
the shared filesystem and the returned Tripo URL; it does not rehost assets.

The endpoint requires an application/json body with a nonempty `prompt` (maximum
2000 characters). The client sends the same fresh arcade-machine prompt in both
requests. `test:x402` is now an alias for the paid-generation client too.

The client prints the verification, settlement, and receipt, saves
`generated/mesh402-e2e-receipt.json`, and closes the server. The original Milestone 1
receipt remains at `generated/x402-receipt.json`. Each invocation authorizes
one new payment and generation: do not rerun after success. There are no submission retries;
the temporary server permits only one payment attempt and rejects replays.
An interrupted or timed-out settlement can have an unknown on-chain outcome;
do not infer failure or resubmit automatically.
Generation failure after settlement returns HTTP 502 with payment evidence;
this spike does not automatically refund or retry. Tripo keeps its four-minute
deadline and two-second polling; GLB download has a separate two-minute deadline.

References: [Blocky402 API](https://blocky402.com/docs/api-reference/),
[Hedera signing example](https://blocky402.com/docs/examples/), and
[official x402 v2 HTTP headers](https://docs.x402.org/core-concepts/http-402).
The installed `@x402/hedera` SDK constructs and signs the native Hedera transfer.
