# ADR-0006 — Contact-handler testability seam (injectable core, @aws-sdk only at the composition root)

## Status

Accepted. Supports backlog items 2, 3, 4 (contact-durability characterization, app layer).
Does not supersede ADR-0004 — the deployed Lambda behavior it describes is unchanged.

## Context

Backlog items 2–4 characterize the contact pipeline's durability invariants (#3 persist+enqueue
before 200; #4 honeypot silent-discard; #5 sender skip-when-sent / mark-failed-and-rethrow) as
`node --test` unit tests in the **app layer**.

The blocker is a dependency seam. Both handlers import `@aws-sdk/*` at the top of the module and
construct clients at **module load**:

- `aws/src/contact-ingress.js:1-3,13-14` — `import … from '@aws-sdk/client-dynamodb' / lib-dynamodb / client-sqs`, then `const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))` and `const sqs = new SQSClient({})`.
- `aws/src/contact-sender.js:1-2,6` — same `@aws-sdk` imports, `const ddb = …` at module load; the IO is already factored into module-private `loadMessage/markSending/markSent/markFailed` (`contact-sender.js:8-66`) that close over that `ddb`.

`@aws-sdk/*` is declared **only** in `aws/src/package.json:6-11` and is **not installed** (no
`aws/src/node_modules`; `sam build` installs it at deploy). The app-layer CI job — the repurposed
`.github/workflows/tdd-verify.yml`, per backlog decision (b) — runs a **bare `node --test` with no
install step** (the canonical floor; ADR-0005), and the only existing node test imports a pure
module (`test/starfield-reduced-motion.test.mjs`). So **`import`-ing either handler under
`node --test` today throws `ERR_MODULE_NOT_FOUND`** before any test body runs.

The pure helpers are unaffected: `aws/src/common/contact-shared.js` imports only `node:crypto`
(`contact-shared.js:1`) and `aws/src/common/resend.js` uses global `fetch` (`resend.js:7`) — neither
touches `@aws-sdk`, so both are already directly unit-testable as-is.

Two ways to make the handlers testable:

- **Approach A — keep handlers unchanged; install `@aws-sdk` for the node test layer and mock the
  SDK** (`node:test` `mock.method` on the client prototype, or `aws-sdk-client-mock`). Tradeoff:
  forces `npm ci --prefix aws/src` into the CI job and every local run (pulls tens of MB of
  `@aws-sdk` onto the always-present node floor) and couples tests to SDK `send`-mocking / adds a
  dev dependency — it regresses the "fast, install-free node floor" that ADR-0005 made canonical.

- **Approach B — extract an injectable handler core** that imports no `@aws-sdk` at module load,
  behind a thin composition-root entry that builds the real clients and wires them. Tradeoff: a
  small, mechanical production refactor (extract + inject) on currently-untested code — mitigated by
  the fact that these tests are landing in the same slice and will pin the behavior.

## Decision

**Adopt Approach B: extract an injectable handler core per handler; keep `@aws-sdk` imports and
real-client construction in a thin composition-root entry that re-exports the deployed
`export const handler`.** The app/node test layer stays `@aws-sdk`-free and the CI job stays
install-free.

This is idiomatic for the repo norm of thin ES-module Lambdas (separating IO wiring from logic),
and it preserves ADR-0005's install-free node floor. Approach A is rejected because it loads the
entire `@aws-sdk` onto the always-present node bar to test three small behavior tables.

### File layout (new + changed)

```
aws/src/
  contact-ingress.js          # CHANGED → composition root: imports @aws-sdk, builds real ddb/sqs +
                              #   command constructors, wires them into the core, re-exports `handler`.
  contact-ingress-core.js     # NEW → pure: NO @aws-sdk import. Exports createIngressHandler({...}).
  contact-sender.js           # CHANGED → composition root: imports @aws-sdk, builds real ddb +
                              #   GetCommand/UpdateCommand wiring, re-exports `handler`.
  contact-sender-core.js      # NEW → pure: NO @aws-sdk import. Exports createSenderHandler({...}).
```

The `*-core.js` modules import only `./common/contact-shared.js` (and, for the sender, may use the
injected `sendEmail`). **Neither `*-core.js` may import `@aws-sdk/*`** — that is the load-bearing
constraint the test layer relies on, and it is the thing `tdd-critic` should eyeball.

