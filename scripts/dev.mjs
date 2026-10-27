// Dev server for Drawdy's development mode. Drawdy polls /version every second and,
// when it changes, downloads /built.drawdyx and reloads the driver in place.
// Usage: npm run dev            (port 5173)
//        npm run dev -- --port 5174

import { watch } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { buildExtension, root } from "./lib.mjs";

const portArg = process.argv.indexOf("--port");
const port = Number(portArg !== -1 ? process.argv[portArg + 1] : process.env.PORT) || 5173;

let version = 0;
let bytes = null;

const log = (message) => console.log(`[sprint-board] ${message}`);

function rebuild() {
    try {
        const built = buildExtension();
        bytes = built.bytes;
        version++;
        log(`built v${version} (${built.manifest.driverId}, ${bytes.length} bytes)`);
    } catch (err) {
        log(`build failed: ${err instanceof Error ? err.message : err}`);
    }
}

let timer = null;
function scheduleRebuild() {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 120);
}

createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, OPTIONS");
    res.setHeader("cache-control", "no-store");
    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
    }
    if (path === "/version") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ version }));
        return;
    }
    if (path === "/built.drawdyx" && bytes) {
        res.setHeader("content-type", "application/zip");
        res.end(bytes);
        return;
    }
    res.statusCode = path === "/" ? 200 : 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(
        path === "/"
            ? `Sprint Board dev server, build v${version}.\nIn Drawdy, open a local board, press Ctrl+K and run "Add extension dev server" with http://localhost:${port}\n`
            : "Not found\n"
    );
})
    .on("error", (err) => {
        log(err.code === "EADDRINUSE" ? `port ${port} is in use; try npm run dev -- --port ${port + 1}` : err.message);
        process.exit(1);
    })
    .listen(port, () => {
        rebuild();
        log(`serving http://localhost:${port}  (add it in Drawdy: Ctrl+K > Add extension dev server)`);
    });

watch(join(root, "src"), { recursive: true }, (_event, name) => {
    if (name && name.replace(/\\/g, "/") === "webview-html.ts") return; // written by the build itself
    scheduleRebuild();
});
watch(join(root, "manifest.json"), scheduleRebuild);
