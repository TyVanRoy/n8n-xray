import * as fs from "fs";
import * as path from "path";
require("dotenv").config({
    path: "./.env",
});

// ---------------------------------------------------------------------------
// Config – override via environment variables
// ---------------------------------------------------------------------------
const N8N_BASE_URL = (
    process.env.N8N_BASE_URL || "http://localhost:5678"
).replace(/\/+$/, ""); // strip trailing slashes

const N8N_API_KEY = process.env.N8N_API_KEY;

const OUTPUT_ROOT = process.env.OUTPUT_DIR || "./output";
const OUTPUT_DIR = path.join(OUTPUT_ROOT, "workflows");

// ---------------------------------------------------------------------------
// Types (trimmed to what we need – n8n's API returns more fields)
// ---------------------------------------------------------------------------
interface N8nWorkflowSummary {
    id: string;
    name: string;
    active: boolean;
    createdAt: string;
    updatedAt: string;
    tags?: { id: string; name: string }[];
}

interface N8nListResponse {
    data: N8nWorkflowSummary[];
    nextCursor?: string | null;
}

interface N8nWorkflow extends N8nWorkflowSummary {
    nodes: Record<string, unknown>[];
    connections: Record<string, unknown>;
    settings?: Record<string, unknown>;
    staticData?: unknown;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (N8N_API_KEY) {
        h["X-N8N-API-KEY"] = N8N_API_KEY;
    }
    return h;
}

/** Sanitise a workflow name into something safe for a filename. */
function sanitize(name: string): string {
    return name
        .replace(/[^a-zA-Z0-9_\-. ]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .substring(0, 100);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/** Paginate through GET /api/v1/workflows and collect every summary. */
async function listAllWorkflows(): Promise<N8nWorkflowSummary[]> {
    const all: N8nWorkflowSummary[] = [];
    let cursor: string | null | undefined = undefined;

    while (true) {
        const url = new URL(`${N8N_BASE_URL}/api/v1/workflows`);
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("cursor", cursor);

        const res = await fetch(url.toString(), { headers: headers() });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(
                `Failed to list workflows (${res.status} ${res.statusText}): ${body}`,
            );
        }

        const json = (await res.json()) as N8nListResponse;
        all.push(...json.data);

        if (!json.nextCursor) break;
        cursor = json.nextCursor;
    }

    return all;
}

/** Fetch the full definition of a single workflow by ID. */
async function getWorkflow(id: string): Promise<N8nWorkflow> {
    const url = `${N8N_BASE_URL}/api/v1/workflows/${id}`;
    const res = await fetch(url, { headers: headers() });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(
            `Failed to fetch workflow ${id} (${res.status} ${res.statusText}): ${body}`,
        );
    }

    return (await res.json()) as N8nWorkflow;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    // Validate config
    if (!N8N_API_KEY) {
        console.error(
            "ERROR: N8N_API_KEY is not set.\n" +
                "Generate one in n8n → Settings → API → Create API Key, then:\n\n" +
                "  export N8N_API_KEY=your-key-here\n",
        );
        process.exit(1);
    }

    console.log(`n8n instance : ${N8N_BASE_URL}`);
    console.log(`Output dir   : ${path.resolve(OUTPUT_DIR)}\n`);

    // Ensure output directory exists
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // 1. List all workflows
    console.log("Fetching workflow list…");
    const summaries = await listAllWorkflows();
    console.log(`Found ${summaries.length} workflow(s).\n`);

    if (summaries.length === 0) {
        console.log("Nothing to export.");
        return;
    }

    // 2. Download each workflow's full JSON
    const manifest: {
        id: string;
        name: string;
        active: boolean;
        nodeCount: number;
        filename: string;
        tags: string[];
    }[] = [];

    for (const summary of summaries) {
        const label = `[${summary.id}] ${summary.name}`;
        process.stdout.write(`  Downloading ${label} … `);

        try {
            const workflow = await getWorkflow(summary.id);
            const filename = `${summary.id}__${sanitize(summary.name)}.json`;
            const filepath = path.join(OUTPUT_DIR, filename);

            fs.writeFileSync(
                filepath,
                JSON.stringify(workflow, null, 2),
                "utf-8",
            );

            manifest.push({
                id: summary.id,
                name: summary.name,
                active: summary.active,
                nodeCount: workflow.nodes?.length ?? 0,
                filename,
                tags: summary.tags?.map((t) => t.name) ?? [],
            });

            console.log(`✓  (${workflow.nodes?.length ?? "?"} nodes)`);
        } catch (err) {
            console.error(`✗  ${(err as Error).message}`);
        }
    }

    // 3. Write a manifest / index file for easy consumption by an LLM
    const manifestPath = path.join(OUTPUT_DIR, "_manifest.json");
    fs.writeFileSync(
        manifestPath,
        JSON.stringify(
            {
                exportedAt: new Date().toISOString(),
                n8nInstance: N8N_BASE_URL,
                totalWorkflows: manifest.length,
                workflows: manifest,
            },
            null,
            2,
        ),
        "utf-8",
    );

    console.log(
        `\nDone. ${manifest.length} workflow(s) saved to ${path.resolve(OUTPUT_DIR)}`,
    );
    console.log(`Manifest written to ${manifestPath}`);
}

main().catch((err) => {
    console.error("\nFatal error:", err);
    process.exit(1);
});
