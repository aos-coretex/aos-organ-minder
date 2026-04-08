# Minder — ESB Organ

## What this is

Minder is the person memory organ (Monad Leg 3). It manages observations about people and personas through a 4-level hierarchy (explicit, deductive, inductive, contradiction) and synthesizes person cards via a 4-phase dream cycle. This is the ESB organ — a new process on port 4007 (AOS) / 3907 (SAAS), separate from the existing MCP server.

## Architecture

- **Runtime:** Node.js, Express 5, ES modules
- **Test runner:** Node.js built-in (`node --test`)
- **Database:** PostgreSQL `minder` on localhost:5432 (existing — do NOT create tables)
- **Spine:** WebSocket connection to Spine ESB at ws://127.0.0.1:4000
- **Embedding:** Vectr sidecar at http://127.0.0.1:3901 (graceful degradation)
- **LLM:** 5 internal service agents via `@coretex/organ-boot/llm-client`
- **Boot:** Uses `createOrgan()` from `@coretex/organ-boot`

## Internal Service Agents

| Agent | Model | Purpose |
|---|---|---|
| Deriver | claude-haiku-4-5-20251001 | Extract explicit observations from messages |
| Deduction worker | claude-haiku-4-5-20251001 | Logical inference from facts (dream Phase 1) |
| Induction worker | claude-sonnet-4-6 | Pattern generalization (dream Phase 2) |
| Dialectic worker | claude-haiku-4-5-20251001 (+ thinking) | NL query answering + contradiction detection (dream Phase 3) |
| Card generator | claude-sonnet-4-6 | Biographical summary synthesis (dream Phase 4) |

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/peers` | POST | Register a new peer |
| `/peers/:peer_id` | DELETE | Retire a peer |
| `/ingest` | POST | Ingest conversation messages |
| `/derive` | POST | Manual derivation trigger |
| `/peers/:peer_id/card` | GET | Current person card |
| `/peers/:peer_id/representation` | GET | Full representation with observation stats |
| `/query` | POST | Natural language query about a person |
| `/search` | POST | Semantic vector search across observations |
| `/dream` | POST | Trigger dream cycle |
| `/peers/:peer_id/dream-analysis` | GET | LLM analysis of dream results |
| `/peers/:peer_id/perception` | GET | LLM perception analysis of card |
| `/identify` | POST | Identify a person at session start |
| `/config/:key` | GET/PUT | Read/write configuration values |
| `/stats` | GET | System-wide statistics |
| `/health` | GET | Standard health endpoint (via organ-boot) |
| `/introspect` | GET | Standard introspect endpoint (via organ-boot) |

## Dream Cycle (4 phases)

1. **Deduction** — derive logical conclusions from explicit facts
2. **Induction** — identify patterns across all observation levels
3. **Contradiction** — detect mutually exclusive observations, soft-delete losers
4. **Card generation** — synthesize max-40-entry biographical summary

**Default:** DISABLED (`DREAM_ENABLED=false`). The monolith continues running production dreams.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MINDER_PORT` | `4007` | HTTP port (4007=AOS, 3907=SAAS) |
| `MINDER_DB_HOST` | `localhost` | PostgreSQL host |
| `MINDER_DB_PORT` | `5432` | PostgreSQL port |
| `MINDER_DB_NAME` | `minder` | Database name |
| `MINDER_DB_USER` | `graphheight_sys` | Database user |
| `SPINE_URL` | `http://127.0.0.1:4000` | Spine ESB URL |
| `LLM_OPS_EMBEDDING_URL` | `http://127.0.0.1:3901` | Vectr embedding URL |
| `DREAM_ENABLED` | `false` | Enable automatic dream timer |
| `ANTHROPIC_API_KEY` | — | Required for all LLM agents |
| `DERIVE_TOKEN_THRESHOLD` | `1000` | Token threshold for auto-derivation |
| `CARD_MAX_ENTRIES` | `40` | Max entries in person card |

## Running

```bash
npm install
npm test           # Run unit tests (mock DB)
npm start          # Start organ (requires Spine + PostgreSQL)
```

## Zero Cross-Contamination Rules

- Never reference `ai-kb.db` or `AI-Datastore/`
- Never reference `AOS-software-dev/` paths
- Never use ports 3800-3851 (monolith range)
- Never import from monolith MCP packages
