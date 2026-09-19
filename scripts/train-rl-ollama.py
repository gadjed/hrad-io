#!/usr/bin/env python3
"""Train settlement planner PPO against a live World via Node gym worker."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import gymnasium as gym
import numpy as np
from gymnasium import spaces
from stable_baselines3.common.callbacks import CheckpointCallback, EvalCallback
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv
from sb3_contrib import MaskablePPO
from sb3_contrib.common.maskable.policies import MaskableActorCriticPolicy
from sb3_contrib.common.wrappers import ActionMasker

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
        self.proc = subprocess.Popen(
            ["node", str(WORKER)],
            cwd=str(ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
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


def mask_fn(env):
    return env.unwrapped.action_masks()


def make_env(rank, args, seed=0):
    def _init():
        env = SettlementPlannerEnv(worker_env=worker_env_from_args(args))
        env = Monitor(env)
        env = ActionMasker(env, mask_fn)
        return env

    return _init


def worker_env_from_args(args):
    return {
        "SETTLEMENT_GYM_TICKS": args.ticks,
        "SETTLEMENT_GYM_MAX_STEPS": args.max_steps,
        "SETTLEMENT_GYM_USE_OLLAMA": "1" if args.use_ollama else "0",
        "SETTLEMENT_GYM_OLLAMA_FREQ": args.ollama_freq,
        "OLLAMA_HOST": args.ollama_host,
        "OLLAMA_PORT": args.ollama_port,
        "OLLAMA_MODEL": args.ollama_model,
    }


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
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not WORKER.is_file():
        raise SystemExit(f"missing worker: {WORKER}")

    output_dir = Path(args.output)
    if not output_dir.is_absolute():
        output_dir = ROOT / output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    print("Training settlement planner PPO")
    print(f"  timesteps={args.timesteps:,}  n_envs={args.n_envs}  n_steps={args.n_steps}")
    print(f"  worker={WORKER}")
    print(f"  ollama={'on' if args.use_ollama else 'off'}")
    if args.use_ollama:
        print(f"  ollama=http://{args.ollama_host}:{args.ollama_port} model={args.ollama_model}")

    env_fns = [make_env(i, args) for i in range(args.n_envs)]
    env = SubprocVecEnv(env_fns) if args.n_envs > 1 else DummyVecEnv(env_fns)

    callbacks = [
        CheckpointCallback(
            save_freq=max(1, 10_000 // args.n_envs),
            save_path=str(output_dir / "checkpoints"),
            name_prefix="rl_agent",
        )
    ]
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
        verbose=1,
        tensorboard_log=str(output_dir / "tensorboard"),
    )

    print("Starting training...")
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
