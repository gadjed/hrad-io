import { BUILDINGS } from "/shared/defs.mjs";
import {
  applyTrainEvent,
  createTrainState,
  detectStuck,
} from "/shared/train-dashboard-state.mjs";

const BUILD_COLOR = {
  core: "#d7b056",
  wall_wood: "#d0924a",
  wall_stone: "#c5cdd6",
  gate: "#f4e08a",
  mill: "#7ec96a",
  quarry: "#b7c0cc",
  goldmine: "#f2d15c",
  tower_arrow: "#efe0b0",
  tower_cannon: "#e06a5c",
  spikes: "#c97a4a",
};

const ACTION_UA = {
  wait: "чекати",
  place_mill: "лісопилка",
  place_quarry: "каменоломня",
  place_goldmine: "копальня",
  place_wall_stone: "кам'яний мур",
  place_gate: "брама",
  place_tower_arrow: "стрільниця",
  place_tower_cannon: "гармата",
  place_spikes: "шипи",
  upgrade_core: "апгрейд цитаделі",
  upgrade_harvest: "апгрейд видобутку",
  upgrade_tower: "апгрейд вежі",
  repair_core: "ремонт цитаделі",
  repair_damaged: "ремонт пошкодженого",
  sell_worst_harvest: "продати гірший видобуток",
  sell_worst_wall: "продати гірший мур",
  sell_redundant: "продати зайве",
  place_core: "поставити цитадель",
  expand_ring: "розширити кільце",
  fortify_ring: "укріпити кільце",
};

const $ = (id) => document.getElementById(id);
const els = {
  run: $("run-badge"),
  start: $("btn-start"),
  stop: $("btn-stop"),
  resetWeights: $("btn-reset-weights"),
  command: $("command"),
  modal: $("start-modal"),
  modalCmd: $("modal-command"),
  startError: $("start-error"),
  cancelStart: $("btn-cancel-start"),
  confirmStart: $("btn-confirm-start"),
  form: $("cfg"),
  kpis: $("kpis"),
  stuck: $("stuck"),
  prevTitle: $("prev-title"),
  prevScore: $("prev-score"),
  prevCanvas: $("prev-canvas"),
  prevMeta: $("prev-meta"),
  actions: $("actions"),
  history: $("history"),
  logs: $("logs"),
  capReward: $("cap-reward"),
  charts: {
    reward: $("ch-reward"),
    utility: $("ch-utility"),
    ollama: $("ch-ollama"),
    eprew: $("ch-eprew"),
    loss: $("ch-loss"),
    stab: $("ch-stab"),
    gpuUtil: $("ch-gpu-util"),
    gpuTemp: $("ch-gpu-temp"),
    ollamaPie: $("ch-ollama-pie"),
    ollamaOk: $("ch-ollama-ok"),
  },
};

let state = createTrainState();
let raf = 0;
let timer = 0;

function cfgFromForm() {
  const fd = new FormData(els.form);
  const num = (name, fallback) => {
    const v = Number(fd.get(name));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    timesteps: num("timesteps", 1_000_000),
    nEnvs: num("nEnvs", 1),
    nSteps: num("nSteps", 256),
    batchSize: num("batchSize", 64),
    learningRate: num("learningRate", 3e-4),
    ticks: num("ticks", 10),
    maxSteps: num("maxSteps", 500),
    ollamaFreq: num("ollamaFreq", 1),
    ollamaHost: String(fd.get("ollamaHost") || "localhost"),
    ollamaPort: num("ollamaPort", 11434),
    ollamaModel: String(fd.get("ollamaModel") || "gemma4:e4b"),
    seed: String(fd.get("seed") || "none"),
    useOllama: els.form.elements.useOllama.checked,
    noEval: els.form.elements.noEval.checked,
    resume: !els.form.elements.resume || els.form.elements.resume.checked,
  };
}

