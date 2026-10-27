// Dependency-free build for the Sprint Board driver: Node's own TypeScript type
// stripping, a small bundler for this repo's modules, and a zip writer for .drawdyx.
//
// Drawdy builds submitted extensions itself (esbuild, from src/index.ts), so this is
// only for local development and for packing a .drawdyx by hand. The bundler joins
// the modules into one scope, which keeps it tiny but asks three things of the source:
//   - only relative imports (type-only imports from @drawdy/driver-protocol are erased),
//   - exports written as `export function|const|let|class`,
//   - no two modules declaring the same top-level name.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const rel = (file) => relative(root, file).replace(/\\/g, "/");

/** Writes src/webview-html.ts from src/webview/panel.html. Drawdy's build can't read .html, so it's committed. */
export function generateWebview() {
    const html = readFileSync(join(src, "webview", "panel.html"), "utf8");
    const out =
        "// Generated from src/webview/panel.html by scripts/lib.mjs. Edit that file, then run a build.\n" +
        `export const WEBVIEW_HTML = ${JSON.stringify(html)};\n`;
    const target = join(src, "webview-html.ts");
    if (!existsSync(target) || readFileSync(target, "utf8") !== out) writeFileSync(target, out);
}

function resolveImport(from, spec) {
    const base = join(dirname(from), spec);
    for (const candidate of [`${base}.ts`, base, join(base, "index.ts")]) {
        if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
    }
    throw new Error(`${rel(from)}: cannot find "${spec}"`);
}

export function bundle(entry) {
    const ordered = [];
    const state = new Map();

    const visit = (file) => {
        if (state.get(file) === "done") return;
        if (state.get(file) === "visiting") throw new Error(`import cycle through ${rel(file)}`);
        state.set(file, "visiting");

        let code = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" });
        code = code.replace(/^import\s+[^;]*?\s+from\s+["']([^"']+)["'];?/gm, (match, spec) => {
            if (!spec.startsWith(".")) throw new Error(`${rel(file)}: only relative imports can be bundled, not "${spec}"`);
            visit(resolveImport(file, spec));
            return match.replace(/[^\n]/g, " ");
        });
        code = code.replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm, "");
        if (/^export\b/m.test(code)) {
            throw new Error(`${rel(file)}: write exports as "export function|const|let|class"`);
        }

        state.set(file, "done");
        ordered.push({ file, code });
    };
    visit(entry);

    const declaredIn = new Map();
    const topLevel = /^(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|class\s+)([A-Za-z_$][\w$]*)/gm;
    for (const { file, code } of ordered) {
        for (const [, name] of code.matchAll(topLevel)) {
            if (declaredIn.has(name)) {
                throw new Error(`"${name}" is declared in both ${declaredIn.get(name)} and ${rel(file)}`);
            }
            declaredIn.set(name, rel(file));
        }
    }
    for (const name of ["activate", "onEvent"]) {
        if (!declaredIn.has(name)) throw new Error(`the entry module must export "${name}"`);
    }

    const body = ordered.map(({ file, code }) => `// ---- ${rel(file)} ----\n${code}`).join("\n");
    return `"use strict";\n${body}\nexports.activate = activate;\nexports.onEvent = onEvent;\n`;
}

// ---- zip (stored entries, which every unzip reads) ----

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE_1980 = 0x21;
const UTF8_NAMES = 0x0800;

export function zip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, "utf8");
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(UTF8_NAMES, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(DOS_DATE_1980, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        parts.push(local, nameBuf, data);

        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(UTF8_NAMES, 8);
        entry.writeUInt16LE(0, 10);
        entry.writeUInt16LE(0, 12);
        entry.writeUInt16LE(DOS_DATE_1980, 14);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(data.length, 20);
        entry.writeUInt32LE(data.length, 24);
        entry.writeUInt16LE(nameBuf.length, 28);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, nameBuf);

        offset += local.length + nameBuf.length + data.length;
    }
    const centralSize = central.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, ...central, end]);
}

/** Builds dist/main.js and dist/<driver-id>.drawdyx. */
export function buildExtension() {
    generateWebview();
    const manifestRaw = readFileSync(join(root, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    if (typeof manifest.driverId !== "string" || typeof manifest.main !== "string") {
        throw new Error('manifest.json must define string "driverId" and "main"');
    }

    const code = bundle(join(src, "index.ts"));
    new Script(code, { filename: manifest.main }); // throws on a syntax error in the bundle

    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, manifest.main), code);
    const bytes = zip([
        { name: "manifest.json", data: Buffer.from(manifestRaw, "utf8") },
        { name: manifest.main, data: Buffer.from(code, "utf8") },
    ]);
    const file = `${manifest.driverId.replace(/\./g, "-")}.drawdyx`;
    writeFileSync(join(dist, file), bytes);
    return { bytes, manifest, file };
}
