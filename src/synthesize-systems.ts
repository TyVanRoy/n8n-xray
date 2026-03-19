import * as fs from "fs";
import * as path from "path";
require("dotenv").config({
    path: "./.env",
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_SYNTHESIS_MODEL || "claude-sonnet-4-6";
const OUTPUT_ROOT = process.env.OUTPUT_DIR || "./output";
const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || path.join(OUTPUT_ROOT, "workflows");
const ANALYSIS_DIR = process.env.ANALYSIS_OUTPUT_DIR || path.join(OUTPUT_ROOT, "analysis");
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "3", 10);
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

// Marker names that signal "not actually used" even if active flag is true
const EXCLUDED_NAME_PATTERNS = [/\bNOT IT USED\b/i, /\bDEPRECATED\b/i];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ManifestEntry {
    id: string;
    name: string;
    active: boolean;
    nodeCount: number;
    filename: string;
    tags: string[];
}

interface AnalysisEntry {
    id: string;
    name: string;
    active: boolean;
    tags: string[];
    nodeCount: number;
    triggers: { type: string; nodeName: string; detail?: string }[];
    callsWorkflows: {
        targetWorkflowId: string;
        targetWorkflowName?: string;
        sourceNodeName: string;
    }[];
    calledByWorkflows: {
        targetWorkflowId: string;
        targetWorkflowName?: string;
        sourceNodeName: string;
    }[];
    externalServices: { service: string; count: number }[];
    markdownFile: string;
}

interface AnalysisJson {
    totalWorkflows: number;
    dependencyGraph: {
        nodes: string[];
        edges: { from: string; to: string; fromId: string; toId: string }[];
    };
    workflows: AnalysisEntry[];
}

interface WorkflowDigest {
    id: string;
    name: string;
    nodeCount: number;
    triggers: string[];
    services: string[];
    callsIds: string[];
    calledByIds: string[];
    executiveSummary: string;
    crossReferences: string;
    concerns: string;
    markdownFile: string;
}

interface System {
    name: string;
    slug: string;
    workflows: WorkflowDigest[];
    /** IDs of workflows in this system */
    workflowIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Anthropic API helper (same as llm-analyze.ts)
// ---------------------------------------------------------------------------
async function callAnthropic(
    system: string,
    userMessage: string,
    maxTokens: number = 8192,
): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const res = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": ANTHROPIC_API_KEY!,
                    "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                    model: MODEL,
                    max_tokens: maxTokens,
                    system,
                    messages: [{ role: "user", content: userMessage }],
                }),
            });

            if (res.status === 429 || res.status === 529) {
                const retryAfter = res.headers.get("retry-after");
                const delay = retryAfter
                    ? parseInt(retryAfter, 10) * 1000
                    : RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
                console.warn(
                    `    Rate limited (${res.status}), retrying in ${delay}ms…`,
                );
                await sleep(delay);
                continue;
            }

            if (!res.ok) {
                const body = await res.text();
                throw new Error(`API error ${res.status}: ${body}`);
            }

            const data = await res.json();
            const text = (data as any).content
                ?.filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("\n");

            if (!text) throw new Error("Empty response from API");
            return text;
        } catch (err) {
            lastError = err as Error;
            if (attempt < MAX_RETRIES - 1) {
                const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
                console.warn(
                    `    Error: ${lastError.message}. Retrying in ${delay}ms…`,
                );
                await sleep(delay);
            }
        }
    }

    throw lastError || new Error("Failed after retries");
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

