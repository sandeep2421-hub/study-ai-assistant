#!/usr/bin/env bash

echo "[VIT] Stopping processes..."
# Kill any running electron or node processes related to VIT
pkill -f "electron main.js" 2>/dev/null || true
pkill -f "node server.js" 2>/dev/null || true

# Remove temporary installation directories
echo "[VIT] Removing temporary files..."
rm -rf /tmp/vit-app-* 2>/dev/null || true

# Remove session cache
rm -f /tmp/.engoulp_sess 2>/dev/null || true
rm -f "$HOME/.config/study-ai-assistant" 2>/dev/null || true

echo "[✓] Cleanup complete! No digital footprints left."
