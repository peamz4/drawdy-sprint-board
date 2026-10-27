// Runs the bundled driver against a small in-memory stand-in for Drawdy and walks
// through the main flows: create a board, add tickets, drag one to Done, assign,
// complete the sprint, and import existing cards. Run with `npm test`.

import assert from "node:assert/strict";
import { join } from "node:path";
import { bundle, generateWebview, root } from "../scripts/lib.mjs";

generateWebview();
const driverModule = { exports: {} };
new Function("exports", bundle(join(root, "src", "index.ts")))(driverModule.exports);
const { activate, onEvent } = driverModule.exports;

// ---- fake host ----

const scene = new Map();
let selection = [];
const posted = [];
let subscriptionSeq = 0;
let idSeq = 0;
let webviewCreated = false;

function toStored(schema) {
    const base = { id: schema.drawdyElementId, meta: { ...(schema.meta ?? {}) }, frameId: schema.frameId };
    switch (schema.type) {
        case "frame":
            return { ...base, type: "frame", x: schema.position[0], y: schema.position[1], width: schema.width, height: schema.height, frameName: schema.name };
        case "text":
            return { ...base, type: "text", x: schema.x, y: schema.y, width: schema.width ?? schema.text.length * schema.fontSize * 0.55, height: schema.fontSize * 1.3, text: schema.text };
        default:
            return { ...base, type: "path", componentType: schema.componentType ?? "rect", x: schema.x, y: schema.y, width: schema.width ?? 200, height: schema.height ?? 193, text: schema.text };
    }
}

function pick(el, properties) {
    const out = { id: el.id };
    for (const p of properties) if (el[p] !== undefined) out[p] = el[p];
    return out;
}

function ok(value = {}) {
    return { res: { value } };
}

