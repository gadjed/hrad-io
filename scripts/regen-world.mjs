import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");

for (const file of ["world.sqlite", "world.sqlite-wal", "world.sqlite-shm"]) {
  try {
    fs.unlinkSync(path.join(dataDir, file));
  } catch {
    /* ignore */
  }
}

const r = spawnSync(process.execPath, [path.join(root, "scripts/generate-settlements.mjs")], {
  stdio: "inherit",
  cwd: root,
});
process.exit(r.status ?? 1);
