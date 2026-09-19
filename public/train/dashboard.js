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

const NODE_COLOR = {
  tree: "#6ea35a",
  rock: "#9aa4b2",
  goldvein: "#efc94a",
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
  command: $("command"),
  form: $("cfg"),
  kpis: $("kpis"),
  stuck: $("stuck"),
  prevTitle: $("prev-title"),
  prevScore: $("prev-score"),
  prevCanvas: $("prev-canvas"),
  prevMeta: $("prev-meta"),
  currTitle: $("curr-title"),
  currScore: $("curr-score"),
  currCanvas: $("curr-canvas"),
  currMeta: $("curr-meta"),
  cardCurr: $("card-curr"),
  actions: $("actions"),
  history: $("history"),
  logs: $("logs"),
  charts: {
    reward: $("ch-reward"),
    utility: $("ch-utility"),
    ollama: $("ch-ollama"),
    eprew: $("ch-eprew"),
    loss: $("ch-loss"),
    stab: $("ch-stab"),
    gpuUtil: $("ch-gpu-util"),
    gpuTemp: $("ch-gpu-temp"),
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
    ollamaFreq: num("ollamaFreq", 10),
    ollamaHost: String(fd.get("ollamaHost") || "localhost"),
    ollamaPort: num("ollamaPort", 11434),
    ollamaModel: String(fd.get("ollamaModel") || "gemma4:e4b"),
    useOllama: els.form.elements.useOllama.checked,
    noEval: els.form.elements.noEval.checked,
  };
}

