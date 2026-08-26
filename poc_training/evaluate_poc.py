import mlx_lm
import json

def test_thinker():
    print("=====================================")
    print(" Testing RK Thinker Lite (Zero Prompt)")
    print("=====================================")
    
    # Load base model + fine-tuned adapter
    model, tokenizer = mlx_lm.load("Qwen/Qwen2.5-1.5B-Instruct", adapter_path="adapters_thinker")
    
    prompts = [
        "Create a folder called Projects on my desktop.",
        "Deploy this using the AWS deployment tool.",
        "Explain Newton's laws.",
        "Use the teleportation tool to send this file to Mars.",
        # Unseen tool generalization test
        "Open a PR on Github with the title 'Fix bug'."
    ]
    
    for p in prompts:
        print(f"\n[USER]: {p}")
        messages = [{"role": "user", "content": p}]
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        response = mlx_lm.generate(model, tokenizer, prompt=prompt, max_tokens=150, verbose=False)
        print(f"[RK THINKER]:\n{response.strip()}")

def test_chat():
    print("\n=====================================")
    print(" Testing RK Chat Lite (Zero Prompt)")
    print("=====================================")
    
    # Load base model + fine-tuned adapter
    model, tokenizer = mlx_lm.load("mlx-community/gemma-2-2b-it", adapter_path="adapters_chat")
    
    prompts = [
        "What are you?",
        "Why do programmers prefer dark mode? Because light attracts bugs.",
        # Post tool execution
        "Tool execution results: folder created at ~/Desktop/Projects.\n\nOriginal Request: Create a folder called Projects on my desktop.",
        "Tool execution results: Error: Permission denied.\n\nOriginal Request: Install that system package for me."
    ]
    
    for p in prompts:
        print(f"\n[USER Context]: {p}")
        messages = [{"role": "user", "content": p}]
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        response = mlx_lm.generate(model, tokenizer, prompt=prompt, max_tokens=150, verbose=False)
        print(f"[RK CHAT]:\n{response.strip()}")

if __name__ == "__main__":
    test_thinker()
    test_chat()
