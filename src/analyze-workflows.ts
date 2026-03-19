import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const OUTPUT_ROOT = process.env.OUTPUT_DIR || "./output";
const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || path.join(OUTPUT_ROOT, "workflows");
const OUTPUT_DIR = process.env.ANALYSIS_OUTPUT_DIR || path.join(OUTPUT_ROOT, "analysis");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface N8nNode {
    name: string;
    type: string;
    parameters?: Record<string, any>;
    credentials?: Record<string, any>;
    disabled?: boolean;
    [key: string]: any;
}

interface N8nWorkflow {
    id: string;
    name: string;
    active: boolean;
    nodes: N8nNode[];
    connections: Record<string, any>;
    tags?: { id: string; name: string }[];
    settings?: Record<string, any>;
    createdAt?: string;
    updatedAt?: string;
    [key: string]: any;
}

interface TriggerInfo {
    type:
        | "webhook"
        | "cron"
        | "manual"
        | "execute_workflow_trigger"
        | "polling"
        | "event"
        | "other";
    nodeType: string;
    nodeName: string;
    /** Webhook path, cron expression, polling interval, etc. */
    detail?: string;
}

interface CrossReference {
    /** The workflow ID being called */
    targetWorkflowId: string;
    /** Resolved name (if found in our dataset) */
    targetWorkflowName?: string;
    /** The node in *this* workflow that makes the call */
    sourceNodeName: string;
}

interface ExternalService {
    /** Human-readable service name */
    service: string;
    /** Raw n8n node type */
    nodeType: string;
    /** How many nodes of this type in the workflow */
    count: number;
    /** Credential names referenced (if any) */
    credentials: string[];
}

interface WorkflowAnalysis {
    id: string;
    name: string;
    active: boolean;
    tags: string[];
    nodeCount: number;
    disabledNodeCount: number;
    triggers: TriggerInfo[];
    /** Workflows this one calls */
    callsWorkflows: CrossReference[];
    /** Workflows that call this one (populated in a second pass) */
    calledByWorkflows: CrossReference[];
    externalServices: ExternalService[];
    /** Unique credential names across all nodes */
    allCredentials: string[];
    /** HTTP Request nodes with static URLs */
    httpEndpoints: string[];
    createdAt?: string;
    updatedAt?: string;
    /** The markdown filename that Phase 2 will produce */
    markdownFile: string;
}

// ---------------------------------------------------------------------------
// Known service mappings  (n8n node type prefix → human-readable name)
// ---------------------------------------------------------------------------
const SERVICE_MAP: Record<string, string> = {
    // Google
    googleSheets: "Google Sheets",
    googleDrive: "Google Drive",
    gmail: "Gmail",
    googleCalendar: "Google Calendar",
    googleBigQuery: "Google BigQuery",
    googleCloudStorage: "Google Cloud Storage",
    googleAnalytics: "Google Analytics",
    googleDocs: "Google Docs",
    googleSlides: "Google Slides",
    googleForms: "Google Forms",
    googleChat: "Google Chat",
    // Comms
    slack: "Slack",
    discord: "Discord",
    telegram: "Telegram",
    microsoftTeams: "Microsoft Teams",
    twilio: "Twilio",
    sendGrid: "SendGrid",
    mailchimp: "Mailchimp",
    // Databases
    postgres: "PostgreSQL",
    mysql: "MySQL",
    mongoDb: "MongoDB",
    redis: "Redis",
    supabase: "Supabase",
    dynamoDb: "DynamoDB",
    elasticsearch: "Elasticsearch",
    mssql: "Microsoft SQL Server",
    // CRMs / Business
    salesforce: "Salesforce",
    hubspot: "HubSpot",
    pipedrive: "Pipedrive",
    airtable: "Airtable",
    notion: "Notion",
    monday: "Monday.com",
    clickUp: "ClickUp",
    asana: "Asana",
    jira: "Jira",
    confluence: "Confluence",
    linear: "Linear",
    zendesk: "Zendesk",
    intercom: "Intercom",
    freshdesk: "Freshdesk",
    // Dev / Infra
    github: "GitHub",
    gitlab: "GitLab",
    bitbucket: "Bitbucket",
    aws: "AWS",
    s3: "AWS S3",
    sqs: "AWS SQS",
    sns: "AWS SNS",
    lambda: "AWS Lambda",
    // Payments
    stripe: "Stripe",
    shopify: "Shopify",
    wooCommerce: "WooCommerce",
    // AI
    openAi: "OpenAI",
    anthropic: "Anthropic",
    // Storage / Files
    dropbox: "Dropbox",
    box: "Box",
    oneDrive: "OneDrive",
    ftp: "FTP",
    // Other
    httpRequest: "HTTP Request",
    webhook: "Webhook",
    cron: "Cron",
    scheduleTrigger: "Schedule Trigger",
    errorTrigger: "Error Trigger",
    manualTrigger: "Manual Trigger",
    executeWorkflow: "Execute Workflow",
    executeWorkflowTrigger: "Execute Workflow Trigger",
    set: "Set",
    if: "IF",
    switch: "Switch",
    merge: "Merge",
    code: "Code",
    function: "Function",
    functionItem: "Function Item",
    noOp: "No Operation",
    wait: "Wait",
    splitInBatches: "Split In Batches",
    respondToWebhook: "Respond to Webhook",
};