function formatCmd(cfg) {
  const parts = [
    "python scripts/train-rl-ollama.py",
    `--n-envs ${cfg.nEnvs}`,
    `--timesteps ${cfg.timesteps}`,
    `--n-steps ${cfg.nSteps}`,
  ];
  if (cfg.noEval) parts.push("--no-eval");
  if (cfg.useOllama) {
    parts.push("--use-ollama", `--ollama-freq ${cfg.ollamaFreq}`, `--ollama-model ${cfg.ollamaModel}`);
  }
  parts.push("--dash");
  return parts.join(" ");
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
  if (viz.ring) {
    add(viz.ring.x0, viz.ring.y0);
    add(viz.ring.x1, viz.ring.y1);
  }
  for (const b of viz.buildings || []) {
    add(b.tx, b.ty);
    add(b.tx + (b.w || 1), b.ty + (b.h || 1));
  }
  for (const n of viz.nodes || []) add(n.tx, n.ty);
  for (const hole of viz.holes || []) add(hole.tx, hole.ty);
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

  for (const n of viz.nodes || []) {
    ctx.fillStyle = NODE_COLOR[n.kind] || "#888";
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(px(n.tx) + cell / 2, py(n.ty) + cell / 2, Math.max(2, cell * 0.22), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  for (const hole of viz.holes || []) {
    ctx.strokeStyle = "rgba(196, 69, 60, 0.85)";
    ctx.strokeRect(px(hole.tx) + 1, py(hole.ty) + 1, cell - 2, cell - 2);
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
  if (!all.length) {
    ctx.fillStyle = "#b7aa8e";
    ctx.font = "11px Figtree, sans-serif";
    ctx.fillText("немає точок", 8, 18);
    return;
  }
  let minY = Math.min(...all.map((p) => p.y));
  let maxY = Math.max(...all.map((p) => p.y));
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
    if (pts.length < 2) continue;
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = left + (i / (pts.length - 1)) * plotW;
      const y = 4 + (1 - (p.y - minY) / (maxY - minY)) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
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

function kpi(label, value) {
  return `<div class="kpi"><span>${label}</span><b>${value}</b></div>`;
}

function metaHtml(proposal, extra = "") {
  if (!proposal) return "<div>Немає даних</div>";
  const t = proposal.treasury || {};
  const b = proposal.breakdown || {};
  const d = proposal.decision || {};
  const action = d.action || {};
  const ollama = proposal.ollama;
  const rows = [
    [`Дія`, `<strong>${actionLabel(proposal.actionName)}</strong> · ${action.op || "wait"} ${action.type || ""}`],
    [`Крок`, `еп. ${proposal.episode ?? "—"} / ${proposal.step ?? "—"} · тік ${proposal.tick ?? "—"}`],
    [`Скарб`, `дерево ${t.wood ?? 0} · камінь ${t.stone ?? 0} · золото ${t.gold ?? 0}`],
    [`Utility`, `${fmt(proposal.utility, 1)} · Δreward ${fmt(proposal.reward, 3)}`],
    [`U = E/D/S/F−W`, `${fmt(b.E, 0)} / ${fmt(b.D, 0)} / ${fmt(b.S, 0)} / ${fmt(b.F, 0)} / ${fmt(b.W, 0)}`],
    [`Кільце`, `цілісність ${fmt((proposal.viz?.ring?.integrity ?? 0) * 100, 0)}% · дірки ${proposal.viz?.holes?.length ?? 0}`],
    [`Виконано`, proposal.executed ? "так" : "ні (no-op / маска)"],
    [`Загроза`, `${fmt((proposal.threat || 0) * 100, 0)}%`],
  ];
  if (action.tx != null) rows.push([`Клітинка`, `${action.tx}, ${action.ty}`]);
  if (proposal.ollamaIn != null && !proposal.ollama && !proposal.ollamaPending) {
    rows.push([`Ollama`, proposal.ollamaIn === 0 ? "зараз" : `через ${proposal.ollamaIn} кроків`]);
  }
  if (proposal.skippedWait) rows.push([`Wait`, "симуляцію й Ollama пропущено"]);
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

function renderVariant(kind, proposal) {
  const title = kind === "prev" ? els.prevTitle : els.currTitle;
  const scoreEl = kind === "prev" ? els.prevScore : els.currScore;
  const canvas = kind === "prev" ? els.prevCanvas : els.currCanvas;
  const meta = kind === "prev" ? els.prevMeta : els.currMeta;
  drawFort(canvas, proposal);

  if (!proposal) {
    title.textContent = kind === "prev" ? "ще немає оцінки Ollama" : "очікує перший крок";
    scoreEl.className = "score idle";
    scoreEl.textContent = "—";
    meta.innerHTML = "<div>Немає даних</div>";
    return;
  }

  title.textContent = `${actionLabel(proposal.actionName)} · ${buildingName(proposal.decision?.action?.type) || proposal.decision?.action?.op || ""}`.trim();

  if (kind === "curr" && (state.evaluating || proposal.ollamaPending) && !proposal.ollama) {
    const elapsed = state.evaluateStartedAt ? Math.max(0, Date.now() - state.evaluateStartedAt) : 0;
    scoreEl.className = "score wait";
    scoreEl.textContent = `Ollama ${Math.round(elapsed / 100) / 10}с`;
    meta.innerHTML = metaHtml(proposal, `Валідація на Ollama (${state.ollamaStats.model || "модель"})… Поки дивіться попередній варіант.`);
    return;
  }

  const score = proposal.ollama?.score;
  if (score != null) {
    scoreEl.className = `score ${scoreClass(score)}`;
    scoreEl.textContent = fmt(score, 1);
  } else {
    scoreEl.className = "score idle";
    scoreEl.textContent = kind === "prev" ? "—" : "без Ollama";
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
  if (state.command) els.command.textContent = state.command;

  const v = state.values;
  els.kpis.innerHTML = [
    kpi("кроки", `${fmtInt(state.numTimesteps)} / ${fmtInt(state.totalTimesteps)}`),
    kpi("ітерація PPO", `${fmtInt(state.iteration)} / ${fmtInt(state.totalIterations) || "—"}`),
    kpi("FPS", fmt(state.fps, 1)),
    kpi("епізоди", fmtInt(state.episodes)),
    kpi("ep_rew_mean", fmt(v["rollout/ep_rew_mean"], 3)),
    kpi("останній reward", fmt(state.current?.reward, 3)),
    kpi("utility", fmt(state.current?.utility, 1)),
    kpi("Ollama", state.ollamaStats.lastScore == null ? "—" : `${fmt(state.ollamaStats.lastScore, 1)} · ${state.ollamaStats.lastMs}мс`),
    kpi("entropy", fmt(v["train/entropy_loss"], 3)),
    kpi("explained var", fmt(v["train/explained_variance"], 3)),
    kpi("clip frac", fmt(v["train/clip_fraction"], 3)),
    kpi("помилки Ollama", `${state.ollamaStats.errors} / ${state.ollamaStats.scores}`),
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

  els.cardCurr.classList.toggle("evaluating", evaluating);
  renderVariant("prev", state.previous);
  renderVariant("curr", state.current);

  drawChart(els.charts.reward, [{ points: state.series.reward, color: "#d7b056" }]);
  drawChart(els.charts.utility, [{ points: state.series.utility, color: "#7bed9f" }]);
  drawChart(els.charts.ollama, [{ points: state.series.ollama, color: "#70a1ff" }]);
  drawChart(els.charts.eprew, [{ points: state.series.epRew, color: "#f0d48a" }]);
  drawChart(els.charts.loss, [
    { points: state.series.policyLoss, color: "#ff6b6b", label: "policy" },
    { points: state.series.valueLoss, color: "#70a1ff", label: "value" },
  ], { legend: true });
  drawChart(els.charts.stab, [
    { points: state.series.entropy, color: "#4ecdc4", label: "entropy" },
    { points: state.series.explainedVar, color: "#7bed9f", label: "expl.var" },
    { points: state.series.clipFrac, color: "#f0d48a", label: "clip" },
  ], { legend: true });
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
      return `<li><span>#${row.id}</span><b>${actionLabel(row.actionName)}</b><span>${score} · U ${fmt(row.utility, 0)}</span></li>`;
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
  els.command.textContent = formatCmd(cfgFromForm());
});

els.start.addEventListener("click", async () => {
  els.start.disabled = true;
  const res = await fetch("/api/train/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfgFromForm()),
  });
  const data = await res.json();
  if (!data.ok) {
    els.start.disabled = false;
    alert(data.error || "не вдалося стартувати");
  }
});

els.stop.addEventListener("click", async () => {
  await fetch("/api/train/stop", { method: "POST" });
});

fetch("/api/state")
  .then((r) => r.json())
  .then(applyRemoteState)
  .catch(() => {});

fetch("/api/defaults")
  .then((r) => r.json())
  .then((cfg) => {
    if (state.running) return;
    for (const [k, v] of Object.entries(cfg)) {
      const el = els.form.elements[k];
      if (!el) continue;
      if (el.type === "checkbox") el.checked = !!v;
      else el.value = v;
    }
    els.command.textContent = formatCmd(cfgFromForm());
  })
  .catch(() => {
    els.command.textContent = formatCmd(cfgFromForm());
  });

connect();
timer = setInterval(schedule, 500);
window.addEventListener("resize", schedule);
render();
