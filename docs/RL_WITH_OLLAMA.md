# Settlement Planner — RL + Ollama

Маленька RL-мережа (PPO) приймає **одне з 20 високорівневих рішень**; Node parameterizer перетворює його на `place/upgrade/sell/repair/wait` з координатами. Ollama оцінює якість під час training і змішує score у reward.

Симуляція — той самий `World.mjs`, що й у грі. Python **не** імпортує світ: кожен Gym env тримає дочірній `node scripts/settlement-gym-worker.mjs`.

## Scope цього зрізу

**Є:** `reset` / `step` на живому NPC-форті → PPO збирає rollouts і вчиться.

**Немає (наступний зріз):** `server/RLAgent.mjs`, ONNX у `NpcBrain`, `RL_AGENT_ENABLED=true npm start`.

## Конфіг Ollama (опційно)

Training стартує без Ollama. Якщо `--use-ollama`:

```bash
OLLAMA_HOST=localhost
OLLAMA_PORT=11434
OLLAMA_MODEL=gemma4:e4b   # або R4C3R/qwen3-8b-heretic:q4_k_m
```

API: `http://{OLLAMA_HOST}:{OLLAMA_PORT}/api/generate`.

### embedding ≠ scoring

| Модель | Capability | Для чого |
|--------|------------|----------|
| `gemma4:e4b` | completion | оцінка рішень 0–10 |
| `R4C3R/qwen3-8b-heretic:q4_k_m` | completion | те саме |
| `qwen3-embedding:0.6b` | **embedding only** | `/api/embed`; **не** `/api/generate` |

## Архітектура training

```
Python MaskablePPO
  ↕ JSONL stdin/stdout (один рядок = один запит)
Node settlement-gym-worker
  World.generate() → stamp NPC keeps
  lock NpcBrain on all factions (агент — єдиний будівельник)
  pick one npc_* with a core

Observation JSON (SettlementSnapshot)
  → encode → float32[29]
  → action mask bool[20]
  → PPO → action index 0..19
  → parameterizer (NpcBrain survey + findHarvestSite / wallRing)
  → execute on World (skipRange place, upgrade/repair, faction sell)
  → world.step() × ticks_per_action
  → Reward = 0.7·ΔU + 0.3·Ollama(score)   # Ollama лише якщо увімкнено, раз на N кроків
```

Invalid / нема сайту → no-op + маска вимикає дію на наступному кроці. HARD-порушення не виконуються.

### JSONL протокол (stdout = лише JSON)

```json
{"cmd":"reset","seed":1}
{"ok":true,"obs":[...29],"mask":[...20],"info":{"settlement_id":"npc_0","utility":...}}

{"cmd":"step","action":4}
{"ok":true,"obs":[...],"mask":[...],"reward":0.12,"done":false,"truncated":false,"info":{}}

{"cmd":"close"}
{"ok":true}
```

Логи воркера — лише **stderr**.

## Feature vector (29)

Порядок фіксований у `encodeObservation` (`server/SettlementPlanner.mjs`):

| Слот | Dims | Зміст (нормалізовано 0..1) |
|------|------|----------------------------|
| Treasury | 3 | wood/100, stone/100, gold/50 |
| Core | 2 | hp/max_hp, level/5 (0 якщо нема core) |
| Threat | 2 | threat, enemies_nearby |
| Nearby nodes | 3 | wood/20, stone/20, gold/10 |
| Building counts | 9 | mill, quarry, goldmine, tower_arrow, tower_cannon, wall_wood, wall_stone, gate, spikes |
| Coverage | 3 | mill/quarry/goldmine coverage (сер. по будівлях типу, /8) |
| Ring | 3 | integrity, holes/10, can_expand |
| Derived | 4 | gold buffer vs respawn cost, keep fill, mean hp ratio, waste (harvest coverage=0) |

## Action space (20)

Політика **не** виводить `tx/ty`. Індекс → intent; parameterizer заповнює decision schema.

