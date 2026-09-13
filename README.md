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

## Minimal Nebius agent consumer

The separate agent layer leaves the `mvp-e2e` server, Tripo files, and golden test
unchanged. It uses native fetch and the existing x402 SDK; no new dependencies.
Configure `NEBIUS_API_KEY`, `NEBIUS_BASE_URL`, and `NEBIUS_MODEL` as shown in
`.env.example`. The configured model is used directly, without discovery or fallback.

```sh
npm run typecheck
npm run test:agent:guards
npm run test:agent -- --dry-run "I need a newly generated low-poly sci-fi cargo drone GLB for my game."
```

Dry run is the default. It sends a real Nebius Chat Completions request with
`tool_choice: "auto"`, validates the selected tool, and sends back an explicitly
nonexecuted dry-run result for a final answer. Nebius inference may consume tokens;
no Mesh402 endpoint, signing, payment, or Tripo request runs in dry-run mode.

The only tool is `generate_3d_asset({ prompt: string })`. If the model answers
without a tool, no payment is made. Multiple calls in one response are rejected
before execution. A single-use closure locks before its first await and remains
locked after any error. The final model request has no tools and its response is
never dispatched again. No automatic retries exist.

After explicit human authorization, `--live` enables at most one paid generation.
It starts the existing local endpoint only after the model selects the tool, then
follows the golden client's HTTP sequence. Before parsing the private key or
creating a signer, the tool requires exactly `hedera:testnet`, `100000` tinybars,
and `HEDERA_PAY_TO_ACCOUNT_ID`. It also checks exact/HBAR, all discovered server
requirements including fee payer, and the serialized transfer before submission.
It returns verified asset metadata and the shared local GLB path to Nebius.

The CLI prints the final answer and saves `generated/mesh402-agent-receipt.json`
with an explicit live/dry-run mode, decision, invocation count, result, and final
answer (or error). It does not overwrite the golden E2E receipt. Keys and signed
payment payloads are never included in model messages. No live agent run has been
authorized as part of implementation/testing.

### Finalize an already successful paid tool result

```sh
npm run finalize:agent
```

This command reads the successful tool result from `generated/mesh402-agent-receipt.json`
and makes one Nebius-only request, with no tool declarations or execution path.
It preserves payment/generation evidence and invocation counts. It records the
finish reason, truncation flag, usage, response ID, and final answer in the receipt.
Older receipts without conversation messages are reconstructed from the original
request, selected tool arguments, and result, with a synthetic matching call ID.
Future agent runs preserve the actual conversation for finalization.

Final answers use 1024 tokens and a concise-summary instruction. A truncated
answer remains an explicit finalization failure; it never triggers a payment,
generation, or automatic retry. Use finalization only to recover the wording.
