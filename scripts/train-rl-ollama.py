#!/usr/bin/env python3
"""Train settlement planner PPO against a live World via Node gym worker."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import gymnasium as gym
import numpy as np
import torch as th
from gymnasium import spaces
from stable_baselines3.common.callbacks import BaseCallback, CheckpointCallback, EvalCallback
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.torch_layers import BaseFeaturesExtractor
from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv
from sb3_contrib import MaskablePPO
from sb3_contrib.common.maskable.policies import MaskableActorCriticPolicy
from sb3_contrib.common.wrappers import ActionMasker
from torch import nn
from tqdm import tqdm

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "scripts" / "settlement-gym-worker.mjs"
OBS_DIM = 29
ACTION_COUNT = 20
KEEP_N = 18
GRID_CH = 6
CELL_COUNT = KEEP_N * KEEP_N


class KeepGridExtractor(BaseFeaturesExtractor):
    """CNN over L1 keep grid + MLP over compact vec → shared features for two action heads."""

    def __init__(self, observation_space: spaces.Dict, features_dim: int = 160):
        super().__init__(observation_space, features_dim)
        n_ch = int(observation_space.spaces["grid"].shape[0])
        vec_dim = int(observation_space.spaces["vec"].shape[0])
        self.cnn = nn.Sequential(
            nn.Conv2d(n_ch, 32, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.Conv2d(32, 64, kernel_size=3, stride=2, padding=1),
            nn.ReLU(),
            nn.Flatten(),
        )
        n_cnn = 64 * 9 * 9
        self.mlp = nn.Sequential(
            nn.Linear(n_cnn + vec_dim, features_dim),
            nn.ReLU(),
        )

    def forward(self, observations):
        grid = observations["grid"]
        vec = observations["vec"]
        return self.mlp(th.cat([self.cnn(grid), vec], dim=1))


class NodeGymError(RuntimeError):
    pass


class SettlementPlannerEnv(gym.Env):
    """Gymnasium env: one Node worker process, JSONL over stdin/stdout."""

    metadata = {"render_modes": []}

    def __init__(self, worker_env=None):
        super().__init__()
        self.observation_space = spaces.Dict(
            {
                "vec": spaces.Box(low=0.0, high=1.0, shape=(OBS_DIM,), dtype=np.float32),
                "grid": spaces.Box(low=0.0, high=1.0, shape=(GRID_CH, KEEP_N, KEEP_N), dtype=np.float32),
            }
        )
        self.action_space = spaces.MultiDiscrete([ACTION_COUNT, CELL_COUNT])
        self._worker_env = worker_env or {}
        self.proc = None
        self._masks = np.ones(ACTION_COUNT + CELL_COUNT, dtype=bool)
        self._start_worker()

    def _start_worker(self):
        env = os.environ.copy()
        env.update({k: str(v) for k, v in self._worker_env.items() if v is not None})
        stderr = None if env.get("TRAIN_DASH_URL") else subprocess.DEVNULL
        self.proc = subprocess.Popen(
            ["node", str(WORKER)],
            cwd=str(ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
            bufsize=1,
            env=env,
        )

    def _rpc(self, payload, timeout=120):
        if self.proc is None or self.proc.poll() is not None:
            raise NodeGymError(f"gym worker exited ({None if self.proc is None else self.proc.returncode})")
        line = json.dumps(payload, separators=(",", ":"))
        try:
            self.proc.stdin.write(line + "\n")
            self.proc.stdin.flush()
        except BrokenPipeError as exc:
            raise NodeGymError("gym worker stdin closed") from exc
        raw = self.proc.stdout.readline()
        if not raw:
            raise NodeGymError("gym worker closed stdout")
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise NodeGymError(f"bad worker json: {raw[:200]!r}") from exc
        if not msg.get("ok"):
            raise NodeGymError(msg.get("error") or "worker error")
        return msg

    def _obs(self, msg):
        vec = np.asarray(msg["obs"], dtype=np.float32)
        if vec.shape != (OBS_DIM,):
            raise NodeGymError(f"obs shape {vec.shape} != ({OBS_DIM},)")
        grid = np.asarray(msg.get("grid") or np.zeros(GRID_CH * KEEP_N * KEEP_N), dtype=np.float32)
        if grid.size != GRID_CH * KEEP_N * KEEP_N:
            raise NodeGymError(f"grid size {grid.size} != {GRID_CH * KEEP_N * KEEP_N}")
        grid = grid.reshape(GRID_CH, KEEP_N, KEEP_N)
        intent = np.asarray(msg.get("mask") or [True] * ACTION_COUNT, dtype=bool)
        if intent.shape != (ACTION_COUNT,):
            intent = np.ones(ACTION_COUNT, dtype=bool)
        if not intent.any():
            intent[0] = True
        cells = np.asarray(msg.get("cellMask") or [True] * CELL_COUNT, dtype=bool)
        if cells.shape != (CELL_COUNT,):
            cells = np.ones(CELL_COUNT, dtype=bool)
        if not cells.any():
            cells[0] = True
        self._masks = np.concatenate([intent, cells])
        return {"vec": vec, "grid": grid}

    def action_masks(self):
        return self._masks

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        msg = self._rpc({"cmd": "reset", "seed": seed})
        return self._obs(msg), msg.get("info") or {}

    def step(self, action):
        arr = np.asarray(action).reshape(-1)
        intent = int(arr[0])
        cell = int(arr[1]) if arr.size > 1 else 0
        msg = self._rpc({"cmd": "step", "action": intent, "cell": cell})
        obs = self._obs(msg)
        reward = float(msg.get("reward") or 0.0)
        terminated = bool(msg.get("done"))
        truncated = bool(msg.get("truncated"))
        return obs, reward, terminated, truncated, msg.get("info") or {}

    def close(self):
        if self.proc is None:
            return
        try:
            if self.proc.poll() is None:
                self.proc.stdin.write(json.dumps({"cmd": "close"}) + "\n")
                self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.proc = None


class IterationProgressBar(BaseCallback):
    """Single tqdm bar: completed PPO rollouts / planned iterations."""

    def __init__(self, total_iterations: int):
        super().__init__(verbose=0)
        self.total_iterations = max(1, int(total_iterations))
        self._pbar = None

    def _on_training_start(self):
        self._pbar = tqdm(
            total=self.total_iterations,
            desc="iterations",
            unit="it",
            dynamic_ncols=True,
            file=sys.stdout,
            mininterval=0.2,
            bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}]",
        )

    def _on_rollout_end(self):
        if self._pbar is None or self._pbar.n >= self.total_iterations:
            return
        self._pbar.update(1)

    def _on_training_end(self):
        if self._pbar is not None:
            self._pbar.close()
            self._pbar = None

    def _on_step(self):
        return True


def dash_url_from_args(args):
    return (args.dash or os.environ.get("TRAIN_DASH_URL") or "").rstrip("/")


def dash_post(url, payload, timeout=2.0):
    if not url:
        return
    try:
        data = json.dumps(payload, default=_json_default, separators=(",", ":")).encode()
        req = urllib.request.Request(
            f"{url}/api/events",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=timeout).read()
    except (urllib.error.URLError, TimeoutError, OSError):
        pass


def _json_default(value):
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    return str(value)


class DashboardCallback(BaseCallback):
    """Push PPO metrics after train(); rollout_end is before dump_logs/train()."""

    def __init__(self, url: str, total_iterations: int, total_timesteps: int):
        super().__init__(verbose=0)
        self.url = url
        self.total_iterations = max(1, int(total_iterations))
        self.total_timesteps = int(total_timesteps)
        self._iter = 0
        self._need_post = False

    def _on_training_start(self):
        dash_post(
            self.url,
            {
                "type": "train_start",
                "total_timesteps": self.total_timesteps,
                "total_iterations": self.total_iterations,
                "n_steps": int(getattr(self.model, "n_steps", 256) or 256),
            },
        )

    def _on_rollout_end(self):
        self._iter += 1
        self._need_post = True

    def _on_rollout_start(self):
        if self._need_post:
            self._post_metrics()
            self._need_post = False

    def _logger_values(self):
        values = {}
        if self.logger is not None:
            for key, value in self.logger.name_to_value.items():
                if isinstance(value, (int, float, np.integer, np.floating)):
                    values[key] = float(value)
        buf = getattr(self.model, "ep_info_buffer", None) or []
        rewards = [float(ep["r"]) for ep in buf if ep and "r" in ep]
        lengths = [float(ep["l"]) for ep in buf if ep and "l" in ep]
        if rewards:
            values["rollout/ep_rew_mean"] = sum(rewards) / len(rewards)
        if lengths:
            values["rollout/ep_len_mean"] = sum(lengths) / len(lengths)
        return values

    def _post_metrics(self):
        dash_post(
            self.url,
            {
                "type": "metrics",
                "iteration": self._iter,
                "total_iterations": self.total_iterations,
                "num_timesteps": int(self.num_timesteps),
                "values": self._logger_values(),
            },
        )

    def _on_training_end(self):
        if self._need_post:
            self._post_metrics()
            self._need_post = False
        dash_post(
            self.url,
            {
                "type": "train_end",
                "num_timesteps": int(self.num_timesteps),
                "iteration": self._iter,
            },
        )

    def _on_step(self):
        return True


def mask_fn(env):
    return env.unwrapped.action_masks()


def make_env(rank, args, seed=0):
    def _init():
        env = SettlementPlannerEnv(worker_env=worker_env_from_args(args, rank))
        env = Monitor(env)
        env = ActionMasker(env, mask_fn)
        return env

    return _init


def worker_env_from_args(args, rank=0):
    env = {
        "SETTLEMENT_GYM_TICKS": args.ticks,
        "SETTLEMENT_GYM_MAX_STEPS": args.max_steps,
        "SETTLEMENT_GYM_USE_OLLAMA": "1" if args.use_ollama else "0",
        "SETTLEMENT_GYM_OLLAMA_FREQ": args.ollama_freq,
        "SETTLEMENT_GYM_ENV_ID": rank,
        "SETTLEMENT_GYM_DESIGN": "0" if args.no_design else "1",
        "SETTLEMENT_GYM_INFINITE_TREASURY": "0" if args.no_infinite else "1",
        "SETTLEMENT_GYM_SEED": args.seed or "",
        "OLLAMA_HOST": args.ollama_host,
        "OLLAMA_PORT": args.ollama_port,
        "OLLAMA_MODEL": args.ollama_model,
    }
    dash = dash_url_from_args(args)
    if dash:
        env["TRAIN_DASH_URL"] = dash
    return env


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Train settlement planner PPO on live World")
    parser.add_argument("--timesteps", type=int, default=1_000_000)
    parser.add_argument("--n-envs", type=int, default=1)
    parser.add_argument("--n-steps", type=int, default=256, help="PPO rollout length per env")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--output", type=str, default="models/rl_agent/L1")
    parser.add_argument("--ticks", type=int, default=10, help="World ticks per gym step")
    parser.add_argument("--max-steps", type=int, default=500, help="Episode length in gym steps")
    parser.add_argument("--use-ollama", action="store_true")
    parser.add_argument("--ollama-freq", type=int, default=1, help="Ollama every N executed non-wait decisions (1 = every decision)")
    parser.add_argument("--ollama-host", type=str, default=os.environ.get("OLLAMA_HOST", "localhost"))
    parser.add_argument("--ollama-port", type=int, default=int(os.environ.get("OLLAMA_PORT", "11434")))
    parser.add_argument(
        "--ollama-model",
        type=str,
        default=os.environ.get("OLLAMA_MODEL", "gemma4:e4b"),
        help="Completion model (not embedding-only)",
    )
    parser.add_argument("--no-eval", action="store_true", help="Skip EvalCallback (faster start)")
    parser.add_argument("--eval-freq", type=int, default=10_000)
    parser.add_argument(
        "--dash",
        nargs="?",
        const="http://127.0.0.1:8787",
        default=None,
        help="POST live events to training dashboard (default URL if flag has no value)",
    )
    parser.add_argument(
        "--resume",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Load latest.zip / newest checkpoint (default). --no-resume starts from scratch",
    )
    parser.add_argument(
        "--seed",
        type=str,
        default=os.environ.get("SETTLEMENT_GYM_SEED", "none"),
        help="Sandbox prototype to stamp as interior seed. none = core only (compact curriculum)",
    )
    parser.add_argument("--no-design", action="store_true", help="Old env: stamped prototypes + nodes")
    parser.add_argument("--no-infinite", action="store_true", help="Charge building costs in gym")
    return parser.parse_args(argv)


def find_resume_path(output_dir: Path):
    latest = output_dir / "latest.zip"
    if latest.is_file():
        return latest
    ckpt_dir = output_dir / "checkpoints"
    if not ckpt_dir.is_dir():
        return None
    zips = list(ckpt_dir.glob("*.zip"))
    if not zips:
        return None

    def step_of(path: Path):
        match = re.search(r"(\d+)_steps", path.name)
        return int(match.group(1)) if match else path.stat().st_mtime

    zips.sort(key=step_of)
    return zips[-1]


class LatestSaveCallback(BaseCallback):
    def __init__(self, path: Path):
        super().__init__(verbose=0)
        self.path = path

    def _on_rollout_end(self):
        try:
            self.model.save(str(self.path))
        except Exception as err:
            print(f"latest save failed: {err}", file=sys.stderr)

    def _on_step(self):
        return True


def main(argv=None):
    args = parse_args(argv)
    if not WORKER.is_file():
        raise SystemExit(f"missing worker: {WORKER}")

    output_dir = Path(args.output)
    if not output_dir.is_absolute():
        output_dir = ROOT / output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    steps_per_iter = max(1, args.n_steps * args.n_envs)
    total_iters = (args.timesteps + steps_per_iter - 1) // steps_per_iter

    env_fns = [make_env(i, args) for i in range(args.n_envs)]
    env = SubprocVecEnv(env_fns) if args.n_envs > 1 else DummyVecEnv(env_fns)

    callbacks = [
        IterationProgressBar(total_iters),
        CheckpointCallback(
            save_freq=max(1, 10_000 // args.n_envs),
            save_path=str(output_dir / "checkpoints"),
            name_prefix="rl_agent",
            verbose=0,
        ),
        LatestSaveCallback(output_dir / "latest"),
    ]
    dash = dash_url_from_args(args)
    if dash:
        callbacks.append(DashboardCallback(dash, total_iters, args.timesteps))
        dash_post(
            dash,
            {
                "type": "log",
                "level": "info",
                "text": f"PPO start · timesteps={args.timesteps} n_envs={args.n_envs} n_steps={args.n_steps} ollama={args.use_ollama} design={not args.no_design} resume={args.resume}",
            },
        )
    eval_env = None
    if not args.no_eval:
        eval_env = DummyVecEnv([make_env(10_000 + args.n_envs, args)])
        callbacks.append(
            EvalCallback(
                eval_env,
                best_model_save_path=str(output_dir),
                log_path=str(output_dir / "eval_logs"),
                eval_freq=max(1, args.eval_freq // args.n_envs),
                n_eval_episodes=3,
                deterministic=True,
                verbose=0,
            )
        )

    resume_path = find_resume_path(output_dir) if args.resume else None
    if args.resume and resume_path is None:
        print("No checkpoint to resume; starting fresh", file=sys.stderr)

    policy_kwargs = dict(
        features_extractor_class=KeepGridExtractor,
        features_extractor_kwargs=dict(features_dim=160),
        net_arch=dict(pi=[128, 128], vf=[128, 128]),
    )

    model = None
    if resume_path is not None:
        try:
            model = MaskablePPO.load(str(resume_path), env=env)
            print(f"Resumed {resume_path}")
            if dash:
                dash_post(dash, {"type": "log", "level": "info", "text": f"resumed {resume_path}"})
        except Exception as err:
            print(f"Resume failed ({err}); starting fresh", file=sys.stderr)
            if dash:
                dash_post(dash, {"type": "log", "level": "warn", "text": f"resume failed: {err}"})
            resume_path = None

    if model is None:
        model = MaskablePPO(
            MaskableActorCriticPolicy,
            env,
            learning_rate=args.learning_rate,
            n_steps=args.n_steps,
            batch_size=min(args.batch_size, args.n_steps * args.n_envs),
            n_epochs=10,
            gamma=0.99,
            gae_lambda=0.95,
            clip_range=0.2,
            ent_coef=0.01,
            verbose=0,
            tensorboard_log=str(output_dir / "tensorboard"),
            policy_kwargs=policy_kwargs,
        )

    try:
        model.learn(
            total_timesteps=args.timesteps,
            callback=callbacks,
            progress_bar=False,
            reset_num_timesteps=resume_path is None,
        )
        model.save(str(output_dir / "final_model"))
        model.save(str(output_dir / "latest"))
        print(f"Training complete → {output_dir / 'final_model.zip'}")
    except KeyboardInterrupt:
        model.save(str(output_dir / "latest"))
        print(f"Interrupted · saved {output_dir / 'latest.zip'}")
        raise
    finally:
        env.close()
        if eval_env is not None:
            eval_env.close()


if __name__ == "__main__":
    def _on_stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _on_stop)
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
