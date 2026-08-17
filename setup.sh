#!/usr/bin/env bash
set -e

echo ""
echo "===================================="
echo "         VIT Linux/Mac Setup"
echo "===================================="
echo ""

# ── Auto-install Node.js if not found ──
if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
  echo "[VIT] Node.js not found. Installing automatically..."

  if [ "$(uname)" = "Darwin" ]; then
    # macOS
    if command -v brew &>/dev/null; then
      brew install node
    else
      echo "[VIT] Installing Homebrew first..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      brew install node
    fi
  elif [ -f /etc/debian_version ] || command -v apt-get &>/dev/null; then
    # Ubuntu/Debian
    echo "[VIT] Detected Ubuntu/Debian..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
    sudo apt-get install -y nodejs 2>/dev/null
  elif [ -f /etc/redhat-release ] || command -v yum &>/dev/null; then
    # CentOS/RHEL/Fedora
    echo "[VIT] Detected RHEL/CentOS/Fedora..."
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - 2>/dev/null
    sudo yum install -y nodejs 2>/dev/null
  elif command -v dnf &>/dev/null; then
    # Fedora (dnf)
    echo "[VIT] Detected Fedora (dnf)..."
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - 2>/dev/null
    sudo dnf install -y nodejs 2>/dev/null
  elif command -v pacman &>/dev/null; then
    # Arch Linux
    echo "[VIT] Detected Arch Linux..."
    sudo pacman -S --noconfirm nodejs npm 2>/dev/null
  elif command -v apk &>/dev/null; then
    # Alpine
    echo "[VIT] Detected Alpine..."
    sudo apk add --no-cache nodejs npm 2>/dev/null
  else
    echo "[ERROR] Could not detect your OS to install Node.js."
    echo "        Please install Node.js manually: https://nodejs.org"
    exit 1
  fi

  # Verify installation
  if ! command -v node &>/dev/null; then
    echo "[ERROR] Node.js installation failed. Please install manually: https://nodejs.org"
    exit 1
  fi
  echo "[✓] Node.js $(node --version) installed successfully!"
else
  echo "[✓] Node.js $(node --version) already installed"
fi

# ── Auto-install git/unzip if needed ──
if ! command -v git &>/dev/null && ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
  echo "[VIT] Installing git..."
  if command -v apt-get &>/dev/null; then sudo apt-get install -y git 2>/dev/null
  elif command -v yum &>/dev/null; then sudo yum install -y git 2>/dev/null
  elif command -v pacman &>/dev/null; then sudo pacman -S --noconfirm git 2>/dev/null
  elif command -v brew &>/dev/null; then brew install git
  fi
fi

# ── Create temp directory ──
INSTALL_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'vit')
echo "[VIT] Working directory: $INSTALL_DIR"

# ── Cleanup on exit ──
cleanup() {
  echo ""
  echo "[VIT] Cleaning up..."
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$INSTALL_DIR" 2>/dev/null || true
  echo "[✓] Cleaned up. No traces left."
}
trap cleanup EXIT

# ── Download repo ──
echo "[VIT] Downloading app..."
if command -v git &>/dev/null; then
  git clone --depth 1 https://github.com/sandeep2421-hub/study-ai-assistant.git "$INSTALL_DIR/app" 2>/dev/null
  cd "$INSTALL_DIR/app"
elif command -v curl &>/dev/null; then
  curl -sL https://github.com/sandeep2421-hub/study-ai-assistant/archive/refs/heads/main.zip -o "$INSTALL_DIR/app.zip"
  cd "$INSTALL_DIR"
  unzip -q app.zip
  cd study-ai-assistant-main
elif command -v wget &>/dev/null; then
  wget -q https://github.com/sandeep2421-hub/study-ai-assistant/archive/refs/heads/main.zip -O "$INSTALL_DIR/app.zip"
  cd "$INSTALL_DIR"
  unzip -q app.zip
  cd study-ai-assistant-main
else
  echo "[ERROR] Need git, curl, or wget. None found."
  exit 1
fi
echo "[✓] Download complete!"

# ── Install dependencies ──
echo "[VIT] Installing dependencies..."
npm install --loglevel=error 2>/dev/null
echo "[✓] Dependencies installed!"

# ── Launch app ──
echo ""
echo "===================================="
echo "          Setup complete!"
echo "===================================="
echo ""
echo "Ctrl+Shift+S   Silent screen capture"
echo "Ctrl+Shift+A   Ask / generate answer"
echo "Ctrl+Shift+L   Toggle audio listener"
echo "Ctrl+Shift+C   Copy text from external window"
echo "Ctrl+Shift+V   Auto-type code at OS cursor"
echo "Ctrl+Shift+K   Toggle kiosk/stealth mode"
echo "Ctrl+Shift+H   Hide / show window"
echo "Ctrl+Shift+Q   Quit app"
echo ""
echo "[VIT] Launching app..."

if [ -f "node_modules/.bin/electron" ]; then
  ./node_modules/.bin/electron main.js
else
  npx electron main.js
fi

echo ""
echo "[VIT] App closed. Goodbye!"
