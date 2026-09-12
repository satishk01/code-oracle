# 🔮 Codebase Oracle

**Local-first codebase knowledge graph** — parse any TypeScript/JavaScript repository into a queryable ontology-driven graph using KuzuDB, with impact analysis, architecture pattern detection, multi-repo management, an agentic Q&A assistant, generated documentation, and an interactive dashboard.

---

## What It Does

1. **Parses** your codebase using ts-morph AST analysis
2. **Builds a knowledge graph** in KuzuDB (embedded, zero-server) with typed nodes and edges
3. **Detects architecture patterns** (MVC, Repository, Factory, Middleware, DI, CQRS, etc.)
4. **Discovers API endpoints** automatically (Express/Fastify route patterns)
5. **Manages multiple repos** — index, switch between, and remove repositories safely at runtime
6. **Watches for file changes** and computes **impact analysis** in real-time
7. **Answers questions** via Ollama (local), Omniroute, or AWS Bedrock — with an agent mode that uses tools, permissions, memory, and audit logging
8. **Generates documentation** — business/functional overview, architecture, API reference, and developer guide as Markdown or HTML
9. **Visualizes** everything in an interactive React dashboard

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     React Dashboard                          │
│  ┌──────────┐ ┌────────┐ ┌────────┐ ┌──────┐ ┌────────────┐ │
│  │ Overview │ │ Graph  │ │ Impact │ │ Q&A  │ │ Docs/Agent │ │
│  └──────────┘ └────────┘ └────────┘ └──────┘ └────────────┘ │
└──────────────────────┬──────────────────────────────────────┘
                       │ REST API
┌──────────────────────┴──────────────────────────────────────┐
│                   Express API Server (:3001)                 │
│  ┌──────────┐ ┌────────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ Ingest   │ │ Graph Store│ │ Impact   │ │ LLM Provider│  │
│  │ Engine   │ │  (KuzuDB)  │ │ Analyzer │ │ (Ollama /   │  │
│  │          │ │            │ │          │ │  Omniroute /│  │
│  │          │ │            │ │          │ │  Bedrock)   │  │
│  └────┬─────┘ └─────┬──────┘ └────┬─────┘ └──────┬──────┘  │
│       │              │             │               │         │
│  ┌────┴─────┐   ┌────┴──────┐  ┌──┴───┐    ┌─────┴──────┐  │
│  │TS Parser │   │ Repo      │  │Choki-│    │ Agent      │  │
│  │(ts-morph)│   │ Registry  │  │ dar  │    │ Engine     │  │
│  └──────────┘   └───────────┘  └──────┘    └────────────┘  │
└────────────────────────┬────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │   store/  (STORE_DIR)│  ← all app data lives here
              │   ├─ repos.json      │
              │   ├─ repos/<repo>-<hash>/graph.db, hash-cache…
              │   └─ memory.json, pending-delete.json
              └─────────────────────┘
```

**All index data lives in the `store/` directory** — nothing is written into the analyzed repositories and nothing depends on a user home directory. See [Data Storage](#data-storage) below.

### Ontology Model (Node Types)

| Node Kind     | What it represents                              |
|---------------|--------------------------------------------------|
| Module        | A source file (.ts, .js, .tsx, .jsx)             |
| Class         | Class declaration                                |
| Interface     | Interface declaration                            |
| Function      | Standalone function                              |
| Method        | Class method                                     |
| TypeAlias     | Type alias                                       |
| Enum          | Enumeration                                      |
| Package       | package.json (dependencies, scripts)             |
| ArchPattern   | Detected architecture pattern                    |
| APIEndpoint   | HTTP route (Express-style)                       |
| Config        | Configuration file                               |

### Relationship Types (Edges)

| Edge Kind       | Meaning                                |
|-----------------|----------------------------------------|
| IMPORTS         | Module imports another module          |
| EXPORTS         | Module exports a symbol                |
| CONTAINS        | Parent → child (module → class → method) |
| EXTENDS         | Class/interface inheritance            |
| IMPLEMENTS      | Class implements interface             |
| CALLS           | Function/method calls another          |
| USES_TYPE       | Uses a type/interface                  |
| INSTANTIATES    | Creates an instance of a class         |
| FOLLOWS_PATTERN | Module/class follows an arch pattern   |
| EXPOSES         | Module exposes an API endpoint         |

---

## Quick Start

### Prerequisites

- **Node.js** ≥ 18
- **Ollama** (optional, for local AI Q&A) — https://ollama.ai — or an Omniroute / AWS Bedrock endpoint

### Setup

```bash
# 1. Install dependencies (root + frontend)
npm run setup

