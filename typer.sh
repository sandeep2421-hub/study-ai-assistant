#!/bin/bash

# Standalone, end-to-end memory-only assistant for Linux.
# Zero Clipboard Use — reads from Primary Selection (highlighted text).

# 1. Check if xdotool is installed
if ! command -v xdotool &> /dev/null; then
    echo "===================================================="
    echo "ERROR: 'xdotool' is not installed on this system."
    echo "To run this on Linux, you need xdotool."
    echo "===================================================="
    exit 1
fi

SERVER_BASE="https://study-ai-backend-omega.vercel.app"

# Find or ask for license key
if [ -n "$license" ]; then
    licenseKey="$license"
else
    read -p "Enter your License Key: " licenseKey
fi

if [ -z "$licenseKey" ]; then
    echo "Error: License key is required."
    exit 1
fi

# Prompt user to highlight text
echo "1. Highlight the question text on your exam page with your mouse."
echo "2. Keep it highlighted."
echo "Capturing selected text in:"
for i in {4..1}; do
    echo "$i..."
    sleep 1
done

# Read from Primary Selection (current selection, not clipboard)
question=""
if command -v xclip &> /dev/null; then
    question=$(xclip -selection primary -o 2>/dev/null)
elif command -v xsel &> /dev/null; then
    question=$(xsel -primary -o 2>/dev/null)
fi

if [ -z "$question" ] || [ ${#question} -lt 5 ]; then
    echo "Error: No text highlighted! Make sure to select the text before the countdown ends."
    exit 1
fi

# Generate unique HWID
hwid=$(echo -n "$(hostname)linux" | md5sum | cut -d' ' -f1 | cut -c1-16)

echo "Question captured successfully! Connecting to server..."

# 1. Login to get session token
login_body="{\"licenseKey\":\"$licenseKey\",\"hwid\":\"$hwid\"}"
login_res=$(curl -s -X POST -H "Content-Type: application/json" -d "$login_body" "$SERVER_BASE/login")

success=$(echo "$login_res" | grep -o '"success":[^,]*' | cut -d':' -f2)
if [ "$success" != "true" ]; then
    echo "Error: Invalid license key."
    exit 1
fi

sessionToken=$(echo "$login_res" | grep -o '"sessionToken":"[^"]*' | grep -o '[^"]$' | cut -d'"' -f1)

# 2. Get answer from AI
echo "Solving question (please wait 5-10s)..."

fullQuestion="You are an expert Software Engineer assistant helping in a live interview.

Interview Question: $question

Provide a thorough, well-structured answer. For code questions, provide complete, working code with no comments inside the code blocks.
Be concise but complete. For MCQ, give the answer letter and a brief explanation."

# Safe JSON escaping using python3
escaped_question=$(python3 -c "import json, sys; print(json.dumps(sys.stdin.read()))" <<< "$fullQuestion")

answer_body="{\"sessionToken\":\"$sessionToken\",\"licenseKey\":\"$licenseKey\",\"hwid\":\"$hwid\",\"question\":$escaped_question}"
answer_res=$(curl -s -X POST -H "Content-Type: application/json" -d "$answer_body" "$SERVER_BASE/answer")

server_error=$(echo "$answer_res" | grep -o '"error":"[^"]*' | grep -o '[^"]*$' | cut -d'"' -f1)
if [ -n "$server_error" ]; then
    echo "Error: Server error: $server_error"
    exit 1
fi

raw_answer=$(python3 -c "import json, sys; print(json.loads(sys.stdin.read()).get('answer', ''))" <<< "$answer_res")

if [ -z "$raw_answer" ]; then
    echo "Error: No answer returned."
    exit 1
fi

# 3. Extract code block
code=$(python3 -c "
import sys, re
text = sys.stdin.read()
closed = re.search(r'```[\w]*\r?\n?(.*?)```', text, re.DOTALL)
if closed:
    print(closed.group(1).strip())
else:
    print(text.strip())
" <<< "$raw_answer")

# Replace public class Solution for Java
code=$(sed 's/\bpublic\(\s\+class\s\+Solution\b\)/\1/g' <<< "$code")

echo "Solution ready!"
echo "Focus your editor! Starting auto-typing in:"
for i in {5..1}; do
    echo "$i..."
    sleep 1
done

echo "Typing started..."

# Read line by line and type
while IFS= read -r line || [ -n "$line" ]; do
    xdotool key Escape
    sleep 0.05
    xdotool key Return
    sleep 0.35
    for t in {1..10}; do
        xdotool key shift+Tab
        sleep 0.02
    done
    sleep 0.08
    
    indent=$(echo "$line" | grep -o "^[ ]*")
    if [ -n "$indent" ]; then
        xdotool type "$indent"
        sleep 0.05
    fi
    
    content=$(echo "$line" | sed 's/^[ ]*//')
    if [ -n "$content" ]; then
        xdotool type --delay 35 "$content"
    fi
done <<< "$code"

echo "Typing finished!"