// Node types that are internal flow control, not "external services"
const INTERNAL_NODE_TYPES = new Set([
    "set",
    "if",
    "switch",
    "merge",
    "code",
    "function",
    "functionItem",
    "noOp",
    "wait",
    "splitInBatches",
    "stickyNote",
    "manualTrigger",
    "executeWorkflow",
    "executeWorkflowTrigger",
    "respondToWebhook",
    "start",
    "webhook",
    "cron",
    "scheduleTrigger",
    "errorTrigger",
    "interval",
    "n8n-nodes-base.noOp",
    "n8n-nodes-base.stickyNote",
    "n8n-nodes-base.set",
    "n8n-nodes-base.start",
]);

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function shortType(fullType: string): string {
    // "n8n-nodes-base.googleSheets" → "googleSheets"
    // "@n8n/n8n-nodes-langchain.openAi" → "openAi"
    const parts = fullType.split(".");
    return parts[parts.length - 1] || fullType;
}

function resolveServiceName(nodeType: string): string {
    const short = shortType(nodeType);

    // Direct match
    if (SERVICE_MAP[short]) return SERVICE_MAP[short];

    // Check if short type starts with a known key (e.g., "googleSheetsTrigger" → "Google Sheets")
    for (const [key, name] of Object.entries(SERVICE_MAP)) {
        if (short.toLowerCase().startsWith(key.toLowerCase())) return name;
    }

    // Fallback: humanize the short type
    return short
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (s) => s.toUpperCase())
        .trim();
}

function isInternalNode(nodeType: string): boolean {
    const short = shortType(nodeType);
    if (INTERNAL_NODE_TYPES.has(short)) return true;
    if (INTERNAL_NODE_TYPES.has(nodeType)) return true;
    // Sticky notes, annotations, etc.
    if (short.toLowerCase().includes("sticky")) return true;
    if (short.toLowerCase() === "start") return true;
    return false;
}

