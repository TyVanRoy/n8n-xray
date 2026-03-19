import * as fs from "fs";
import * as path from "path";
require("dotenv").config({
    path: "./.env",
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_ANALYZE_MODEL || "claude-sonnet-4-6";
const OUTPUT_ROOT = process.env.OUTPUT_DIR || "./output";
const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || path.join(OUTPUT_ROOT, "workflows");
const ANALYSIS_DIR = process.env.ANALYSIS_OUTPUT_DIR || path.join(OUTPUT_ROOT, "analysis");
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "5", 10);
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

// Rough token budget: keep per-request context under this to stay safe
const MAX_WORKFLOW_JSON_CHARS = 600_000; // ~25K tokens

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface AnalysisEntry {
    id: string;
    name: string;
    active: boolean;
    tags: string[];
    nodeCount: number;
    disabledNodeCount: number;
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
    allCredentials: string[];
    httpEndpoints: string[];
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

interface ManifestEntry {
    id: string;
    name: string;
    filename: string;
}

// ---------------------------------------------------------------------------
// Anthropic API helper
// ---------------------------------------------------------------------------
async function callAnthropic(
    system: string,
    userMessage: string,
    maxTokens: number = 4096,
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

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------
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
// Condensed TOC builder (fits in context with any single workflow)
// ---------------------------------------------------------------------------
function buildCondensedToc(analysis: AnalysisJson): string {
    const lines: string[] = [];
    lines.push("# Workflow Registry (condensed)\n");
    lines.push(
        "Use this to resolve workflow IDs to names and understand cross-references.\n",
    );

    lines.push("## All Workflows\n");
    lines.push("| ID | Name | File | Active | Nodes | Trigger Types |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const wf of analysis.workflows) {
        const triggers = wf.triggers.map((t) => t.type).join(", ");
        lines.push(
            `| ${wf.id} | ${wf.name} | ${wf.markdownFile} | ${wf.active} | ${wf.nodeCount} | ${triggers} |`,
        );
    }

    if (analysis.dependencyGraph.edges.length > 0) {
        lines.push("\n## Dependency Edges\n");
        for (const e of analysis.dependencyGraph.edges) {
            lines.push(`- "${e.from}" (${e.fromId}) → "${e.to}" (${e.toId})`);
        }
    }

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Per-workflow prompt
// ---------------------------------------------------------------------------
function buildWorkflowPrompt(
    workflowJson: string,
    entry: AnalysisEntry,
    condensedToc: string,
): { system: string; user: string } {
    const system = `You are a senior software engineer documenting n8n automation workflows for a CTO who needs to understand them before migrating to code-based solutions.

You will receive:
1. A condensed table-of-contents of ALL workflows in the organization (for resolving cross-references)
2. The full JSON definition of ONE specific workflow to analyze

Produce a markdown document with EXACTLY these sections, in this order. Do NOT include a top-level heading (that will be added programmatically). Start directly with ## Executive Summary.

## Executive Summary
2-3 sentences in plain English. A non-technical CEO should understand what this workflow does and why it exists. Mention the business purpose, not the technical mechanism.

## Trigger
What starts this workflow. Be specific: if it's a cron, state the human-readable schedule. If it's a webhook, note the path. If it's called by another workflow, name and link to it.

## Inputs / Outputs
What data flows in (trigger payload, fetched from a DB, etc.) and what the workflow produces or where it sends results (writes to a sheet, sends a Slack message, updates a CRM record, etc.).

## Logic Flow
A step-by-step pseudocode walkthrough of the node chain. Use indentation for branches. Keep it concise but complete — someone should be able to reimplement this from your description. Example format:

\`\`\`
1. Receive webhook payload with {fields}
2. Query PostgreSQL for matching customer record
3. IF customer exists:
   3a. Update record with new data
   3b. Send Slack notification to #sales
4. ELSE:
   4a. Create new customer record
   4b. Send welcome email via SendGrid
\`\`\`

## External Dependencies
List every external service, API, or credential this workflow requires. For each, briefly note what it's used for in context (not just "Google Sheets" but "Google Sheets — reads lead list from 'Inbound Leads' tab").

## Cross-References
List every workflow that this one calls or is called by. For each, write a one-line explanation of the relationship. Use markdown links with the EXACT filename from the "File" column in the workflow registry — do NOT construct filenames yourself. Format: [Workflow Name](exact_filename.md). If no cross-references exist, write "None — this is a standalone workflow."

## Potential Concerns
Flag anything a CTO should know before migration:
- Missing error handling or retry logic
- Hardcoded values that should be config/env vars
- Overly complex branching that could be simplified
- Race conditions or timing dependencies
- Single points of failure
- Disabled nodes that suggest abandoned logic
- Security concerns (credentials in plaintext, overly broad permissions)

If the workflow is straightforward and well-structured, say so briefly.

IMPORTANT:
- Do NOT wrap your response in markdown code fences. Just output the raw markdown.
- When referencing other workflows, look up their exact filename from the "File" column in the workflow registry. Do NOT attempt to construct filenames by sanitizing names yourself — always use the exact filename from the registry.
- Be precise about what each node does. Read the node parameters carefully.`;

    const user = `<condensed_toc>
${condensedToc}
</condensed_toc>

<workflow_metadata>
ID: ${entry.id}
Name: ${entry.name}
Active: ${entry.active}
Tags: ${entry.tags.join(", ") || "(none)"}
Node count: ${entry.nodeCount} (${entry.disabledNodeCount} disabled)
</workflow_metadata>

<workflow_json>
${workflowJson}
</workflow_json>

Analyze this workflow and produce the markdown document as specified.`;

    return { system, user };
}

// ---------------------------------------------------------------------------
// Grouping prompt (final pass)
// ---------------------------------------------------------------------------
function buildGroupingPrompt(
    summaries: {
        id: string;
        name: string;
        active: boolean;
        summary: string;
        services: string[];
        triggerTypes: string[];
    }[],
): { system: string; user: string } {
    const system = `You are helping a CTO understand a large portfolio of n8n automation workflows. You will receive a list of workflow summaries. Your job is to:

1. Group them into logical business-function categories (e.g., "Lead Management", "Customer Onboarding", "Reporting & Analytics", "Data Sync", "Internal Notifications", "Error Handling", etc.). Invent category names that fit the actual workflows — don't force them into pre-defined buckets.

2. For each category, write a 2-3 sentence description of what this group of automations does collectively and why it matters to the business.

3. Within each category, list the workflows with their ID, name, active status, and a one-line description.

4. After all categories, write a "Key Observations" section with 3-5 bullet points about the overall automation landscape — patterns, risks, opportunities, or recommendations.

Output format — raw markdown, no code fences:

## {Category Name}

{2-3 sentence description}

| ID | Name | Active | Summary |
| --- | --- | --- | --- |
| ... | ... | ... | ... |

(repeat for each category)

## Key Observations

- ...
- ...`;

    const entries = summaries
        .map(
            (s) =>
                `- ID: ${s.id} | Name: ${s.name} | Active: ${s.active} | Triggers: ${s.triggerTypes.join(", ")} | Services: ${s.services.join(", ")}\n  Summary: ${s.summary}`,
        )
        .join("\n");

    const user = `Here are ${summaries.length} workflow summaries to categorize:\n\n${entries}`;

    return { system, user };
}

// ---------------------------------------------------------------------------
// Resumability check
// ---------------------------------------------------------------------------
const PHASE2_MARKER = "<!-- phase2-complete -->";

function isAlreadyProcessed(markdownPath: string): boolean {
    if (!fs.existsSync(markdownPath)) return false;
    const content = fs.readFileSync(markdownPath, "utf-8");
    return content.includes(PHASE2_MARKER);
}

// ---------------------------------------------------------------------------
// Sanitize helper (must match Phase 1)
// ---------------------------------------------------------------------------
function sanitizeFilename(name: string): string {
    return name
        .replace(/[^a-zA-Z0-9_\-. ]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .substring(0, 100);
}

// ---------------------------------------------------------------------------
// Extract executive summary from generated markdown
// ---------------------------------------------------------------------------
function extractExecutiveSummary(markdown: string): string {
    const match = markdown.match(
        /## Executive Summary\s*\n([\s\S]*?)(?=\n## |\n$|$)/,
    );
    if (!match) return "(no summary extracted)";
    return match[1].trim().split("\n").join(" ").substring(0, 500);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    // Validate
    if (!ANTHROPIC_API_KEY) {
        console.error(
            "ERROR: ANTHROPIC_API_KEY is not set.\n\n  export ANTHROPIC_API_KEY=sk-ant-...\n",
        );
        process.exit(1);
    }

    const analysisPath = path.join(ANALYSIS_DIR, "analysis.json");
    if (!fs.existsSync(analysisPath)) {
        console.error(
            `ERROR: ${analysisPath} not found. Run Phase 1 (npm run analyze) first.`,
        );
        process.exit(1);
    }

    const analysis: AnalysisJson = JSON.parse(
        fs.readFileSync(analysisPath, "utf-8"),
    );
    const manifestPath = path.join(WORKFLOWS_DIR, "_manifest.json");
    const manifest: { workflows: ManifestEntry[] } = JSON.parse(
        fs.readFileSync(manifestPath, "utf-8"),
    );

    // Build filename lookup: workflow id → JSON filename
    const jsonFileById = new Map(
        manifest.workflows.map((w) => [w.id, w.filename]),
    );

    console.log(`Model         : ${MODEL}`);
    console.log(`Concurrency   : ${CONCURRENCY}`);
    console.log(`Workflows     : ${analysis.totalWorkflows}`);
    console.log(`Workflows dir : ${path.resolve(WORKFLOWS_DIR)}`);
    console.log(`Analysis dir  : ${path.resolve(ANALYSIS_DIR)}\n`);

    // Build condensed TOC once
    const condensedToc = buildCondensedToc(analysis);
    const tocTokenEstimate = Math.ceil(condensedToc.length / 4);
    console.log(`Condensed TOC : ~${tocTokenEstimate} tokens\n`);

    // Ensure output dir
    const stubsDir = path.join(ANALYSIS_DIR, "workflows");
    fs.mkdirSync(stubsDir, { recursive: true });

    // ---------------------------------------------------------------------------
    // Phase 2a: Per-workflow LLM analysis
    // ---------------------------------------------------------------------------
    console.log("=".repeat(60));
    console.log("Phase 2a: Per-workflow LLM analysis");
    console.log("=".repeat(60) + "\n");

    const sem = new Semaphore(CONCURRENCY);
    let completed = 0;
    let skipped = 0;
    let failed = 0;
    let processed = 0; // unified counter for progress display
    const total = analysis.workflows.length;

    // Collect summaries for the grouping pass
    const summaries: {
        id: string;
        name: string;
        active: boolean;
        summary: string;
        services: string[];
        triggerTypes: string[];
    }[] = [];

    const tasks = analysis.workflows.map((entry) => async () => {
        const mdPath = path.join(stubsDir, entry.markdownFile);

        // Resumability check
        if (isAlreadyProcessed(mdPath)) {
            skipped++;
            processed++;
            // Still extract summary for grouping pass
            const existingContent = fs.readFileSync(mdPath, "utf-8");
            summaries.push({
                id: entry.id,
                name: entry.name,
                active: entry.active,
                summary: extractExecutiveSummary(existingContent),
                services: entry.externalServices.map((s) => s.service),
                triggerTypes: entry.triggers.map((t) => t.type),
            });
            console.log(
                `  [${processed}/${total}] SKIP ${entry.name} (already processed)`,
            );
            return;
        }

        // Load workflow JSON
        const jsonFile = jsonFileById.get(entry.id);
        if (!jsonFile) {
            console.warn(
                `  WARN: No JSON file for workflow ${entry.id}, skipping`,
            );
            failed++;
            return;
        }
        const jsonPath = path.join(WORKFLOWS_DIR, jsonFile);
        if (!fs.existsSync(jsonPath)) {
            console.warn(`  WARN: ${jsonPath} not found, skipping`);
            failed++;
            return;
        }

        let workflowJson = fs.readFileSync(jsonPath, "utf-8");

        // Truncation guard
        if (workflowJson.length > MAX_WORKFLOW_JSON_CHARS) {
            console.warn(
                `  WARN: ${entry.name} JSON is ${(workflowJson.length / 1000).toFixed(0)}K chars, truncating`,
            );
            // Keep the structure but trim node parameters for huge workflows
            try {
                const parsed = JSON.parse(workflowJson);
                // Slim down: remove position data, keep only essential parameters
                for (const node of parsed.nodes || []) {
                    delete node.position;
                    delete node.typeVersion;
                    // Truncate very large parameter values
                    if (node.parameters) {
                        for (const [key, val] of Object.entries(
                            node.parameters,
                        )) {
                            if (
                                typeof val === "string" &&
                                (val as string).length > 2000
                            ) {
                                (node.parameters as any)[key] =
                                    (val as string).substring(0, 2000) +
                                    "… [truncated]";
                            }
                        }
                    }
                }
                // Remove static data (can be huge)
                delete parsed.staticData;
                workflowJson = JSON.stringify(parsed, null, 2);
            } catch {
                workflowJson =
                    workflowJson.substring(0, MAX_WORKFLOW_JSON_CHARS) +
                    "\n… [truncated]";
            }
        }

        await sem.acquire();
        try {
            const { system, user } = buildWorkflowPrompt(
                workflowJson,
                entry,
                condensedToc,
            );
            const markdown = await callAnthropic(system, user);

            // Build final file content
            const header =
                `# ${entry.name}\n\n` +
                `> **ID:** ${entry.id} · **Active:** ${entry.active ? "Yes" : "No"} · **Nodes:** ${entry.nodeCount}` +
                (entry.tags.length > 0
                    ? ` · **Tags:** ${entry.tags.join(", ")}`
                    : "") +
                "\n\n";

            const fileContent = header + markdown + `\n\n${PHASE2_MARKER}\n`;
            fs.writeFileSync(mdPath, fileContent, "utf-8");

            completed++;
            processed++;
            summaries.push({
                id: entry.id,
                name: entry.name,
                active: entry.active,
                summary: extractExecutiveSummary(markdown),
                services: entry.externalServices.map((s) => s.service),
                triggerTypes: entry.triggers.map((t) => t.type),
            });

            console.log(`  [${processed}/${total}] ✓ ${entry.name}`);
        } catch (err) {
            failed++;
            processed++;
            console.error(
                `  [${processed}/${total}] ✗ ${entry.name}: ${(err as Error).message}`,
            );
        } finally {
            sem.release();
        }
    });

    // Execute all tasks with concurrency control
    await Promise.all(tasks.map((fn) => fn()));

    console.log(
        `\nPhase 2a complete: ${completed} analyzed, ${skipped} skipped, ${failed} failed\n`,
    );

    // ---------------------------------------------------------------------------
    // Phase 2b: Business-function grouping
    // ---------------------------------------------------------------------------
    if (summaries.length === 0) {
        console.warn("No summaries available for grouping. Exiting.");
        return;
    }

    console.log("=".repeat(60));
    console.log("Phase 2b: Business-function grouping");
    console.log("=".repeat(60) + "\n");

    // Skip grouping if already done for the same number of workflows
    const groupingPath = path.join(
        ANALYSIS_DIR,
        "02_BUSINESS_FUNCTION_GROUPS.md",
    );
    if (fs.existsSync(groupingPath)) {
        const existing = fs.readFileSync(groupingPath, "utf-8");
        const countMatch = existing.match(/(\d+) workflows categorized/);
        if (countMatch && parseInt(countMatch[1], 10) === summaries.length) {
            console.log(
                `  SKIP grouping (already done for ${summaries.length} workflows)`,
            );
            console.log(`\n${"=".repeat(60)}`);
            console.log("Phase 2 complete.");
            console.log(`  ${completed + skipped} workflows documented`);
            console.log(`  Output: ${path.resolve(ANALYSIS_DIR)}/`);
            console.log("=".repeat(60));
            return;
        }
    }

    console.log(`  Sending ${summaries.length} summaries for categorization…`);

    try {
        const { system, user } = buildGroupingPrompt(summaries);
        const groupingMarkdown = await callAnthropic(system, user, 8192);
        const groupingContent =
            `# Workflows by Business Function\n\n` +
            `> Auto-generated grouping · ${new Date().toISOString()}\n` +
            `> ${summaries.length} workflows categorized\n\n` +
            groupingMarkdown +
            "\n";

        fs.writeFileSync(groupingPath, groupingContent, "utf-8");
        console.log(`  ✓ Business function groups → ${groupingPath}`);
        // Note: TOC navigation and doc enrichment are handled by Phase 4 (npm run synthesize)
    } catch (err) {
        console.error(`  ✗ Grouping failed: ${(err as Error).message}`);
        console.error(
            "  Individual workflow docs are still valid. You can retry the grouping pass.",
        );
    }

    // ---------------------------------------------------------------------------
    // Done
    // ---------------------------------------------------------------------------
    console.log(`\n${"=".repeat(60)}`);
    console.log("Phase 2 complete.");
    console.log(`  ${completed + skipped} workflows documented`);
    console.log(`  Output: ${path.resolve(ANALYSIS_DIR)}/`);
    console.log("=".repeat(60));
}

main().catch((err) => {
    console.error("\nFatal error:", err);
    process.exit(1);
});
