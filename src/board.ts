// The sprint board as canvas elements: reading it back from the scene, the element
// schemas for each part, and the layout pass that snaps everything into columns.
//
// Where the data lives (all in element `meta`, so it syncs on cloud boards):
//   board frame    sbRole "board"    sbConfig, sbSprint, sbArchive (the version log)
//   column         sbRole "column"   sbStatus
//   ticket card    sbRole "card"     sbTicket (the whole ticket)
//   sprint title   sbRole "title" / "subtitle"
//   archive frame  sbRole "archive"
//   release card   sbRole "release"  sbSprintId
// Every part except the board frame also carries sbBoard, the board frame's id.

import { call, CommandError, newId } from "./drawdy";
import type { ArchivedSprint, BoardConfig, Sprint, Status, Ticket } from "./model";
import {
    formatDayLabel,
    normalizeArchive,
    normalizeConfig,
    normalizeSprint,
    normalizeTicket,
    PRIORITY_LABEL,
    PRIORITY_STROKE,
    STATUS_COLOR,
    STATUS_LABEL,
    STATUS_ORDER,
    TYPE_FILL,
    TYPE_LABEL,
} from "./model";

export type Rect = { x: number; y: number; width: number; height: number };
export type Placed = Rect & { id: string; frameId: string | null };
export type CardElement = Placed & { ticket: Ticket };
export type ReleaseElement = Placed & { sprintId: string };

export type BoardIndex = {
    frame: Placed;
    config: BoardConfig;
    sprint: Sprint;
    archive: ArchivedSprint[];
    columns: Partial<Record<Status, Placed>>;
    title: Placed | null;
    subtitle: Placed | null;
    cards: CardElement[];
    archiveFrame: Placed | null;
    releases: ReleaseElement[];
};

const PAD = 32;
const COL_W = 320;
const COL_GAP = 24;
const HEADER_H = 116;
const COL_HEAD = 52;
const CARD_INSET = 16;
const CARD_W = COL_W - CARD_INSET * 2;
const CARD_H = 100;
const CARD_GAP = 12;
const COL_MIN_H = 460;
const ARCHIVE_GAP = 120;
const RELEASE_GAP = 16;
export const BOARD_W = PAD * 2 + STATUS_ORDER.length * COL_W + (STATUS_ORDER.length - 1) * COL_GAP;

// Canvas text has to read for collaborators in either theme, so loose text uses
// mid-tone colors, and dark text only ever sits on the light card fills.
const TITLE_INK = "#4c6ef5";
const MUTED_INK = "#868e96";
const CARD_INK = "#1f2933";

const READ_PROPS = ["meta", "x", "y", "width", "height", "frameId"];

