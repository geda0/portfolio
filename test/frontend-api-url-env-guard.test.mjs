import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Guard against the 2026-06-04 incident: a fast-forward of `agent` -> `main` silently
// carried the STAGING API meta URLs onto `main`, and AWS Amplify (which serves the
// committed HTML as-is — there is no amplify.yml, and the deploy workflows run with
// SYNC_API_URLS=0) briefly published the staging contact + chat backends as production.
//
// `index.html` and `admin/index.html` legitimately DIVERGE between the two branches ONLY
// on the `portfolio:*-api-url` meta tags:
//   main  (prod,    www.example.com)  -> abcd123456.execute-api… + <express-prod>.ecs.us-east-2.on.aws
//   agent (staging, chat.example.com) -> ijkl345678.execute-api… + <express-stage>.ecs.us-east-2.on.aws
//
// This guard pins that divergence: on `main` the shipped HTML MUST carry the prod hosts and
// MUST NOT carry any staging host; on `agent` the inverse. It is environment-gated so it never
// fails on a feature branch or a plain local `node --test`:
//   - explicit : PORTFOLIO_EXPECTED_ENV=prod|stage           (set by the deploy workflows, fail-fast)
//   - automatic: GITHUB_REF_NAME main->prod, agent->stage (rides the existing CI `node --test`)
//   - otherwise: skipped.

const REPO = fileURLToPath(new URL('..', import.meta.url))

// Per-environment hosts. We pin the HOST (which backend), not the full path, so a legitimate
// path change does not trip the guard — the incident was a host swap, not a path change.
const ENV_HOSTS = {
  prod: {
    contact: 'abcd123456.execute-api.us-east-2.amazonaws.com',
    // ADR-0022: prod chat moved OFF the ECS Express host onto its OWN CloudFront distribution,
    // 2026-10-08, after the same shape ran on stage. `/api/chat` goes to the response-streaming
    // Lambda Function URL via OAC; everything else — the paid voice mint included — goes to the
    // throttled prod HttpApi. VERIFIED through this front door before the flip: /health 200,
    // streaming returns token then done, a forged sessionId is rejected 400, and the voice mint
    // returns liveVoiceTransport=direct_google with a Google wss URL, so the browser still
    // connects straight to Google.
    // The PRIOR value was 'example-chat-host-prev.ecs.us-east-2.on.aws' (ECS
    // Express). That service is deliberately STILL RUNNING: per ADR-0022 §27.1 its hostname is
    // unrecoverable once deleted, so Express-still-existing IS the rollback, and reverting this
    // flip is a one-line meta change for as long as that holds. Do not delete it to tidy up.
    chat: 'd222222abcdef8.cloudfront.net'
  },
  stage: {
    contact: 'ijkl345678.execute-api.us-east-2.amazonaws.com',
    // ADR-0022: staging chat moved OFF the ECS Express host onto the CloudFront distribution
    // that fronts both origins — `/api/chat` to the response-streaming Lambda Function URL via
    // OAC, everything else (the paid voice mint included) to the throttled HttpApi. Prod is
    // deliberately NOT moved: that is gated on a human voice pass and the Lambda concurrency
    // quota. A public Function URL cannot be reached directly (anonymous AuthType NONE is
    // blocked account-wide), so the distribution is not an optimisation here, it is the only
    // browser-reachable streaming path.
    chat: 'd111111abcdef8.cloudfront.net'
  }
}

