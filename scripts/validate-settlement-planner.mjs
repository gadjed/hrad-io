/**
 * Lightweight JSON validation for settlement planner I/O (no extra deps).
 * For full JSON Schema validation: npx ajv validate -s docs/schemas/... -d file.json
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BUILDING_TYPES = new Set([
  "core",
  "wall_wood",
  "wall_stone",
  "gate",
  "mill",
  "quarry",
  "goldmine",
  "tower_arrow",
  "tower_cannon",
  "spikes",
]);

const MODES = new Set(["survive", "economy", "fortify", "expand", "upgrade", "wait"]);
const OPS = new Set(["place", "upgrade", "sell", "repair", "wait"]);

function fail(errors, msg) {
  errors.push(msg);
}

function validateObservation(obj, errors, prefix = "") {
  if (!obj || typeof obj !== "object") {
    fail(errors, `${prefix}observation must be an object`);
    return;
  }
  const req = [
    "tick",
    "settlement_id",
    "core",
    "keep",
    "treasury",
    "threat",
    "nearby_nodes",
    "buildings",
    "ring",
    "enemies_nearby",
    "respawn_gold_cost",
  ];
  for (const k of req) {
    if (!(k in obj)) fail(errors, `${prefix}missing observation.${k}`);
  }
  if (typeof obj.threat === "number" && (obj.threat < 0 || obj.threat > 1)) {
    fail(errors, `${prefix}observation.threat out of range`);
  }
  if (Array.isArray(obj.buildings)) {
    for (const [i, b] of obj.buildings.entries()) {
      if (!BUILDING_TYPES.has(b.type)) fail(errors, `${prefix}buildings[${i}].type invalid`);
    }
  }
}

function validateAction(action, errors, prefix) {
  if (!action || typeof action !== "object") {
    fail(errors, `${prefix}action must be an object`);
    return;
  }
  if (!OPS.has(action.op)) fail(errors, `${prefix}action.op invalid`);
  if (action.op === "place") {
    if (!BUILDING_TYPES.has(action.type)) fail(errors, `${prefix}place requires valid type`);
    if (!Number.isInteger(action.tx) || !Number.isInteger(action.ty)) {
      fail(errors, `${prefix}place requires tx, ty`);
    }
  }
  if (["upgrade", "sell", "repair"].includes(action.op) && !action.building_id) {
    fail(errors, `${prefix}${action.op} requires building_id`);
  }
}

function validateDecision(obj, errors, prefix = "") {
  if (!obj || typeof obj !== "object") {
    fail(errors, `${prefix}decision must be an object`);
    return;
  }
  if (!MODES.has(obj.mode)) fail(errors, `${prefix}decision.mode invalid`);
  validateAction(obj.action, errors, `${prefix}decision.`);
  if (obj.queue && obj.queue.length > 5) fail(errors, `${prefix}decision.queue max 5`);
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/validate-settlement-planner.mjs <file.json|file.jsonl>");
    process.exit(1);
  }
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  const raw = await readFile(abs, "utf8");
  const lines = abs.endsWith(".jsonl") ? raw.trim().split("\n").filter(Boolean) : [raw.trim()];
  let bad = 0;
  for (const [i, line] of lines.entries()) {
    const errors = [];
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      console.error(`Line ${i + 1}: invalid JSON`);
      bad++;
      continue;
    }
    if (row.observation) validateObservation(row.observation, errors, `L${i + 1} `);
    else validateObservation(row, errors, `L${i + 1} `);
    if (row.decision) validateDecision(row.decision, errors, `L${i + 1} `);
    if (errors.length) {
      bad++;
      console.error(`Line ${i + 1}:\n  ${errors.join("\n  ")}`);
    }
  }
  if (bad) {
    console.error(`${bad} invalid record(s)`);
    process.exit(1);
  }
  console.log(`OK · ${lines.length} record(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
