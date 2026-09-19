#!/usr/bin/env python3
"""
Train RL agent with Ollama quality feedback.

Usage:
    python scripts/train-rl-ollama.py --timesteps 1000000 --use-ollama
"""

import argparse
import numpy as np
import gymnasium as gym
from gymnasium import spaces
from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import SubprocVecEnv, DummyVecEnv
from stable_baselines3.common.callbacks import CheckpointCallback, EvalCallback
from stable_baselines3.common.monitor import Monitor
import requests
import json
from pathlib import Path
from collections import deque

# TODO: Import your World class
# from server.World import World
# from server.SettlementSnapshot import settlementPlannerObservation


class OllamaEvaluator:
    """Evaluate decisions via running Ollama (host/port/model)."""

    def __init__(self, host='localhost', port=11434, model='gemma4:e4b'):
        self.host = host
        self.port = int(port)
        self.model = model
        self.url = f'http://{self.host}:{self.port}'
        self.cache = {}
        self.eval_count = 0

    def evaluate(self, observation, decision):
        """Return quality score 0-10."""
        cache_key = self._hash_decision(observation, decision)

        if cache_key in self.cache:
            return self.cache[cache_key]

        prompt = self._build_prompt(observation, decision)

        try:
            response = requests.post(
                f'{self.url}/api/generate',
                json={
                    'model': self.model,
                    'prompt': prompt,
                    'stream': False,
                    'options': {'temperature': 0.3, 'num_predict': 50}
                },
                timeout=5
            )
            response.raise_for_status()

            score = self._parse_score(response.json()['response'])
            self.cache[cache_key] = score
            self.eval_count += 1

            return score

        except Exception as e:
            print(f"Ollama evaluation failed ({self.url}, model={self.model}): {e}")
            return 5.0  # neutral score
    
    def _build_prompt(self, obs, decision):
        return f"""Rate settlement decision 0-10:

STATE: Wood={obs.get('treasury',{}).get('wood',0)} Stone={obs.get('treasury',{}).get('stone',0)} Gold={obs.get('treasury',{}).get('gold',0)}
Threat={obs.get('threat',0):.2f} Buildings={len(obs.get('buildings',[]))}

DECISION: {decision.get('op','wait')} {decision.get('type','')}

Score:"""
    
    def _parse_score(self, text):
        import re
        match = re.search(r'(\d+(?:\.\d+)?)', text)
        if match:
            return min(max(float(match.group(1)), 0), 10)
        return 5.0
    
    def _hash_decision(self, obs, decision):
        return json.dumps({
            'op': decision.get('op'),
            'type': decision.get('type'),
            'threat': round(obs.get('threat', 0), 1),
            'buildings': len(obs.get('buildings', []))
        }, sort_keys=True)


