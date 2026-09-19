/**
 * Ollama decision quality evaluator (training / offline labeling).
 * Requires a running Ollama at host:port with the given model.
 */

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
    const cacheKey = this.hashDecision(observation, decision);
    if (this.cache.has(cacheKey)) {
      this.stats.cacheHits++;
      return this.cache.get(cacheKey);
    }

    try {
      const response = await fetch(`${this.url}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: this.buildPrompt(observation, decision),
          stream: false,
          options: { temperature: 0.3, num_predict: 50 },
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) throw new Error(`Ollama ${response.status}`);

      const data = await response.json();
      const score = this.parseScore(data.response);
      this.addToCache(cacheKey, score);
      this.stats.evaluations++;
      return score;
    } catch (err) {
      this.stats.errors++;
      console.error("Ollama evaluation failed:", err.message);
      return 5.0;
    }
  }

  buildPrompt(obs, decision) {
    const t = obs.treasury || {};
    const ring = obs.ring || {};
    const nodes = obs.nearby_nodes || {};
    const action = decision.action || decision;

    return `Evaluate settlement development decision (score 0-10):

STATE:
- Resources: Wood=${t.wood || 0} Stone=${t.stone || 0} Gold=${t.gold || 0}
- Threat: ${((obs.threat || 0) * 100).toFixed(0)}%
- Buildings: ${(obs.buildings || []).length}
- Ring integrity: ${((ring.integrity || 0) * 100).toFixed(0)}%
- Nearby: Wood=${nodes.wood || 0} Stone=${nodes.stone || 0} Gold=${nodes.gold || 0}

DECISION:
- Mode: ${decision.mode || "n/a"}
- Action: ${action.op || "wait"} ${action.type || ""}
- Reasoning: ${decision.rationale || "N/A"}

Rate 0-10 (resource efficiency + defense + strategy + long-term):`;
  }

  parseScore(text) {
    const match = String(text).match(/(\d+(?:\.\d+)?)/);
    if (!match) return 5.0;
    return Math.min(Math.max(parseFloat(match[1]), 0), 10);
  }

  hashDecision(obs, decision) {
    const action = decision.action || decision;
    return JSON.stringify({
      mode: decision.mode,
      op: action.op,
      type: action.type,
      threat: Math.floor((obs.threat || 0) * 4) / 4,
      buildings: (obs.buildings || []).length,
      gold: Math.floor((obs.treasury?.gold || 0) / 5) * 5,
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
