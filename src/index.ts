// Sprint Board: a Jira-style sprint board for Drawdy.
//
// The board lives on the canvas (see board.ts), so everyone on a shared board sees
// the same tickets. The toolbar button opens a panel (webview) with the sprint,
// filters, the ticket editor, Complete sprint and the version log.

import type { DriverModule } from "@drawdy/driver-protocol";
import type { BoardIndex } from "./board";
import type { ArchivedSprint, Person, ReleasedTicket, Sprint, Status, Ticket } from "./model";
import { call, driver, isUnauthorized, newId, setDriverContext, themeCss, tryCall } from "./drawdy";
import {
    addElements,
    archiveFrameSchema,
    BOARD_W,
    cardSchema,
    cardText,
    columnCards,
    currentColumnHeight,
    ensureStructure,
    frameSchema,
    newCardSlot,
    readBoard,
    redrawCard,
    redrawHeading,
    relayout,
    releaseSchema,
    removeElements,
    statusAt,
    updateElements,
} from "./board";
import {
    addDays,
    applyTicketPatch,
    bumpVersionName,
    clip,
    formatKey,
    keyNumber,
    normalizePerson,
    normalizePrefix,
    normalizeSprint,
    normalizeTicket,
    parseImportedText,
    STATUS_ORDER,
    statusFromLabel,
    todayISO,
} from "./model";
import { WEBVIEW_HTML } from "./webview-html";

// Three columns of cards.
const ACTION_BUTTON_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" stroke="#5c7cfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="5" height="15" rx="1.5"/><rect x="10" y="4" width="5" height="9" rx="1.5"/><rect x="17" y="4" width="4" height="12" rx="1.5"/></svg>`;

const MENU_ROOT = "sprint-board";
const MENU = {
    open: "sprint-board:open",
    create: "sprint-board:create",
    add: "sprint-board:add",
    importSelection: "sprint-board:import",
    complete: "sprint-board:complete",
};

const SYNC_DELAY_MS = 350;

let actionButtonId = "";
let webviewId = "";
let panelCreated = false;
let pendingView: string | null = null;
let sceneSubscribed = false;
let sceneDenied = false;
let dragIds: string[] = [];
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<void> = Promise.resolve();
let boardUsers: Person[] = [];
let me: Person | null = null;

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Runs board operations one at a time, so each reads the board after the previous one wrote it. */
function enqueue(task: () => Promise<void>): void {
    queue = queue.then(task).catch((err) => toast(`Sprint Board: ${errorText(err)}`, "danger"));
}

// ---- driver entry points ----

export const activate: DriverModule["activate"] = async ({ manifest, issueCommand, styling, generateId }) => {
    setDriverContext({ issue: issueCommand, driverId: manifest.driverId, generateId, styling });
    actionButtonId = `${manifest.driverId}:button`;
    webviewId = `${manifest.driverId}:panel`;

    const button = await tryCall("command:dom:create-action-button", {
        domElementId: actionButtonId,
        svg: ACTION_BUTTON_SVG,
    });
    if (button?.created) {
        await tryCall("subscription:dom:element-clicked", { domElementId: actionButtonId });
    }

    await tryCall("command:context-menu:add", {
        menuId: MENU_ROOT,
        menuTitle: "Sprint board",
        children: [
            { menuId: MENU.open, menuTitle: "Open sprint panel" },
            { menuId: MENU.add, menuTitle: "New ticket" },
            { menuId: MENU.importSelection, menuTitle: "Turn selection into tickets" },
            { menuId: MENU.complete, menuTitle: "Complete sprint…" },
            { menuId: MENU.create, menuTitle: "Create sprint board" },
        ],
    });
    for (const menuId of Object.values(MENU)) {
        await tryCall("subscription:context-menu:clicked", { menuId });
    }
    await tryCall("subscription:webview:message", { webviewDomId: webviewId });
    await tryCall("subscription:dom:theme-changed");
};

