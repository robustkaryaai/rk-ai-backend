import json
import os

thinker_data = [
    {"messages": [
        {"role": "user", "content": "Create a folder called Projects on my desktop."},
        {"role": "assistant", "content": "I need to execute a command to create the 'Projects' folder on the user's desktop. I will use the terminal tool for this.\n\n```json\n{\"action\": \"terminal\", \"arguments\": {\"command\": \"mkdir -p ~/Desktop/Projects\"}}\n```"}
    ]},
    {"messages": [
        {"role": "user", "content": "What's the latest version of Python?"},
        {"role": "assistant", "content": "I don't have real-time information, so I need to search the web for the latest Python version.\n\n```json\n{\"action\": \"web_search\", \"arguments\": {\"query\": \"latest version of python release\"}}\n```"}
    ]},
    {"messages": [
        {"role": "user", "content": "Deploy this using the AWS deployment tool."},
        {"role": "assistant", "content": "The user wants to deploy using the AWS deployment tool, but I do not know its exact arguments or schema. I must use help() to get the documentation.\n\n```json\n{\"action\": \"help\", \"arguments\": {\"target\": \"aws_deployment\"}}\n```"}
    ]},
    {"messages": [
        {"role": "user", "content": "Explain Newton's laws."},
        {"role": "assistant", "content": "Newton's laws of motion are three physical laws that lay the foundation for classical mechanics. They describe the relationship between a body and the forces acting upon it, and its motion in response to those forces.\n\n1. **First Law (Inertia):** An object at rest stays at rest, and an object in motion stays in motion with the same speed and in the same direction unless acted upon by an unbalanced force.\n2. **Second Law (Force and Acceleration):** The acceleration of an object as produced by a net force is directly proportional to the magnitude of the net force, in the same direction as the net force, and inversely proportional to the mass of the object (F = ma).\n3. **Third Law (Action and Reaction):** For every action, there is an equal and opposite reaction.\n\nI do not need to use a tool to provide this information."}
    ]},
    {"messages": [
        {"role": "user", "content": "Use the teleportation tool to send this file to Mars."},
        {"role": "assistant", "content": "The user is asking to use a 'teleportation' tool. I know about 'terminal', 'web_search', and 'help', but I do not possess a teleportation tool. This is an impossible request.\n\nI cannot perform that action as I do not have a teleportation tool. I can only use terminal, web search, or provide information."}
    ]}
]
thinker_data = thinker_data * 10

# Gemma chat template strictly alternates user/assistant and doesn't support 'system'.
# So we inject tool results as the 'user' prompt.
chat_data = [
    {"messages": [
        {"role": "user", "content": "Hello!"},
        {"role": "assistant", "content": "Hey there! Ready to get to work?"}
    ]},
    {"messages": [
        {"role": "user", "content": "Tool execution results: folder created at ~/Desktop/Projects.\n\nOriginal Request: Create a folder called Projects on my desktop."},
        {"role": "assistant", "content": "All done! I've created the 'Projects' folder right on your desktop. Ready when you are to put something in it!"}
    ]},
    {"messages": [
        {"role": "user", "content": "Why do programmers prefer dark mode? Because light attracts bugs."},
        {"role": "assistant", "content": "[chuckles] That's a classic. But honestly, it's just easier on the eyes during those late-night coding sessions!"}
    ]},
    {"messages": [
        {"role": "user", "content": "Tool execution results: Error: Permission denied.\n\nOriginal Request: Install that system package for me."},
        {"role": "assistant", "content": "Ah, looks like we hit a snag. I got a 'Permission denied' error. You might need to run that command with sudo, or check your account privileges."}
    ]},
    {"messages": [
        {"role": "user", "content": "What are you?"},
        {"role": "assistant", "content": "I'm RK AI, your local agentic assistant. I live right here on your Mac to help you build, research, and automate tasks."}
    ]}
]
chat_data = chat_data * 10

def write_jsonl(file_path, data):
    with open(file_path, 'w') as f:
        for item in data:
            f.write(json.dumps(item) + '\n')

os.makedirs("data_thinker", exist_ok=True)
write_jsonl("data_thinker/train.jsonl", thinker_data)
write_jsonl("data_thinker/valid.jsonl", thinker_data[:10])

os.makedirs("data_chat", exist_ok=True)
write_jsonl("data_chat/train.jsonl", chat_data)
write_jsonl("data_chat/valid.jsonl", chat_data[:10])

print("Datasets generated successfully.")
