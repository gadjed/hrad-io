#!/usr/bin/env node
/**
 * Live training dashboard: start/stop PPO, stream gym + Ollama events, serve UI.
 *   npm run planner:dashboard
 *   http://127.0.0.1:8787
 */
import express from "express";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  applyTrainEvent,
  cloneTrainState,
  createTrainState,
  detectStuck,
} from "../shared/train-dashboard-state.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dir, "..");
const PORT = Number(process.env.TRAIN_DASH_PORT || 8787);
const HOST = process.env.TRAIN_DASH_HOST || "127.0.0.1";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/shared", express.static(path.join(root, "shared")));
app.use(express.static(path.join(root, "public/train")));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const state = createTrainState();
let child = null;
let logBuf = "";

function resolvePython() {
  const win = process.platform === "win32";
  const candidates = win
    ? [path.join(root, "venv", "Scripts", "python.exe"), "python"]
    : [path.join(root, "venv", "bin", "python"), "python3", "python"];
  for (const c of candidates) {
    if (c === "python" || c === "python3") return c;
    if (fs.existsSync(c)) return c;
  }
  return win ? "python" : "python3";
}

function ingest(event) {
  if (!event || typeof event !== "object") return;
  if (!event.ts) event.ts = Date.now();
  applyTrainEvent(state, event);
  const msg = JSON.stringify({ type: "event", event });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function snapshot() {
  return {
    ...cloneTrainState(state),
    stuck: detectStuck(state),
    dashUrl: `http://${HOST}:${PORT}`,
  };
}

function appendLog(text, level = "info") {
  const lines = String(text).replace(/\r/g, "").split("\n");
  for (const line of lines) {
    const trimmed = line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    if (!trimmed) continue;
    ingest({ type: "log", level, text: trimmed, ts: Date.now() });
  }
}

function buildArgs(cfg = {}) {
  const args = [path.join(root, "scripts", "train-rl-ollama.py")];
  const flag = (name, value, fallback) => {
    const v = value === undefined || value === null || value === "" ? fallback : value;
    if (v === undefined || v === null || v === "") return;
    args.push(name, String(v));
  };
  flag("--timesteps", cfg.timesteps, 1_000_000);
  flag("--n-envs", cfg.nEnvs, 1);
  flag("--n-steps", cfg.nSteps, 256);
  flag("--batch-size", cfg.batchSize, 64);
  flag("--learning-rate", cfg.learningRate, 3e-4);
  flag("--ticks", cfg.ticks, 10);
  flag("--max-steps", cfg.maxSteps, 500);
  flag("--ollama-freq", cfg.ollamaFreq, 1);
  flag("--ollama-host", cfg.ollamaHost, "localhost");
  flag("--ollama-port", cfg.ollamaPort, 11434);
  flag("--ollama-model", cfg.ollamaModel, "gemma4:e4b");
  if (cfg.noEval !== false) args.push("--no-eval");
  if (cfg.useOllama !== false) args.push("--use-ollama");
  if (cfg.resume) args.push("--resume");
  args.push("--output", "models/rl_agent/L1");
  args.push("--dash", `http://${HOST}:${PORT}`);
  return args;
}

function commandPreview(cfg) {
  const py = "python";
  return [py, ...buildArgs(cfg).map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ");
}

function stopTraining() {
  if (!child || !child.pid) {
    ingest({ type: "train_proc", running: false, ts: Date.now() });
    return { ok: true, running: false };
  }
  const pid = child.pid;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child && child.pid === pid) child.kill("SIGKILL");
      }, 4000);
    }
  } catch {
    /* already gone */
  }
  return { ok: true, stopping: true, pid };
}