function formatCmd(cfg) {
  const parts = [
    "python scripts/train-rl-ollama.py",
    `--timesteps ${cfg.timesteps}`,
    `--n-envs ${cfg.nEnvs}`,
    `--n-steps ${cfg.nSteps}`,
    `--batch-size ${cfg.batchSize}`,
    `--learning-rate ${cfg.learningRate}`,
    `--ticks ${cfg.ticks}`,
    `--max-steps ${cfg.maxSteps}`,
    `--ollama-freq ${cfg.ollamaFreq}`,
    `--ollama-host ${cfg.ollamaHost}`,
    `--ollama-port ${cfg.ollamaPort}`,
    `--ollama-model ${cfg.ollamaModel}`,
  ];
  if (cfg.noEval) parts.push("--no-eval");
  if (cfg.useOllama) parts.push("--use-ollama");
  if (cfg.seed) parts.push(`--seed ${cfg.seed}`);
  if (cfg.resume) parts.push("--resume");
  else parts.push("--no-resume");
  parts.push("--output models/rl_agent/L1");
  parts.push("--dash http://127.0.0.1:8787");
  return parts.join(" ");
}

function refreshCmd() {
  const cmd = formatCmd(cfgFromForm());
  if (!state.running || !state.command) els.command.textContent = cmd;
  if (els.modalCmd) els.modalCmd.textContent = cmd;
  return cmd;
}

function applyCfg(cfg) {
  if (!cfg || !els.form) return;
  for (const [k, v] of Object.entries(cfg)) {
    const el = els.form.elements[k];
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v;
  }
}

const LAUNCH_CFG_KEY = "hrad-train-launch";

function loadLocalCfg() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAUNCH_CFG_KEY) || "null");
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function saveLocalCfg() {
  localStorage.setItem(LAUNCH_CFG_KEY, JSON.stringify(cfgFromForm()));
}

let persistTimer = 0;
function persistCfg() {
  saveLocalCfg();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    fetch("/api/defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfgFromForm()),
    }).catch(() => {});
  }, 250);
}

function openStartModal() {
  if (state.running) return;
  if (els.startError) {
    els.startError.hidden = true;
    els.startError.textContent = "";
  }
  refreshCmd();
  els.modal.showModal();
}

function closeStartModal() {
  if (els.modal.open) els.modal.close();
}

function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    render();
  });
}

function fmt(n, digits = 2) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

function fmtInt(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Math.round(Number(n)).toLocaleString("uk-UA");
}

function actionLabel(name) {
  return ACTION_UA[name] || name || "—";
}

function scoreClass(score) {
  if (score == null) return "idle";
  if (score >= 7.5) return "good";
  if (score >= 5.5) return "mid";
  return "bad";
}

function buildingName(type) {
  return BUILDINGS[type]?.name || type || "";
}

