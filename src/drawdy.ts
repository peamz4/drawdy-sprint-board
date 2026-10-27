// A thin wrapper over `issueCommand`: it fills in driverId and requestId and turns
// an error response into a thrown CommandError, so call sites read as plain awaits.

import type { DriverCommandIssuer, ModuleStyling } from "@drawdy/driver-protocol";

type DriverContext = {
    issue: DriverCommandIssuer;
    driverId: string;
    generateId: () => string;
    styling: ModuleStyling;
};

let driverContext: DriverContext | null = null;
let requestSeq = 0;

export class CommandError extends Error {
    kind: string;
    body: Record<string, unknown> | undefined;

    constructor(kind: string, message: string | undefined, body: Record<string, unknown> | undefined) {
        super(message || kind);
        this.kind = kind;
        this.body = body;
    }
}

export function setDriverContext(c: DriverContext): void {
    driverContext = c;
}

export function driver(): DriverContext {
    if (!driverContext) throw new Error("Sprint Board is not activated yet");
    return driverContext;
}

export function newId(): string {
    return driver().generateId();
}

/** Issues one command and resolves its `res.value`; rejects with CommandError on `res.error`. */
export async function call(type: string, req?: unknown): Promise<any> {
    const c = driver();
    const request: Record<string, unknown> = {
        type,
        driverId: c.driverId,
        requestId: `sb-${requestSeq++}`,
    };
    if (req !== undefined) request.req = req;
    const response: any = await c.issue(request as any);
    const error = response?.res?.error;
    if (error) throw new CommandError(String(error.type), error.message, error.body);
    return response?.res?.value;
}

/** Like `call`, but resolves null instead of throwing. For best-effort commands. */
export async function tryCall(type: string, req?: unknown): Promise<any | null> {
    try {
        return await call(type, req);
    } catch {
        return null;
    }
}

export function isUnauthorized(err: unknown): boolean {
    return err instanceof CommandError && err.kind === "unauthorized";
}

/** The theme as `--dd-*` declarations for the panel's :root. */
export function themeCss(styling: ModuleStyling): string {
    const s = styling as any;
    const decls: string[] = [`color-scheme: ${s.theme === "dark" ? "dark" : "light"};`];
    if (s.tokens && typeof s.tokens === "object") {
        for (const [name, value] of Object.entries(s.tokens)) {
            if (typeof value === "string" && name.startsWith("--dd-")) decls.push(`${name}: ${value};`);
        }
    }
    return decls.join("");
}
