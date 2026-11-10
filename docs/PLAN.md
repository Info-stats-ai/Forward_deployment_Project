# Plan: the claims pilot

This plan builds the pilot in `docs/SPEC.md` on the stack in `docs/TECH_STACK.md`, starting from the hello-world skeleton. It has six phases, each building on the last: the records, then the claim workflow and its rules, then the agent, then the screens, and last the end-to-end tests and a live run.

## Approach

The main choices, and the reasons for them:

- **The backend enforces the rules, not the agent.** The $1,000 sign-off rule is checked in the payment operation itself, so a payment over the limit is refused whatever the agent asks for. The agent's instructions mention the rule, but nothing depends on the agent following it.
- **The agent only uses the API.** It gets claims, policies, claim history, the policy wording and its own instructions through HTTP calls to the backend, as `docs/TECH_STACK.md` asks. The backend never loads `data/evals/` or `data/security/`, so the answer key can't reach the agent by any route.
- **SQLite through Python's built-in `sqlite3`, with no ORM.** There are only a few tables, and structured parts of a record (a claim's items and documents, a policy's trip) are stored as JSON text. This keeps the code small (code standard 1).
- **The database seeds itself.** On startup, if the database file doesn't exist, the backend creates it and loads the queue, policies, customers and handlers from `data/`. Its path comes from `UNDERCOVER_DB` (default `backend/undercover.db`, which `.gitignore` already covers through `*.db`), so tests and the end-to-end run each get a fresh copy.
- **The agent's steps are recorded by its runner, not by the model.** `run()` streams the agent's progress and posts each tool call and each result to the backend as a step. The model can't skip or invent steps, and the dashboard shows them by polling while the claim is in progress.
- **The instructions live in the backend.** The agent's system prompt is `backend/instructions.md`, served read-only by `GET /api/instructions`. The agent and the dashboard both read it from there, so the screen always shows what the agent was actually told.
- **Tests never call a model.** Agent tests use the skeleton's stub model with scripted replies. End-to-end tests play the agent's part through the API (start, steps, decision) and check what the dashboard shows. The only real model calls are the manual live checks in phases 3 and 6.

### Claim states