function startTraining(cfg = {}) {
  if (child) return { ok: false, error: "training already running" };
  const python = resolvePython();
  const args = buildArgs(cfg);
  const command = [python, ...args].join(" ");
  const env = {
    ...process.env,
    TRAIN_DASH_URL: `http://${HOST}:${PORT}`,
    PYTHONUNBUFFERED: "1",
  };
  const nSteps = Number(cfg.nSteps) || 256;
  const nEnvs = Number(cfg.nEnvs) || 1;
  const timesteps = Number(cfg.timesteps) || 1_000_000;
  ingest({
    type: "train_proc",
    running: true,
    reset: true,
    pid: null,
    command,
    startedAt: Date.now(),
    totalTimesteps: timesteps,
    totalIterations: Math.max(1, Math.ceil(timesteps / (nSteps * nEnvs))),
    nSteps,
    nEnvs,
    ts: Date.now(),
  });
  try {
    child = spawn(python, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    child = null;
    ingest({ type: "log", level: "error", text: err.message, ts: Date.now() });
    ingest({ type: "train_proc", running: false, ts: Date.now() });
    return { ok: false, error: err.message };
  }
  state.pid = child.pid;
  ingest({
    type: "train_proc",
    running: true,
    pid: child.pid,
    command,
    startedAt: Date.now(),
    ts: Date.now(),
  });
  appendLog(`spawn ${command}`);

  const onChunk = (buf, level) => {
    logBuf += buf.toString("utf8");
    const parts = logBuf.split(/\r?\n/);
    logBuf = parts.pop() || "";
    for (const line of parts) appendLog(line, level);
  };
  child.stdout.on("data", (buf) => onChunk(buf, "info"));
  child.stderr.on("data", (buf) => onChunk(buf, "warn"));
  child.on("exit", (code, signal) => {
    if (logBuf.trim()) appendLog(logBuf, "info");
    logBuf = "";
    appendLog(`процес завершився · code=${code} signal=${signal || "-"}`, code ? "error" : "info");
    child = null;
    ingest({ type: "train_proc", running: false, ts: Date.now() });
  });
  child.on("error", (err) => {
    appendLog(err.message, "error");
    child = null;
    ingest({ type: "train_proc", running: false, ts: Date.now() });
  });
  return { ok: true, pid: state.pid, command };
}

app.get("/api/state", (_req, res) => {
  res.json(snapshot());
});

app.get("/api/defaults", (_req, res) => {
  const cfg = {
    timesteps: 1_000_000,
    nEnvs: 1,
    nSteps: 256,
    batchSize: 64,
    learningRate: 3e-4,
    ticks: 10,
    maxSteps: 500,
    useOllama: true,
    ollamaFreq: 1,
    ollamaHost: process.env.OLLAMA_HOST || "localhost",
    ollamaPort: Number(process.env.OLLAMA_PORT || 11434),
    ollamaModel: process.env.OLLAMA_MODEL || "gemma4:e4b",
    noEval: true,
  };
  res.json({ ...cfg, command: commandPreview(cfg) });
});

app.post("/api/events", (req, res) => {
  ingest(req.body);
  res.json({ ok: true });
});

app.post("/api/train/start", (req, res) => {
  res.json(startTraining(req.body || {}));
});

app.post("/api/train/stop", (_req, res) => {
  res.json(stopTraining());
});

app.get("/api/ollama/health", async (req, res) => {
  const host = req.query.host || process.env.OLLAMA_HOST || "localhost";
  const port = req.query.port || process.env.OLLAMA_PORT || 11434;
  const model = req.query.model || process.env.OLLAMA_MODEL || "gemma4:e4b";
  const url = `http://${host}:${port}`;
  try {
    const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) {
      res.json({ online: false, url });
      return;
    }
    const data = await response.json();
    const names = (data.models || []).map((m) => m.name);
    res.json({
      online: true,
      url,
      model,
      modelAvailable: names.some((n) => n === model || n.startsWith(`${model}:`)),
      models: names,
    });
  } catch {
    res.json({ online: false, url, model });
  }
});

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "state", state: snapshot() }));
});

function parseGpuLine(line) {
  const parts = String(line || "").split(",").map((s) => s.trim());
  if (parts.length < 5) return null;
  const util = Number(parts[1]);
  const temp = Number(parts[2]);
  if (!Number.isFinite(util) && !Number.isFinite(temp)) return null;
  return {
    name: parts[0],
    util,
    temp,
    memUsed: Number(parts[3]),
    memTotal: Number(parts[4]),
  };
}

function readGpu() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      [
        "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 1500, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve({ type: "gpu", available: false });
          return;
        }
        const rows = String(stdout)
          .trim()
          .split(/\r?\n/)
          .map(parseGpuLine)
          .filter(Boolean);
        if (!rows.length) {
          resolve({ type: "gpu", available: false });
          return;
        }
        rows.sort((a, b) => (b.util || 0) - (a.util || 0));
        resolve({ type: "gpu", available: true, ...rows[0] });
      }
    );
  });
}

async function pollGpu() {
  ingest(await readGpu());
}

setInterval(() => {
  pollGpu().catch(() => {});
}, 2000);
pollGpu().catch(() => {});

httpServer.listen(PORT, HOST, () => {
  console.log(`Training dashboard → http://${HOST}:${PORT}`);
});