export const onEvent: DriverModule["onEvent"] = async (event) => {
    const e = event as any;
    switch (e.type) {
        case "subscription:dom:element-clicked":
            if (e.body?.domElementId === actionButtonId) await openPanel(null);
            return;
        case "subscription:context-menu:clicked":
            await onMenu(e.body?.menuId);
            return;
        case "subscription:webview:message":
            if (e.body?.webviewDomId === webviewId) onPanelMessage(e.body.message);
            return;
        case "subscription:dom:theme-changed":
            driver().styling = e.body.styling;
            await post({ type: "theme", css: themeCss(e.body.styling) });
            return;
        case "subscription:scene:elements-added":
        case "subscription:scene:elements-updated":
        case "subscription:scene:elements-replaced":
        case "subscription:scene:elements-removed":
            if (touchesBoard(e)) scheduleSync();
            return;
        case "subscription:scene:drawdy-elements-dragged":
            onDrag(e.body);
            return;
        case "subscription:scene:drawdy-element-selection":
            onSelection(e.body?.drawdyElementIds);
            return;
    }
};

// ---- panel ----

async function openPanel(view: string | null): Promise<void> {
    const htmlContent = WEBVIEW_HTML.replace("/*__DD_THEME__*/", themeCss(driver().styling));
    const res = await tryCall("command:webview:create", {
        webviewDomId: webviewId,
        htmlContent,
        keepStateWhenClosed: true,
    });
    panelCreated = true;
    if (res && res.created === false) {
        // The kept-alive panel was shown again: refresh what it shows.
        await post({ type: "theme", css: themeCss(driver().styling) });
        enqueue(() => pushState());
        if (view) await post({ type: "open", view });
        return;
    }
    // A new panel sends "ready" once it has loaded; the view opens then.
    pendingView = view;
}

async function post(message: Record<string, unknown>): Promise<boolean> {
    if (!panelCreated) return false;
    const res = await tryCall("command:webview:post-message", { webviewDomId: webviewId, message });
    return !!res?.posted;
}

/** Shows a message in the panel, or as a short-lived banner when the panel isn't open. */
async function toast(text: string, tone: "info" | "success" | "warning" | "danger" = "info"): Promise<void> {
    if (await post({ type: "toast", text, tone })) return;
    const domId = `${webviewId}:toast`;
    const size = await tryCall("command:dom:window-size");
    const width = 360;
    await tryCall("command:dom:upsert-floating-element", {
        domId,
        position: { x: size ? Math.max(16, size.width / 2 - width / 2) : 200, y: 72 },
        asPopover: false,
        schema: {
            type: "box",
            styles: {
                width: [width, "px"],
                padding: [12, "px"],
                borderRadius: [8, "px"],
                backgroundColor: tone === "danger" ? "#c92a2a" : "#212529",
                pointerEvents: "none",
            },
            children: [{ type: "text", child: text, styles: { color: "#ffffff", fontSize: [13, "px"] } }],
        },
    });
    setTimeout(() => void tryCall("command:dom:remove-floating-element", { domId }), 4000);
}

function strings(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

function onPanelMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const m = raw as Record<string, any>;
    switch (m.type) {
        case "ready":
            enqueue(async () => {
                await ensureScene();
                await pushState();
                if (pendingView) {
                    await post({ type: "open", view: pendingView });
                    pendingView = null;
                }
            });
            return;
        case "people":
            enqueue(async () => {
                await refreshBoardUsers();
                await pushState();
            });
            return;
        case "create-board":
            enqueue(() => createBoard(m));
            return;
        case "create-ticket":
            enqueue(() => createTicket(m.ticket));
            return;
        case "update-ticket":
            enqueue(() => updateTicket(String(m.cardId), m.patch));
            return;
        case "delete-ticket":
            enqueue(() => deleteTicket(String(m.cardId)));
            return;
        case "update-sprint":
            enqueue(() => updateSprint(m.patch));
            return;
        case "complete-sprint":
            enqueue(() => completeSprint(m));
            return;
        case "show-cards":
            enqueue(() => showElements(strings(m.cardIds)));
            return;
        case "show-release":
            enqueue(() => showRelease(String(m.sprintId)));
            return;
        case "import-selection":
            enqueue(() => importSelection());
            return;
        case "close":
            void tryCall("command:webview:hide", { webviewDomId: webviewId });
            return;
    }
}