async function issueCommand(req) {
    const r = req.req ?? {};
    if (req.type.startsWith("subscription:")) return ok({ subscriptionId: `s${subscriptionSeq++}` });
    switch (req.type) {
        case "command:scene:add-drawdy-elements": {
            const taken = r.elements.map((e) => e.drawdyElementId).filter((id) => scene.has(id));
            if (taken.length) return { res: { error: { type: "bad-argument", body: { existingIds: taken } } } };
            for (const schema of r.elements) scene.set(schema.drawdyElementId, toStored(schema));
            return ok({ added: true });
        }
        case "command:scene:remove-drawdy-elements": {
            let removed = 0;
            for (const id of r.drawdyElementIds) removed += scene.delete(id) ? 1 : 0;
            return ok({ removed });
        }
        case "command:scene:update-drawdy-elements": {
            for (const { drawdyElementId, properties } of r.updates) {
                const el = scene.get(drawdyElementId);
                if (!el) return { res: { error: { type: "not-found", body: { id: drawdyElementId } } } };
                const { meta, transform, ...rest } = properties;
                if (meta) el.meta = { ...el.meta, ...meta };
                if (transform?.x !== undefined) el.x = transform.x;
                if (transform?.y !== undefined) el.y = transform.y;
                Object.assign(el, rest);
            }
            return ok({ updated: r.updates.length });
        }
        case "command:scene:get-drawdy-elements": {
            const els = [...scene.values()].filter((el) => !r.drawdyElementIds || r.drawdyElementIds.includes(el.id));
            return ok({ drawdyElements: els.map((el) => pick(el, r.properties)) });
        }
        case "command:scene:get-current-selected-drawdy-elements":
            return ok({ drawdyElementIds: selection });
        case "command:scene:set-selection":
            selection = r.drawdyElementIds;
            return ok();
        case "command:camera:get-viewport-rect":
            return ok({ rect: { x: 0, y: 0, width: 1600, height: 900 } });
        case "command:webview:create": {
            const created = !webviewCreated;
            webviewCreated = true;
            return ok({ created });
        }
        case "command:webview:post-message":
            posted.push(r.message);
            return ok({ posted: true });
        case "command:collaboration:get-all-users-in-board":
            return ok({ users: [{ id: "u-ada", name: "Ada", color: "#4263eb", isHost: true, isSelf: true, cursorPosition: null }] });
        default:
            return ok({ created: true });
    }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const panel = async (message) => {
    await onEvent({ type: "subscription:webview:message", subscriptionId: "s", body: { webviewDomId: "peamz4.sprint-board:panel", message } });
    await settle();
};
const lastState = () => [...posted].reverse().find((m) => m.type === "state");
const byRole = (role) => [...scene.values()].filter((el) => el.meta?.sbRole === role);
const cards = () => byRole("card").sort((a, b) => a.meta.sbTicket.key.localeCompare(b.meta.sbTicket.key));

// ---- the walk-through ----

await activate({
    issueCommand,
    manifest: { driverId: "peamz4.sprint-board", driverName: "Sprint Board", driverVersion: "0.1.0", main: "main.js", permissions: [] },
    styling: { theme: "light", tokens: { "--dd-surface-panel": "#fff" } },
    generateId: () => `el${idSeq++}`,
});

await onEvent({ type: "subscription:dom:element-clicked", subscriptionId: "s", body: { domElementId: "peamz4.sprint-board:button", clientX: 0, clientY: 0 } });
await panel({ type: "ready" });
assert.equal(lastState().hasBoard, false, "no board before one is created");

await panel({ type: "create-board", keyPrefix: "laor", sprintName: "v0.0.6-beta", goal: "Ship slides", weeks: 2 });
assert.equal(byRole("board").length, 1, "one board frame");
assert.equal(byRole("column").length, 5, "five columns");
assert.equal(byRole("title")[0].text, "v0.0.6-beta");
assert.equal(lastState().keyPrefix, "LAOR");

await panel({ type: "create-ticket", ticket: { title: "Slide notes on device", type: "feature", priority: "p1", status: "testing" } });
await panel({ type: "create-ticket", ticket: { title: "Grade score cut-offs", type: "feature", priority: "p2", status: "todo" } });
await panel({ type: "create-ticket", ticket: { title: "Release v0.0.6-beta", type: "chore", priority: "p1", status: "todo" } });
assert.deepEqual(cards().map((c) => c.meta.sbTicket.key), ["LAOR-001", "LAOR-002", "LAOR-003"]);
const todo = byRole("column").find((c) => c.meta.sbStatus === "todo");
const [, second, third] = cards();
assert.equal(second.x, todo.x + 16, "card sits inside its column");
assert.ok(third.y > second.y, "second card in a column stacks below the first");

// Drag LAOR-001 from Testing into Done.
const done = byRole("column").find((c) => c.meta.sbStatus === "done");
const first = cards()[0];
await onEvent({ type: "subscription:scene:drawdy-elements-dragged", subscriptionId: "s", body: { type: "dragStart", drawdyElementIds: [first.id] } });
first.x = done.x + 40;
first.y = done.y + 80;
await onEvent({ type: "subscription:scene:drawdy-elements-dragged", subscriptionId: "s", body: { type: "dragEnd" } });
await settle();
assert.equal(cards()[0].meta.sbTicket.status, "done", "dropping on Done changes the status");
assert.equal(cards()[0].x, done.x + 16, "the dropped card snaps into the column");

// Assign LAOR-002 to the person on the board.
await panel({ type: "people" });
const me = lastState().me;
assert.equal(me.name, "Ada");
await panel({ type: "update-ticket", cardId: cards()[1].id, patch: { assignee: me, points: 3 } });
assert.match(cards()[1].text, /@Ada/, "the card shows its assignee");
assert.match(cards()[1].text, /3 pt/, "the card shows its points");

// Complete the sprint: LAOR-001 goes to the archive, LAOR-002 and LAOR-003 carry over.
await panel({ type: "complete-sprint", moveOpenTo: "next", nextName: "", nextGoal: "", weeks: 2, notes: "Slides shipped" });
const board = byRole("board")[0];
assert.equal(board.meta.sbSprint.name, "v0.0.7-beta", "the next sprint name is bumped");
assert.equal(board.meta.sbArchive.length, 1);
assert.deepEqual(board.meta.sbArchive[0].done.map((t) => t.key), ["LAOR-001"]);
assert.deepEqual(board.meta.sbArchive[0].carriedOver, ["LAOR-002", "LAOR-003"]);
assert.equal(cards().length, 2, "done tickets leave the board");
assert.equal(byRole("release").length, 1, "the version log gets an entry");
assert.match(byRole("release")[0].text, /v0\.0\.6-beta/);
assert.ok(byRole("archive")[0].y > board.y + board.height, "the archive sits below the board");
assert.equal(byRole("title")[0].text, "v0.0.7-beta", "the heading shows the new sprint");

// Import existing cards: keys are kept, a "Done" column sets the status.
const column = { id: "col-done", type: "path", componentType: "rect", x: 5000, y: 0, width: 360, height: 880, text: "Done", meta: {} };
const keyed = { id: "old1", type: "path", componentType: "rect", x: 5020, y: 60, width: 320, height: 109, meta: {}, text: "LAOR-009 · Private GitHub repo\nBuild output stays out of git.\nChore · P2" };
const plain = { id: "old2", type: "path", componentType: "sticky-note", x: 6000, y: 60, width: 200, height: 193, meta: {}, text: "Hard Judgement mode\nStricter windows" };
for (const el of [column, keyed, plain]) scene.set(el.id, el);
selection = ["old1", "old2", "col-done"];
await panel({ type: "import-selection" });
const imported = cards().filter((c) => !["LAOR-002", "LAOR-003"].includes(c.meta.sbTicket.key));
assert.deepEqual(imported.map((c) => c.meta.sbTicket.key).sort(), ["LAOR-009", "LAOR-010"]);
const repo = imported.find((c) => c.meta.sbTicket.key === "LAOR-009").meta.sbTicket;
assert.equal(repo.status, "done");
assert.equal(repo.type, "chore");
assert.equal(repo.priority, "p2");
assert.equal(repo.title, "Private GitHub repo");
assert.equal(byRole("board")[0].meta.sbConfig.nextNumber, 11, "numbering continues after imported keys");

// Complete again, moving unfinished work to the backlog.
await panel({ type: "complete-sprint", moveOpenTo: "backlog", nextName: "v0.0.8-beta", weeks: 1, notes: "" });
assert.equal(byRole("board")[0].meta.sbArchive[0].name, "v0.0.7-beta");
assert.ok(cards().every((c) => c.meta.sbTicket.status === "backlog"), "unfinished tickets go back to the backlog");
const releases = byRole("release").sort((a, b) => a.y - b.y);
assert.match(releases[0].text, /^v0\.0\.7-beta/, "newest release is on top");
assert.match(releases[1].text, /^v0\.0\.6-beta/);

console.log("smoke test passed");
