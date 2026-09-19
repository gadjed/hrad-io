export const DEFAULT_ACTION_NAMES = [
  "wait",
  "place_mill",
  "place_quarry",
  "place_goldmine",
  "place_wall_stone",
  "place_gate",
  "place_tower_arrow",
  "place_tower_cannon",
  "place_spikes",
  "upgrade_core",
  "upgrade_harvest",
  "upgrade_tower",
  "repair_core",
  "repair_damaged",
  "sell_worst_harvest",
  "sell_worst_wall",
  "sell_redundant",
  "place_core",
  "expand_ring",
  "fortify_ring",
];

const SERIES_MAX = 400;
const LOG_MAX = 280;
const HISTORY_MAX = 24;

export function createTrainState() {
  return {
    running: false,
    pid: null,
    command: "",
    startedAt: null,
    finishedAt: null,
    totalTimesteps: 1_000_000,
    totalIterations: 0,
    iteration: 0,
    numTimesteps: 0,
    gymSteps: 0,
    nSteps: 256,
    nEnvs: 1,
    fps: 0,
    values: {},
    series: {
      reward: [],
      utility: [],
      ollama: [],
      epRew: [],
      epLen: [],
      entropy: [],
      policyLoss: [],
      valueLoss: [],
      explainedVar: [],
      clipFrac: [],
      approxKl: [],
      gpuUtil: [],
      gpuTemp: [],
      ollamaOk: [],
    },
    gpu: {
      available: null,
      name: null,
      util: null,
      temp: null,
      memUsed: null,
      memTotal: null,
    },
    current: null,
    previous: null,
    episodeViz: null,
    evaluating: false,
    evaluateStartedAt: null,
    history: [],
    actionCounts: {},
    ollamaStats: {
      scores: 0,
      ok: 0,
      bad: 0,
      errors: 0,
      cacheHits: 0,
      lastMs: 0,
      lastScore: null,
      lastRaw: "",
      lastOk: null,
      model: null,
      failStreak: 0,
      resetsToCore: 0,
      verdicts: [],
    },
    logs: [],
    worker: {
      ollama: false,
      ollamaFreq: 1,
      actions: DEFAULT_ACTION_NAMES.slice(),
      ticks: 10,
      maxSteps: 500,
    },
    lastEventAt: 0,
    stepIndex: 0,
    episodes: 0,
    lastEpisodeReward: null,
    lastEpisodeReason: null,
  };
}