async function onMenu(menuId: unknown): Promise<void> {
    switch (menuId) {
        case MENU.open:
            await openPanel(null);
            return;
        case MENU.create:
            await openPanel("create-board");
            return;
        case MENU.add:
            await openPanel("new-ticket");
            return;
        case MENU.complete:
            await openPanel("complete");
            return;
        case MENU.importSelection:
            await openPanel(null);
            enqueue(() => importSelection());
            return;
    }
}

function personKey(p: Person): string {
    return p.userId ?? `name:${p.name.toLowerCase()}`;
}

/** Everyone the assignee picker offers: people on the board now, plus anyone already assigned. */
function knownPeople(b: BoardIndex | null): Person[] {
    const seen = new Map<string, Person>();
    const add = (p: Person | null): void => {
        if (p && !seen.has(personKey(p))) seen.set(personKey(p), p);
    };
    boardUsers.forEach(add);
    b?.cards.forEach((c) => add(c.ticket.assignee));
    b?.archive.forEach((r) => r.done.forEach((t) => add(t.assignee)));
    return [...seen.values()].sort((a, c) => a.name.localeCompare(c.name));
}

async function pushState(extra: Record<string, unknown> = {}): Promise<void> {
    if (!panelCreated) return;
    const b = sceneSubscribed ? await readBoard() : null;
    await post({
        type: "state",
        sceneAllowed: !sceneDenied,
        hasBoard: !!b,
        keyPrefix: b?.config.keyPrefix ?? "",
        sprint: b?.sprint ?? null,
        archive: b?.archive ?? [],
        tickets: b ? b.cards.map((c) => ({ ...c.ticket, cardId: c.id })) : [],
        people: knownPeople(b),
        me,
        today: todayISO(),
        ...extra,
    });
}

async function refreshBoardUsers(): Promise<void> {
    try {
        const res = await call("command:collaboration:get-all-users-in-board");
        const users: any[] = Array.isArray(res?.users) ? res.users : [];
        const toPerson = (u: any): Person | null => normalizePerson({ name: u?.name, color: u?.color, userId: u?.id });
        boardUsers = users.map(toPerson).filter((p): p is Person => p !== null);
        me = toPerson(users.find((u) => u?.isSelf));
    } catch {
        // Without the collaboration permission, assignees are typed in by name.
    }
}

// ---- scene ----

/** Subscribes to the scene the first time it's needed, so the permission prompt follows a user action. */
async function ensureScene(): Promise<boolean> {
    if (sceneSubscribed) return true;
    if (sceneDenied) return false;
    try {
        await call("subscription:scene:elements-added", { properties: ["meta"] });
    } catch (err) {
        if (isUnauthorized(err)) {
            sceneDenied = true;
            return false;
        }
        throw err;
    }
    await tryCall("subscription:scene:elements-updated", { properties: ["meta"] });
    await tryCall("subscription:scene:elements-replaced", { properties: ["meta"] });
    await tryCall("subscription:scene:elements-removed", { properties: ["meta"] });
    await tryCall("subscription:scene:drawdy-elements-dragged");
    await tryCall("subscription:scene:drawdy-element-selection");
    sceneSubscribed = true;
    return true;
}

function touchesBoard(e: any): boolean {
    if (e.type === "subscription:scene:elements-removed") return true;
    const els = [...(e.body?.drawdyElements ?? []), ...(e.body?.replaced ?? [])];
    return els.some((el: any) => el?.meta?.sbRole);
}

