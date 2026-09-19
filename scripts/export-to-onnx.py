#!/usr/bin/env python3
"""Export trained RL model to ONNX for fast inference."""

import argparse
from pathlib import Path
import torch
from stable_baselines3 import PPO

def export_to_onnx(model_path, output_path):
    """Export SB3 model to ONNX format."""
    print(f"📥 Loading model from {model_path}")
    model = PPO.load(model_path)
    
    # Get policy network
    policy = model.policy
    policy.eval()
    
    # Dummy input (1 batch, 29 features)
    dummy_input = torch.randn(1, 29)
    
    # Export
    print(f"📤 Exporting to ONNX...")
    torch.onnx.export(
        policy,
        dummy_input,
        output_path,
        export_params=True,
        opset_version=14,
        do_constant_folding=True,
        input_names=['state'],
        output_names=['action_logits', 'value'],
        dynamic_axes={
            'state': {0: 'batch_size'},
            'action_logits': {0: 'batch_size'},
            'value': {0: 'batch_size'}
        }
    )
    
    print(f"✅ Exported to {output_path}")
    print(f"   Size: {Path(output_path).stat().st_size / 1024:.1f} KB")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=str, default='models/rl_agent/final_model.zip')
    parser.add_argument('--output', type=str, default='models/rl_agent/policy.onnx')
    args = parser.parse_args()
    
    export_to_onnx(args.model, args.output)


if __name__ == '__main__':
    main()