function extractTriggers(workflow: N8nWorkflow): TriggerInfo[] {
    const triggers: TriggerInfo[] = [];

    for (const node of workflow.nodes) {
        if (node.disabled) continue;
        const short = shortType(node.type);
        const lower = short.toLowerCase();

        if (lower === "webhook" || lower.includes("webhooktrigger")) {
            triggers.push({
                type: "webhook",
                nodeType: node.type,
                nodeName: node.name,
                detail: node.parameters?.path
                    ? `path: /${node.parameters.path}`
                    : undefined,
            });
        } else if (
            lower === "cron" ||
            lower === "scheduletrigger" ||
            lower === "interval"
        ) {
            let detail: string | undefined;
            if (node.parameters?.rule?.cronExpression) {
                detail = `cron: ${node.parameters.rule.cronExpression}`;
            } else if (node.parameters?.interval) {
                detail = `interval: ${JSON.stringify(node.parameters.interval)}`;
            } else if (node.parameters?.rule) {
                detail = `rule: ${JSON.stringify(node.parameters.rule)}`;
            }
            triggers.push({
                type: "cron",
                nodeType: node.type,
                nodeName: node.name,
                detail,
            });
        } else if (lower === "manualtrigger") {
            triggers.push({
                type: "manual",
                nodeType: node.type,
                nodeName: node.name,
            });
        } else if (lower === "executeworkflowtrigger") {
            triggers.push({
                type: "execute_workflow_trigger",
                nodeType: node.type,
                nodeName: node.name,
            });
        } else if (lower === "errortrigger") {
            triggers.push({
                type: "event",
                nodeType: node.type,
                nodeName: node.name,
                detail: "Triggered on workflow error",
            });
        } else if (lower.endsWith("trigger")) {
            // Catch-all for service-specific triggers (e.g., "slackTrigger", "gmailTrigger")
            const service = resolveServiceName(node.type);
            triggers.push({
                type: "polling",
                nodeType: node.type,
                nodeName: node.name,
                detail: `Polling/event trigger via ${service}`,
            });
        }
    }

    // If no triggers found, it's likely manual-only
    if (triggers.length === 0) {
        triggers.push({
            type: "manual",
            nodeType: "implicit",
            nodeName: "(none detected)",
        });
    }

    return triggers;
}

function extractCrossReferences(workflow: N8nWorkflow): CrossReference[] {
    const refs: CrossReference[] = [];

    for (const node of workflow.nodes) {
        if (node.disabled) continue;
        const short = shortType(node.type);

        if (short.toLowerCase() === "executeworkflow") {
            const targetId =
                node.parameters?.workflowId?.value ??
                node.parameters?.workflowId ??
                node.parameters?.workflow?.value ??
                null;

            if (targetId) {
                refs.push({
                    targetWorkflowId: String(targetId),
                    sourceNodeName: node.name,
                });
            }
        }
    }

    return refs;
}

function extractExternalServices(workflow: N8nWorkflow): ExternalService[] {
    const serviceMap = new Map<
        string,
        { nodeType: string; count: number; credentials: Set<string> }
    >();

    for (const node of workflow.nodes) {
        if (node.disabled) continue;
        if (isInternalNode(node.type)) continue;

        const service = resolveServiceName(node.type);
        const existing = serviceMap.get(service);

        const credNames = new Set<string>();
        if (node.credentials) {
            for (const cred of Object.values(node.credentials) as any[]) {
                if (typeof cred === "string") credNames.add(cred);
                else if (cred?.name) credNames.add(cred.name);
            }
        }

        if (existing) {
            existing.count++;
            credNames.forEach((c) => existing.credentials.add(c));
        } else {
            serviceMap.set(service, {
                nodeType: node.type,
                count: 1,
                credentials: credNames,
            });
        }
    }

    return Array.from(serviceMap.entries())
        .map(([service, info]) => ({
            service,
            nodeType: info.nodeType,
            count: info.count,
            credentials: Array.from(info.credentials),
        }))
        .sort((a, b) => b.count - a.count);
}

function extractHttpEndpoints(workflow: N8nWorkflow): string[] {
    const urls: string[] = [];
    for (const node of workflow.nodes) {
        if (node.disabled) continue;
        const short = shortType(node.type).toLowerCase();
        if (short === "httprequest") {
            const url = node.parameters?.url;
            if (typeof url === "string" && !url.startsWith("=")) {
                urls.push(url);
            } else if (typeof url === "string") {
                urls.push(`(expression) ${url.substring(0, 80)}`);
            }
        }
    }
    return urls;
}