/** Collaborators' edits arrive as scene events; refresh the panel once they settle. */
function scheduleSync(): void {
    if (!panelCreated) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        syncTimer = null;
        enqueue(() => pushState());
    }, SYNC_DELAY_MS);
}

async function requireBoard(): Promise<BoardIndex | null> {
    if (!(await ensureScene())) {
        await toast("Sprint Board needs permission to edit this board.", "danger");
        await pushState();
        return null;
    }
    const b = await readBoard();
    if (!b) {
        await toast("Create a sprint board first.", "warning");
        await pushState();
        return null;
    }
    return (await ensureStructure(b)) ? await readBoard() : b;
}

async function relayoutFresh(): Promise<void> {
    const b = await readBoard();
    if (b) await relayout(b);
}

function nextTicketNumber(b: BoardIndex): number {
    let highest = 0;
    const consider = (key: string): void => {
        const n = keyNumber(key, b.config.keyPrefix);
        if (n !== null && n > highest) highest = n;
    };
    b.cards.forEach((c) => consider(c.ticket.key));
    b.archive.forEach((r) => r.done.forEach((t) => consider(t.key)));
    return Math.max(b.config.nextNumber, highest + 1);
}

function weeksFrom(v: unknown): number {
    const n = Math.round(Number(v));
    return n >= 1 && n <= 8 ? n : 2;
}