| State | Meaning | Brand color |
|---|---|---|
| `waiting` | In the queue, not started (the seed data's `open`) | Marigold |
| `in_progress` | The agent is working on it | Cerulean |
| `awaiting_signoff` | Approved with a payout over $1,000, payment held for a handler | Coral |
| `decided` | Approved and paid, declined or referred | Sea Green |

### API operations

Every operation has an `operation_id`, a one-line docstring and no optional inputs.

| Method and path | `operation_id` | Used by |
|---|---|---|
| `GET /api/health` | `health` | dashboard |
| `GET /api/claims` | `list_claims` | dashboard |
| `GET /api/claims/{claim_id}` | `get_claim` | agent, dashboard |
| `GET /api/policies/{policy_id}` | `get_policy` | agent, dashboard |
| `GET /api/customers/{customer_id}` | `get_customer` | agent, dashboard |
| `GET /api/policy-wording` | `get_policy_wording` | agent |
| `GET /api/instructions` | `get_instructions` | agent, dashboard |
| `GET /api/handlers` | `list_handlers` | dashboard |
| `POST /api/claims/{claim_id}/start` | `start_claim` | agent runner |
| `POST /api/claims/{claim_id}/steps` | `add_step` | agent runner |
| `GET /api/claims/{claim_id}/steps` | `list_steps` | dashboard |
| `POST /api/claims/{claim_id}/decision` | `record_decision` | agent |
| `POST /api/claims/{claim_id}/payment` | `pay_claim` | agent |
| `POST /api/claims/{claim_id}/signoff` | `sign_off` | dashboard |
| `POST /api/claims/{claim_id}/run` | `run_agent` | dashboard |

The full claim from `get_claim` includes its decision and payment, if any. A decision is `outcome` (`approve`, `decline` or `refer`), `payout` (0 unless approved), `reason` (two or three sentences, including how the payout was worked out) and `policy_section` (such as "Section 3, Trip Delay").

## Phase 1: The records

Build the database, the seeding and the read operations.

- `backend/db.py`: the schema (claims, policies, customers, handlers, decisions, steps, payments), `connect()` using `UNDERCOVER_DB`, and seeding from `data/claims.json`, `policies.json`, `customers.json` and `handlers.json`, with each `open` claim becoming `waiting`.
- The read operations: `list_claims` (id, summary, type, amount claimed, status and the customer's name), `get_claim`, `get_policy`, `get_customer` (with claim history), `get_policy_wording` (`data/policy_wording.md` as text) and `list_handlers`. An unknown id returns 404.
- A pytest fixture that points `UNDERCOVER_DB` at a temporary file, so each test starts with fresh seed data.

Success criteria:

- [ ] `uv run pytest -q backend` passes, with tests for each read operation and a 404 for an unknown claim, policy and customer
- [ ] A test checks that seeding gives 25 claims, all `waiting`, and that CLM-1901 (the security claim) is not among them
- [ ] A test checks that no file under `backend/` refers to `evals` or `security`, and that no response contains a field from the answer key (such as `failure_class` or `difficulty`)
- [ ] With `npm run dev:backend` running, `curl http://localhost:8000/api/claims` returns 25 claims and `curl http://localhost:8000/api/claims/CLM-1001` returns the Rome trip delay with its 4 documents
- [ ] `curl http://localhost:8000/api/openapi.json` (or `/openapi.json`) shows an `operation_id` and a summary on every operation
- [ ] `npm run check:python` passes

## Phase 2: The claim workflow and its rules

Build the operations that move a claim through its states, and the payment rule.

- `start_claim`: moves a `waiting` claim to `in_progress`; any other state returns 409.
- `add_step` and `list_steps`: a step is a time, a kind (`tool_call`, `tool_result` or `message`) and a short text.
- `record_decision`: only for an `in_progress` claim. A decline or a refer moves it to `decided`. An approve with a payout of $1,000 or less moves it to `decided`, ready to pay. An approve over $1,000 moves it to `awaiting_signoff`. The limit comes from `data/company.json`, not a constant in the code.
- `pay_claim` takes the amount. It is refused with 409 if the claim has no approve decision, if the amount isn't the approved payout, if it has already been paid, or if the payout is over $1,000 and no handler has signed off.
- `sign_off` takes a handler id. Only a handler with `can_approve_over_limit` can sign off, and only on an `awaiting_signoff` claim. Sign-off records the handler, makes the payment for the approved payout and moves the claim to `decided`.
- `get_instructions` serves `backend/instructions.md`. This phase writes the first version: work the claim the way a handler does, follow the policy wording, use section 10 to work out the payout, and record one decision with a two or three sentence reason that cites the section.

Success criteria:

- [ ] `uv run pytest -q backend` passes, with a test for every transition above and every refusal
- [ ] A test approves a claim at $1,150, calls `pay_claim` for $1,150 and gets 409 with no payment recorded; after `sign_off` by HND-01 the claim is `decided` with one payment of $1,150
- [ ] A test checks that a handler without `can_approve_over_limit` gets 403 on sign-off
- [ ] A test approves a claim at $420, pays $420 and gets one payment; a second payment gets 409
- [ ] Through `curl` against the running backend, the same over-limit sequence gives the same responses
- [ ] `npm run check:python` passes

## Phase 3: The UnderCover Agent

Replace the hello-world agent with the claims agent.

- Tools, each a thin call to one API operation: `get_claim`, `get_policy`, `get_customer`, `get_policy_wording`, `record_decision` and `pay_claim`.
- `run(claim_id, thread_id)`: fetches the instructions from the backend, calls `start_claim`, then streams the agent and posts each tool call, tool result and final message to `add_step`. The model is chosen as now: `MODEL_NAME` if set, otherwise `openai/gpt-6-luna` with low reasoning effort.
- `agent/__main__.py`, so `uv run -m agent CLM-1001` runs the agent on one claim from the command line and prints its final reply.
- `run_agent` in the backend starts `run()` in a background task and returns at once, so the dashboard can start the agent and watch it work.

Success criteria:

- [ ] `uv run pytest -q agent` passes, with a stub model that reads the claim, policy, customer and wording, records an approve at $420 and pays it; the test checks the claim ends `decided`, paid, with its steps recorded in order
- [ ] A stub-model test approves over $1,000 and tries to pay; the payment is refused, the claim ends `awaiting_signoff` with no payment, and the refusal appears in the steps
- [ ] A test checks that `run_agent` returns at once and starts the runner for the claim (with the runner replaced by a stub)
- [ ] Live check, with `OPENROUTER_API_KEY` in `.env` and the backend running: `uv run -m agent CLM-1001` records an approve of $420.00 (a crew cancellation that left the traveler delayed from 11:40 to 06:55 the next day, over Premium's 6-hour waiting period, with $420 of receipts under the $800 maximum) and `curl .../api/claims/CLM-1001/steps` lists its tool calls
- [ ] `npm run check:python` passes

## Phase 4: The dashboard's queue and instructions

Build the dashboard's look and its first two screens.

- The brand from `docs/BRAND.md`: Instrument Sans, Instrument Serif and JetBrains Mono from Google Fonts in `index.html`; the colors as CSS variables with light and dark surfaces through `prefers-color-scheme`; rounded panels with no outlines; amounts as $1,250.00 in JetBrains Mono.
- A small typed API module (`dashboard/src/api.ts`) with the response types, and simple hash routing (`#/`, `#/claims/CLM-1001`, `#/instructions`) without a router library.
- The queue: a table of every claim with id, customer, type, amount claimed and a status chip in the state's color, plus a count of claims in each state. Each row opens its claim.
- The instructions: the agent's instructions, read only, with a note that they can't be changed here.

Success criteria:

- [ ] `vitest` tests cover the queue (rows, chips, counts), the instructions page and the routing, with `fetch` stubbed; `npm run check:ts` passes with 80% coverage
- [ ] In the browser through the Playwright MCP server, with `npm run dev` running: `http://localhost:5173` shows 25 claims all `Waiting`, in brand fonts and colors, and clicking CLM-1001 goes to `#/claims/CLM-1001`
- [ ] `#/instructions` shows the text of `backend/instructions.md` with no way to edit it
- [ ] A screenshot in dark mode (emulated through the MCP server) shows the dark surfaces

## Phase 5: The claim page

Build the screen where a handler sees a claim in full and watches the agent.

- The claim in full: summary, story, items, documents, the policy (plan, add-ons, trip dates and cost, travelers) and the customer's claim history.
- The decision: outcome, payout, reason and policy section, and the payment once it's made.
- The agent's activity: its steps in order, refreshed every second while the claim is `in_progress`, so the handler sees each tool call as it happens.
- A "Run agent" button on a `waiting` claim, which calls `run_agent`.
- On an `awaiting_signoff` claim, a sign-off panel: choose a handler who can approve over the limit, then "Sign off and pay", which calls `sign_off`.

Success criteria:

- [ ] `vitest` tests cover each part of the page, the polling (with fake timers), the run button and the sign-off; `npm run check:ts` passes with 80% coverage
- [ ] In the browser through the Playwright MCP server, CLM-1001 shows its story, its 3 items, its 4 documents, policy POL-2001 and the customer's earlier claim
- [ ] Live check: pressing "Run agent" on CLM-1001 shows the steps appearing while the agent works, then the decision with the payout of $420.00, and the queue shows CLM-1001 as `Decided`
- [ ] Live check: running the agent on CLM-1002 (a lost suitcase claimed at $1,150.00) shows either a decision at or under $1,000 that is paid, or an approval over $1,000 that waits in `Awaiting sign-off` with no payment until a handler signs off from the page

## Phase 6: End-to-end tests and the live run

Replace the skeleton's end-to-end test and run the whole pilot.

- End-to-end tests run against their own backend and dashboard on other ports with a fresh database (`UNDERCOVER_DB` under `e2e/test-results/`), started through a small `.mjs` script so it works on Windows. The Vite proxy target comes from an environment variable so the end-to-end dashboard talks to the end-to-end backend.
- The tests play the agent's part through Playwright's `request` API, so they never call a model:
  - the queue shows 25 waiting claims
  - a claim moved to `in_progress`, with steps added, shows those steps on its page
  - a decline shows its reason and section, and the queue shows it as decided
  - an approve over $1,000 can't be paid through the API, shows `Awaiting sign-off`, and after a sign-off on the page shows the payment
  - the instructions page shows the instructions
- A short `README` section in `docs/STATUS.md` on how to run everything.

Success criteria:

- [ ] `npm run e2e` passes, with each test above
- [ ] Live check: the agent runs on 5 claims from the dashboard (CLM-1001, CLM-1002, CLM-1004, CLM-1009 and CLM-1013). Each ends with a decision, a reason citing a section and a full list of steps, and no claim over $1,000 is paid without a sign-off
- [ ] `docs/STATUS.md` describes what's built and how to run it
- [ ] `npm run check` passes

## Not in this plan

As `docs/SPEC.md` says: the claims manual, sign-in, real payments and messages to customers. Scoring the agent against the handlers' decisions in `data/evals/` is also left out, as `docs/PROCESS.md` says not to open that folder unless asked; the pilot is built so that scoring can be added without changing it.
