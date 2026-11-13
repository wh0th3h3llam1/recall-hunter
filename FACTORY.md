# How we built Recall Hunter: a contract-first software factory

Problem with AI-built software: lots of agents produce lots of plausible code that doesn't fit together, with fake data presented as working. Our factory adds four checks against that.

1. **Contracts before code.** `contracts/CONTRACTS.md` fixed the DB schema, Python function signatures, SSE event names and HTTP JSON shapes *before* any agent wrote code. Agents code against the contract, not against each other.
2. **Separate file ownership.** Each agent owns a folder and may not edit anyone else's:
   - Lead: API, schema, ingest, integration
   - Agent A: `web/**` (3D UI)
   - Agent B: `app/gemini/**`, `app/hunter/**` (AI pipeline)
   - Agent C: `app/sources/**` (Bright Data)
   - Agent E: `qa/**` (Playwright QA)
   With no shared files, merges can't conflict and nobody silently rewrites another agent's work.
3. **A proof log instead of claims.** Every external call (Bright Data, Gemini, CPSC, DigitalOcean, Snowflake) goes through `obs.log_call` into a Tiger hypertable `rh.api_calls`. The UI's **Proof** drawer reads it. If a sponsor shows no rows, it didn't run, and the UI says "NOT CONFIGURED" instead of pretending.
4. **Verification gates.** Each agent had to run its piece against real services before handing off. The positive/negative control tests for the Gemini funnel live in `app/gemini/_smoke.py`. A Playwright pass on the running app (screenshots plus console and network errors) is the final gate.

See `PROGRESS.md` for what was verified, what is mocked (nothing in the product path) and what failed.