function isDay(v: unknown): v is string {
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

async function showElements(ids: string[]): Promise<void> {
    if (ids.length === 0) {
        await toast("No tickets match these filters.", "warning");
        return;
    }
    await call("command:scene:set-selection", { drawdyElementIds: ids });
    await call("command:camera:fly-to-elements", { drawdyElementIds: ids, flyDurationMs: 450, zoom: 1 });
}

async function showRelease(sprintId: string): Promise<void> {
    const b = await requireBoard();
    const release = b?.releases.find((r) => r.sprintId === sprintId);
    if (release) await showElements([release.id]);
}

// ---- board and ticket operations ----

async function createBoard(m: Record<string, any>): Promise<void> {
    if (!(await ensureScene())) {
        await toast("Sprint Board needs permission to edit this board.", "danger");
        return;
    }
    const existing = await readBoard();
    if (existing) {
        await showElements([existing.frame.id]);
        await toast("This canvas already has a sprint board.", "warning");
        await pushState();
        return;
    }

    const view = await call("command:camera:get-viewport-rect");
    const x = Math.round(view.rect.x + 80);
    const y = Math.round(view.rect.y + 80);
    const config = { keyPrefix: normalizePrefix(m.keyPrefix), nextNumber: 1 };
    const start = todayISO();
    const sprint: Sprint = {
        id: newId(),
        name: clip(m.sprintName, 80).trim() || "Sprint 1",
        goal: clip(m.goal, 500).trim(),
        startDate: start,
        endDate: addDays(start, weeksFrom(m.weeks) * 7),
    };

    await addElements([frameSchema(newId(), x, y, config, sprint)]);
    const b = await readBoard();
    if (!b) throw new Error("The board frame could not be added.");
    await ensureStructure(b);
    await relayoutFresh();
    await call("command:camera:fly-to-rect", {
        rect: { x, y, width: BOARD_W, height: 640 },
        flyDurationMs: 500,
        zoom: 1,
    });
    await pushState();
    await toast(`Created the ${config.keyPrefix} sprint board.`, "success");
}

async function createTicket(raw: unknown): Promise<void> {
    const b = await requireBoard();
    if (!b) return;
    const n = nextTicketNumber(b);
    const now = new Date().toISOString();
    const fields = raw && typeof raw === "object" ? raw : {};
    const ticket = normalizeTicket({ ...fields, key: formatKey(b.config.keyPrefix, n), createdAt: now, updatedAt: now });
    if (!ticket) return;
    ticket.order = columnCards(b, ticket.status).length;

    const slot = newCardSlot(b, ticket.status, ticket.order);
    const id = newId();
    await addElements([cardSchema(b.frame.id, ticket, slot.x, slot.y, id)]);
    await updateElements([
        { drawdyElementId: b.frame.id, properties: { meta: { sbConfig: { ...b.config, nextNumber: n + 1 } } } },
    ]);
    await relayoutFresh();
    await pushState({ focusCardId: id });
    await toast(`Created ${ticket.key}.`, "success");
}

async function updateTicket(cardId: string, patch: unknown): Promise<void> {
    const b = await requireBoard();
    if (!b) return;
    const card = b.cards.find((c) => c.id === cardId);
    if (!card) {
        await toast("That ticket is no longer on the board.", "warning");
        await pushState();
        return;
    }

    const next = applyTicketPatch(card.ticket, patch);
    if (next.status !== card.ticket.status) next.order = columnCards(b, next.status).length;
    const looksDifferent =
        cardText(next) !== cardText(card.ticket) ||
        next.type !== card.ticket.type ||
        next.priority !== card.ticket.priority;
    if (looksDifferent) {
        await redrawCard(b, card, next);
    } else {
        await updateElements([{ drawdyElementId: card.id, properties: { meta: { sbTicket: next } } }]);
    }
    await relayoutFresh();
    await pushState();
    await toast(`Saved ${next.key}.`, "success");
}

async function deleteTicket(cardId: string): Promise<void> {
    const b = await requireBoard();
    if (!b) return;
    const card = b.cards.find((c) => c.id === cardId);
    if (!card) return;
    await removeElements([card.id]);
    await relayoutFresh();
    await pushState();
    await toast(`Deleted ${card.ticket.key}.`);
}

async function updateSprint(patch: unknown): Promise<void> {
    const b = await requireBoard();
    if (!b) return;
    const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
    const sprint = normalizeSprint({
        ...b.sprint,
        name: typeof p.name === "string" && p.name.trim() ? p.name : b.sprint.name,
        goal: typeof p.goal === "string" ? p.goal.trim() : b.sprint.goal,
        startDate: isDay(p.startDate) ? p.startDate : b.sprint.startDate,
        endDate: isDay(p.endDate) ? p.endDate : b.sprint.endDate,
    });
    await updateElements([{ drawdyElementId: b.frame.id, properties: { meta: { sbSprint: sprint } } }]);
    await redrawHeading({ ...b, sprint });
    await relayoutFresh();
    await pushState();
    await toast("Sprint updated.", "success");
}

function released(t: Ticket): ReleasedTicket {
    return { key: t.key, title: t.title, type: t.type, priority: t.priority, assignee: t.assignee, points: t.points };
}

/**
 * Closes the active sprint: its Done tickets leave the board for the archive as one
 * version-log entry, unfinished tickets stay for the next sprint (or go back to the
 * backlog), and the next sprint starts today.
 */
async function completeSprint(m: Record<string, any>): Promise<void> {
    const b = await requireBoard();
    if (!b) return;
    const moveOpenTo = m.moveOpenTo === "backlog" ? "backlog" : "next";
    const done = columnCards(b, "done");
    const open = b.cards
        .filter((c) => c.ticket.status !== "done" && c.ticket.status !== "backlog")
        .sort((a, c) => a.ticket.key.localeCompare(c.ticket.key));
    const today = todayISO();

    const record: ArchivedSprint = {
        ...b.sprint,
        completedAt: today,
        done: done.map((c) => released(c.ticket)),
        carriedOver: moveOpenTo === "next" ? open.map((c) => c.ticket.key) : [],
        movedToBacklog: moveOpenTo === "backlog" ? open.map((c) => c.ticket.key) : [],
        notes: clip(m.notes, 4000).trim(),
    };
    const nextSprint: Sprint = {
        id: newId(),
        name: clip(m.nextName, 80).trim() || bumpVersionName(b.sprint.name),
        goal: clip(m.nextGoal, 500).trim(),
        startDate: today,
        endDate: addDays(today, weeksFrom(m.weeks) * 7),
    };

    // The archive record is written first, so a failure later never loses the sprint.
    await updateElements([
        { drawdyElementId: b.frame.id, properties: { meta: { sbSprint: nextSprint, sbArchive: [record, ...b.archive] } } },
    ]);
    await removeElements(done.map((c) => c.id));
    if (moveOpenTo === "backlog" && open.length > 0) {
        let order = columnCards(b, "backlog").length;
        await updateElements(
            open.map((c) => ({
                drawdyElementId: c.id,
                properties: { meta: { sbTicket: { ...c.ticket, status: "backlog" as Status, order: order++ } } },
            }))
        );
    }

    let archiveId = b.archiveFrame?.id ?? null;
    const archiveTop = b.archiveFrame?.y ?? b.frame.y + b.frame.height + 120;
    if (!archiveId) {
        archiveId = newId();
        await addElements([archiveFrameSchema(b.frame.id, archiveId, b.frame, b.frame.height)]);
    }
    await addElements([releaseSchema(b.frame.id, archiveId, record, b.frame.x + 32, archiveTop + 32)]);

    const afterArchive = await readBoard();
    if (afterArchive) await redrawHeading(afterArchive);
    await relayoutFresh();

    const moved =
        open.length === 0
            ? ""
            : moveOpenTo === "next"
              ? ` ${open.length} carried over to ${nextSprint.name}.`
              : ` ${open.length} moved to the backlog.`;
    await pushState({ view: "releases" });
    await toast(`Completed ${record.name}: ${done.length} done.${moved}`, "success");
}

async function dropCards(ids: string[]): Promise<void> {
    const b = await readBoard();
    if (!b || ids.includes(b.frame.id)) return; // dragging the whole board moves its cards with it
    const moved = b.cards.filter((c) => ids.includes(c.id));
    if (moved.length === 0) return;

    const before = new Map(b.cards.map((c) => [c.id, JSON.stringify(c.ticket)]));
    const columnHeight = currentColumnHeight(b);
    const touched = new Set<Status>();
    for (const card of moved) {
        touched.add(card.ticket.status);
        const status = statusAt(b, { x: card.x + card.width / 2, y: card.y + card.height / 2 }, columnHeight);
        if (!status) continue; // dropped outside the columns: the layout pass snaps it back
        if (status !== card.ticket.status) {
            card.ticket = { ...card.ticket, status, updatedAt: new Date().toISOString() };
        }
        touched.add(status);
    }
    // Number each touched column by where its cards sit now, so a drop between two cards lands there.
    for (const status of touched) {
        b.cards
            .filter((c) => c.ticket.status === status)
            .sort((a, c) => a.y - c.y)
            .forEach((c, order) => {
                if (c.ticket.order !== order) c.ticket = { ...c.ticket, order };
            });
    }
    await updateElements(
        b.cards
            .filter((c) => before.get(c.id) !== JSON.stringify(c.ticket))
            .map((c) => ({ drawdyElementId: c.id, properties: { meta: { sbTicket: c.ticket } } }))
    );
    await relayout(b);
    await pushState();
}

function onDrag(body: any): void {
    if (body?.type === "dragStart") {
        dragIds = strings(body.drawdyElementIds);
        return;
    }
    if (body?.type === "dragEnd" && dragIds.length > 0) {
        const ids = dragIds;
        dragIds = [];
        enqueue(() => dropCards(ids));
    }
}

function onSelection(ids: unknown): void {
    const list = strings(ids);
    if (panelCreated && list.length === 1) void post({ type: "select", cardId: list[0] });
}

/**
 * Turns the selected sticky notes or cards into tickets. A first line like
 * "LAOR-001 · Title" keeps its key, a line like "Feature · P3" sets type and
 * priority, and a card sitting inside a column labelled "In progress" (or To do,
 * Testing, Done, Backlog) gets that status. The originals stay on the canvas.
 */
async function importSelection(): Promise<void> {
    const b = await requireBoard();
    if (!b) return;
    const selection = await call("command:scene:get-current-selected-drawdy-elements");
    const ids = strings(selection?.drawdyElementIds);
    if (ids.length === 0) {
        await toast("Select sticky notes or cards on the canvas first, then import.", "warning");
        return;
    }

    const res = await call("command:scene:get-drawdy-elements", {
        properties: ["text", "meta", "x", "y", "width", "height", "type"],
    });
    const all: any[] = Array.isArray(res?.drawdyElements) ? res.drawdyElements : [];
    const hasText = (el: any): boolean => typeof el?.text === "string" && el.text.trim().length > 0;
    const isColumn = (el: any): boolean =>
        el.type === "path" && hasText(el) && statusFromLabel(el.text) !== null && el.width >= 150 && el.height >= 150;
    const columns = all.filter(isColumn);
    const picked = all.filter((el) => ids.includes(el.id) && hasText(el) && !el.meta?.sbRole && !isColumn(el));
    const shapes = picked.filter((el) => el.type === "path");
    const sources = (shapes.length > 0 ? shapes : picked.filter((el) => el.type === "text")).sort(
        (a, c) => a.x - c.x || a.y - c.y
    );
    if (sources.length === 0) {
        await toast("None of the selected items has text to turn into a ticket.", "warning");
        return;
    }

    const prefix = b.config.keyPrefix;
    const used = new Set(b.cards.map((c) => c.ticket.key));
    const drafts = sources.map((el) => {
        const parsed = parseImportedText(el.text);
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        const column = columns.find((c) => cx >= c.x && cx <= c.x + c.width && cy >= c.y && cy <= c.y + c.height);
        return { parsed, status: (column ? statusFromLabel(column.text) : null) ?? ("todo" as Status) };
    });

    // Keys like LAOR-007 are kept when free; everything else gets the next number.
    let highest = nextTicketNumber(b) - 1;
    const keys = drafts.map((d) => {
        const hint = d.parsed?.keyHint ?? null;
        const n = hint ? keyNumber(hint, prefix) : null;
        if (hint && n !== null && !used.has(hint)) {
            used.add(hint);
            highest = Math.max(highest, n);
            return hint;
        }
        return null;
    });

    const orders = new Map<Status, number>(STATUS_ORDER.map((s) => [s, columnCards(b, s).length]));
    const now = new Date().toISOString();
    const schemas: any[] = [];
    drafts.forEach((d, i) => {
        if (!d.parsed) return;
        let key = keys[i];
        if (!key) {
            key = formatKey(prefix, ++highest);
            while (used.has(key)) key = formatKey(prefix, ++highest);
        }
        used.add(key);
        const order = orders.get(d.status) ?? 0;
        orders.set(d.status, order + 1);
        const ticket = normalizeTicket({
            key,
            title: d.parsed.title,
            description: d.parsed.description,
            type: d.parsed.type ?? "feature",
            priority: d.parsed.priority ?? "p2",
            status: d.status,
            order,
            createdAt: now,
            updatedAt: now,
        });
        if (!ticket) return;
        const slot = newCardSlot(b, d.status, order);
        schemas.push(cardSchema(b.frame.id, ticket, slot.x, slot.y, newId()));
    });

    await addElements(schemas);
    await updateElements([
        {
            drawdyElementId: b.frame.id,
            properties: { meta: { sbConfig: { ...b.config, nextNumber: Math.max(b.config.nextNumber, highest + 1) } } },
        },
    ]);
    await relayoutFresh();
    await pushState();
    await toast(`Imported ${schemas.length} tickets. The originals are still on the canvas.`, "success");
}