function drawFort(canvas, proposal) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 640;
  const h = canvas.clientHeight || 320;
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#161c18";
  ctx.fillRect(0, 0, w, h);

  const viz = proposal?.viz;
  if (!viz) {
    ctx.fillStyle = "#b7aa8e";
    ctx.font = "13px Figtree, sans-serif";
    ctx.fillText("Немає знімка форту", 16, 28);
    return;
  }

  const xs = [];
  const ys = [];
  const add = (x, y) => {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  };
  if (viz.keep) {
    add(viz.keep.tx, viz.keep.ty);
    add(viz.keep.tx1, viz.keep.ty1);
  }
  for (const b of viz.buildings || []) {
    add(b.tx, b.ty);
    add(b.tx + (b.w || 1), b.ty + (b.h || 1));
  }
  if (viz.highlight?.tx != null) add(viz.highlight.tx, viz.highlight.ty);
  if (!xs.length) {
    add(0, 0);
    add(16, 16);
  }

  const pad = 2;
  let minX = Math.min(...xs) - pad;
  let maxX = Math.max(...xs) + pad;
  let minY = Math.min(...ys) - pad;
  let maxY = Math.max(...ys) + pad;
  if (maxX === minX) maxX += 1;
  if (maxY === minY) maxY += 1;
  const cell = Math.max(4, Math.min((w - 20) / (maxX - minX), (h - 20) / (maxY - minY)));
  const ox = (w - (maxX - minX) * cell) / 2;
  const oy = (h - (maxY - minY) * cell) / 2;
  const px = (tx) => ox + (tx - minX) * cell;
  const py = (ty) => oy + (ty - minY) * cell;

  ctx.strokeStyle = "rgba(232, 223, 200, 0.14)";
  ctx.lineWidth = 1;
  for (let x = Math.floor(minX); x <= maxX; x++) {
    ctx.beginPath();
    ctx.moveTo(px(x), py(minY));
    ctx.lineTo(px(x), py(maxY));
    ctx.stroke();
  }
  for (let y = Math.floor(minY); y <= maxY; y++) {
    ctx.beginPath();
    ctx.moveTo(px(minX), py(y));
    ctx.lineTo(px(maxX), py(y));
    ctx.stroke();
  }

  if (viz.keep) {
    ctx.fillStyle = "rgba(62, 72, 48, 0.85)";
    ctx.strokeStyle = "rgba(215, 176, 86, 0.8)";
    ctx.lineWidth = 2;
    ctx.fillRect(px(viz.keep.tx), py(viz.keep.ty), (viz.keep.tx1 - viz.keep.tx + 1) * cell, (viz.keep.ty1 - viz.keep.ty + 1) * cell);
    ctx.strokeRect(px(viz.keep.tx), py(viz.keep.ty), (viz.keep.tx1 - viz.keep.tx + 1) * cell, (viz.keep.ty1 - viz.keep.ty + 1) * cell);
  }

  for (const b of viz.buildings || []) {
    const hp = b.max_hp ? b.hp / b.max_hp : 1;
    ctx.globalAlpha = 0.7 + 0.3 * hp;
    ctx.fillStyle = BUILD_COLOR[b.type] || "#ccc";
    const x = px(b.tx) + 0.6;
    const y = py(b.ty) + 0.6;
    const bw = (b.w || 1) * cell - 1.2;
    const bh = (b.h || 1) * cell - 1.2;
    ctx.fillRect(x, y, bw, bh);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(12, 16, 14, 0.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, bw, bh);
  }

  const hl = viz.highlight;
  if (hl && hl.kind !== "none" && hl.tx != null) {
    const colors = {
      place: "#4ecdc4",
      upgrade: "#70a1ff",
      repair: "#7bed9f",
      sell: "#ff6b6b",
    };
    ctx.strokeStyle = colors[hl.kind] || "#f0d48a";
    ctx.lineWidth = 2.4;
    const bw = hl.kind === "place" && hl.type && BUILDINGS[hl.type] ? BUILDINGS[hl.type].w : 1;
    const bh = hl.kind === "place" && hl.type && BUILDINGS[hl.type] ? BUILDINGS[hl.type].h : 1;
    ctx.strokeRect(px(hl.tx) - 1, py(hl.ty) - 1, bw * cell + 2, bh * cell + 2);
  }
}