### Contract — exact factory signatures

The test-writer imports the **cores**. Each factory returns an `async (event) => response` with the
same signature/return shape as today's Lambda `handler`.

**`aws/src/contact-ingress-core.js`**

```js
// NO `@aws-sdk` import in this file.
import {
  buildMessageRecord, json, optionsResponse, parseJsonBody,
  resolveCorsOrigin, validateMessage
} from './common/contact-shared.js'

// persistMessage(record): Promise<void>
//   MUST apply the attribute_not_exists(id) idempotency guard inside the
//   composition root's real implementation (the core just calls it once).
// enqueueDelivery({ id, idempotencyKey }): Promise<void>
// env: { CONTACT_MESSAGES_TABLE, CONTACT_DELIVERY_QUEUE_URL } (defaults to process.env)
export function createIngressHandler ({ persistMessage, enqueueDelivery, env = process.env }) {
  return async (event) => { /* ingress flow, calls the two injected collaborators */ }
}
```

Behavior the core preserves verbatim from `contact-ingress.js:16-78`:
OPTIONS→`optionsResponse`; non-POST→405; bad JSON→400; honeypot (`record.company` truthy)→
`200 {ok,persisted,delivery:'queued'}` **without calling either collaborator**; `validateMessage`
error→400; missing `env.CONTACT_MESSAGES_TABLE`/`env.CONTACT_DELIVERY_QUEUE_URL`→500; then
`await persistMessage(record)` **then** `await enqueueDelivery({id, idempotencyKey})` **then**
`200 {ok,persisted,delivery:'queued',id}`; any throw from either→`console.error` + 500.

**`aws/src/contact-sender-core.js`**

```js
// NO `@aws-sdk` import in this file.
import { formatText } from './common/contact-shared.js'

// store: {
//   loadMessage(id): Promise<record|null>,
//   markSending(id, attempts): Promise<void>,
//   markSent(id, attempts, resendId): Promise<void>,
//   markFailed(id, attempts, errorMessage): Promise<void>
// }
// sendEmail(args): Promise<{ id? }>   // composition root binds this to sendViaResend
// env: { RESEND_API_KEY, CONTACT_FROM_EMAIL, CONTACT_TO_EMAIL } (defaults to process.env)
export function createSenderHandler ({ store, sendEmail, env = process.env }) {
  return async (event) => { /* per-Record loop, calls store.* + sendEmail */ }
}
```

Behavior the core preserves verbatim from `contact-sender.js:68-96`:
for each `event.Records[]`, parse `{id}` from `body`; `store.loadMessage(id)`; **skip when record
is null OR `record.status === 'sent'`** (no `sendEmail`, no marks); else
`attempts = (record.attempts||0)+1`, `store.markSending(id, attempts)`, build subject
(`[Contact] <subject>` or `[Contact] New message`), `sendEmail({apiKey, from, to, subject, text:formatText(record), replyTo:record.email})`; on success `store.markSent(id, attempts, info?.id||null)`;
on throw `console.error` + `store.markFailed(id, attempts, errorMessage)` + **re-throw**.

### Composition roots — deployed behavior unchanged

`contact-ingress.js` and `contact-sender.js` keep their `@aws-sdk` imports and module-load client
construction **exactly as today**, then wire the real IO into the core and re-export its result:

```js
// contact-ingress.js (composition root) — illustrative
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { createIngressHandler } from './contact-ingress-core.js'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const sqs = new SQSClient({})

export const handler = createIngressHandler({
  persistMessage: (record) => ddb.send(new PutCommand({
    TableName: process.env.CONTACT_MESSAGES_TABLE,
    Item: record,
    ConditionExpression: 'attribute_not_exists(id)'   // idempotency guard stays here
  })),
  enqueueDelivery: (body) => sqs.send(new SendMessageCommand({
    QueueUrl: process.env.CONTACT_DELIVERY_QUEUE_URL,
    MessageBody: JSON.stringify(body)
  }))
})
```

The sender root binds `store` to the four existing functions (`contact-sender.js:8-66`, unchanged)
and `sendEmail` to `sendViaResend`, then `export const handler = createSenderHandler({ store, sendEmail })`.