# 2. Configure environment
#    Copy .env.example to .env and edit:
#      REPO_ROOT  — repo to analyze on startup (defaults to cwd)
#      STORE_DIR  — where all app data lives (defaults to ./store)
cp .env.example .env

# 3. Build the backend
npm run build

# 4. Ingest your repo
npm run ingest -- /path/to/your/repo --full

# 5. Start the API server
npm start          # production (dist/)
# or
npm run dev        # development (tsx watch)

# 6. Start the dashboard (separate terminal)
npm run frontend

# 7. Open http://localhost:5173
#    (API on :3001, Vite dev server on :5173 proxies /api)
```

### CLI Commands

```bash
# Full ingestion (re-parse everything)
npm run ingest -- /path/to/repo --full

# Incremental ingestion (only changed files)
npm run ingest -- /path/to/repo

# Show stats
npx tsx src/cli.ts stats /path/to/repo

# Ask a question
npx tsx src/cli.ts query /path/to/repo "What patterns does this codebase use?"

# Impact analysis
npx tsx src/cli.ts impact /path/to/repo src/auth/login.ts src/models/user.ts

# Watch for changes (re-ingests + live impact reports)
npx tsx src/cli.ts watch /path/to/repo
```

### Testing

```bash
npm test           # run the test suite once (vitest)
npm run test:watch # watch mode
```

> Note: `src/analysis/__tests__/analysis.test.ts` expects this project's own
> graph to be populated — run `npm run ingest -- .` in the project root first
> if those tests report empty results.

---

## Managing Repositories

The dashboard and API support multiple repositories at once:

- **Index a repo:** Dashboard → enter path → Ingest, or `POST /api/ingest { "repoRoot": "..." }`
- **Switch active repo:** `POST /api/repo { "repoRoot": "..." }`
- **List indexed repos:** `GET /api/repos`
- **Remove a repo:** `DELETE /api/repos { "repoRoot": "...", "deleteData": true }`

Removing repositories — including the **last** one — never stops the backend.
The server keeps running with an empty graph; you can re-ingest or switch at any
time. When a repo's graph database is still held open by the running process,
its on-disk data directory is queued and physically removed on the next server
start (see `store/pending-delete.json`).

---

## Data Storage

All app data lives under `STORE_DIR` (default: `./store` in the working
directory — set a full path in `.env` for deployments):

```
store/
├── repos.json                 # registry of indexed repositories
├── pending-delete.json        # deferred deletions, drained at startup
├── memory.json                # global agent memory
├── ephemeral-*/               # throwaway stores (auto-cleaned)
└── repos/<name>-<pathhash>/   # per-repo index data
    ├── graph.db               # KuzuDB database
    ├── hash-cache.json        # incremental-ingest file hashes
    ├── memory.json            # workspace-scoped agent memory
    └── audit-log.json         # agent tool-call audit log