function drawChart(canvas, seriesList, opts = {}) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 130;
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0c100e";
  ctx.fillRect(0, 0, w, h);

  const all = seriesList.flatMap((s) => s.points);
  const hlines = [];
  if (opts.hline != null && Number.isFinite(Number(opts.hline))) {
    hlines.push({
      y: Number(opts.hline),
      color: opts.hlineColor || "#f0d48a",
      label: opts.hlineLabel || "",
    });
  }
  for (const extra of opts.hlines || []) {
    if (extra && Number.isFinite(Number(extra.y))) hlines.push(extra);
  }
  if (!all.length) {
    ctx.fillStyle = "#b7aa8e";
    ctx.font = "11px Figtree, sans-serif";
    ctx.fillText(opts.empty || "немає точок", 8, 18);
    return;
  }
  let minY = Math.min(...all.map((p) => p.y), ...hlines.map((h) => h.y));
  let maxY = Math.max(...all.map((p) => p.y), ...hlines.map((h) => h.y));
  if (minY === maxY) {
    minY -= 1;
    maxY += 1;
  }
  const pad = (maxY - minY) * 0.08;
  minY -= pad;
  maxY += pad;
  const left = 6;
  const bottom = 4;
  const plotW = w - 12;
  const plotH = h - 10;

  ctx.strokeStyle = "rgba(232,223,200,0.08)";
  ctx.beginPath();
  ctx.moveTo(left, 4 + plotH * 0.5);
  ctx.lineTo(left + plotW, 4 + plotH * 0.5);
  ctx.stroke();

  for (const series of seriesList) {
    const pts = series.points;
    if (!pts.length) continue;
    ctx.strokeStyle = series.color;
    ctx.fillStyle = series.color;
    ctx.lineWidth = 1.5;
    if (pts.length === 1) {
      const p = pts[0];
      const x = left + plotW * 0.5;
      const y = 4 + (1 - (p.y - minY) / (maxY - minY)) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = left + (i / (pts.length - 1)) * plotW;
      const y = 4 + (1 - (p.y - minY) / (maxY - minY)) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  for (const line of hlines) {
    const y = 4 + (1 - (line.y - minY) / (maxY - minY)) * plotH;
    ctx.save();
    ctx.strokeStyle = line.color || "#f0d48a";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = line.label || "";
    if (label) {
      ctx.font = "10px Figtree, sans-serif";
      ctx.fillStyle = line.color || "#f0d48a";
      ctx.textAlign = "right";
      ctx.fillText(label, left + plotW - 1, Math.max(11, y - 3));
      ctx.textAlign = "left";
    }
    ctx.restore();
  }

  if (opts.legend) {
    ctx.font = "10px Figtree, sans-serif";
    let lx = 8;
    for (const series of seriesList) {
      ctx.fillStyle = series.color;
      ctx.fillRect(lx, h - bottom - 8, 8, 8);
      ctx.fillStyle = "#b7aa8e";
      ctx.fillText(series.label, lx + 11, h - bottom - 1);
      lx += 70;
    }
  }
}

function drawPie(canvas, ok, bad) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 130;
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0c100e";
  ctx.fillRect(0, 0, w, h);
  const total = ok + bad;
  const cx = w * 0.38;
  const cy = h / 2;
  const r = Math.min(h * 0.38, w * 0.22);
  if (!total) {
    ctx.strokeStyle = "#3a4036";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#b7aa8e";
    ctx.font = "11px Figtree, sans-serif";
    ctx.fillText("немає перевірок", 8, 18);
    return;
  }
  const okAngle = (ok / total) * Math.PI * 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + okAngle);
  ctx.closePath();
  ctx.fillStyle = "#7bed9f";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, -Math.PI / 2 + okAngle, -Math.PI / 2 + Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "#c4453c";
  ctx.fill();
  ctx.fillStyle = "#e8dfc8";
  ctx.font = "12px Figtree, sans-serif";
  const pct = Math.round((ok / total) * 100);
  ctx.fillText(`${pct}% ок`, cx + r + 14, cy - 6);
  ctx.fillStyle = "#b7aa8e";
  ctx.fillText(`${ok} / ${bad}`, cx + r + 14, cy + 12);
}

function kpi(label, value) {
  return `<div class="kpi"><span>${label}</span><b>${value}</b></div>`;
}

function metaHtml(proposal, extra = "") {
  if (!proposal) return "<div>Немає даних</div>";
  const b = proposal.breakdown || {};
  const d = proposal.decision || {};
  const action = d.action || {};
  const ollama = proposal.ollama;
  const rows = [
    [`Дія`, `<strong>${actionLabel(proposal.actionName)}</strong> · ${action.op || "wait"} ${action.type || ""}`],
    [`Крок`, `еп. ${proposal.episode ?? "—"} / ${proposal.step ?? "—"}`],
    [`Utility`, `${fmt(proposal.utility, 1)} · Δreward ${fmt(proposal.reward, 3)}`],
    [`Розкладка`, `P ${fmt(b.P, 1)} · overlap ${fmt(b.overlap, 2)} · clog ${fmt(b.clog, 2)} · вежі ${b.towers ?? 0}`],
    [`U = E/D/S/F−W`, `${fmt(b.E, 0)} / ${fmt(b.D, 0)} / ${fmt(b.S, 0)} / ${fmt(b.F, 0)} / ${fmt(b.W, 0)}`],
    [`Виконано`, proposal.executed ? "так" : "ні (no-op / маска)"],
  ];
  if (action.tx != null) rows.push([`Клітинка`, `${action.tx}, ${action.ty}`]);
  if (proposal.ollamaIn != null && !proposal.ollama && !proposal.ollamaPending) {
    rows.push([`Ollama`, proposal.ollamaIn === 0 ? "зараз" : `через ${proposal.ollamaIn} кроків`]);
  }
  if (proposal.skippedWait) rows.push([`Wait`, "симуляцію й Ollama пропущено"]);
  if (proposal.ruleFail || ollama?.ruleFail) {
    const why = proposal.ruleFail || ollama.ruleFail;
    rows.push([`Правило`, why === "contour" ? "на контурі keep лише стіна/брама · Ollama пропущено" : "поза зоною цитаделі · Ollama пропущено"]);
  }
  if (d.rationale) rows.push([`Чому`, d.rationale]);
  if (ollama) {
    rows.push([`Ollama`, `${fmt(ollama.score, 1)} / 10 · ${ollama.ms || 0}мс${ollama.cached ? " · cache" : ""}`]);
    if (ollama.raw) rows.push([`Відповідь`, ollama.raw]);
    if (ollama.error) rows.push([`Помилка`, ollama.error]);
  }
  if (extra) rows.push(["Статус", extra]);
  return rows
    .map(([k, v], i) => `<div${i >= 6 ? ' class="full"' : ""}>${k}: ${v}</div>`)
    .join("");
}

