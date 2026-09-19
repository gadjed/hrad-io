#!/usr/bin/env python3
"""Train settlement planner PPO against a live World via Node gym worker."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import gymnasium as gym
import numpy as np
from gymnasium import spaces
from stable_baselines3.common.callbacks import BaseCallback, CheckpointCallback, EvalCallback
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv
from sb3_contrib import MaskablePPO
from sb3_contrib.common.maskable.policies import MaskableActorCriticPolicy
from sb3_contrib.common.wrappers import ActionMasker
from tqdm import tqdm

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "scripts" / "settlement-gym-worker.mjs"
OBS_DIM = 29
ACTION_COUNT = 20


class NodeGymError(RuntimeError):
    pass


class SettlementPlannerEnv(gym.Env):
    """Gymnasium env: one Node worker process, JSONL over stdin/stdout."""

    metadata = {"render_modes": []}

    def __init__(self, worker_env=None):
        super().__init__()
        self.observation_space = spaces.Box(
            low=0.0, high=1.0, shape=(OBS_DIM,), dtype=np.float32
        )
        self.action_space = spaces.Discrete(ACTION_COUNT)
        self._worker_env = worker_env or {}
        self.proc = None
        self._masks = np.ones(ACTION_COUNT, dtype=bool)
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
        mask = np.asarray(msg.get("mask") or [True] * ACTION_COUNT, dtype=bool)
        if mask.shape != (ACTION_COUNT,):
            mask = np.ones(ACTION_COUNT, dtype=bool)
        mask[0] = True
        self._masks = mask
        return vec

    def action_masks(self):
        return self._masks

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        msg = self._rpc({"cmd": "reset", "seed": seed})
        return self._obs(msg), msg.get("info") or {}

    def step(self, action):
        msg = self._rpc({"cmd": "step", "action": int(action)})
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


def dash_post(url, payload, timeout=0.4):
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
    """Push PPO rollout metrics to the training dashboard."""

    def __init__(self, url: str, total_iterations: int, total_timesteps: int):
        super().__init__(verbose=0)
        self.url = url
        self.total_iterations = max(1, int(total_iterations))
        self.total_timesteps = int(total_timesteps)
        self._iter = 0

    def _on_training_start(self):
        dash_post(
            self.url,
            {
                "type": "train_start",
                "total_timesteps": self.total_timesteps,
                "total_iterations": self.total_iterations,
            },
        )

    def _on_rollout_end(self):
        self._iter += 1
        values = {}
        if self.logger is not None:
            for key, value in self.logger.name_to_value.items():
                if isinstance(value, (int, float, np.integer, np.floating)):
                    values[key] = float(value)
        dash_post(
            self.url,
            {
                "type": "metrics",
                "iteration": self._iter,
                "total_iterations": self.total_iterations,
                "num_timesteps": int(self.num_timesteps),
                "values": values,
            },
        )

    def _on_training_end(self):
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
    parser.add_argument("--output", type=str, default="models/rl_agent")
    parser.add_argument("--ticks", type=int, default=10, help="World ticks per gym step")
    parser.add_argument("--max-steps", type=int, default=500, help="Episode length in gym steps")
    parser.add_argument("--use-ollama", action="store_true")
    parser.add_argument("--ollama-freq", type=int, default=10)
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
    return parser.parse_args(argv)


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
    ]
    dash = dash_url_from_args(args)
    if dash:
        callbacks.append(DashboardCallback(dash, total_iters, args.timesteps))
        dash_post(
            dash,
            {
                "type": "log",
                "level": "info",
                "text": f"PPO start · timesteps={args.timesteps} n_envs={args.n_envs} n_steps={args.n_steps} ollama={args.use_ollama}",
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
    )

    try:
        model.learn(total_timesteps=args.timesteps, callback=callbacks, progress_bar=False)
        model.save(str(output_dir / "final_model"))
        print(f"Training complete → {output_dir / 'final_model.zip'}")
    finally:
        env.close()
        if eval_env is not None:
            eval_env.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