class SettlementPlannerEnv(gym.Env):
    """Gym environment for Settlement Planner."""

    def __init__(
        self,
        max_steps=500,
        use_ollama=False,
        ollama_freq=10,
        ollama_host='localhost',
        ollama_port=11434,
        ollama_model='gemma4:e4b',
    ):
        super().__init__()

        self.max_steps = max_steps
        self.current_step = 0
        self.use_ollama = use_ollama
        self.ollama_freq = ollama_freq

        if use_ollama:
            self.ollama = OllamaEvaluator(
                host=ollama_host,
                port=ollama_port,
                model=ollama_model,
            )
        
        # State: 29 features
        self.observation_space = spaces.Box(
            low=0.0, high=1.0,
            shape=(29,),
            dtype=np.float32
        )
        
        # Actions: 20 discrete
        self.action_space = spaces.Discrete(20)
        
        # TODO: Initialize World
        self.world = None
        self.settlement_id = "npc_0"
        
        self.previous_utility = 0
        self.episode_rewards = deque(maxlen=100)
    
    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        
        # TODO: Reset World
        # self.world = World(...)
        # self.world.generate()
        
        self.current_step = 0
        self.previous_utility = self._calculate_utility()
        
        observation = self._get_observation()
        info = {}
        
        return observation, info
    
    def step(self, action):
        # Execute action
        decision = self._action_to_decision(action)
        self._execute_decision(decision)
        
        # Step game world (e.g., 10 ticks)
        # TODO: for _ in range(10): self.world.step()
        
        self.current_step += 1
        
        # Calculate reward
        reward = self._calculate_reward(decision)
        
        # Check terminal
        done = self._is_terminal()
        truncated = self.current_step >= self.max_steps
        
        observation = self._get_observation()
        info = {'episode_step': self.current_step}
        
        return observation, reward, done, truncated, info
    
    def _get_observation(self):
        """Get current state as feature vector."""
        # TODO: Get actual observation
        obs = {
            'treasury': {'wood': 50, 'stone': 20, 'gold': 5},
            'core': {'hp': 800, 'max_hp': 800, 'level': 1},
            'threat': 0.1,
            'nearby_nodes': {'wood': 10, 'stone': 8, 'gold': 3},
            'buildings': [],
            'ring': {'integrity': 0.5, 'holes': [], 'can_expand': True},
            'enemies_nearby': False
        }
        
        features = self._encode_observation(obs)
        return np.array(features, dtype=np.float32)
    
    def _encode_observation(self, obs):
        """Encode observation to 29-dim feature vector."""
        features = []
        
        # Treasury (3)
        t = obs.get('treasury', {})
        features.extend([
            min(t.get('wood', 0) / 100, 1.0),
            min(t.get('stone', 0) / 100, 1.0),
            min(t.get('gold', 0) / 50, 1.0)
        ])
        
        # Core (2)
        c = obs.get('core')
        if c:
            features.extend([c['hp'] / c['max_hp'], c['level'] / 5])
        else:
            features.extend([0, 0])
        
        # Threat (2)
        features.extend([
            obs.get('threat', 0),
            1.0 if obs.get('enemies_nearby') else 0.0
        ])
        
        # Nearby nodes (3)
        n = obs.get('nearby_nodes', {})
        features.extend([
            min(n.get('wood', 0) / 20, 1.0),
            min(n.get('stone', 0) / 20, 1.0),
            min(n.get('gold', 0) / 10, 1.0)
        ])
        
        # Buildings count (9) - simplified
        buildings = obs.get('buildings', [])
        mill = sum(1 for b in buildings if b.get('type') == 'mill')
        quarry = sum(1 for b in buildings if b.get('type') == 'quarry')
        goldmine = sum(1 for b in buildings if b.get('type') == 'goldmine')
        towers = sum(1 for b in buildings if 'tower' in b.get('type', ''))
        walls = sum(1 for b in buildings if 'wall' in b.get('type', ''))
        
        features.extend([
            min(mill / 3, 1.0),
            min(quarry / 3, 1.0),
            min(goldmine / 3, 1.0),
            min(towers / 4, 1.0),
            min(walls / 40, 1.0),
            0, 0, 0, 0  # placeholders
        ])
        
        # Coverage (3) - TODO
        features.extend([0.5, 0.5, 0.5])
        
        # Ring (3)
        r = obs.get('ring')
        if r:
            features.extend([
                r.get('integrity', 0),
                min(len(r.get('holes', [])) / 10, 1.0),
                1.0 if r.get('can_expand') else 0.0
            ])
        else:
            features.extend([0, 0, 0])
        
        # Derived metrics (4) - TODO
        features.extend([0.5, 0.5, 0.5, 0.5])
        
        return features[:29]
    
    def _action_to_decision(self, action):
        """Map action index to decision dict."""
        actions_map = {
            0: {'op': 'wait'},
            1: {'op': 'place', 'type': 'mill'},
            2: {'op': 'place', 'type': 'quarry'},
            3: {'op': 'place', 'type': 'goldmine'},
            4: {'op': 'place', 'type': 'wall_stone'},
            5: {'op': 'place', 'type': 'gate'},
            6: {'op': 'place', 'type': 'tower_arrow'},
            7: {'op': 'place', 'type': 'tower_cannon'},
            8: {'op': 'place', 'type': 'spikes'},
            9: {'op': 'upgrade', 'target': 'core'},
            10: {'op': 'upgrade', 'target': 'harvest'},
            11: {'op': 'upgrade', 'target': 'tower'},
            12: {'op': 'repair', 'target': 'core'},
            13: {'op': 'repair', 'target': 'damaged'},
            14: {'op': 'sell', 'target': 'worst_harvest'},
            15: {'op': 'sell', 'target': 'worst_wall'},
            16: {'op': 'sell', 'target': 'redundant'},
            17: {'op': 'place', 'type': 'core'},
            18: {'op': 'expand_ring'},
            19: {'op': 'fortify_ring'}
        }
        return actions_map.get(action, {'op': 'wait'})
    
    def _execute_decision(self, decision):
        """Execute decision in game world."""
        # TODO: Implement
        pass
    
    def _calculate_reward(self, decision):
        """Calculate reward = game utility + optional Ollama."""
        # Base reward from game
        current_utility = self._calculate_utility()
        game_reward = (current_utility - self.previous_utility) / 100
        self.previous_utility = current_utility
        
        # Ollama evaluation (occasional)
        if self.use_ollama and self.current_step % self.ollama_freq == 0:
            obs = self._get_observation_dict()
            ollama_score = self.ollama.evaluate(obs, decision)
            ollama_reward = (ollama_score - 5) / 5  # -1 to +1
            
            # Weighted combination
            total_reward = 0.7 * game_reward + 0.3 * ollama_reward
            return total_reward
        
        return game_reward
    
    def _calculate_utility(self):
        """Calculate utility function."""
        # TODO: Implement proper utility
        return 200  # dummy
    
    def _get_observation_dict(self):
        """Get observation as dict for Ollama."""
        # TODO: Return actual observation dict
        return {
            'treasury': {'wood': 50, 'stone': 20, 'gold': 5},
            'threat': 0.1,
            'buildings': []
        }
    
    def _is_terminal(self):
        """Check if episode ended."""
        # TODO: Check if settlement destroyed
        return False