class Semaphore {
    private queue: (() => void)[] = [];
    private running = 0;
    constructor(private max: number) {}
    async acquire(): Promise<void> {
        if (this.running < this.max) {
            this.running++;
            return;
        }
        await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    release(): void {
        this.running--;
        const next = this.queue.shift();
        if (next) {
            this.running++;
            next();
        }
    }
}

// ---------------------------------------------------------------------------
// Extract sections from LLM-generated workflow markdown
// ---------------------------------------------------------------------------
function extractSection(markdown: string, heading: string): string {
    const pattern = new RegExp(
        `## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`,
    );
    const match = markdown.match(pattern);
    return match ? match[1].trim() : "";
}

// ---------------------------------------------------------------------------
// Filter: active + not excluded by name pattern
// ---------------------------------------------------------------------------
function isIncluded(entry: { name: string; active: boolean }): boolean {
    if (!entry.active) return false;
    for (const pat of EXCLUDED_NAME_PATTERNS) {
        if (pat.test(entry.name)) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Build digests from analysis.json + LLM markdown files
// ---------------------------------------------------------------------------
function buildDigests(
    analysis: AnalysisJson,
    analysisDir: string,
): WorkflowDigest[] {
    const digests: WorkflowDigest[] = [];
    const stubsDir = path.join(analysisDir, "workflows");

    for (const entry of analysis.workflows) {
        if (!isIncluded(entry)) continue;

        const mdPath = path.join(stubsDir, entry.markdownFile);
        if (!fs.existsSync(mdPath)) {
            console.warn(`  WARN: ${entry.markdownFile} not found, skipping`);
            continue;
        }

        const md = fs.readFileSync(mdPath, "utf-8");

        // Only include workflows that have been LLM-analyzed
        if (!md.includes("<!-- phase2-complete -->")) {
            console.warn(
                `  WARN: ${entry.name} not yet LLM-analyzed, skipping`,
            );
            continue;
        }

        digests.push({
            id: entry.id,
            name: entry.name,
            nodeCount: entry.nodeCount,
            triggers: entry.triggers.map(
                (t) => `${t.type}${t.detail ? ` (${t.detail})` : ""}`,
            ),
            services: entry.externalServices.map((s) => s.service),
            callsIds: entry.callsWorkflows.map((c) => c.targetWorkflowId),
            calledByIds: entry.calledByWorkflows.map(
                (c) => c.targetWorkflowId,
            ),
            executiveSummary: extractSection(md, "Executive Summary"),
            crossReferences: extractSection(md, "Cross-References"),
            concerns: extractSection(md, "Potential Concerns"),
            markdownFile: entry.markdownFile,
        });
    }

    return digests;
}

// ---------------------------------------------------------------------------
// Graph walk: find connected components via dependency edges
// ---------------------------------------------------------------------------
function findConnectedSystems(digests: WorkflowDigest[]): WorkflowDigest[][] {
    const idToDigest = new Map(digests.map((d) => [d.id, d]));
    const activeIds = new Set(digests.map((d) => d.id));
    const visited = new Set<string>();

    function bfs(startId: string): WorkflowDigest[] {
        const component: WorkflowDigest[] = [];
        const queue = [startId];
        visited.add(startId);

        while (queue.length > 0) {
            const id = queue.shift()!;
            const digest = idToDigest.get(id);
            if (digest) component.push(digest);

            // Walk both directions
            const neighbors = [
                ...(digest?.callsIds ?? []),
                ...(digest?.calledByIds ?? []),
            ];
            for (const nid of neighbors) {
                if (!visited.has(nid) && activeIds.has(nid)) {
                    visited.add(nid);
                    queue.push(nid);
                }
            }
        }

        return component;
    }

    const components: WorkflowDigest[][] = [];
    for (const digest of digests) {
        if (!visited.has(digest.id)) {
            const component = bfs(digest.id);
            components.push(component);
        }
    }

    // Sort: largest systems first
    components.sort((a, b) => b.length - a.length);
    return components;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
function buildSystemPrompt(
    workflows: WorkflowDigest[],
    allDigests: WorkflowDigest[],
): { system: string; user: string } {
    const system = `You are a senior software architect writing internal documentation for a CTO who needs to understand a portfolio of n8n automation workflows before migrating them to code.

You will receive a group of related workflows that form a connected system (they call each other or share a pipeline). For each workflow you get: name, executive summary, triggers, services used, cross-references, and concerns.

Write a clear, readable markdown document (NO top-level # heading — that will be added programmatically) with these sections:

## Purpose
2-4 sentences explaining what this system does as a whole, in business terms. What problem does it solve? Who benefits?

## Architecture
Describe how the workflows connect. Which are entry points (triggered externally)? Which are shared sub-workflows? What's the data flow from start to finish? Use a concise diagram-like description or numbered flow. If there are DEV/PROD/FIX variants, note which is the canonical production path.

## Workflow Inventory
A table of the workflows in this system:

| Workflow | Role | Triggers | Key Services |
| --- | --- | --- | --- |

Where "Role" is a short phrase like "entry point", "orchestrator loop", "translation sub-workflow", "shared utility", etc.

## Data Flow
Describe what data enters the system, how it transforms as it moves through workflows, and where it ends up. Be specific about external systems (which Google Sheet, which WordPress endpoint, which Supabase table).

## Key Concerns
Roll up the individual workflow concerns into system-level risks. Focus on:
- Systemic patterns (e.g., "all 5 translation workflows hardcode the same API key")
- Single points of failure
- Missing error handling across the pipeline
- Inconsistencies between variants (DEV vs PROD)
- Architectural complexity that would complicate migration

Don't repeat every individual concern — synthesize the important patterns.

## Migration Notes
2-3 bullet points on what to watch out for when converting this system to code. What's the logical boundary? What shared infrastructure would need to exist?

IMPORTANT:
- Do NOT wrap your response in markdown code fences
- Reference individual workflows using markdown links: [Workflow Name](workflows/{markdownFile})
- Be concise but complete — this is a reference document, not a novel`;

    const workflowSummaries = workflows
        .map(
            (w) =>
                `### ${w.name}
**ID:** ${w.id} | **Nodes:** ${w.nodeCount} | **File:** [${w.name}](workflows/${w.markdownFile})
**Triggers:** ${w.triggers.join(", ") || "none"}
**Services:** ${w.services.join(", ") || "none"}
**Calls:** ${w.callsIds.map((id) => allDigests.find((d) => d.id === id)?.name ?? id).join(", ") || "none"}
**Called by:** ${w.calledByIds.map((id) => allDigests.find((d) => d.id === id)?.name ?? id).join(", ") || "none"}

**Summary:** ${w.executiveSummary}

**Cross-References:** ${w.crossReferences}

**Concerns:** ${w.concerns.substring(0, 1000)}${w.concerns.length > 1000 ? "…" : ""}`,
        )
        .join("\n\n---\n\n");

    const user = `This system contains ${workflows.length} connected workflow(s):\n\n${workflowSummaries}`;

    return { system, user };
}

function buildOverviewPrompt(
    systems: { name: string; slug: string; workflowCount: number; summary: string }[],
    standaloneCount: number,
): { system: string; user: string } {
    const system = `You are a senior software architect writing a top-level overview document for a CTO.

You will receive summaries of all the automation "systems" (groups of connected workflows) in the organization. Write a markdown document (start directly with content, no top-level heading) with:

## Automation Landscape
A 3-5 sentence executive overview of the entire automation portfolio — what it does, what business it supports, and its overall maturity/health.

## Systems Map
A table of all systems with links:

| System | Workflows | Purpose |
| --- | --- | --- |
| [Name](systems/slug.md) | N | one-line purpose |

## Cross-System Dependencies
Note any shared infrastructure, common services, or workflows that appear across multiple systems. Identify the critical shared sub-workflows.

## Strategic Observations
3-5 bullet points about the overall portfolio:
- Patterns and anti-patterns
- Consolidation opportunities
- Risk areas
- Migration priority recommendations

IMPORTANT: Do NOT wrap in code fences. Use the provided system names and slugs for links.`;

    const summaries = systems
        .map(
            (s) =>
                `- **${s.name}** (${s.workflowCount} workflows, file: systems/${s.slug}.md)\n  ${s.summary}`,
        )
        .join("\n");

    const user = `The organization has ${systems.length} connected systems and ${standaloneCount} standalone workflows.\n\n${summaries}`;

    return { system, user };
}

// ---------------------------------------------------------------------------
// Slugify a system name for filenames
// ---------------------------------------------------------------------------
function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .substring(0, 80);
}

// ---------------------------------------------------------------------------
// Auto-name a system from its workflows
// ---------------------------------------------------------------------------
function autoNameSystem(workflows: WorkflowDigest[]): string {
    // Use the most common name prefix, or the entry-point workflow name
    const entryPoints = workflows.filter(
        (w) => w.calledByIds.length === 0 || w.triggers.some((t) => !t.startsWith("execute_workflow_trigger")),
    );

    if (entryPoints.length === 1) {
        return entryPoints[0].name;
    }

    // For multi-workflow systems, find common prefix
    const names = workflows.map((w) => w.name);
    if (names.length <= 3) {
        return names.join(" + ");
    }

    // Use the first entry point or the largest workflow
    const primary =
        entryPoints[0] ?? workflows.sort((a, b) => b.nodeCount - a.nodeCount)[0];
    return `${primary.name} (${workflows.length} workflows)`;
}

// ---------------------------------------------------------------------------
// Resumability marker
// ---------------------------------------------------------------------------
const SYNTH_MARKER = "<!-- synthesis-complete -->";

function isAlreadySynthesized(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    return fs.readFileSync(filePath, "utf-8").includes(SYNTH_MARKER);
}

// ---------------------------------------------------------------------------
// README and doc enrichment (no LLM needed — static templates + counts)
// ---------------------------------------------------------------------------
function generateReadme(stats: {
    totalWorkflows: number;
    activeWorkflows: number;
    inactiveWorkflows: number;
    connectedSystems: number;
    standaloneWorkflows: number;
}): string {
    return `# n8n Workflow Analysis

This directory contains a complete analysis of the organization's n8n automation workflows. The goal is to document every active workflow — what it does, how it connects to other workflows, what external services it depends on, and what concerns exist — so that the team can understand the full automation landscape before making decisions about migration, consolidation, or maintenance.

## At a glance

| | |
| --- | --- |
| Total workflows exported | ${stats.totalWorkflows} |
| Active workflows analyzed | ${stats.activeWorkflows} |
| Inactive workflows (excluded from synthesis) | ${stats.inactiveWorkflows} |
| Connected systems | ${stats.connectedSystems} |
| Standalone workflows | ${stats.standaloneWorkflows} |

## How this was generated

This analysis was produced by a four-phase automated pipeline. For setup and usage instructions, see the [project README](../../README.md).

1. **Export** — All ${stats.totalWorkflows} workflow JSON definitions were pulled from the n8n instance via its REST API
2. **Scan** — Triggers, services, credentials, cross-references, and dependency graphs were extracted from the raw JSON without any LLM involvement
3. **Analyze** — Each workflow's full JSON was sent to Claude for deep documentation: executive summaries, logic flow pseudocode, external dependencies, and migration concerns
4. **Synthesize** — Connected workflows were grouped into systems, architectural narratives were generated, and this README and all navigation docs were produced

## Documents

Start here and work your way down — each level adds more detail.

### Top-level

| Document | What it contains |
| --- | --- |
| [03_SYSTEMS_OVERVIEW.md](03_SYSTEMS_OVERVIEW.md) | **Start here.** High-level map of all automation systems, how they relate, cross-system dependencies, and strategic observations. Best entry point for understanding the portfolio. |
| [02_BUSINESS_FUNCTION_GROUPS.md](02_BUSINESS_FUNCTION_GROUPS.md) | All workflows grouped by business function (translation, content enrichment, SEO, etc.) with one-line summaries. Useful as a quick-reference index. |
| [01_DEPENDENCY_GRAPH.md](01_DEPENDENCY_GRAPH.md) | Mermaid diagram showing which workflows call which. Visual representation of the cross-workflow dependency structure. |
| [00_TABLE_OF_CONTENTS.md](00_TABLE_OF_CONTENTS.md) | Full statistical breakdown: active/inactive counts, external service usage, trigger types, and a searchable index of every workflow with links to its detail page. |

### Per-system deep dives

| Directory | What it contains |
| --- | --- |
| [systems/](systems/) | One markdown file per connected system (group of workflows that call each other). Each includes: purpose, architecture, workflow inventory, data flow, key concerns, and migration notes. Also contains \`standalone_workflows.md\` for workflows with no cross-dependencies. |

### Per-workflow detail

| Directory | What it contains |
| --- | --- |
| [workflows/](workflows/) | One markdown file per workflow. Each includes: executive summary, trigger details, inputs/outputs, step-by-step logic flow (pseudocode), external dependencies with credentials, cross-references, and potential concerns. This is the most granular level — use it when you need to understand exactly what a specific workflow does. |

### Data

| File | What it contains |
| --- | --- |
| [analysis.json](analysis.json) | Structured JSON of the full static analysis (all workflows, dependency graph, services, triggers). Used as input by the LLM and synthesis phases. |

## How to read this

- **"What does our automation do?"** — Read [03_SYSTEMS_OVERVIEW.md](03_SYSTEMS_OVERVIEW.md)
- **"How does system X work end-to-end?"** — Find it in the [systems/](systems/) directory
- **"What does workflow Y do specifically?"** — Find it in the [workflows/](workflows/) directory
- **"What services do we depend on?"** — See the External Services table in [00_TABLE_OF_CONTENTS.md](00_TABLE_OF_CONTENTS.md)
- **"Which workflows call which?"** — See [01_DEPENDENCY_GRAPH.md](01_DEPENDENCY_GRAPH.md)
- **"What should we fix or migrate first?"** — Check the Strategic Observations in [03_SYSTEMS_OVERVIEW.md](03_SYSTEMS_OVERVIEW.md) and the Key Concerns sections in the [systems/](systems/) docs

## Regenerating

This analysis is fully resumable. Re-running the pipeline will skip already-completed work. To force a full regeneration, delete the relevant output files first. See the [project README](../../README.md) for commands.
`;
}

const DOC_EXPLAINERS: Record<string, string> = {
    "00_TABLE_OF_CONTENTS.md":
        "This document is the statistical reference for the entire workflow portfolio. " +
        "It contains aggregate counts (active/inactive, node totals, service usage), a breakdown of trigger types, " +
        "the full cross-workflow dependency list, and a searchable index of every workflow with links to its detail page. " +
        "For a higher-level narrative, start with the [Systems Overview](03_SYSTEMS_OVERVIEW.md) or the [README](README.md).",
    "01_DEPENDENCY_GRAPH.md":
        "This document visualizes which workflows call which using a Mermaid diagram. " +
        "Each node is a workflow, and each arrow represents an \"Execute Workflow\" call. " +
        "Use this to identify pipeline chains, shared sub-workflows, and entry points. " +
        "For a narrative explanation of how these connections form systems, see the [Systems Overview](03_SYSTEMS_OVERVIEW.md). " +
        "For detail on any individual workflow, see the [workflows/](workflows/) directory.",
    "02_BUSINESS_FUNCTION_GROUPS.md":
        "This document organizes all workflows into logical business-function categories " +
        "(translation, content enrichment, SEO, data sync, etc.) based on their LLM-generated executive summaries. " +
        "Each category includes a brief description and a table of its workflows. " +
        "This is a flat grouping — it does not capture how workflows call each other. " +
        "For pipeline-level architecture, see the [Systems Overview](03_SYSTEMS_OVERVIEW.md) and the [systems/](systems/) directory.",
    "03_SYSTEMS_OVERVIEW.md":
        "This is the best starting point for understanding the automation portfolio. " +
        "It maps out the connected systems (groups of workflows that call each other), " +
        "explains what each system does, identifies cross-system dependencies, and offers strategic observations " +
        "for migration and consolidation. For deep dives into individual systems, follow the links in the Systems Map " +
        "below to the [systems/](systems/) directory. For the full statistical breakdown, see the [Table of Contents](00_TABLE_OF_CONTENTS.md).",
};

/**
 * Ensures each top-level doc has a navigation block and explainer paragraph
 * after its first heading. Idempotent — skips if already present.
 */
function enrichTopLevelDocs(analysisDir: string): void {
    const navBlock =
        "**Navigation:**\n" +
        "- [README](README.md) — start here: explains this analysis and how to navigate it\n" +
        "- [Systems Overview](03_SYSTEMS_OVERVIEW.md) — connected workflow systems, architecture, and migration notes\n" +
        "- [Business Function Groups](02_BUSINESS_FUNCTION_GROUPS.md) — workflows organized by what they do\n" +
        "- [Dependency Graph](01_DEPENDENCY_GRAPH.md) — which workflows call which\n" +
        "- [Individual Systems](systems/) — deep-dive docs for each connected pipeline\n";

    for (const [filename, explainer] of Object.entries(DOC_EXPLAINERS)) {
        const filePath = path.join(analysisDir, filename);
        if (!fs.existsSync(filePath)) continue;

        let content = fs.readFileSync(filePath, "utf-8");
        let changed = false;

        // Add explainer if not present (check for a unique fragment)
        const explainerFragment = explainer.substring(0, 60);
        if (!content.includes(explainerFragment)) {
            // Find the end of the metadata block (after > lines) or after first heading
            const firstHeadingEnd = content.indexOf("\n\n", content.indexOf("# "));
            if (firstHeadingEnd !== -1) {
                // Check if there's a > metadata block after the heading
                const afterHeading = content.substring(firstHeadingEnd + 2);
                let insertAt: number;
                if (afterHeading.startsWith(">")) {
                    // Skip past the > block
                    const metaEnd = afterHeading.search(/\n(?!>)/);
                    insertAt = firstHeadingEnd + 2 + (metaEnd === -1 ? afterHeading.length : metaEnd) + 1;
                } else {
                    insertAt = firstHeadingEnd + 2;
                }
                content =
                    content.slice(0, insertAt) +
                    "\n" + explainer + "\n\n" +
                    content.slice(insertAt);
                changed = true;
            }
        }

        // Add nav block to 00_TABLE_OF_CONTENTS if not present
        if (filename === "00_TABLE_OF_CONTENTS.md" && !content.includes("**Navigation:**")) {
            const overviewIdx = content.indexOf("\n## Overview");
            if (overviewIdx !== -1) {
                content =
                    content.slice(0, overviewIdx) +
                    "\n" + navBlock +
                    content.slice(overviewIdx);
                changed = true;
            }
        }

        if (changed) {
            fs.writeFileSync(filePath, content, "utf-8");
            console.log(`  ✓ Enriched ${filename}`);
        } else {
            console.log(`  · ${filename} (already enriched)`);
        }
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    if (!ANTHROPIC_API_KEY) {
        console.error(
            "ERROR: ANTHROPIC_API_KEY is not set.\n\n  export ANTHROPIC_API_KEY=sk-ant-...\n",
        );
        process.exit(1);
    }

    const analysisPath = path.join(ANALYSIS_DIR, "analysis.json");
    if (!fs.existsSync(analysisPath)) {
        console.error(
            `ERROR: ${analysisPath} not found. Run Phase 2 (npm run analyze) first.`,
        );
        process.exit(1);
    }

    const analysis: AnalysisJson = JSON.parse(
        fs.readFileSync(analysisPath, "utf-8"),
    );

    console.log("=".repeat(60));
    console.log("Phase 4: Systems Synthesis");
    console.log("=".repeat(60) + "\n");

    // Build digests (active + non-excluded only)
    const digests = buildDigests(analysis, ANALYSIS_DIR);
    console.log(
        `Active workflows with LLM analysis: ${digests.length} / ${analysis.totalWorkflows}\n`,
    );

    if (digests.length === 0) {
        console.error(
            "ERROR: No analyzed active workflows found. Run Phase 3 (npm run llm-analyze) first.",
        );
        process.exit(1);
    }

    // Find connected systems via dependency graph
    const components = findConnectedSystems(digests);

    // Separate multi-workflow systems from standalone workflows
    const multiSystems = components.filter((c) => c.length > 1);
    const standalones = components.filter((c) => c.length === 1).flat();

    console.log(`Connected systems (2+ workflows): ${multiSystems.length}`);
    console.log(`Standalone workflows: ${standalones.length}\n`);

    // Ensure output dirs
    const systemsDir = path.join(ANALYSIS_DIR, "systems");
    fs.mkdirSync(systemsDir, { recursive: true });

    // ---------------------------------------------------------------------------
    // Phase 4a: Per-system synthesis
    // ---------------------------------------------------------------------------
    console.log("=".repeat(60));
    console.log("Phase 4a: Per-system narrative synthesis");
    console.log("=".repeat(60) + "\n");

    const sem = new Semaphore(CONCURRENCY);
    let completed = 0;
    let skipped = 0;
    let processed = 0;

    const systemMeta: {
        name: string;
        slug: string;
        workflowCount: number;
        summary: string;
    }[] = [];

    // Process multi-workflow systems
    const systemTasks = multiSystems.map((workflows, idx) => async () => {
        const sysName = autoNameSystem(workflows);
        const slug = slugify(sysName) || `system_${idx}`;
        const outPath = path.join(systemsDir, `${slug}.md`);

        if (isAlreadySynthesized(outPath)) {
            skipped++;
            processed++;
            // Extract summary for overview
            const existing = fs.readFileSync(outPath, "utf-8");
            const purposeMatch = existing.match(
                /## Purpose\s*\n([\s\S]*?)(?=\n## )/,
            );
            systemMeta.push({
                name: sysName,
                slug,
                workflowCount: workflows.length,
                summary: purposeMatch
                    ? purposeMatch[1].trim().split("\n").join(" ").substring(0, 300)
                    : "(no summary)",
            });
            console.log(
                `  [${processed}/${multiSystems.length}] SKIP ${sysName} (already synthesized)`,
            );
            return;
        }

        await sem.acquire();
        try {
            const { system, user } = buildSystemPrompt(workflows, digests);
            const markdown = await callAnthropic(system, user);

            const wfList = workflows
                .map((w) => `[${w.name}](workflows/${w.markdownFile})`)
                .join(" · ");

            const header =
                `# ${sysName}\n\n` +
                `> **Workflows:** ${workflows.length} · ` +
                `**Total nodes:** ${workflows.reduce((s, w) => s + w.nodeCount, 0)}\n` +
                `>\n` +
                `> ${wfList}\n\n`;

            fs.writeFileSync(
                outPath,
                header + markdown + `\n\n${SYNTH_MARKER}\n`,
                "utf-8",
            );

            // Extract purpose for overview
            const purposeMatch = markdown.match(
                /## Purpose\s*\n([\s\S]*?)(?=\n## )/,
            );
            systemMeta.push({
                name: sysName,
                slug,
                workflowCount: workflows.length,
                summary: purposeMatch
                    ? purposeMatch[1].trim().split("\n").join(" ").substring(0, 300)
                    : "(no summary)",
            });

            completed++;
            processed++;
            console.log(
                `  [${processed}/${multiSystems.length}] ✓ ${sysName} (${workflows.length} workflows)`,
            );
        } catch (err) {
            processed++;
            console.error(
                `  [${processed}/${multiSystems.length}] ✗ ${sysName}: ${(err as Error).message}`,
            );
        } finally {
            sem.release();
        }
    });

    await Promise.all(systemTasks.map((fn) => fn()));

    console.log(
        `\nPhase 4a complete: ${completed} synthesized, ${skipped} skipped\n`,
    );

    // ---------------------------------------------------------------------------
    // Phase 4b: Standalone workflows doc
    // ---------------------------------------------------------------------------
    if (standalones.length > 0) {
        console.log("=".repeat(60));
        console.log("Phase 4b: Standalone workflows summary");
        console.log("=".repeat(60) + "\n");

        const standalonePath = path.join(
            systemsDir,
            "standalone_workflows.md",
        );

        if (isAlreadySynthesized(standalonePath)) {
            console.log("  SKIP standalone summary (already synthesized)");
        } else {
            const rows = standalones
                .map(
                    (w) =>
                        `| [${w.name}](workflows/${w.markdownFile}) | ${w.triggers.join(", ")} | ${w.services.join(", ") || "—"} | ${w.executiveSummary.substring(0, 150)}${w.executiveSummary.length > 150 ? "…" : ""} |`,
                )
                .join("\n");

            const standaloneContent =
                `# Standalone Workflows\n\n` +
                `> ${standalones.length} active workflows that operate independently (no cross-workflow dependencies)\n\n` +
                `| Workflow | Triggers | Services | Summary |\n` +
                `| --- | --- | --- | --- |\n` +
                rows +
                `\n\n${SYNTH_MARKER}\n`;

            fs.writeFileSync(standalonePath, standaloneContent, "utf-8");
            console.log(
                `  ✓ Standalone summary → ${standalonePath} (${standalones.length} workflows)`,
            );
        }
    }

    // ---------------------------------------------------------------------------
    // Phase 4c: Top-level overview
    // ---------------------------------------------------------------------------
    console.log("\n" + "=".repeat(60));
    console.log("Phase 4c: Top-level systems overview");
    console.log("=".repeat(60) + "\n");

    const overviewPath = path.join(ANALYSIS_DIR, "03_SYSTEMS_OVERVIEW.md");

    // Always regenerate the overview (it's cheap and ties everything together)
    console.log(
        `  Generating overview for ${systemMeta.length} systems + ${standalones.length} standalone workflows…`,
    );

    try {
        const { system, user } = buildOverviewPrompt(
            systemMeta,
            standalones.length,
        );
        const overviewMarkdown = await callAnthropic(system, user);

        const overviewContent =
            `# Systems Overview\n\n` +
            `> Auto-generated synthesis · ${new Date().toISOString()}\n` +
            `> ${digests.length} active workflows across ${systemMeta.length} connected systems + ${standalones.length} standalone\n\n` +
            overviewMarkdown +
            `\n\n---\n\n` +
            `**Standalone workflows:** See [standalone_workflows.md](systems/standalone_workflows.md) for ${standalones.length} independent workflows.\n` +
            `\n${SYNTH_MARKER}\n`;

        fs.writeFileSync(overviewPath, overviewContent, "utf-8");
        console.log(`  ✓ Systems overview → ${overviewPath}`);
    } catch (err) {
        console.error(
            `  ✗ Overview generation failed: ${(err as Error).message}`,
        );
    }

    // ---------------------------------------------------------------------------
    // Phase 4d: README and doc enrichment
    // ---------------------------------------------------------------------------
    console.log("\n" + "=".repeat(60));
    console.log("Phase 4d: README and doc enrichment");
    console.log("=".repeat(60) + "\n");

    // Generate README with current stats
    const readmePath = path.join(ANALYSIS_DIR, "README.md");
    const readmeContent = generateReadme({
        totalWorkflows: analysis.totalWorkflows,
        activeWorkflows: digests.length,
        inactiveWorkflows: analysis.totalWorkflows - digests.length,
        connectedSystems: systemMeta.length,
        standaloneWorkflows: standalones.length,
    });
    fs.writeFileSync(readmePath, readmeContent, "utf-8");
    console.log(`  ✓ README → ${readmePath}`);

    // Enrich top-level docs with explainers and nav
    enrichTopLevelDocs(ANALYSIS_DIR);

    // ---------------------------------------------------------------------------
    // Done
    // ---------------------------------------------------------------------------
    console.log(`\n${"=".repeat(60)}`);
    console.log("Phase 4 complete.");
    console.log(`  ${systemMeta.length} systems documented`);
    console.log(`  ${standalones.length} standalone workflows catalogued`);
    console.log(`  Output: ${path.resolve(ANALYSIS_DIR)}/`);
    console.log("=".repeat(60));
}

main().catch((err) => {
    console.error("\nFatal error:", err);
    process.exit(1);
});