function num(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function placed(el: any): Placed {
    return {
        id: String(el.id),
        x: num(el.x),
        y: num(el.y),
        width: num(el.width),
        height: num(el.height),
        frameId: typeof el.frameId === "string" ? el.frameId : null,
    };
}

/** Finds the sprint board on the canvas and indexes its parts, or null when there is none. */
export async function readBoard(): Promise<BoardIndex | null> {
    const res = await call("command:scene:get-drawdy-elements", { properties: READ_PROPS });
    const elements: any[] = Array.isArray(res?.drawdyElements) ? res.drawdyElements : [];

    const frameEl = elements.find((el) => el?.meta?.sbRole === "board");
    if (!frameEl) return null;
    const boardId = String(frameEl.id);

    const index: BoardIndex = {
        frame: placed(frameEl),
        config: normalizeConfig(frameEl.meta.sbConfig),
        sprint: normalizeSprint(frameEl.meta.sbSprint),
        archive: normalizeArchive(frameEl.meta.sbArchive),
        columns: {},
        title: null,
        subtitle: null,
        cards: [],
        archiveFrame: null,
        releases: [],
    };

    for (const el of elements) {
        const meta = el?.meta;
        if (!meta || meta.sbBoard !== boardId) continue;
        switch (meta.sbRole) {
            case "column":
                if (STATUS_ORDER.includes(meta.sbStatus)) index.columns[meta.sbStatus as Status] = placed(el);
                break;
            case "title":
                index.title = placed(el);
                break;
            case "subtitle":
                index.subtitle = placed(el);
                break;
            case "card": {
                const ticket = normalizeTicket(meta.sbTicket);
                if (ticket) index.cards.push({ ...placed(el), ticket });
                break;
            }
            case "archive":
                index.archiveFrame = placed(el);
                break;
            case "release":
                if (typeof meta.sbSprintId === "string") {
                    index.releases.push({ ...placed(el), sprintId: meta.sbSprintId });
                }
                break;
        }
    }
    return index;
}

// ---- geometry ----

export function columnX(frame: Rect, status: Status): number {
    return frame.x + PAD + STATUS_ORDER.indexOf(status) * (COL_W + COL_GAP);
}

function columnTop(frame: Rect): number {
    return frame.y + HEADER_H;
}

function cardSlot(frame: Rect, status: Status, order: number): { x: number; y: number } {
    return {
        x: columnX(frame, status) + CARD_INSET,
        y: columnTop(frame) + COL_HEAD + order * (CARD_H + CARD_GAP),
    };
}

/** The status column whose area holds this point, or null when it is outside every column. */
export function statusAt(b: BoardIndex, point: { x: number; y: number }, columnHeight: number): Status | null {
    const top = columnTop(b.frame) - 60;
    const bottom = columnTop(b.frame) + columnHeight + 240;
    if (point.y < top || point.y > bottom) return null;
    for (const status of STATUS_ORDER) {
        const x = columnX(b.frame, status);
        if (point.x >= x - COL_GAP / 2 && point.x <= x + COL_W + COL_GAP / 2) return status;
    }
    return null;
}

function columnHeightFor(cards: CardElement[]): number {
    const counts = new Map<Status, number>();
    for (const c of cards) counts.set(c.ticket.status, (counts.get(c.ticket.status) ?? 0) + 1);
    const most = Math.max(0, ...counts.values());
    return Math.max(COL_MIN_H, COL_HEAD + most * (CARD_H + CARD_GAP) + CARD_INSET);
}

export function currentColumnHeight(b: BoardIndex): number {
    return columnHeightFor(b.cards);
}

// ---- element schemas ----

export function cardText(t: Ticket): string {
    const head = [t.key, PRIORITY_LABEL[t.priority], TYPE_LABEL[t.type]];
    if (t.points !== null) head.push(`${t.points} pt`);
    const title = t.title.length > 64 ? `${t.title.slice(0, 63).trimEnd()}…` : t.title;
    const who = t.assignee ? `@${t.assignee.name}` : "Unassigned";
    return `${head.join(" · ")}\n${title}\n${who}`;
}

export function frameSchema(id: string, x: number, y: number, config: BoardConfig, sprint: Sprint): any {
    return {
        type: "frame",
        drawdyElementId: id,
        name: `${config.keyPrefix} sprint board`,
        position: [x, y],
        width: BOARD_W,
        height: HEADER_H + COL_MIN_H + PAD,
        rotation: 0,
        meta: { sbRole: "board", sbConfig: config, sbSprint: sprint, sbArchive: [] },
    };
}

function columnSchema(boardId: string, frame: Rect, status: Status, height: number): any {
    return {
        type: "shape",
        componentType: "rect",
        drawdyElementId: newId(),
        frameId: boardId,
        x: columnX(frame, status),
        y: columnTop(frame),
        width: COL_W,
        height,
        strokeColor: STATUS_COLOR[status],
        fillColor: "transparent",
        strokeWidth: 1.5,
        roughness: 0,
        cornerRadius: 14,
        text: STATUS_LABEL[status],
        fontSize: 20,
        textAlign: "left",
        textVerticalAlign: "top",
        textColor: STATUS_COLOR[status],
        meta: { sbRole: "column", sbBoard: boardId, sbStatus: status },
    };
}

function subtitleText(config: BoardConfig, sprint: Sprint): string {
    const range = `${formatDayLabel(sprint.startDate)} – ${formatDayLabel(sprint.endDate)}`;
    return `${config.keyPrefix} · ${range}${sprint.goal ? ` · Goal: ${sprint.goal}` : ""}`;
}

export function titleSchemas(boardId: string, frame: Rect, config: BoardConfig, sprint: Sprint): any[] {
    return [
        {
            type: "text",
            drawdyElementId: newId(),
            frameId: boardId,
            x: frame.x + PAD,
            y: frame.y + 28,
            text: sprint.name,
            fontSize: 32,
            color: TITLE_INK,
            meta: { sbRole: "title", sbBoard: boardId },
        },
        {
            type: "text",
            drawdyElementId: newId(),
            frameId: boardId,
            x: frame.x + PAD,
            y: frame.y + 74,
            width: BOARD_W - PAD * 2,
            text: subtitleText(config, sprint),
            fontSize: 16,
            color: MUTED_INK,
            meta: { sbRole: "subtitle", sbBoard: boardId },
        },
    ];
}

export function cardSchema(boardId: string, ticket: Ticket, x: number, y: number, id: string): any {
    return {
        type: "shape",
        componentType: "rect",
        drawdyElementId: id,
        frameId: boardId,
        x,
        y,
        width: CARD_W,
        height: CARD_H,
        strokeColor: PRIORITY_STROKE[ticket.priority],
        fillColor: TYPE_FILL[ticket.type],
        strokeWidth: 2,
        roughness: 0,
        cornerRadius: 10,
        text: cardText(ticket),
        fontSize: 15,
        textAlign: "left",
        textVerticalAlign: "top",
        textColor: CARD_INK,
        meta: { sbRole: "card", sbBoard: boardId, sbTicket: ticket },
    };
}

/** Where a new ticket lands: the bottom of its column. */
export function newCardSlot(b: BoardIndex, status: Status, order: number): { x: number; y: number } {
    return cardSlot(b.frame, status, order);
}

export function releaseLines(r: ArchivedSprint): string[] {
    const counts = [`${r.done.length} done`];
    if (r.carriedOver.length) counts.push(`${r.carriedOver.length} carried over`);
    if (r.movedToBacklog.length) counts.push(`${r.movedToBacklog.length} back to backlog`);
    const lines = [`${r.name}  ·  released ${formatDayLabel(r.completedAt)}  ·  ${counts.join(", ")}`];
    if (r.goal) lines.push(`Goal: ${r.goal}`);
    for (const note of r.notes.split("\n").map((n) => n.trim()).filter(Boolean).slice(0, 10)) {
        lines.push(note.startsWith("•") || note.startsWith("-") ? note : `• ${note}`);
    }
    const shown = r.done.slice(0, 40);
    for (const t of shown) {
        lines.push(`${t.key}   ${t.title}${t.assignee ? `   @${t.assignee.name}` : ""}`);
    }
    if (r.done.length > shown.length) lines.push(`…and ${r.done.length - shown.length} more`);
    if (r.done.length === 0) lines.push("No tickets were finished in this sprint.");
    return lines;
}

function releaseHeight(r: ArchivedSprint): number {
    return 28 + releaseLines(r).length * 22;
}

export function archiveFrameSchema(boardId: string, id: string, frame: Rect, frameHeight: number): any {
    return {
        type: "frame",
        drawdyElementId: id,
        name: "Sprint archive · version log",
        position: [frame.x, frame.y + frameHeight + ARCHIVE_GAP],
        width: BOARD_W,
        height: 200,
        rotation: 0,
        meta: { sbRole: "archive", sbBoard: boardId },
    };
}

export function releaseSchema(boardId: string, archiveFrameId: string, r: ArchivedSprint, x: number, y: number): any {
    return {
        type: "shape",
        componentType: "rect",
        drawdyElementId: newId(),
        frameId: archiveFrameId,
        x,
        y,
        width: BOARD_W - PAD * 2,
        height: releaseHeight(r),
        strokeColor: STATUS_COLOR.done,
        fillColor: "#ebfbee",
        strokeWidth: 1.5,
        roughness: 0,
        cornerRadius: 12,
        text: releaseLines(r).join("\n"),
        fontSize: 15,
        textAlign: "left",
        textVerticalAlign: "top",
        textColor: CARD_INK,
        meta: { sbRole: "release", sbBoard: boardId, sbSprintId: r.id },
    };
}

// ---- writing ----

/**
 * Adds elements. Adding is all-or-nothing on ids, so when an id is already taken
 * (a re-added card whose old copy is still being removed) it retries once with fresh ids.
 */
export async function addElements(elements: any[]): Promise<void> {
    if (elements.length === 0) return;
    try {
        await call("command:scene:add-drawdy-elements", { elements });
    } catch (err) {
        const taken = err instanceof CommandError ? (err.body?.existingIds as unknown) : null;
        if (!Array.isArray(taken) || taken.length === 0) throw err;
        const retry = elements.map((el) =>
            taken.includes(el.drawdyElementId) ? { ...el, drawdyElementId: newId() } : el
        );
        await call("command:scene:add-drawdy-elements", { elements: retry });
    }
}

export async function removeElements(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await call("command:scene:remove-drawdy-elements", { drawdyElementIds: ids });
}

/** Shape labels can't be patched, so a card whose text changes is removed and added again in place. */
export async function redrawCard(b: BoardIndex, card: CardElement, ticket: Ticket): Promise<void> {
    await removeElements([card.id]);
    await addElements([cardSchema(b.frame.id, ticket, card.x, card.y, card.id)]);
}

export async function updateElements(updates: { drawdyElementId: string; properties: Record<string, unknown> }[]): Promise<void> {
    if (updates.length === 0) return;
    await call("command:scene:update-drawdy-elements", { updates });
}

/** Adds any column or heading the user deleted. Resolves true when something was added. */
export async function ensureStructure(b: BoardIndex): Promise<boolean> {
    const missing: any[] = [];
    const height = currentColumnHeight(b);
    for (const status of STATUS_ORDER) {
        if (!b.columns[status]) missing.push(columnSchema(b.frame.id, b.frame, status, height));
    }
    if (!b.title || !b.subtitle) {
        const [title, subtitle] = titleSchemas(b.frame.id, b.frame, b.config, b.sprint);
        if (!b.title) missing.push(title);
        if (!b.subtitle) missing.push(subtitle);
    }
    await addElements(missing);
    return missing.length > 0;
}

/** Redraws the sprint title and subtitle after the sprint changed. */
export async function redrawHeading(b: BoardIndex): Promise<void> {
    const old = [b.title?.id, b.subtitle?.id].filter((id): id is string => !!id);
    await removeElements(old);
    await addElements(titleSchemas(b.frame.id, b.frame, b.config, b.sprint));
}

export function columnCards(b: BoardIndex, status: Status): CardElement[] {
    return b.cards
        .filter((c) => c.ticket.status === status)
        .sort((a, c) => a.ticket.order - c.ticket.order || a.y - c.y);
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;

/**
 * Snaps every card into its column slot, sizes the columns and the frame to the
 * tallest column, keeps the archive below the board, and stacks the releases in
 * it newest first. Only elements that are off get an update.
 */
export async function relayout(b: BoardIndex): Promise<void> {
    const updates: { drawdyElementId: string; properties: Record<string, unknown> }[] = [];
    const place = (el: Placed, x: number, y: number, frameId: string | null, w?: number, h?: number): void => {
        const props: Record<string, unknown> = {};
        if (!near(el.x, x) || !near(el.y, y)) props.transform = { x, y };
        if (w !== undefined && !near(el.width, w)) props.width = w;
        if (h !== undefined && !near(el.height, h)) props.height = h;
        if (frameId !== null && el.frameId !== frameId) props.frameId = frameId;
        if (Object.keys(props).length > 0) updates.push({ drawdyElementId: el.id, properties: props });
    };

    const colH = currentColumnHeight(b);
    for (const status of STATUS_ORDER) {
        const column = b.columns[status];
        if (column) place(column, columnX(b.frame, status), columnTop(b.frame), b.frame.id, COL_W, colH);
        columnCards(b, status).forEach((card, order) => {
            const slot = cardSlot(b.frame, status, order);
            place(card, slot.x, slot.y, b.frame.id);
            if (card.ticket.order !== order) {
                card.ticket = { ...card.ticket, order };
                updates.push({ drawdyElementId: card.id, properties: { meta: { sbTicket: card.ticket } } });
            }
        });
    }
    if (b.title) place(b.title, b.frame.x + PAD, b.frame.y + 28, b.frame.id);
    if (b.subtitle) place(b.subtitle, b.frame.x + PAD, b.frame.y + 74, b.frame.id);

    const frameH = HEADER_H + colH + PAD;
    if (!near(b.frame.width, BOARD_W) || !near(b.frame.height, frameH)) {
        updates.push({ drawdyElementId: b.frame.id, properties: { width: BOARD_W, height: frameH } });
    }

    if (b.archiveFrame) {
        const archive = b.archiveFrame;
        const boardBottom = b.frame.y + frameH;
        const overlapsX = archive.x < b.frame.x + BOARD_W && archive.x + archive.width > b.frame.x;
        // Keep the archive where the user put it, unless the growing board now runs into it.
        let ax = archive.x;
        let ay = archive.y;
        if (overlapsX && archive.y < boardBottom + 40 && archive.y + archive.height > b.frame.y) {
            ax = b.frame.x;
            ay = boardBottom + ARCHIVE_GAP;
        }
        let y = ay + PAD;
        const byId = new Map(b.releases.map((r) => [r.sprintId, r]));
        for (const record of b.archive) {
            const el = byId.get(record.id);
            if (!el) continue;
            place(el, ax + PAD, y, archive.id);
            y += el.height + RELEASE_GAP;
        }
        const archiveH = Math.max(160, y - ay - RELEASE_GAP + PAD);
        const props: Record<string, unknown> = {};
        if (!near(archive.x, ax) || !near(archive.y, ay)) props.transform = { x: ax, y: ay };
        if (!near(archive.width, BOARD_W)) props.width = BOARD_W;
        if (!near(archive.height, archiveH)) props.height = archiveH;
        if (Object.keys(props).length > 0) updates.push({ drawdyElementId: archive.id, properties: props });
    }

    await updateElements(updates);
}
