# Caller-paid Mesh402 API

Bring your own agent. Bring your own wallet.
No account. No subscription. No provider API key.

This route is independent of the operator-funded `/demo/live` flow. The public
server never creates a signer, reads an operator payer key, launches the agent CLI,
or pays on a caller's behalf. It uses the existing Tripo adapter only after Blocky402
verifies and settles the supplied caller-signed transaction. Nebius is not required.

Implementation is verified with non-spending mocks. A real public caller-paid run
has NOT been executed. The server defaults to disabled until explicitly enabled.

## Contract

Gateway API Base URL: `https://mesh402.onrender.com`

Public OpenAPI 3.1 spec: `https://mesh402.onrender.com/openapi.json`

The spec documents only `POST /api/v1/generate`. It is served from
`frontend/public/openapi.json` through the existing Vite build and static server;
Render must deploy the commit containing it before gateway analysis. An OpenAPI
import does not implement x402 signing: the caller still needs its own Hedera
wallet and must handle the 402 challenge.

Validation: `npm run test:public-api` checks the spec against mocked route responses
(no network settlement or generation). Full OpenAPI lint:
`npx --yes @redocly/cli@2.21.1 lint frontend/public/openapi.json --extends=minimal`.

`POST https://mesh402.onrender.com/api/v1/generate`

```json
{ "prompt": "low-poly autonomous delivery robot" }
```

Requires `Content-Type: application/json`, exactly one `prompt` string (1–2000
characters after nonblank validation), and at most 16 KB request body.

When enabled, configured, idle, and below quota, an unpaid request returns **402**
with `PAYMENT-REQUIRED`: base64 JSON of the x402 v2 `PaymentRequired` object. The
same object is included in the JSON body. `accepts` contains one requirement:

```json
{
  "scheme": "exact",
  "network": "hedera:testnet",
  "amount": "100000",
  "asset": "0.0.0",
  "payTo": "<configured HEDERA_PAY_TO_ACCOUNT_ID>",
  "maxTimeoutSeconds": 120,
  "extra": { "feePayer": "<discovered from Blocky402>" }
}
```

`x402Version` is 2. `resource.url` is `${PUBLIC_ORIGIN}/api/v1/generate` and
`resource.mimeType` is `application/json`. The existing discovery helper reads
`https://api.testnet.blocky402.com/supported`, including the current v2 exact kind
and fee payer. The public route caches discovery for up to 60 seconds; provider
failure does not produce a guessed requirement. No fee payer is hardcoded.

The caller signs with its OWN ECDSA Hedera testnet account and sends the identical
prompt with `PAYMENT-SIGNATURE`: base64 JSON containing `x402Version`, `resource`,
`accepted`, and the SDK's signed `payload`. The server compares the entire accepted
requirement, inspects the serialized transfer (one 100000-tinybar debit and one
credit to the configured recipient), and checks verification/settlement payer
identity. Actual cryptographic validity is verified by Blocky402.

After settlement, generation and local GLB persistence, **200** returns:

```json
{
  "status": "success",
  "network": "hedera:testnet",
  "price": "0.001 HBAR",
  "amountTinybars": "100000",
  "transactionId": "<Hedera transaction ID>",
  "payer": "<caller account>",
  "recipient": "<configured recipient>",
  "verificationValid": true,
  "settlementSuccess": true,
  "taskId": "<real Tripo task ID>",
  "assetUrl": "https://mesh402.onrender.com/api/v1/assets/<taskId>.glb",
  "receiptUrl": "https://mesh402.onrender.com/api/v1/receipts/<taskId>.json",
  "creditsConsumed": 20,
  "glbBytes": 123456,
  "prompt": "low-poly autonomous delivery robot"
}
```

Values above are schema examples, not a claimed public execution. Credits may be
null if omitted by Tripo. `PAYMENT-RESPONSE` contains the sanitized x402 settlement
receipt. Stable assets/receipts remain readable when new generation is disabled
or quota-exhausted. No local paths, original signed model URLs, provider keys or
operator secrets are returned. Preview is omitted because it is not persisted.
Only explicitly registered task assets can be downloaded. No fallback replay is
substituted. Public API CORS permits payment headers without operator cookies.

## Errors and retry policy

| HTTP | Error | Meaning |
| --- | --- | --- |
| 400 | invalid_prompt / invalid_json / malformed_payment | Invalid input, no settlement |
| 400 | payment_requirements_mismatch / payment_transfer_mismatch / payment_resource_mismatch | Wrong payment, no settlement |
| 402 | payment_verification_failed | Canonical payment requirements returned again; no generation |
| 409 | generation_in_progress | Capacity reserved; this request has not settled |
| 409 | payment_already_attempted | This transaction ID cannot trigger another paid execution |
| 409 | reconciliation_required | Prior interrupted/ambiguous attempt blocks further execution |
| 429 | quota_exhausted | No further public generation offered or settled |
| 503 | public_api_disabled / public_api_not_configured / facilitator_unavailable | Not offering payment |
| 502 | execution_requires_reconciliation | Includes paid=true/false/"unknown", transaction/task IDs when known, retryable=false |

Non-402 errors use `{ "error": { "code": "..." } }`. A verification-failed 402 uses
x402's string `error` alongside its canonical requirements. There is no automatic
paid retry. After an ambiguous response/disconnect, retain the signed transaction
ID and reconcile with the operator. Creating a fresh payment blindly is unsafe.