```

Nothing is written into the analyzed repositories — `.codebase-oracle/` is no
longer used. On startup, any existing per-repo `.codebase-oracle` directories
are automatically migrated into `store/repos/`, and a legacy
`~/.codebase-oracle/repos.json` registry is imported once.

For EC2/containers: set `STORE_DIR` to an absolute path (e.g.
`/var/lib/codebase-oracle`) so the data location doesn't depend on the
process working directory.

---

## LLM Providers

Set `LLM_PROVIDER` in `.env` to one of:

| Provider    | Config keys                                        | Notes                          |
|-------------|-----------------------------------------------------|--------------------------------|
| `ollama`    | `OLLAMA_URL`, `OLLAMA_MODEL`                        | Fully local — no API key needed |
| `omniroute` | `OMNIROUTE_URL`, `OMNIROUTE_MODEL`, `OMNIROUTE_API_KEY` | OpenAI-compatible gateway   |
| `bedrock`   | `BEDROCK_REGION`, `BEDROCK_MODEL`, `BEDROCK_AUTH_METHOD`, plus auth keys | IAM or API-key auth |

Q&A works without any provider configured — it falls back to structured
graph-only answers.

### Ollama Setup (optional)

```bash
ollama pull llama3.2
# Server auto-connects to OLLAMA_URL (default http://localhost:11434)
```

---

## Dashboard Features

### 📊 Overview
Entity counts, detected architecture patterns, and API endpoints at a glance.

### 🕸 Graph Explorer & Mindmap
Interactive force-directed graph with type filters, search, and node details —
plus a hierarchical mindmap view of the codebase structure.

### ⚡ Impact Analysis
Risk score, direct/transitive impacts, affected endpoints, touched patterns —
including live impact reports from the file watcher.

### 💬 Q&A / Agent
Natural-language questions about the codebase. Agent mode adds tool use with a
permission system (`AGENT_PERMISSION_MODE`: `discuss` / `plan` / `interactive` /
`auto-approve` / `bypass`), per-workspace memory, and an audit log.

### 📄 Docs
Generates a full handbook — Business & Functional Overview, Architecture, API
Reference, Technical Code Reference, and Developer Guide — as Markdown or
standalone HTML. Add `?llm=true` to `/api/docs/generate` for LLM-written
summaries.

---

## Key Design Decisions

1. **KuzuDB (embedded)** — no database server to manage; each repo's graph lives under `store/repos/<name>-<hash>/graph.db`
2. **Centralized store** — all app data under `STORE_DIR`; nothing written into analyzed repos, nothing in user home dirs (deployment-friendly)
3. **Safe repository deletion** — removing a repo never kills the process; data dirs are deleted immediately when unopened, or deferred to the next startup while a KuzuDB handle is open
4. **ts-morph for AST parsing** — full TypeScript compiler API access for accurate type-aware analysis
5. **Incremental ingestion** — content-hash-based change detection means re-indexing is fast
6. **Ontology-first** — the schema defines what entities and relationships exist before any parsing happens
7. **Local-first** — no GitHub API, no required cloud services; everything can run on your machine
8. **Provider-agnostic LLM** — Ollama, Omniroute, or Bedrock; graph-only fallback works without any LLM

---

## Environment Variables

| Variable               | Default                   | Description                              |
|------------------------|---------------------------|------------------------------------------|
| `REPO_ROOT`            | current directory         | Repository to analyze on startup         |
| `PORT`                 | `3001`                    | API server port                          |
| `STORE_DIR`            | `./store`                 | App data directory (registry + indexes)  |
| `LLM_PROVIDER`         | `ollama`                  | `ollama` · `omniroute` · `bedrock`       |
| `OLLAMA_URL`           | `http://localhost:11434`  | Ollama API endpoint                      |
| `OLLAMA_MODEL`         | `llama3.2`                | Ollama model for Q&A                     |
| `OMNIROUTE_URL`        | `http://localhost:20128`  | Omniroute endpoint                       |
| `OMNIROUTE_MODEL`      | `auto`                    | Omniroute model                          |
| `OMNIROUTE_API_KEY`    | —                         | Omniroute Bearer token (optional)        |
| `BEDROCK_REGION`       | `us-east-1`               | AWS region                               |
| `BEDROCK_MODEL`        | —                         | Bedrock model ID                         |
| `BEDROCK_AUTH_METHOD`  | `iam-long-term`           | `iam-long-term`/`iam-short-term`/`api-key`/`api-key-endpoint` |
| `BEDROCK_ACCESS_KEY_ID` / `BEDROCK_SECRET_ACCESS_KEY` / `BEDROCK_SESSION_TOKEN` | — | IAM credentials |
| `BEDROCK_API_KEY` / `BEDROCK_ENDPOINT` | —            | API-key auth / custom endpoint           |
| `LOG_LEVEL`            | `info`                    | `debug`·`info`·`warn`·`error`·`silent`   |
| `AGENT_MAX_ITERATIONS` | `15`                      | Agent tool-loop iteration cap            |
| `AGENT_PERMISSION_MODE`| `interactive`             | `discuss`·`plan`·`interactive`·`auto-approve`·`bypass` |
| `AGENT_TOKEN_BUDGET`   | `120000`                  | Context compaction budget                |

See `.env.example` for the full annotated list.

---

## Development

```bash
npm run build        # compile TypeScript → dist/
npm run dev          # tsx watch on the API server
npm run frontend     # vite dev server for the dashboard
npm run lint         # eslint (requires eslint.config.* migration — see note)
npm run format       # prettier
```

> **Note:** the repo still ships an `.eslintrc.cjs`; ESLint v9 requires
> `eslint.config.js`. `npm run lint` will not work until the config is migrated.

---