function renderEvaluated(proposal) {
  const title = els.prevTitle;
  const scoreEl = els.prevScore;
  const canvas = els.prevCanvas;
  const meta = els.prevMeta;
  drawFort(canvas, proposal);

  if (!proposal) {
    title.textContent = "ще немає оцінки";
    scoreEl.className = "score idle";
    scoreEl.textContent = "—";
    meta.innerHTML = "<div>Немає даних</div>";
    return;
  }

  title.textContent = `${actionLabel(proposal.actionName)} · ${buildingName(proposal.decision?.action?.type) || proposal.decision?.action?.op || ""}`.trim();

  const score = proposal.ollama?.score;
  if (score != null) {
    scoreEl.className = `score ${scoreClass(score)}`;
    scoreEl.textContent =
      proposal.ollama?.model === "rule" ||
      proposal.ollama?.model === "opening_rule" ||
      proposal.ruleFail ||
      proposal.ollama?.ruleFail
        ? `правило ${fmt(score, 0)}`
        : fmt(score, 1);
  } else {
    scoreEl.className = "score idle";
    scoreEl.textContent = "—";
  }
  meta.innerHTML = metaHtml(proposal);
}

function render() {
  const stuck = detectStuck(state);
  const evaluating = state.evaluating;
  els.run.className = `badge ${state.running ? (evaluating ? "eval" : "run") : state.finishedAt ? "done" : "idle"}`;
  els.run.textContent = !state.running
    ? state.finishedAt
      ? "завершено"
      : "очікує"
    : evaluating
      ? "Ollama перевіряє"
      : "навчання";
  els.start.disabled = state.running;
  els.stop.disabled = !state.running;
  if (els.resetWeights) els.resetWeights.disabled = state.running;
  if (state.running && els.modal?.open) closeStartModal();
  if (state.command) els.command.textContent = state.command;

  const v = state.values || {};
  const ollama = state.ollamaStats || {};
  const last100 = ollama.verdicts || [];
  const ok100 = last100.filter((row) => row.ok).length;
  const bad100 = last100.length - ok100;
  const gymNow = Math.max(state.gymSteps || 0, state.numTimesteps || 0, state.stepIndex || 0);
  const rolloutLen = Math.max(1, (state.nSteps || 256) * (state.nEnvs || 1));
  const intoRollout = gymNow % rolloutLen;
  const ppoLabel = state.totalIterations
    ? `${fmtInt(state.iteration)} / ${fmtInt(state.totalIterations)} · ${intoRollout}/${rolloutLen}`
    : `${fmtInt(state.iteration)} · ${intoRollout}/${rolloutLen}`;
  els.kpis.innerHTML = [
    kpi("gym-кроки", `${fmtInt(gymNow)} / ${fmtInt(state.totalTimesteps)}`),
    kpi("PPO оновлення", ppoLabel),
    kpi("перевірки (правило/Ollama)", `${fmtInt(ollama.ok)} ок / ${fmtInt(ollama.scores)}`),
    kpi("останні 100", last100.length ? `${Math.round((ok100 / last100.length) * 100)}% ок` : "—"),
    kpi("fail streak", fmtInt(ollama.failStreak)),
    kpi("скид до core", fmtInt(ollama.resetsToCore)),
    kpi("FPS", fmt(state.fps, 1)),
    kpi("епізоди", fmtInt(state.episodes)),
    kpi("ep_rew_mean", fmt(v["rollout/ep_rew_mean"], 3)),
    kpi("останній reward", fmt(state.current?.reward, 3)),
    kpi("utility", fmt(state.current?.utility, 1)),
    kpi("Ollama score", ollama.lastScore == null ? "—" : `${fmt(ollama.lastScore, 1)}${ollama.lastOk ? " ок" : ""} · ${ollama.lastMs}мс`),
    kpi("entropy", fmt(v["train/entropy_loss"], 3)),
    kpi("explained var", fmt(v["train/explained_variance"], 3)),
    kpi(
      "GPU",
      state.gpu?.available
        ? `${fmt(state.gpu.util, 0)}% · ${fmt(state.gpu.temp, 0)}°C`
        : "немає даних"
    ),
    kpi(
      "VRAM",
      state.gpu?.available && state.gpu.memTotal
        ? `${fmtInt(state.gpu.memUsed)} / ${fmtInt(state.gpu.memTotal)} МБ`
        : "—"
    ),
  ].join("");

  if (stuck.length) {
    els.stuck.hidden = false;
    els.stuck.innerHTML = stuck.map((w) => `<p class="${w.level}">${w.text}</p>`).join("");
  } else {
    els.stuck.hidden = true;
    els.stuck.innerHTML = "";
  }

  renderEvaluated(state.previous);

  if (els.capReward) {
    const n = state.okStreakMax1000;
    els.capReward.innerHTML =
      n == null
        ? "Reward кроку"
        : `Reward кроку · макс. серія <b>${fmtInt(n)}</b>`;
  }

  drawChart(els.charts.reward, [{ points: state.series.reward, color: "#d7b056" }]);
  drawChart(els.charts.utility, [{ points: state.series.utility, color: "#7bed9f" }], {
    hline: state.utilityMax1000,
    hlineColor: "#f0d48a",
    hlineLabel:
      state.utilityMax1000 == null
        ? ""
        : `макс. ${fmt(state.utilityMax1000, 0)} · ${fmtInt((state.episodePeaks?.length || 0) + (state.episodeUtilityPeak != null ? 1 : 0))} еп.`,
  });
  drawChart(els.charts.ollama, [{ points: state.series.ollama, color: "#70a1ff" }]);
  drawPie(els.charts.ollamaPie, ok100, bad100);
  drawChart(els.charts.ollamaOk, [{ points: state.series.ollamaOk || [], color: "#7bed9f" }]);
  drawChart(els.charts.eprew, [{ points: state.series.epRew, color: "#f0d48a" }], {
    empty: "після першого епізоду (500 кроків)",
  });
  drawChart(els.charts.loss, [
    { points: state.series.policyLoss, color: "#ff6b6b", label: "policy" },
    { points: state.series.valueLoss, color: "#70a1ff", label: "value" },
  ], { legend: true, empty: "після першого PPO оновлення (256 кроків)" });
  drawChart(els.charts.stab, [
    { points: state.series.entropy, color: "#4ecdc4", label: "entropy" },
    { points: state.series.explainedVar, color: "#7bed9f", label: "expl.var" },
    { points: state.series.clipFrac, color: "#f0d48a", label: "clip" },
  ], { legend: true, empty: "після першого PPO оновлення (256 кроків)" });
  drawChart(els.charts.gpuUtil, [{ points: state.series.gpuUtil || [], color: "#4ecdc4" }]);
  drawChart(els.charts.gpuTemp, [{ points: state.series.gpuTemp || [], color: "#ff6b6b" }]);

  const names = state.worker.actions || [];
  const total = Object.values(state.actionCounts).reduce((s, n) => s + n, 0) || 1;
  const ranked = names
    .map((name) => ({ name, n: state.actionCounts[name] || 0 }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 12);
  els.actions.innerHTML = ranked
    .map((row) => {
      const pct = Math.round((row.n / total) * 100);
      return `<div class="act"><span>${actionLabel(row.name)}</span><i style="width:${Math.max(2, pct)}%"></i><b>${row.n}</b></div>`;
    })
    .join("");

  els.history.innerHTML = state.history
    .map((row) => {
      const score = row.score == null ? "…" : fmt(row.score, 1);
      const tone = row.ok === true ? "ok" : row.ok === false ? "bad" : row.score == null ? "idle" : scoreClass(row.score);
      return `<li class="${tone}"><span>#${row.id}</span><b>${actionLabel(row.actionName)}</b><span>${score} · U ${fmt(row.utility, 0)}</span></li>`;
    })
    .join("");

  const logText = state.logs
    .slice(-80)
    .map((l) => {
      const cls = l.level === "error" ? "err" : l.level === "warn" ? "warn" : "";
      return `<span class="${cls}">${escapeHtml(l.text)}</span>`;
    })
    .join("\n");
  if (els.logs.innerHTML !== logText) {
    els.logs.innerHTML = logText;
    els.logs.scrollTop = els.logs.scrollHeight;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function applyRemoteState(remote) {
  const { stuck, dashUrl, ...rest } = remote;
  state = rest;
  schedule();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}`);
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "state" && msg.state) {
      applyRemoteState(msg.state);
      return;
    }
    if (msg.type === "event" && msg.event) {
      applyTrainEvent(state, msg.event);
      schedule();
    }
  };
  ws.onclose = () => setTimeout(connect, 1200);
}

els.form.addEventListener("input", () => {
  refreshCmd();
  persistCfg();
});

els.form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (state.running) return;
  persistCfg();
  els.confirmStart.disabled = true;
  if (els.startError) {
    els.startError.hidden = true;
    els.startError.textContent = "";
  }
  try {
    const res = await fetch("/api/train/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfgFromForm()),
    });
    const data = await res.json();
    if (!data.ok) {
      if (els.startError) {
        els.startError.hidden = false;
        els.startError.textContent = data.error || "не вдалося стартувати";
      } else {
        alert(data.error || "не вдалося стартувати");
      }
      return;
    }
    closeStartModal();
  } catch (err) {
    if (els.startError) {
      els.startError.hidden = false;
      els.startError.textContent = err.message || "немає зв'язку з дашбордом";
    }
  } finally {
    els.confirmStart.disabled = false;
  }
});

els.start.addEventListener("click", openStartModal);
els.command.addEventListener("click", () => {
  if (!state.running) openStartModal();
});
els.cancelStart.addEventListener("click", closeStartModal);
els.modal.addEventListener("click", (ev) => {
  if (ev.target === els.modal) closeStartModal();
});

els.stop.addEventListener("click", async () => {
  await fetch("/api/train/stop", { method: "POST" });
});

els.resetWeights.addEventListener("click", async () => {
  if (state.running) {
    alert("Спочатку Стоп.");
    return;
  }
  if (!confirm("Видалити чекпоінти L1 і почати з випадкових ваг? Це нескасовно.")) return;
  els.resetWeights.disabled = true;
  try {
    const res = await fetch("/api/train/reset-weights", { method: "POST" });
    const data = await res.json();
    if (!data.ok) {
      alert(data.error || "не вдалося скинути ваги");
      return;
    }
    if (els.form.elements.resume) els.form.elements.resume.checked = false;
    refreshCmd();
    persistCfg();
  } finally {
    els.resetWeights.disabled = state.running;
  }
});

fetch("/api/state")
  .then((r) => r.json())
  .then(applyRemoteState)
  .catch(() => {});

{
  const local = loadLocalCfg();
  if (local) applyCfg(local);
  refreshCmd();
}

fetch("/api/defaults")
  .then((r) => r.json())
  .then((cfg) => {
    const local = loadLocalCfg();
    if (cfg.saved) applyCfg(cfg);
    else if (local) applyCfg(local);
    else applyCfg(cfg);
    refreshCmd();
  })
  .catch(() => {
    const local = loadLocalCfg();
    if (local) applyCfg(local);
    refreshCmd();
  });

connect();
timer = setInterval(schedule, 500);
window.addEventListener("resize", schedule);
render();