def make_env(
    rank,
    seed=0,
    use_ollama=False,
    ollama_freq=10,
    ollama_host='localhost',
    ollama_port=11434,
    ollama_model='gemma4:e4b',
):
    def _init():
        env = SettlementPlannerEnv(
            max_steps=500,
            use_ollama=use_ollama,
            ollama_freq=ollama_freq,
            ollama_host=ollama_host,
            ollama_port=ollama_port,
            ollama_model=ollama_model,
        )
        env.reset(seed=seed + rank)
        env = Monitor(env)
        return env
    return _init


def main():
    import os

    parser = argparse.ArgumentParser()
    parser.add_argument('--timesteps', type=int, default=1_000_000)
    parser.add_argument('--n-envs', type=int, default=16)
    parser.add_argument('--learning-rate', type=float, default=3e-4)
    parser.add_argument('--output', type=str, default='models/rl_agent')
    parser.add_argument('--use-ollama', action='store_true',
                        help='Use Ollama for decision evaluation')
    parser.add_argument('--ollama-freq', type=int, default=10,
                        help='Evaluate every N steps with Ollama')
    parser.add_argument('--ollama-host', type=str,
                        default=os.environ.get('OLLAMA_HOST', 'localhost'))
    parser.add_argument('--ollama-port', type=int,
                        default=int(os.environ.get('OLLAMA_PORT', '11434')))
    parser.add_argument('--ollama-model', type=str,
                        default=os.environ.get('OLLAMA_MODEL', 'gemma4:e4b'),
                        help='Completion model (not embedding-only, e.g. not qwen3-embedding)')
    args = parser.parse_args()

    print(f"🚀 Training RL agent")
    print(f"   Timesteps: {args.timesteps:,}")
    print(f"   Parallel envs: {args.n_envs}")
    print(f"   Ollama: {'enabled' if args.use_ollama else 'disabled'}")
    if args.use_ollama:
        print(f"   Ollama: http://{args.ollama_host}:{args.ollama_port} model={args.ollama_model}")
        print(f"   Ollama freq: every {args.ollama_freq} steps")

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    ollama_kwargs = dict(
        use_ollama=args.use_ollama,
        ollama_freq=args.ollama_freq,
        ollama_host=args.ollama_host,
        ollama_port=args.ollama_port,
        ollama_model=args.ollama_model,
    )

    # Create environments
    if args.n_envs > 1:
        env = SubprocVecEnv([
            make_env(i, **ollama_kwargs)
            for i in range(args.n_envs)
        ])
    else:
        env = DummyVecEnv([make_env(0, **ollama_kwargs)])

    eval_env = DummyVecEnv([make_env(9999)])

    # Callbacks
    checkpoint_callback = CheckpointCallback(
        save_freq=10000 // args.n_envs,
        save_path=str(output_dir / 'checkpoints'),
        name_prefix='rl_agent'
    )

    eval_callback = EvalCallback(
        eval_env,
        best_model_save_path=str(output_dir),
        log_path=str(output_dir / 'eval_logs'),
        eval_freq=5000 // args.n_envs,
        n_eval_episodes=10
    )

    # Create PPO model
    model = PPO(
        "MlpPolicy",
        env,
        learning_rate=args.learning_rate,
        n_steps=2048,
        batch_size=64,
        n_epochs=10,
        gamma=0.99,
        gae_lambda=0.95,
        clip_range=0.2,
        ent_coef=0.01,
        verbose=1,
        tensorboard_log=str(output_dir / 'tensorboard')
    )

    # Train
    print("\n📈 Starting training...")
    model.learn(
        total_timesteps=args.timesteps,
        callback=[checkpoint_callback, eval_callback],
        progress_bar=True
    )

    # Save
    model.save(str(output_dir / 'final_model'))

    print(f"\n✅ Training complete!")
    print(f"   Model: {output_dir / 'final_model.zip'}")
    print(f"\n📊 View progress:")
    print(f"   tensorboard --logdir {output_dir / 'tensorboard'}")

    if args.use_ollama:
        print(f"\n🤖 Ollama evaluations: {env.envs[0].ollama.eval_count if hasattr(env.envs[0], 'ollama') else 0}")


if __name__ == '__main__':
    main()
