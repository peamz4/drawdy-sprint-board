// Tickets, sprints and the board config, plus the small pure helpers around them.
// Everything here is plain data: it lives in element `meta` on the canvas, so any
// value read back is treated as untrusted and normalized before use.

export type Status = "backlog" | "todo" | "inprogress" | "testing" | "done";
export type TicketType = "feature" | "bug" | "chore";
export type Priority = "p1" | "p2" | "p3";

export type Person = {
    name: string;
    color: string;
    /** The Drawdy collaboration user id, when the person was picked from the board's users. */
    userId: string | null;
};

export type Ticket = {
    key: string;
    title: string;
    description: string;
    type: TicketType;
    priority: Priority;
    status: Status;
    assignee: Person | null;
    points: number | null;
    /** Position inside its column, 0 at the top. */
    order: number;
    createdAt: string;
    updatedAt: string;
};

export type Sprint = {
    id: string;
    name: string;
    goal: string;
    startDate: string;
    endDate: string;
};

export type ReleasedTicket = {
    key: string;
    title: string;
    type: TicketType;
    priority: Priority;
    assignee: Person | null;
    points: number | null;
};

/** A completed sprint: one entry of the version log. */
export type ArchivedSprint = Sprint & {
    completedAt: string;
    done: ReleasedTicket[];
    carriedOver: string[];
    movedToBacklog: string[];
    notes: string;
};

export type BoardConfig = {
    keyPrefix: string;
    nextNumber: number;
};

export const STATUS_ORDER: Status[] = ["backlog", "todo", "inprogress", "testing", "done"];
export const SPRINT_STATUSES: Status[] = ["todo", "inprogress", "testing", "done"];
const TICKET_TYPES: TicketType[] = ["feature", "bug", "chore"];
const PRIORITIES: Priority[] = ["p1", "p2", "p3"];

export const STATUS_LABEL: Record<Status, string> = {
    backlog: "Backlog",
    todo: "To do",
    inprogress: "In progress",
    testing: "Testing",
    done: "Done",
};

export const STATUS_COLOR: Record<Status, string> = {
    backlog: "#868e96",
    todo: "#4263eb",
    inprogress: "#e8590c",
    testing: "#ae3ec9",
    done: "#2f9e44",
};

export const TYPE_LABEL: Record<TicketType, string> = {
    feature: "Feature",
    bug: "Bug",
    chore: "Chore",
};

/** Card paper per ticket type. Light fills with dark text read in both themes. */
export const TYPE_FILL: Record<TicketType, string> = {
    feature: "#dbe4ff",
    bug: "#ffe0e3",
    chore: "#eceef1",
};

export const PRIORITY_LABEL: Record<Priority, string> = { p1: "P1", p2: "P2", p3: "P3" };

/** Card outline per priority. */
export const PRIORITY_STROKE: Record<Priority, string> = {
    p1: "#e03131",
    p2: "#f08c00",
    p3: "#868e96",
};

const PERSON_COLORS = [
    "#4263eb",
    "#0ca678",
    "#e8590c",
    "#ae3ec9",
    "#1c7ed6",
    "#d6336c",
    "#5c940d",
    "#f59f00",
];

export function colorForName(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    return PERSON_COLORS[Math.abs(hash) % PERSON_COLORS.length];
}

