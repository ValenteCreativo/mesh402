# Bazantic paid gateway upstream

- Gateway API Base URL: `https://mesh402.onrender.com`
- Analyze this dedicated spec: `https://mesh402.onrender.com/bazantic-openapi.json`
- Upstream resource: `POST /api/bazantic/generate`
- Private upstream header: `X-Bazantic-Upstream-Secret`
- Render environment variable: `BAZANTIC_UPSTREAM_SECRET`

Set a strong random secret (at least 32 random bytes recommended) in Render and
configure the same value as a private, server-side upstream header in Bazantic.
Bazantic must overwrite any caller-supplied version of that header and forward
requests only after its own payment check. Never embed the value in OpenAPI,
frontend code, a browser request, or source control. An unset Render secret keeps
this generation route disabled. The existing `TRIPO_API_KEY` remains server-side.

Import the dedicated Bazantic spec, not `/openapi.json`, which continues to describe
the separate caller-paid Hedera API. Redeploy Render with this commit before
analyzing the dedicated spec. Confirm Bazantic supports private upstream header
injection before enabling the resource; an OpenAPI import alone does not configure
the credential or prove a gateway payment occurred.

The upstream accepts exactly the same `{ "prompt": "..." }` JSON input as the public
Hedera route. It calls the existing Tripo adapter and GLB persistence function, with
no Mesh402 402, signing, verification, or settlement. Its result contains `status`,
`taskId`, `assetUrl`, `receiptUrl`, `creditsConsumed`, `glbBytes`, and trimmed `prompt`.
It deliberately makes no Hedera payment claims. The stable public asset and sanitized
receipt URLs use `/api/bazantic/assets/{taskId}.glb` and
`/api/bazantic/receipts/{taskId}.json`. No secret, temporary provider URL, local path,
or operator receipt is returned.

GLBs remain on the existing persistent `generated` disk. Sanitized receipts and a
separate execution lock live under `generated/bazantic`. Only registered assets
are served. One Bazantic request runs at a time; a provider/persistence failure or
process interruption leaves the lock for human reconciliation. Do not delete it
without checking whether a generation occurred. This state is independent of the
existing public Hedera quota and operator demo state.

Allow several minutes for a response. Disable automatic upstream retries in the
gateway: there is no gateway payment-ID/idempotency contract yet, and a second
successful request would create another generation. The separate paths do not
coordinate provider concurrency with each other; avoid simultaneous demo/public/
Bazantic generations when the Tripo account has a one-task limit.

Checks (all generation and payment dependencies are mocked):

```sh
npm run typecheck
npm run test:bazantic
npm run test:public-api
npm run test:wrapper
npm run build:visual
npx --yes @redocly/cli@2.21.1 lint frontend/public/bazantic-openapi.json --extends=minimal
```
