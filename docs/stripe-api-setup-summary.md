# PROVF Stripe API setup summary

This file is safe to share with another chat. It lists the required keys and API contract, but it does not include secret values.

## Required environment variables

| Key | Required | Server/browser | Description |
| --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | Yes | Server only | Stripe secret API key. Used by server routes to create and retrieve Checkout Sessions. Must start with `sk_...`. Never expose this to the browser. |
| `STRIPE_PUBLISHABLE_KEY` | Yes | Browser/client | Stripe publishable key. Used by client UI if Stripe.js or Elements are added. Must start with `pk_...`. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Recommended | Browser/client | Public alias for frontend frameworks that only expose `NEXT_PUBLIC_*` variables. Same value as `STRIPE_PUBLISHABLE_KEY`. |
| `GOOGLE_PUBLIC_BASE_URL` | Yes for current app | Server | Public base URL used to build Stripe `success_url` and `cancel_url`. Current production value should point to `https://ivucx.vercel.app`. |
| `PUBLIC_APP_URL` | Optional | Server | Alternative public base URL. The code checks this before `APP_URL`, `GOOGLE_PUBLIC_BASE_URL`, and `VERCEL_URL`. |
| `APP_URL` | Optional | Server | Alternative public base URL. |
| `IVUCX_YEN_PER_VX` | Optional | Server | Vx conversion rate. Defaults to `200`, meaning `Vx 1 = 200 JPY`. Used for Conditional bounty checkout and split calculations. |
| `STRIPE_WEBHOOK_SECRET` | Optional future hardening | Server only | Required only if adding a Stripe webhook endpoint. Must start with `whsec_...`. Current implementation verifies Checkout Sessions by retrieving them from Stripe after checkout. |

## Current Vercel status

Already configured on Vercel:

- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `GOOGLE_PUBLIC_BASE_URL`

`IVUCX_YEN_PER_VX` is optional because the server defaults to `200`.

## Existing API endpoints

### Create unresolved problem bounty checkout

`POST /api/bounty-checkout`

Request body:

```json
{
  "amountCents": 1000,
  "currency": "usd",
  "title": "Problem title",
  "problemKind": "problem",
  "proofState": "NY",
  "language": "coq",
  "fileName": "Main.v",
  "clientReferenceId": "optional-client-id"
}
```

Response:

```json
{
  "url": "https://checkout.stripe.com/...",
  "sessionId": "cs_...",
  "amountCents": 1000,
  "currency": "usd"
}
```

Rules:

- Login is required before funding.
- `problemKind` must be `problem`.
- `proofState` must be `NY`.
- Minimum bounty is `100` cents.
- Maximum bounty is `1000000` cents.

### Read unresolved problem bounty checkout

`GET /api/bounty-checkout?session_id=cs_...`

Response includes:

- `sessionId`
- `status`
- `paymentStatus`
- `paid`
- `amountTotal`
- `currency`
- `metadata`

### Create Conditional bounty checkout

`POST /api/conditional-checkout`

Request body:

```json
{
  "amountVx": 1,
  "problemId": "problem-uuid",
  "title": "Conditional proof title",
  "problemTitle": "Original problem",
  "proofState": "NY",
  "language": "coq",
  "fileName": "Main.v",
  "clientReferenceId": "optional-client-id"
}
```

Response:

```json
{
  "url": "https://checkout.stripe.com/...",
  "sessionId": "cs_...",
  "amountVx": 1,
  "amountYen": 200,
  "yenPerVx": 200,
  "currency": "jpy",
  "split": {
    "feeYen": 20,
    "problemBountyYen": 90,
    "creatorYen": 90
  }
}
```

Rules:

- Login is required before funding.
- `problemId` is required.
- `proofState` must be `NY`.
- Minimum is `Vx 1`.
- Currency is JPY.
- Split is `10% fee`, `45% problem bounty`, `45% creator`.

### Read Conditional bounty checkout

`GET /api/conditional-checkout?session_id=cs_...`

Response includes:

- `sessionId`
- `status`
- `paymentStatus`
- `paid`
- `amountTotal`
- `amountYen`
- `amountVx`
- `yenPerVx`
- `currency`
- `metadata`
- `split`

## Server-side verification

Implementation file:

`lib/stripe-payment-verify.js`

The server re-fetches Checkout Sessions from Stripe before accepting paid state. It checks:

- Session exists.
- Session `mode` is `payment`.
- Session `status` is `complete`.
- Session `payment_status` is `paid`.
- Metadata `type` matches the operation.
- Paid amount matches metadata.
- Current logged-in account matches Stripe metadata when account metadata exists.

Verification functions:

```js
verifyBountyCheckoutSession(bounty, expected)
verifyConditionalCheckoutSession(conditionalBounty, expected)
```

## Stripe metadata used

Bounty checkout metadata:

```json
{
  "type": "provf_bounty",
  "title": "Problem title",
  "problemKind": "problem",
  "proofState": "NY",
  "language": "coq",
  "fileName": "Main.v",
  "amountCents": "1000",
  "accountProvider": "google-or-blue",
  "accountIdHash": "hashed-account-id"
}
```

Conditional checkout metadata:

```json
{
  "type": "provf_conditional_bounty",
  "problemId": "problem-uuid",
  "problemTitle": "Original problem",
  "conditionalTitle": "Conditional proof title",
  "proofState": "NY",
  "amountVx": "1",
  "amountYen": "200",
  "yenPerVx": "200",
  "feeYen": "20",
  "problemBountyYen": "90",
  "creatorYen": "90",
  "accountProvider": "google-or-blue",
  "accountIdHash": "hashed-account-id"
}
```

## Important security notes

- Do not trust client-provided `bounty`, `conditionalBounty`, `amountCents`, `amountVx`, or `paid`.
- Always verify the Checkout Session server-side with Stripe before saving paid state.
- Never expose `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` to frontend code.
- Checkout Session IDs must not be reused across problem records.
- If webhooks are added later, verify the raw body with `STRIPE_WEBHOOK_SECRET`.
