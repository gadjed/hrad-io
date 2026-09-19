/**
 * Ollama decision quality evaluator (training / offline labeling).
 * Requires a running Ollama at host:port with the given model.
 */

import { layoutQuality } from "./LayoutQuality.mjs";

function baseUrl(host, port) {
  return `http://${host}:${Number(port)}`;
}

export class OllamaEvaluator {
  constructor({
    host = process.env.OLLAMA_HOST || "localhost",
    port = process.env.OLLAMA_PORT || 11434,
    model = process.env.OLLAMA_MODEL || "gemma4:e4b",
    url = null,
    cacheSize = 1000,
  } = {}) {
    this.host = host;
    this.port = Number(port);
    this.model = model;
    this.url = url || baseUrl(this.host, this.port);
    this.cache = new Map();
    this.cacheSize = cacheSize;
    this.stats = { evaluations: 0, cacheHits: 0, errors: 0 };
  }

  /** @returns {Promise<number>} score 0–10 */
  async evaluateDecision(observation, decision) {
    const result = await this.evaluateDetailed(observation, decision);
    return result.score;
  }

  /** @returns {Promise<{score:number,raw:string,ms:number,cached:boolean,error:string|null,model:string}>} */
  async evaluateDetailed(observation, decision) {
    const cacheKey = this.hashDecision(observation, decision);
    if (this.cache.has(cacheKey)) {
      this.stats.cacheHits++;
      return {
        score: this.cache.get(cacheKey),
        raw: "",
        prompt: "",
        ms: 0,
        cached: true,
        error: null,
        model: this.model,
      };
    }

    const started = Date.now();
    const prompt = this.buildPrompt(observation, decision);
    try {
      const response = await fetch(`${this.url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          think: false,
          options: { temperature: 0.3, num_predict: 16 },
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) throw new Error(`Ollama ${response.status}`);

      const data = await response.json();
      const raw = String(data.response || "").trim();
      const score = this.parseScore(raw);
      this.addToCache(cacheKey, score);
      this.stats.evaluations++;
      return {
        score,
        raw,
        prompt,
        ms: Date.now() - started,
        cached: false,
        error: null,
        model: this.model,
      };
    } catch (err) {
      this.stats.errors++;
      console.error("Ollama evaluation failed:", err.message);
      return {
        score: 5.0,
        raw: "",
        prompt,
        ms: Date.now() - started,
        cached: false,
        error: err.message || String(err),
        model: this.model,
      };
    }
  }

  buildPrompt(obs, decision) {
    const ring = obs.ring || {};
    const action = decision.action || decision;
    const lq = layoutQuality(obs);
    const buildings = (obs.buildings || [])
      .slice(0, 24)
      .map((b) => `${b.type}@${b.tx},${b.ty}L${b.level || 1}`)
      .join(", ");

    return `Score a fortress LAYOUT decision 0-10. Money is unlimited. There are no trees/ores/monsters. Judge geometry only.

RULES:
- Protection = closed wall/gate contour AND at least one tower. Open path from keep edge = 0. Walls without towers = 0. Nested contours are better.
- Keep perimeter cells are for walls/gates only. Mills/towers/harvest must sit strictly inside, not on the outer ring, and never outside the keep.
- Same-type harvest radii should not overlap (mill/quarry/goldmine).
- Do not pack the keep with walls; leave courtyard.
- One mill, one quarry, one goldmine, then towers, then a closed ring is a good opening.
- Sell-spam or wait-spam is bad. score>7 only if the layout is actually good.

STATE:
- Buildings (${(obs.buildings || []).length}): ${buildings || "core only"}
- Ring integrity: ${((ring.integrity || 0) * 100).toFixed(0)}%
- Protection P=${(lq.P || 0).toFixed(1)} overlap=${(lq.overlap || 0).toFixed(2)} clog=${(lq.clog || 0).toFixed(2)} towers=${lq.towers || 0}

DECISION:
- ${action.op || "wait"} ${action.type || ""} ${action.tx != null ? `at ${action.tx},${action.ty}` : ""}
- ${decision.rationale || ""}

Reply with one number 0-10.`;
  }

  parseScore(text) {
    const match = String(text).match(/(\d+(?:\.\d+)?)/);
    if (!match) return 5.0;
    return Math.min(Math.max(parseFloat(match[1]), 0), 10);
  }

  hashDecision(obs, decision) {
    const action = decision.action || decision;
    const lq = layoutQuality(obs);
    return JSON.stringify({
      mode: decision.mode,
      op: action.op,
      type: action.type,
      buildings: (obs.buildings || []).map((b) => `${b.type}:${b.tx},${b.ty}`).join("|"),
      p: Math.round((lq.P || 0) * 10) / 10,
      overlap: Math.round((lq.overlap || 0) * 10) / 10,
      tx: action.tx ?? null,
      ty: action.ty ?? null,
    });
  }

  addToCache(key, value) {
    if (this.cache.size >= this.cacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  getStats() {
    const total = this.stats.evaluations + this.stats.cacheHits;
    return {
      ...this.stats,
      cacheSize: this.cache.size,
      cacheHitRate: total ? `${((this.stats.cacheHits / total) * 100).toFixed(1)}%` : "0%",
      url: this.url,
      model: this.model,
    };
  }

  async checkHealth() {
    try {
      const response = await fetch(`${this.url}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return { online: false, url: this.url };
      const data = await response.json();
      const names = (data.models || []).map((m) => m.name);
      return {
        online: true,
        url: this.url,
        model: this.model,
        modelAvailable: names.some((n) => n === this.model || n.startsWith(`${this.model}:`)),
        models: names,
      };
    } catch {
      return { online: false, url: this.url };
    }
  }

  resetStats() {
    this.stats = { evaluations: 0, cacheHits: 0, errors: 0 };
  }

  clearCache() {
    this.cache.clear();
  }
}
