import json
from transformers import AutoTokenizer
import os

def inspect_model(model_id):
    print(f"--- Inspecting {model_id} ---")
    try:
        tokenizer = AutoTokenizer.from_pretrained(model_id)
        print("Special Tokens:")
        print(tokenizer.special_tokens_map)
        print("\nChat Template:")
        print(tokenizer.chat_template)
        
        # Test a simple message
        messages = [
            {"role": "user", "content": "Hello!"},
            {"role": "assistant", "content": "Hi there!"}
        ]
        formatted = tokenizer.apply_chat_template(messages, tokenize=False)
        print("\nFormatted Example:")
        print(formatted)
        print("-" * 50)
    except Exception as e:
        print(f"Error inspecting {model_id}: {e}")
        if "HF_TOKEN" not in os.environ and "gemma" in model_id.lower():
            print("Note: Gemma 2 requires authentication. Please set HF_TOKEN environment variable.")

if __name__ == "__main__":
    inspect_model("Qwen/Qwen2.5-1.5B-Instruct")
    inspect_model("google/gemma-2-2b-it")