function extractAllCredentials(workflow: N8nWorkflow): string[] {
    const creds = new Set<string>();
    for (const node of workflow.nodes) {
        if (node.credentials) {
            for (const cred of Object.values(node.credentials) as any[]) {
                if (typeof cred === "string") creds.add(cred);
                else if (cred?.name) creds.add(cred.name);
            }
        }
    }
    return Array.from(creds).sort();
}

function sanitizeFilename(name: string): string {
    return name
        .replace(/[^a-zA-Z0-9_\-. ]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .substring(0, 100);
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

function generateTocMarkdown(
    analyses: WorkflowAnalysis[],
    depGraph: { nodes: string[]; edges: { from: string; to: string }[] },
): string {
    const lines: string[] = [];

    lines.push("# n8n Workflows — Table of Contents\n");
    lines.push(
        `> Auto-generated static analysis · ${new Date().toISOString()}`,
    );
    lines.push(`> ${analyses.length} workflows analyzed\n`);

    // ---- Quick stats ----
    const active = analyses.filter((a) => a.active).length;
    const inactive = analyses.length - active;
    const totalNodes = analyses.reduce((s, a) => s + a.nodeCount, 0);
    const allServices = new Set(
        analyses.flatMap((a) => a.externalServices.map((s) => s.service)),
    );

    lines.push("## Overview\n");
    lines.push(`| Metric | Count |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Active workflows | ${active} |`);
    lines.push(`| Inactive workflows | ${inactive} |`);
    lines.push(`| Total nodes (across all workflows) | ${totalNodes} |`);
    lines.push(`| Unique external services | ${allServices.size} |`);
    lines.push("");

    // ---- Service usage summary ----
    const serviceCounts = new Map<string, number>();
    for (const a of analyses) {
        for (const s of a.externalServices) {
            serviceCounts.set(
                s.service,
                (serviceCounts.get(s.service) || 0) + s.count,
            );
        }
    }
    const sortedServices = Array.from(serviceCounts.entries()).sort(
        (a, b) => b[1] - a[1],
    );

    lines.push("## External Services Used\n");
    lines.push("| Service | Total Node Count | Workflows Using It |");
    lines.push("| --- | --- | --- |");
    for (const [service, count] of sortedServices) {
        const wfCount = analyses.filter((a) =>
            a.externalServices.some((s) => s.service === service),
        ).length;
        lines.push(`| ${service} | ${count} | ${wfCount} |`);
    }
    lines.push("");

    // ---- Trigger type breakdown ----
    const triggerTypeCounts = new Map<string, number>();
    for (const a of analyses) {
        for (const t of a.triggers) {
            triggerTypeCounts.set(
                t.type,
                (triggerTypeCounts.get(t.type) || 0) + 1,
            );
        }
    }
    lines.push("## Trigger Types\n");
    lines.push("| Trigger Type | Count |");
    lines.push("| --- | --- |");
    for (const [type, count] of Array.from(triggerTypeCounts.entries()).sort(
        (a, b) => b[1] - a[1],
    )) {
        lines.push(`| ${type} | ${count} |`);
    }
    lines.push("");

    // ---- Cross-workflow dependency graph (text representation) ----
    if (depGraph.edges.length > 0) {
        lines.push("## Cross-Workflow Dependencies\n");
        lines.push('Arrows show "calls" relationships.\n');

        // Group by caller
        const callerMap = new Map<string, string[]>();
        for (const edge of depGraph.edges) {
            const existing = callerMap.get(edge.from) || [];
            existing.push(edge.to);
            callerMap.set(edge.from, existing);
        }

        for (const [caller, callees] of callerMap) {
            for (const callee of callees) {
                lines.push(`- **${caller}** → ${callee}`);
            }
        }
        lines.push("");

        // Identify root workflows (called by nothing) and leaf workflows (call nothing)
        const calledIds = new Set(depGraph.edges.map((e) => e.to));
        const callerIds = new Set(depGraph.edges.map((e) => e.from));
        const roots = analyses.filter(
            (a) => callerIds.has(a.name) && !calledIds.has(a.name),
        );
        const leaves = analyses.filter(
            (a) => calledIds.has(a.name) && !callerIds.has(a.name),
        );

        if (roots.length > 0) {
            lines.push(
                "**Entry-point workflows** (call others but are not called):\n",
            );
            for (const r of roots)
                lines.push(`- [${r.name}](${r.markdownFile})`);
            lines.push("");
        }
        if (leaves.length > 0) {
            lines.push(
                "**Leaf workflows** (called by others but don't call any):\n",
            );
            for (const l of leaves)
                lines.push(`- [${l.name}](${l.markdownFile})`);
            lines.push("");
        }
    }

    // ---- Full workflow index ----
    lines.push("## Workflow Index\n");
    lines.push("| ID | Name | Active | Nodes | Trigger | Services | Links |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");

    // Sort: active first, then alphabetical
    const sorted = [...analyses].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    for (const a of sorted) {
        const triggerStr = a.triggers.map((t) => t.type).join(", ");
        const serviceStr = a.externalServices
            .slice(0, 4)
            .map((s) => s.service)
            .join(", ");
        const suffix =
            a.externalServices.length > 4
                ? ` +${a.externalServices.length - 4}`
                : "";
        const activeIcon = a.active ? "✅" : "⏸️";
        lines.push(
            `| ${a.id} | ${a.name} | ${activeIcon} | ${a.nodeCount} | ${triggerStr} | ${serviceStr}${suffix} | [detail](${a.markdownFile}) |`,
        );
    }
    lines.push("");

    return lines.join("\n");
}

function generateMermaidDependencyGraph(
    analyses: WorkflowAnalysis[],
    depGraph: {
        nodes: string[];
        edges: { from: string; to: string; fromId: string; toId: string }[];
    },
): string {
    if (depGraph.edges.length === 0) return "";

    const lines: string[] = [];
    lines.push("# Dependency Graph (Mermaid)\n");
    lines.push("```mermaid");
    lines.push("graph LR");

    // Collect only nodes involved in edges
    const involvedIds = new Set<string>();
    for (const e of depGraph.edges) {
        involvedIds.add(e.fromId);
        involvedIds.add(e.toId);
    }

    // Declare nodes
    const nameById = new Map(analyses.map((a) => [a.id, a.name]));
    for (const id of involvedIds) {
        const name = nameById.get(id) || id;
        // Mermaid-safe label
        const safeLabel = name.replace(/"/g, "'").replace(/[[\](){}]/g, "");
        lines.push(`  wf_${id}["${safeLabel}"]`);
    }

    // Edges
    for (const e of depGraph.edges) {
        lines.push(`  wf_${e.fromId} --> wf_${e.toId}`);
    }

    lines.push("```\n");
    return lines.join("\n");
}

function generatePerWorkflowStub(analysis: WorkflowAnalysis): string {
    const lines: string[] = [];

    lines.push(`# ${analysis.name}\n`);
    lines.push(
        `> **ID:** ${analysis.id} · **Active:** ${analysis.active ? "Yes" : "No"} · **Nodes:** ${analysis.nodeCount}`,
    );
    if (analysis.tags.length > 0) {
        lines.push(`> **Tags:** ${analysis.tags.join(", ")}`);
    }
    lines.push("");

    // Triggers
    lines.push("## Triggers\n");
    for (const t of analysis.triggers) {
        const detail = t.detail ? ` — ${t.detail}` : "";
        lines.push(`- **${t.type}** (${t.nodeName})${detail}`);
    }
    lines.push("");

    // External services
    if (analysis.externalServices.length > 0) {
        lines.push("## External Services\n");
        for (const s of analysis.externalServices) {
            const creds =
                s.credentials.length > 0
                    ? ` (credentials: ${s.credentials.join(", ")})`
                    : "";
            lines.push(`- **${s.service}** — ${s.count} node(s)${creds}`);
        }
        lines.push("");
    }

    // HTTP endpoints
    if (analysis.httpEndpoints.length > 0) {
        lines.push("## HTTP Endpoints\n");
        for (const url of analysis.httpEndpoints) {
            lines.push(`- \`${url}\``);
        }
        lines.push("");
    }

    // Cross-references
    if (analysis.callsWorkflows.length > 0) {
        lines.push("## Calls Workflows\n");
        for (const ref of analysis.callsWorkflows) {
            const name = ref.targetWorkflowName || ref.targetWorkflowId;
            const mdFile = `${ref.targetWorkflowId}__${sanitizeFilename(ref.targetWorkflowName || ref.targetWorkflowId)}.md`;
            lines.push(
                `- [${name}](${mdFile}) (via node "${ref.sourceNodeName}")`,
            );
        }
        lines.push("");
    }

    if (analysis.calledByWorkflows.length > 0) {
        lines.push("## Called By\n");
        for (const ref of analysis.calledByWorkflows) {
            const name = ref.targetWorkflowName || ref.targetWorkflowId;
            const mdFile = `${ref.targetWorkflowId}__${sanitizeFilename(ref.targetWorkflowName || ref.targetWorkflowId)}.md`;
            lines.push(
                `- [${name}](${mdFile}) (via node "${ref.sourceNodeName}")`,
            );
        }
        lines.push("");
    }

    // Placeholder for Phase 2 LLM content
    lines.push("## Executive Summary\n");
    lines.push("_To be generated by Phase 2 LLM analysis._\n");

    lines.push("## Logic Flow\n");
    lines.push("_To be generated by Phase 2 LLM analysis._\n");

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    console.log(`Workflows dir : ${path.resolve(WORKFLOWS_DIR)}`);
    console.log(`Output dir    : ${path.resolve(OUTPUT_DIR)}\n`);

    // Read manifest
    const manifestPath = path.join(WORKFLOWS_DIR, "_manifest.json");
    if (!fs.existsSync(manifestPath)) {
        console.error(`ERROR: _manifest.json not found in ${WORKFLOWS_DIR}`);
        console.error("Run the export script first.");
        process.exit(1);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    console.log(`Manifest lists ${manifest.workflows.length} workflow(s).\n`);

    // Load all workflow JSONs
    const workflows: N8nWorkflow[] = [];
    for (const entry of manifest.workflows) {
        const filepath = path.join(WORKFLOWS_DIR, entry.filename);
        if (!fs.existsSync(filepath)) {
            console.warn(`  WARN: ${entry.filename} not found, skipping`);
            continue;
        }
        const wf = JSON.parse(
            fs.readFileSync(filepath, "utf-8"),
        ) as N8nWorkflow;
        workflows.push(wf);
    }
    console.log(`Loaded ${workflows.length} workflow JSON(s).\n`);

    // Build a name lookup for cross-reference resolution
    const nameById = new Map(workflows.map((wf) => [String(wf.id), wf.name]));

    // Analyze each workflow
    const analyses: WorkflowAnalysis[] = [];

    for (const wf of workflows) {
        const triggers = extractTriggers(wf);
        const crossRefs = extractCrossReferences(wf);
        const externalServices = extractExternalServices(wf);
        const httpEndpoints = extractHttpEndpoints(wf);
        const allCredentials = extractAllCredentials(wf);

        // Resolve cross-reference names
        for (const ref of crossRefs) {
            ref.targetWorkflowName = nameById.get(ref.targetWorkflowId);
        }

        const disabledCount = wf.nodes.filter((n) => n.disabled).length;

        analyses.push({
            id: String(wf.id),
            name: wf.name,
            active: wf.active,
            tags: wf.tags?.map((t) => t.name) ?? [],
            nodeCount: wf.nodes.length,
            disabledNodeCount: disabledCount,
            triggers,
            callsWorkflows: crossRefs,
            calledByWorkflows: [], // populated below
            externalServices,
            allCredentials,
            httpEndpoints,
            createdAt: wf.createdAt,
            updatedAt: wf.updatedAt,
            markdownFile: `${wf.id}__${sanitizeFilename(wf.name)}.md`,
        });
    }

    // Second pass: populate "calledBy" reverse references
    for (const a of analyses) {
        for (const ref of a.callsWorkflows) {
            const target = analyses.find((t) => t.id === ref.targetWorkflowId);
            if (target) {
                target.calledByWorkflows.push({
                    targetWorkflowId: a.id,
                    targetWorkflowName: a.name,
                    sourceNodeName: ref.sourceNodeName,
                });
            }
        }
    }

    // Build dependency graph for the TOC
    const depEdges: {
        from: string;
        to: string;
        fromId: string;
        toId: string;
    }[] = [];
    for (const a of analyses) {
        for (const ref of a.callsWorkflows) {
            depEdges.push({
                from: a.name,
                to: ref.targetWorkflowName || ref.targetWorkflowId,
                fromId: a.id,
                toId: ref.targetWorkflowId,
            });
        }
    }
    const depNodes = Array.from(
        new Set([...depEdges.map((e) => e.from), ...depEdges.map((e) => e.to)]),
    );
    const depGraph = { nodes: depNodes, edges: depEdges };

    // Create output directory
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // Write TOC
    const tocMd = generateTocMarkdown(analyses, depGraph);
    const tocPath = path.join(OUTPUT_DIR, "00_TABLE_OF_CONTENTS.md");
    fs.writeFileSync(tocPath, tocMd, "utf-8");
    console.log(`✓ Table of Contents → ${tocPath}`);

    // Write Mermaid dependency graph
    const mermaidMd = generateMermaidDependencyGraph(analyses, depGraph);
    if (mermaidMd) {
        const mermaidPath = path.join(OUTPUT_DIR, "01_DEPENDENCY_GRAPH.md");
        fs.writeFileSync(mermaidPath, mermaidMd, "utf-8");
        console.log(`✓ Dependency Graph  → ${mermaidPath}`);
    }

    // Write per-workflow stub files
    const stubsDir = path.join(OUTPUT_DIR, "workflows");
    fs.mkdirSync(stubsDir, { recursive: true });
    for (const a of analyses) {
        const stubMd = generatePerWorkflowStub(a);
        const stubPath = path.join(stubsDir, a.markdownFile);
        fs.writeFileSync(stubPath, stubMd, "utf-8");
    }
    console.log(`✓ ${analyses.length} workflow stubs   → ${stubsDir}/`);

    // Write structured JSON (for Phase 2 to consume)
    const analysisJsonPath = path.join(OUTPUT_DIR, "analysis.json");
    fs.writeFileSync(
        analysisJsonPath,
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                totalWorkflows: analyses.length,
                dependencyGraph: depGraph,
                workflows: analyses,
            },
            null,
            2,
        ),
        "utf-8",
    );
    console.log(`✓ Structured JSON   → ${analysisJsonPath}`);

    // Summary
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Analysis complete.`);
    console.log(`  ${analyses.length} workflows analyzed`);
    console.log(
        `  ${analyses.filter((a) => a.active).length} active, ${analyses.filter((a) => !a.active).length} inactive`,
    );
    console.log(`  ${depEdges.length} cross-workflow dependencies found`);
    console.log(
        `  ${new Set(analyses.flatMap((a) => a.externalServices.map((s) => s.service))).size} unique external services`,
    );
    console.log(`${"=".repeat(60)}`);
}

main().catch((err) => {
    console.error("\nFatal error:", err);
    process.exit(1);
});
