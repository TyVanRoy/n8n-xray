# n8n-xray

Point this at any n8n instance and get a complete, navigable documentation suite — from high-level system architecture down to per-workflow pseudocode.

**The problem:** n8n is great for building automations, but once you have dozens (or hundreds) of workflows, understanding how they all fit together becomes impossible. Workflow names are cryptic, dependencies are implicit, and there's no bird's-eye view.

**What this does:** A four-phase pipeline that exports every workflow from your n8n instance, statically analyzes the structure, sends each one to Claude for deep documentation, then synthesizes connected workflows into system-level narratives. The output is a self-contained documentation directory you can browse, search, or hand to your team.

## What you get

```
output/
├── analysis/
│   ├── README.md                        # Navigation guide for the analysis
│   ├── 03_SYSTEMS_OVERVIEW.md           # Start here — high-level map of all systems
│   ├── 02_BUSINESS_FUNCTION_GROUPS.md   # Workflows grouped by business function
│   ├── 01_DEPENDENCY_GRAPH.md           # Mermaid diagram of cross-workflow calls
│   ├── 00_TABLE_OF_CONTENTS.md          # Full stats, service usage, searchable index
│   ├── analysis.json                    # Structured data (for programmatic use)
│   ├── systems/                         # Per-system deep dives
│   │   ├── translation_pipeline.md      #   Architecture, data flow, concerns, migration notes
│   │   ├── content_enrichment.md
│   │   ├── standalone_workflows.md      #   Independent workflows catalogued
│   │   └── ...
│   └── workflows/                       # Per-workflow detail
│       ├── {id}__{name}.md              #   Executive summary, logic flow, dependencies, concerns
│       └── ...
└── workflows/                           # Raw exported JSON
    ├── {id}__{name}.json
    └── _manifest.json
```

## Quick start

```bash
# 1. Install
git clone <this-repo> && cd n8n-xray
npm install
cp .env.example .env  # fill in your keys

# 2. Run everything
npm run all
```

That's it. Open `output/analysis/03_SYSTEMS_OVERVIEW.md` to start reading.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

| Variable | Required | Default | Used by |
| --- | --- | --- | --- |
| `N8N_API_KEY` | Export | — | Export |
| `N8N_BASE_URL` | No | `http://localhost:5678` | Export |
| `ANTHROPIC_API_KEY` | Analyze + Synthesize | — | Analyze, Synthesize |
| `ANTHROPIC_ANALYZE_MODEL` | No | `claude-sonnet-4-6` | Analyze |
| `ANTHROPIC_SYNTHESIS_MODEL` | No | `claude-sonnet-4-6` | Synthesize |
| `CONCURRENCY` | No | `5` / `3` | Parallel LLM requests |
| `OUTPUT_DIR` | No | `./output` | All phases |

You can use a cheaper/faster model for per-workflow analysis and a stronger model for synthesis, or set both to the same model.

### Generating an n8n API Key

1. Open your n8n instance
2. Go to **Settings → API**
3. Click **Create API Key**
4. Copy the key into your `.env` as `N8N_API_KEY`

## Usage

### Run the full pipeline

```bash
npm run all       # export → scan → analyze → synthesize
```

### Run phases individually

```bash
npm run export        # Pull workflow JSON from n8n
npm run scan          # Static analysis (no LLM, no API key needed)
npm run analyze       # LLM-powered deep analysis of each workflow
npm run synthesize    # System-level synthesis + README generation
```

### Already have the exported JSON?

```bash
npm run report    # scan → analyze → synthesize (skips export)
```

### Resumability

Every phase is resumable. If interrupted, just re-run the same command — it picks up where it left off by checking for completion markers in the output files. To force a full re-run of a phase, delete its output files.

## How it works

### Export

Pulls every workflow from the n8n REST API and saves them as individual JSON files with a manifest.

### Scan

Parses each workflow JSON without any LLM to extract: triggers (webhook, cron, manual, sub-workflow), external services and credentials, cross-workflow dependencies ("Execute Workflow" nodes), HTTP endpoints, and node counts. Produces a table of contents, a Mermaid dependency graph, per-workflow stubs, and a structured `analysis.json`.

### Analyze

Sends each workflow's full JSON plus a condensed registry of all workflows to Claude. For each workflow, generates: an executive summary, trigger details, inputs/outputs, step-by-step logic flow in pseudocode, external dependencies, cross-references, and potential concerns (hardcoded secrets, missing error handling, dead code, etc.). Also runs a grouping pass to categorize workflows by business function.

### Synthesize

Walks the dependency graph to find connected components — groups of workflows that call each other. For each system, generates an architectural narrative covering: purpose, architecture, workflow inventory, data flow, key concerns, and migration notes. Produces a top-level systems overview, a standalone workflows catalogue, and enriches all docs with navigation and explainer sections.

## Cost estimate

Export and Scan are free (no LLM calls). Analyze and Synthesize cost roughly **$0.01–0.02 per workflow** at Sonnet pricing. A 200-workflow instance runs about **$2–5 total**.

## License

MIT
