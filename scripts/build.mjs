import { buildExtension } from "./lib.mjs";

const { bytes, manifest, file } = buildExtension();
console.log(`packed ${manifest.driverId} ${manifest.driverVersion} -> dist/${file} (${bytes.length} bytes)`);
