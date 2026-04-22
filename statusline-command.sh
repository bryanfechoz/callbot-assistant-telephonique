#!/bin/sh
input=$(cat)
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
remaining=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')
used_tokens=$(echo "$input" | jq -r '.context_window.current_usage.input_tokens // empty')
ctx_size=$(echo "$input" | jq -r '.context_window.context_window_size // empty')

if [ -n "$used" ] && [ -n "$remaining" ]; then
  used_int=$(printf '%.0f' "$used")
  remaining_int=$(printf '%.0f' "$remaining")
  if [ -n "$ctx_size" ]; then
    ctx_k=$(echo "$ctx_size" | awk '{printf "%dk", $1/1000}')
    printf "Tokens: %s%% used · %s%% left (ctx %s)" "$used_int" "$remaining_int" "$ctx_k"
  else
    printf "Tokens: %s%% used · %s%% left" "$used_int" "$remaining_int"
  fi
else
  printf "Tokens: waiting for first message..."
fi