function pushSeries(arr, x, y, max = SERIES_MAX) {
  if (!Number.isFinite(y)) return;
  arr.push({ x, y });
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function applyTrainEvent(state, ev) {
  if (!ev || !ev.type) return state;
  if (ev.type !== "gpu") state.lastEventAt = ev.ts || Date.now();

  switch (ev.type) {
    case "train_proc": {
      state.running = !!ev.running;
      state.pid = ev.pid || null;
      state.command = ev.command || state.command;
      if (ev.reset) {
        const keepCmd = ev.command || state.command;
        const next = createTrainState();
        Object.assign(state, next);
        state.running = !!ev.running;
        state.pid = ev.pid || null;
        state.command = keepCmd;
        state.startedAt = ev.startedAt || Date.now();
        state.totalTimesteps = ev.totalTimesteps || next.totalTimesteps;
        if (ev.totalIterations) state.totalIterations = ev.totalIterations;
        if (ev.nSteps) state.nSteps = ev.nSteps;
        if (ev.nEnvs) state.nEnvs = ev.nEnvs;
      } else if (ev.running) {
        state.startedAt = ev.startedAt || state.startedAt || Date.now();
        state.finishedAt = null;
      } else {
        state.finishedAt = ev.ts || Date.now();
        state.evaluating = false;
      }
      break;
    }
    case "train_start": {
      state.totalTimesteps = ev.total_timesteps ?? ev.totalTimesteps ?? state.totalTimesteps;
      state.totalIterations = ev.total_iterations ?? ev.totalIterations ?? state.totalIterations;
      if (ev.n_steps) state.nSteps = ev.n_steps;
      if (ev.n_envs) state.nEnvs = ev.n_envs;
      break;
    }
    case "train_end": {
      if (ev.num_timesteps != null) state.numTimesteps = ev.num_timesteps;
      if (ev.iteration != null) state.iteration = ev.iteration;
      state.running = false;
      state.finishedAt = ev.ts || Date.now();
      state.evaluating = false;
      break;
    }
    case "worker_ready": {
      state.worker = {
        ollama: !!ev.ollama,
        ollamaFreq: ev.ollamaFreq || 1,
        actions: ev.actions || DEFAULT_ACTION_NAMES.slice(),
        ticks: ev.ticks || 10,
        maxSteps: ev.maxSteps || 500,
      };
      if (ev.model) state.ollamaStats.model = ev.model;
      break;
    }
    case "episode": {
      state.episodes = ev.episode || state.episodes;
      state.episodeViz = ev;
      break;
    }
    case "episode_end": {
      state.lastEpisodeReward = num(ev.reward);
      state.lastEpisodeReason = ev.reason || null;
      const y = num(ev.reward);
      const x = state.gymSteps || state.stepIndex || ev.steps || 0;
      if (y != null) pushSeries(state.series.epRew, x, y);
      break;
    }
    case "proposal": {
      state.stepIndex += 1;
      state.gymSteps = Math.max(state.gymSteps || 0, state.stepIndex, Number(ev.gymSteps) || 0);
      if (ev.num_timesteps != null) state.numTimesteps = Math.max(state.numTimesteps || 0, Number(ev.num_timesteps) || 0);
      state.current = ev;
      state.episodes = ev.episode || state.episodes;
      const name = ev.actionName || "wait";
      state.actionCounts[name] = (state.actionCounts[name] || 0) + 1;
      pushSeries(state.series.reward, state.stepIndex, num(ev.reward));
      pushSeries(state.series.utility, state.stepIndex, num(ev.utility));
      if (ev.ollamaPending) {
        state.evaluating = true;
        state.evaluateStartedAt = ev.ts || Date.now();
      }
      state.history.unshift({
        id: ev.proposalId,
        actionName: name,
        utility: ev.utility,
        reward: ev.reward,
        score: ev.ollama?.score ?? null,
        executed: ev.executed,
        ts: ev.ts,
        episode: ev.episode,
        step: ev.step,
      });
      if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
      break;
    }
    case "ollama_start": {
      state.evaluating = true;
      state.evaluateStartedAt = ev.ts || Date.now();
      if (ev.model) state.ollamaStats.model = ev.model;
      if (state.current && state.current.proposalId === ev.proposalId) {
        state.current.ollamaPending = true;
      }
      break;
    }
    case "ollama_done": {
      state.evaluating = false;
      state.ollamaStats.scores += 1;
      const ok = ev.ok === true || (ev.ok !== false && num(ev.score) != null && ev.score > 7);
      if (ok) state.ollamaStats.ok += 1;
      else state.ollamaStats.bad += 1;
      if (ev.error) state.ollamaStats.errors += 1;
      if (ev.cached) state.ollamaStats.cacheHits += 1;
      state.ollamaStats.lastMs = ev.ms || 0;
      state.ollamaStats.lastScore = num(ev.score);
      state.ollamaStats.lastRaw = ev.raw || "";
      state.ollamaStats.lastOk = ok;
      state.ollamaStats.failStreak = ev.failStreak || 0;
      if (ev.model) state.ollamaStats.model = ev.model;
      state.ollamaStats.verdicts.push({ ts: ev.ts || Date.now(), ok, score: num(ev.score) });
      if (state.ollamaStats.verdicts.length > 100) state.ollamaStats.verdicts.shift();
      pushSeries(state.series.ollama, ev.proposalId || state.stepIndex, num(ev.score));
      pushSeries(state.series.ollamaOk, ev.proposalId || state.stepIndex, ok ? 1 : 0);
      if (state.current && state.current.proposalId === ev.proposalId) {
        state.current.ollamaPending = false;
        state.current.ollama = ev;
        state.current.reward = ev.reward ?? state.current.reward;
        state.previous = { ...state.current };
      } else if (state.current) {
        state.previous = {
          ...state.current,
          ollama: ev,
          ollamaPending: false,
        };
      }
      const hit = state.history.find((row) => row.id === ev.proposalId);
      if (hit) {
        hit.score = ev.score;
        hit.ok = ok;
      }
      break;
    }
    case "reset_to_core": {
      state.ollamaStats.resetsToCore += 1;
      state.ollamaStats.failStreak = 0;
      break;
    }
    case "metrics":
    case "progress": {
      if (ev.iteration != null) state.iteration = ev.iteration;
      if (ev.total_iterations != null) state.totalIterations = ev.total_iterations;
      if (ev.num_timesteps != null) {
        state.numTimesteps = ev.num_timesteps;
        state.gymSteps = Math.max(state.gymSteps || 0, ev.num_timesteps);
      }
      const values = ev.values || {};
      state.values = { ...state.values, ...values };
      const t = state.numTimesteps || state.iteration;
      const fps = num(values["time/fps"]);
      if (fps != null) state.fps = fps;
      const map = [
        ["epRew", "rollout/ep_rew_mean"],
        ["epLen", "rollout/ep_len_mean"],
        ["entropy", "train/entropy_loss"],
        ["policyLoss", "train/policy_gradient_loss"],
        ["valueLoss", "train/value_loss"],
        ["explainedVar", "train/explained_variance"],
        ["clipFrac", "train/clip_fraction"],
        ["approxKl", "train/approx_kl"],
      ];
      for (const [seriesKey, valueKey] of map) {
        const y = num(values[valueKey]);
        if (y != null) pushSeries(state.series[seriesKey], t, y);
      }
      break;
    }
    case "gpu": {
      state.gpu = {
        available: ev.available !== false,
        name: ev.name || state.gpu.name,
        util: num(ev.util),
        temp: num(ev.temp),
        memUsed: num(ev.memUsed),
        memTotal: num(ev.memTotal),
      };
      if (state.gpu.available) {
        const x = ev.ts || Date.now();
        pushSeries(state.series.gpuUtil, x, state.gpu.util);
        pushSeries(state.series.gpuTemp, x, state.gpu.temp);
      }
      break;
    }
    case "log": {
      state.logs.push({
        ts: ev.ts || Date.now(),
        level: ev.level || "info",
        text: String(ev.text || ""),
      });
      if (state.logs.length > LOG_MAX) state.logs.splice(0, state.logs.length - LOG_MAX);
      break;
    }
    default:
      break;
  }

  return state;
}

function tailStd(points, n = 8) {
  const slice = points.slice(-n);
  if (slice.length < 3) return null;
  const ys = slice.map((p) => p.y);
  const mean = ys.reduce((s, y) => s + y, 0) / ys.length;
  const variance = ys.reduce((s, y) => s + (y - mean) ** 2, 0) / ys.length;
  return { mean, std: Math.sqrt(variance), n: ys.length };
}

export function detectStuck(state) {
  const warnings = [];
  const now = Date.now();

  if (state.running && state.lastEventAt && now - state.lastEventAt > 20000) {
    const wait = Math.round((now - state.lastEventAt) / 1000);
    warnings.push({
      id: "stall",
      level: "warn",
      text: state.evaluating
        ? `Немає нових кроків ${wait}с — Ollama ймовірно тримає валідацію.`
        : `Немає подій уже ${wait}с. Навчання могло зависнути.`,
    });
  }

  const ev = tailStd(state.series.explainedVar, 6);
  if (ev && ev.mean < 0 && ev.n >= 4) {
    warnings.push({
      id: "value",
      level: "warn",
      text: "explained_variance < 0 — value-мережа поки не пояснює нагороду.",
    });
  }

  const ent = tailStd(state.series.entropy, 6);
  if (ent && Math.abs(ent.mean) < 0.01 && state.iteration >= 8) {
    warnings.push({
      id: "entropy",
      level: "warn",
      text: "Ентропія майже нульова — політика зхлопнулась, мало дослідження.",
    });
  }

  const rew = tailStd(state.series.epRew, 8);
  if (rew && rew.std < 0.02 && state.iteration >= 10) {
    warnings.push({
      id: "plateau",
      level: "info",
      text: "Середня нагорода епізоду стоїть на місці — можливе плато.",
    });
  }

  const totalActs = Object.values(state.actionCounts).reduce((s, n) => s + n, 0);
  const waits = state.actionCounts.wait || 0;
  if (totalActs >= 30 && waits / totalActs > 0.65) {
    warnings.push({
      id: "wait",
      level: "warn",
      text: `${Math.round((waits / totalActs) * 100)}% дій — wait. Симуляцію й Ollama для wait пропущено, але політика майже не будує.`,
    });
  }

  if (state.ollamaStats.errors >= 3 && state.ollamaStats.errors >= state.ollamaStats.scores * 0.4) {
    warnings.push({
      id: "ollama-err",
      level: "warn",
      text: `Ollama часто падає (${state.ollamaStats.errors} помилок) і віддає запасну оцінку 5.0.`,
    });
  }

  const oll = tailStd(state.series.ollama, 6);
  if (oll && oll.std < 0.05 && Math.abs(oll.mean - 5) < 0.15 && oll.n >= 4) {
    warnings.push({
      id: "ollama-flat",
      level: "info",
      text: "Оцінки Ollama тримаються біля 5.0 — модель, ймовірно, не дає справжнього скору.",
    });
  }

  const kl = tailStd(state.series.approxKl, 4);
  if (kl && kl.mean > 0.08) {
    warnings.push({
      id: "kl",
      level: "info",
      text: "approx_kl високий — політика стрибає занадто різко.",
    });
  }

  return warnings;
}

export function cloneTrainState(state) {
  return JSON.parse(JSON.stringify(state));
}