## Persistent quota and concurrency

Render disk state: `/opt/render/project/src/generated/public-api/state.json`.
Exclusive reservation: `generated/public-api/execution.lock`.

- Reserve before verification/settlement; at most one public execution is active.
- The lock uses exclusive file creation plus a synchronous in-process guard.
- Persist each attempted transaction ID, preventing replay across restarts/prompts.
- `created` increments on the existing adapter's observed successful task-creation
  response, not on an unpaid request or a failed verification. `completed` records
  successful generation + persistence separately.
- A created task counts even if later generation/download fails, because provider
  credits may already have been consumed.
- An unknown task-creation outcome retains its reservation without falsely counting
  a known task. Ambiguous verification/settlement/generation or a process crash
  blocks further execution until human reconciliation; restarts never clear it.
- Invalid verification releases concurrency but retains the attempted transaction ID.
- Completed public receipts and approved asset URLs are stored in the same state.

One paid Render instance and the existing disk are required. `MAX_CONCURRENT`
currently supports only **1**; other values fail closed. This is a hackathon quota,
not a durable job queue. No database or automatic refunds/resumption were added.
The separate operator demo is not charged against this public quota; leave it in
dry-run mode while validating the public API to avoid competing provider jobs.

Never delete the lock or reduce counters to recover from an unknown payment/task.
First reconcile on Hedera and Tripo, preserve the state/receipt, then explicitly
resolve the active reservation and account for any consumed task. Stop the process
before manual state changes. Do not run multiple service instances sharing this disk.

## Configuration and example client

Add on Render, initially disabled:

```dotenv
PUBLIC_API_ENABLED=false
PUBLIC_API_MAX_GENERATIONS=5
PUBLIC_API_MAX_CONCURRENT=1
```

The endpoint also uses existing `PUBLIC_ORIGIN`, `HEDERA_PAY_TO_ACCOUNT_ID`, and
`TRIPO_API_KEY`. It does not require `NEBIUS_*`, `HEDERA_PAYER_ACCOUNT_ID`,
`HEDERA_PAYER_PRIVATE_KEY`, or `LIVE_OPERATOR_SECRET`. Keep the operator demo's
`MESH402_UI_EXECUTION=dry-run`; this setting does not enable/disable the public API.
Enable public offering with `PUBLIC_API_ENABLED=true` only after authorization.
Testnet HBAR has no economic value; this quota protects real Tripo credits.

On the external caller's machine, create Git-ignored **`.env.caller.local`**:

```dotenv
MESH402_API_URL=https://mesh402.onrender.com/api/v1/generate
CALLER_HEDERA_ACCOUNT_ID=<caller ECDSA testnet account>
CALLER_HEDERA_PRIVATE_KEY=<caller private key>
CALLER_EXPECTED_PAY_TO=<optional independently verified recipient account>
```

```sh
npm run example:external-agent -- "low-poly autonomous delivery robot"
```

This command WILL sign a payment and request a real generation when the API is
available; do not run during mock validation. It loads only the caller env file,
requires both CALLER credentials, checks exact testnet/price/asset, verifies current
facilitator metadata, inspects transfers, signs once, and performs one paid retry.
An optional recipient pin avoids relying solely on the chosen service's advertised
recipient. It returns the stable GLB URL and receipt; download with an ordinary GET.
Never copy the server's payer key into the caller example implicitly.

## Exact sequence for ONE later authorized real test

1. Explicitly authorize the real external-client test and its single generation.
2. Verify the pushed commit is deployed; `/health` and replay remain healthy.
3. Keep operator LIVE in dry-run. Confirm public state has no active/ambiguous run.
4. For the first public test, set `PUBLIC_API_MAX_GENERATIONS=1` (assuming created=0),
   `PUBLIC_API_MAX_CONCURRENT=1`, then `PUBLIC_API_ENABLED=true`. A quota of one
   bounds public exposure during this test; do not increase to five yet.
5. Create/fund a separate caller-owned ECDSA Hedera testnet wallet with test HBAR.
   Set only the caller variables on that caller's machine; verify the recipient pin.
6. Run the example command once with a fresh prompt. Do not run the operator demo.
7. Verify initial 402, inspected caller debit, Blocky402 settlement, Tripo task,
   persisted GLB, final 200, and receipt. Download the stable GLB and inspect it.
8. Disable `PUBLIC_API_ENABLED` after completion. Verify created=1/completed=1 and
   asset/receipt availability. Preserve transaction/task IDs and test output.
9. On any failure, STOP; inspect disk/Hedera/Tripo evidence. Never rerun automatically.
10. Raise the public quota to five only after reviewing that evidence and authorizing
    broader public use. Existing counters remain in effect; deployment never resets them.

Read-only requirements discovery does not reserve a slot, so another public caller
can win the available slot before the test. If it does, stop; don't increase quota
or create another payment to work around it.

## Non-spending checks

`npm run test:public-api` uses injected facilitator/generation/persistence mocks.
It covers unpaid 402, malformed/wrong payment fields, invalid signatures, no operator
key fallback, exact-once generation, duplicate payment, quotas, concurrent requests,
settlement/task ambiguity, and restart behavior. It never calls a real facilitator
settlement, Tripo endpoint or signer.

Protocol sources: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
and live read-only discovery: https://api.testnet.blocky402.com/supported
