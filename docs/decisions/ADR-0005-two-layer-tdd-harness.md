# ADR-0005 — Two-layer TDD harness (app = node:test, chat = pytest)

## Status

Accepted. (Retroactively recorded during the teamentic adoption bootstrap.)

## Context

The repo holds two distinct codebases with different runtimes: the static site +
AWS contact Lambda handlers (JavaScript, under `js/ scripts/ aws/`), and the
Gemini chat/voice backend (Python FastAPI, under `docker/chat/app/`). A single test
command can't cover both cleanly — the Python tree has its own dependency set
(langchain, google-genai) and a much larger suite, and forcing every edit through a
cold Python import would make the TDD loop slow and fragile on machines without a
local Python env.

## Decision

Define **two independently-tested layers**, with `node --test` as the canonical
always-present floor:

- **app layer:** `node --test "test/*.test.mjs"` over source under `js/`, `scripts/`, and
  `aws/`. This is the fast, always-present canonical bar — never regress it. Individual
  suites are also exposed as npm scripts (e.g. `npm run test:reduced-motion`).
- **chat layer:** `cd docker/chat && PYTHONPATH=. python3 -m pytest tests -q` over source
  under `docker/chat/app/`. Cold start imports langchain (~100s once per session), which is
  why the always-on floor stays node-only on purpose.
- **CI gating:** `.github/workflows/docker-compose-chat-ci.yml` validates/builds the
  compose stack and runs the pytest suite (`working-directory: docker/chat`,
  `PYTHONPATH=. python -m pytest tests -v`).

## Consequences

- The split is deliberate and matches the runtime boundary: JS edits are gated by
  node:test, Python edits by pytest, and neither blocks the other.
- Contributors need a Python environment only when touching `docker/chat/`. Everything
  else is verifiable with Node alone, no install step required.
- Adding a third runtime means adding a third layer and its own command, not widening
  either existing one.