function resolveExpectedEnv (env) {
  const explicit = String(env.PORTFOLIO_EXPECTED_ENV || '').trim().toLowerCase()
  if (explicit === 'prod' || explicit === 'production') return 'prod'
  if (explicit === 'stage' || explicit === 'staging') return 'stage'
  if (explicit) return null // explicit but unrecognized -> do not guess an environment
  // Branch inference, so the guard ARMS ITSELF wherever it runs:
  //   GITHUB_REF_NAME — GitHub Actions
  //   AWS_BRANCH      — AWS Amplify (set by the build; needs no console configuration)
  //
  // AWS_BRANCH added 2026-10-14 after measuring that PORTFOLIO_EXPECTED_ENV is unset on EVERY
  // Amplify app and branch, so this guard resolved nothing and SKIPPED on every Amplify build
  // it has ever run in — it was decoration. The miss was real: merging main into agent carried
  // PROD hosts onto the staging branch and three consecutive stage builds reported SUCCEED.
  //
  // A guard whose arming depends on someone remembering a console variable is unarmed exactly
  // when it matters. Do not reduce this back to PORTFOLIO_EXPECTED_ENV alone.
  const branch = String(env.GITHUB_REF_NAME || env.AWS_BRANCH || '').trim()
  if (branch === 'main') return 'prod'
  if (branch === 'agent') return 'stage'
  return null
}

function metaUrl (html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = html.match(new RegExp(`<meta\\s+name="${escaped}"\\s+content="([^"]*)"`, 'i'))
  return m ? m[1] : null
}

function readFrontend (rel) {
  return readFileSync(join(REPO, rel), 'utf8')
}

const expected = resolveExpectedEnv(process.env)

if (!expected) {
  test('frontend API URL environment guard (skipped: no target environment)', {
    skip: 'set PORTFOLIO_EXPECTED_ENV=prod|stage, or run on the main/agent branch in CI'
  }, () => {})
} else {
  const other = expected === 'prod' ? 'stage' : 'prod'
  const want = ENV_HOSTS[expected]
  const forbidden = ENV_HOSTS[other]
  const E = expected.toUpperCase()
  const O = other.toUpperCase()

  test(`index.html meta API hosts are ${E}, never ${O}`, () => {
    const html = readFrontend('index.html')
    const contact = metaUrl(html, 'portfolio:contact-api-url')
    const chat = metaUrl(html, 'portfolio:chat-api-url')

    assert.ok(contact, 'index.html is missing the portfolio:contact-api-url meta tag')
    assert.ok(chat, 'index.html is missing the portfolio:chat-api-url meta tag')

    assert.ok(contact.includes(want.contact), `contact meta must point at the ${expected} host ${want.contact} (got: ${contact})`)
    assert.ok(chat.includes(want.chat), `chat meta must point at the ${expected} host ${want.chat} (got: ${chat})`)

    assert.ok(!contact.includes(forbidden.contact), `contact meta must NOT carry the ${other} host ${forbidden.contact} — env leak: ${contact}`)
    assert.ok(!chat.includes(forbidden.chat), `chat meta must NOT carry the ${other} host ${forbidden.chat} — env leak: ${chat}`)
  })

  test(`admin/index.html contact meta host is ${E}, never ${O}`, () => {
    const html = readFrontend('admin/index.html')
    const contact = metaUrl(html, 'portfolio:contact-api-url')

    assert.ok(contact, 'admin/index.html is missing the portfolio:contact-api-url meta tag')
    assert.ok(contact.includes(want.contact), `admin contact meta must point at the ${expected} host ${want.contact} (got: ${contact})`)
    assert.ok(!contact.includes(forbidden.contact), `admin contact meta must NOT carry the ${other} host ${forbidden.contact} — env leak: ${contact}`)
  })

  test(`admin/index.html chat meta host is ${E}, never ${O}`, () => {
    // The dashboard's deep live-smoke probe calls the chat host from this meta; pin it to
    // the right environment so a stage chat host can never reach prod admin (or vice versa).
    const html = readFrontend('admin/index.html')
    const chat = metaUrl(html, 'portfolio:chat-api-url')

    assert.ok(chat, 'admin/index.html is missing the portfolio:chat-api-url meta tag')
    assert.ok(chat.includes(want.chat), `admin chat meta must point at the ${expected} host ${want.chat} (got: ${chat})`)
    assert.ok(!chat.includes(forbidden.chat), `admin chat meta must NOT carry the ${other} host ${forbidden.chat} — env leak: ${chat}`)
  })
}