**Guarantee:** the deployed artifact still exposes `export const handler` from the same two file
paths SAM references; the real DynamoDB/SQS/Resend calls, the `attribute_not_exists(id)` guard, the
command shapes, the SQS body, the per-`Record` loop, and the re-throw are byte-for-byte the same.
The refactor is observ­ationally null at the Lambda boundary — it only relocates the wiring and adds
seams. `aws/template.yaml` handler paths do not change.

### Seam each acceptance bullet asserts against

| Backlog | Acceptance bullet | Faked collaborator → assertion |
|---|---|---|
| **2** | persist + enqueue **before** 200; body reports persisted+queued | `persistMessage` & `enqueueDelivery` fakes record call order; assert both called **before** the resolved `200` and `persistMessage` ordered before `enqueueDelivery`; assert 200 body `{ok,persisted,delivery:'queued',id}`. |
| **2** | idempotency guard `attribute_not_exists(id)` | Asserted in the **composition root** by review against ADR-0004 (the guard lives in the real `PutCommand`, not the core). The core test asserts `persistMessage` is the single persist call. *(Optional: a thin root-level test may assert the `PutCommand` input shape if `@aws-sdk` is locally available; not required for the app floor.)* |
| **2** | persist throws → **500**, no enqueue treated as success | `persistMessage` rejects; assert response `500` and `enqueueDelivery` **never called**. |
| **2** | enqueue throws after successful persist → **500** | `persistMessage` resolves, `enqueueDelivery` rejects; assert `500`. |
| **3** | honeypot `company` non-empty → **200** | Build event with `company` set (via `buildMessageRecord` through the real body path); assert `200`. |
| **3** | honeypot → **no** DDB write, **no** SQS enqueue | Assert `persistMessage` and `enqueueDelivery` **both** uncalled. |
| **3** | empty `company` → normal persist+enqueue path | Assert both collaborators called (reuses item 2 fakes). |
| **4** | already `sent` → **no-op** (no Resend, no marks) | `store.loadMessage` returns `{status:'sent'}`; assert `sendEmail` and all `store.mark*` uncalled. |
| **4** | Resend failure → mark `failed` **and re-throw** | `sendEmail` rejects; assert `store.markFailed(id, attempts, msg)` called **and** the handler promise rejects (SQS redelivers). |
| **4** | successful send → row `sent` | `sendEmail` resolves `{id}`; assert `store.markSent(id, attempts, info.id)` called; `markFailed` uncalled. |

The infra halves (SQS `maxReceiveCount:5` → DLQ → `ContactDlqAlarm` → SNS) remain review-against-
ADR-0004, not node tests (backlog "Out of scope").

## Consequences

- **No CI or package.json change.** The node test layer imports only the `*-core.js` modules +
  pure `common/*`; none import `@aws-sdk`. The repurposed `.github/workflows/tdd-verify.yml`
  (decision (b)) keeps `node --test` with **no install step**, and **no `aws/src` install** is
  needed locally or in CI. No dev dependency is added. ADR-0005's install-free node floor holds.
- The deployed Lambda contract (`export const handler`, real client wiring, idempotency guard,
  command shapes, re-throw semantics) is unchanged; this ADR adds seams, it does not supersede
  ADR-0004. `aws/template.yaml` handler entry points are untouched.
- New invariant to keep green: **`contact-ingress-core.js` and `contact-sender-core.js` must never
  import `@aws-sdk/*`.** If a future edit pulls the SDK into a core, the app floor breaks with
  `ERR_MODULE_NOT_FOUND` again — `tdd-critic` should watch for it; a one-line guard test that
  scans the two core files for an `@aws-sdk` import is a cheap optional reinforcement.
- `common/contact-shared.js` (pure, `node:crypto` only) and `common/resend.js` (fetch-based) are
  already directly unit-testable and need no seam — characterizing `buildMessageRecord`,
  `validateMessage`, `resolveCorsOrigin`, and `sendViaResend`'s retry directly is available to the
  loop if useful (a standing hardening item),
  but is not required by items 2–4.
- If the loop finds the shipped handlers have already drifted from this contract (e.g. a core that
  imports `@aws-sdk`, or a composition root that changed an observable behavior), that is drift for
  the inner loop to fix against this ADR — the architect records, does not implement.
