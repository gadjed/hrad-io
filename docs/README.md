# Settlement Planner

RL-агент (PPO) планує розвиток **NPC-фортів**. Ollama оцінює якість рішень лише під час training і змішується в reward. У грі inference — ONNX, без Ollama (наступний зріз, після першої моделі).

## Рішення (зафіксовано)

| Питання | Відповідь |
|---------|-----------|
| Хто агент | Лише NPC-поселення (`f.npc`), одне на episode |
| Action space | 20 дискретних високорівневих дій |
| Координати | `tx/ty/rot` / `building_id` добиває parameterizer (`NpcBrain` + `findHarvestSite` / `wallRing`) |
| Симуляція | Живий `World.mjs` у Node gym-worker |
| Python | PPO (`sb3-contrib.MaskablePPO`) спілкується з worker JSONL stdin/stdout |
| Ollama | Опційно (`--use-ollama`); training стартує і без неї |
| У грі | `RL_AGENT_ENABLED` / ONNX — **не** в цьому зрізі |

Повний контракт observation/decision JSON: [settlement-planner-system-prompt.md](settlement-planner-system-prompt.md) + [schemas/](schemas/).

## Документація

| Файл | Призначення |
|------|-------------|
| [RL_WITH_OLLAMA.md](RL_WITH_OLLAMA.md) | Gym worker, PPO, Ollama, команди |
| [settlement-planner-system-prompt.md](settlement-planner-system-prompt.md) | Правила світу, modes, utility, I/O |
| [schemas/](schemas/) | JSON Schema observation / decision |

## Швидкий старт (training)

Ollama **не** обов’язкова для старту PPO. Якщо є — completion-модель (`OLLAMA_MODEL`), не embedding.

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements-rl.txt

# Тренування на живому World (1 env → одразу збір rollouts)
python scripts/train-rl-ollama.py --n-envs 1 --timesteps 1000000 --no-eval
# або: npm run planner:train

# Те саме + Ollama scoring
python scripts/train-rl-ollama.py --n-envs 1 --use-ollama --ollama-model gemma4:e4b
```

Очікуваний старт: процес Node gym-worker, потім рядок `Starting training` і збір `rollout/` у Stable-Baselines3.

Додатково (датасет / валідація схем, не потрібні для PPO):

```bash
npm run planner:snapshots
npm run planner:validate
```

## Код

| Шлях | Роль |
|------|------|
| `server/SettlementSnapshot.mjs` | Observation з World |
| `server/SettlementPlanner.mjs` | 20 дій, parameterizer, utility, encode, execute |
| `server/OllamaEvaluator.mjs` | Оцінка decision через Ollama API |
| `scripts/settlement-gym-worker.mjs` | Headless World, JSONL протокол для Gym |
| `scripts/export-settlement-snapshots.mjs` | JSONL датасет (expert labels) |
| `scripts/validate-settlement-planner.mjs` | Валідація JSONL |
| `scripts/train-rl-ollama.py` | MaskablePPO + Node worker |
| `scripts/export-to-onnx.py` | Експорт моделі (після training) |

## Конфіг

Див. `.env.example`.

```bash
OLLAMA_HOST=localhost
OLLAMA_PORT=11434
OLLAMA_MODEL=gemma4:e4b          # completion: оцінка рішень (/api/generate)
# OLLAMA_EMBED_MODEL=qwen3-embedding:0.6b  # лише embeddings, не для scoring
```

`qwen3-embedding:0.6b` **не** підходить для scoring (`does not support generate`).