| i | Intent | Parameterizer |
|---|--------|----------------|
| 0 | `wait` | no-op |
| 1 | place mill | `findHarvestSite(mill)` |
| 2 | place quarry | `findHarvestSite(quarry)` |
| 3 | place goldmine | `findHarvestSite(goldmine)` |
| 4 | place wall_stone | перша дірка кільця, тип stone якщо affordable інакше wood |
| 5 | place gate | осьова клітинка кільця / дірка з `gate` |
| 6 | place tower_arrow | `weakestCorner` |
| 7 | place tower_cannon | `weakestCorner` |
| 8 | place spikes | `spikeSpot` біля брами без spikes |
| 9 | upgrade core | core id |
| 10 | upgrade harvest | harvest з coverage>0, найнижчий level |
| 11 | upgrade tower | найнижчий level серед веж |
| 12 | repair core | якщо hp < max |
| 13 | repair damaged | найнижчий hp ratio |
| 14 | sell worst_harvest | harvest з coverage=0, інакше найменший coverage |
| 15 | sell worst_wall | wall_wood (не єдиний периметр, якщо можна) |
| 16 | sell redundant | spikes не біля брами, інакше зайва arrow |
| 17 | place core | лише якщо core=null і є місце |
| 18 | expand_ring | перша клітинка `ring.next` |
| 19 | fortify_ring | як fortify: дірка → spikes → wood→stone |

Маска: дія легальна, якщо parameterizer знаходить валідний job **і** treasury тягне HARD-кошти.

## Utility / reward

Формула з system prompt (дефолтні ваги):

```
U = 1.0·E + 0.85·D + 1.2·S + 0.4·F − 0.9·W
```

Реалізація (скаляр для ΔU, не LLM):

- **E** — gold×3 + stone×1.5 + wood + 8·(cov_wood+cov_stone+1.4·cov_gold)
- **D** — 40·integrity + 8·towers + 4·spikes + 6·gates
- **S** — 50·core_hp_ratio + 12·min(gold/5, 1) + 20·mean_wall_hp
- **F** — 30·min(building_tiles / keep_tiles, 1)
- **W** — 15·count(harvest coverage=0) + 8·(integrity<0.5)

`reward_game = clip((U' − U) / 80, -1, 1)` плюс −0.02 за no-op коли маска мала інші дії.

Ollama (якщо увімкнено, кожні `--ollama-freq` кроків): `reward_ollama = (score − 5) / 5`, суміш `0.7·game + 0.3·ollama`.

Episode: `done` якщо зник core; `truncated` після `max_steps` (дефолт 500 gym-кроків). Кожен gym-крок = `--ticks` тіків World (дефолт 10 ≈ 0.5 с).

Інші NPC-форти залишаються як stamped prototypes; їхній `NpcBrain` заблокований (`plannerLocked`), щоб не конкурувати з агентом за MDP.

## Workflow

```bash
pip install -r requirements-rl.txt

# старт training (без Ollama)
python scripts/train-rl-ollama.py --n-envs 1 --timesteps 1000000

# швидший smoke (має одразу показати rollout)
python scripts/train-rl-ollama.py --n-envs 1 --timesteps 2048 --n-steps 128 --no-eval

# з Ollama
python scripts/train-rl-ollama.py \
  --n-envs 1 \
  --use-ollama \
  --ollama-freq 10 \
  --ollama-host localhost \
  --ollama-port 11434 \
  --ollama-model gemma4:e4b

# датасет expert labels (окремо від PPO)
npm run planner:snapshots
npm run planner:validate

# після training
python scripts/export-to-onnx.py \
  --model models/rl_agent/final_model.zip \
  --output models/rl_agent/policy.onnx
```

`--n-envs > 1` піднімає окремий Node worker на кожен SubprocVecEnv процес. Починати з 1.

## Файли

| Шлях | Роль |
|------|------|
| `docs/settlement-planner-system-prompt.md` | Правила / utility / JSON I/O |
| `docs/schemas/*.schema.json` | Валідація observation/decision |
| `server/SettlementSnapshot.mjs` | Builder observation |
| `server/SettlementPlanner.mjs` | Encode, mask, parameterize, execute, U |
| `server/OllamaEvaluator.mjs` | Ollama HTTP client |
| `scripts/settlement-gym-worker.mjs` | Headless env |
| `scripts/export-settlement-snapshots.mjs` | JSONL export |
| `scripts/validate-settlement-planner.mjs` | Schema-ish check |
| `scripts/train-rl-ollama.py` | MaskablePPO |
| `scripts/export-to-onnx.py` | ONNX (після моделі) |
| `requirements-rl.txt` | Python deps |

## Далі (не цей зріз)

1. `server/RLAgent.mjs` — ONNX inference тих самих 29 dims / 20 actions
2. Підміна `NpcBrain.queueJob` коли `RL_AGENT_ENABLED=true`
3. `RL_AGENT_MODEL_PATH=models/rl_agent/policy.onnx`
