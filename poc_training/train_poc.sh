#!/bin/bash
set -e

source .venv/bin/activate

echo "====================================="
echo " Training Thinker Lite (Qwen2.5-1.5B)"
echo "====================================="
mlx_lm.lora \
    --model Qwen/Qwen2.5-1.5B-Instruct \
    --train \
    --data data_thinker \
    --iters 100 \
    --batch-size 2 \
    --num-layers 4 \
    --learning-rate 1e-4 \
    --adapter-path adapters_thinker

echo "====================================="
echo " Training Chat Lite (Gemma-2-2B)"
echo "====================================="
mlx_lm.lora \
    --model mlx-community/gemma-2-2b-it \
    --train \
    --data data_chat \
    --iters 100 \
    --batch-size 2 \
    --num-layers 4 \
    --learning-rate 1e-4 \
    --adapter-path adapters_chat

echo "====================================="
echo " Fusing Models"
echo "====================================="
mlx_lm.fuse --model Qwen/Qwen2.5-1.5B-Instruct --adapter-path adapters_thinker --save-path rk_ai_thinker_lite_v1
mlx_lm.fuse --model mlx-community/gemma-2-2b-it --adapter-path adapters_chat --save-path rk_ai_chat_lite_v1

echo "PoC Training Complete! Models saved to rk_ai_thinker_lite_v1 and rk_ai_chat_lite_v1"