// ---- dates ----

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function formatDay(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Today as YYYY-MM-DD in the viewer's time zone. */
export function todayISO(): string {
    return formatDay(new Date());
}

export function addDays(isoDay: string, days: number): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
    const base = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
    base.setDate(base.getDate() + days);
    return formatDay(base);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-27" -> "Oct 27, 2026". */
export function formatDayLabel(isoDay: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
    if (!m) return isoDay;
    return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

// ---- keys and names ----

/** Two to ten capital letters or digits, starting with a letter. */
export function normalizePrefix(input: unknown): string {
    const cleaned = (typeof input === "string" ? input : "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const trimmed = cleaned.replace(/^[0-9]+/, "").slice(0, 10);
    return trimmed.length >= 2 ? trimmed : "TASK";
}

export function formatKey(prefix: string, n: number): string {
    return `${prefix}-${String(n).padStart(3, "0")}`;
}

/** The number in "LAOR-012" when the key uses this prefix, else null. */
export function keyNumber(key: string, prefix: string): number | null {
    const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(key);
    if (!m || m[1] !== prefix) return null;
    return Number(m[2]);
}

/** "v0.0.6-beta" -> "v0.0.7-beta", "Sprint 3" -> "Sprint 4", "Polish" -> "Polish 2". */
export function bumpVersionName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return "Sprint 1";
    const m = /^(.*?)(\d+)(\D*)$/.exec(trimmed);
    if (!m) return `${trimmed} 2`;
    return `${m[1]}${Number(m[2]) + 1}${m[3]}`;
}

// ---- normalizing values read back from the canvas ----

export function clip(v: unknown, max: number): string {
    return typeof v === "string" ? v.slice(0, max) : "";
}

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
    return typeof v === "string" && (options as readonly string[]).includes(v) ? (v as T) : fallback;
}

function finiteOr(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function normalizePerson(v: unknown): Person | null {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const name = clip(o.name, 80).trim();
    if (!name) return null;
    return {
        name,
        color: clip(o.color, 40) || colorForName(name),
        userId: typeof o.userId === "string" && o.userId ? o.userId : null,
    };
}

function normalizePoints(v: unknown): number | null {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    return Math.round(v * 10) / 10;
}

export function normalizeTicket(v: unknown): Ticket | null {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const key = clip(o.key, 40).trim();
    if (!key) return null;
    const now = new Date().toISOString();
    return {
        key,
        title: clip(o.title, 300).trim() || "Untitled",
        description: clip(o.description, 4000),
        type: oneOf(o.type, TICKET_TYPES, "feature"),
        priority: oneOf(o.priority, PRIORITIES, "p2"),
        status: oneOf(o.status, STATUS_ORDER, "todo"),
        assignee: normalizePerson(o.assignee),
        points: normalizePoints(o.points),
        order: finiteOr(o.order, 0),
        createdAt: clip(o.createdAt, 40) || now,
        updatedAt: clip(o.updatedAt, 40) || now,
    };
}

export function normalizeSprint(v: unknown): Sprint {
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const start = clip(o.startDate, 10) || todayISO();
    return {
        id: clip(o.id, 80) || "sprint-1",
        name: clip(o.name, 80).trim() || "Sprint 1",
        goal: clip(o.goal, 500),
        startDate: start,
        endDate: clip(o.endDate, 10) || addDays(start, 14),
    };
}

function normalizeReleased(v: unknown): ReleasedTicket | null {
    const t = normalizeTicket(v);
    if (!t) return null;
    return {
        key: t.key,
        title: t.title,
        type: t.type,
        priority: t.priority,
        assignee: t.assignee,
        points: t.points,
    };
}

function stringList(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, 500) : [];
}

export function normalizeArchive(v: unknown): ArchivedSprint[] {
    if (!Array.isArray(v)) return [];
    const out: ArchivedSprint[] = [];
    for (const item of v) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        out.push({
            ...normalizeSprint(o),
            completedAt: clip(o.completedAt, 10) || todayISO(),
            done: (Array.isArray(o.done) ? o.done : [])
                .map(normalizeReleased)
                .filter((t): t is ReleasedTicket => t !== null),
            carriedOver: stringList(o.carriedOver),
            movedToBacklog: stringList(o.movedToBacklog),
            notes: clip(o.notes, 4000),
        });
    }
    return out;
}

export function normalizeConfig(v: unknown): BoardConfig {
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    return {
        keyPrefix: normalizePrefix(o.keyPrefix),
        nextNumber: Math.max(1, Math.floor(finiteOr(o.nextNumber, 1))),
    };
}

/** Applies an edit from the panel onto a ticket, keeping only known fields. */
export function applyTicketPatch(t: Ticket, patch: unknown): Ticket {
    const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = { ...t };
    for (const field of ["title", "description", "type", "priority", "status", "points"]) {
        if (field in p) merged[field] = p[field];
    }
    if ("assignee" in p) merged.assignee = p.assignee;
    merged.updatedAt = new Date().toISOString();
    return normalizeTicket(merged) ?? t;
}

// ---- importing existing board items ----

const STATUS_ALIASES: Record<string, Status> = {
    backlog: "backlog",
    "to do": "todo",
    todo: "todo",
    "in progress": "inprogress",
    doing: "inprogress",
    testing: "testing",
    review: "testing",
    "in review": "testing",
    qa: "testing",
    done: "done",
};

/** The status a column label like "In progress" names, or null. */
export function statusFromLabel(label: string): Status | null {
    const first = label.split("\n")[0].trim().toLowerCase().replace(/\s*\(\d+\)$/, "");
    return STATUS_ALIASES[first] ?? null;
}

export type ImportedText = {
    keyHint: string | null;
    title: string;
    description: string;
    type: TicketType | null;
    priority: Priority | null;
};

/**
 * Reads a sticky note or card such as
 *   "LAOR-001 · Hard Judgement mode\nOptional stricter windows…\nFeature · P3"
 * into a ticket draft. A line made only of a type and a priority becomes those fields.
 */
export function parseImportedText(raw: string): ImportedText | null {
    const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length === 0) return null;

    let keyHint: string | null = null;
    let title = lines[0];
    const keyed = /^([A-Z][A-Z0-9]+-\d+)\s*[·:|\-–—]?\s*(.*)$/.exec(title);
    if (keyed) {
        keyHint = keyed[1];
        title = keyed[2] || keyed[1];
    }

    let type: TicketType | null = null;
    let priority: Priority | null = null;
    const description: string[] = [];
    for (const line of lines.slice(1)) {
        const typeMatch = /\b(feature|story|bug|chore|task)\b/i.exec(line);
        const prioMatch = /\bP([1-3])\b/.exec(line);
        const leftover = line
            .replace(/\b(feature|story|bug|chore|task)\b/gi, "")
            .replace(/\bP[1-3]\b/g, "")
            .replace(/[\s·|,\-–—]/g, "");
        if ((typeMatch || prioMatch) && leftover.length === 0) {
            if (typeMatch) {
                const word = typeMatch[1].toLowerCase();
                type = word === "bug" ? "bug" : word === "chore" || word === "task" ? "chore" : "feature";
            }
            if (prioMatch) priority = `p${prioMatch[1]}` as Priority;
            continue;
        }
        description.push(line);
    }

    return { keyHint, title: title.slice(0, 300), description: description.join("\n"), type, priority };
}
