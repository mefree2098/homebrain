#!/bin/bash

# HomeBrain Remote Device Installation Script
# For Raspberry Pi OS

set -e

echo "======================================"
echo "HomeBrain Remote Device Installer"
echo "======================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   print_error "This script should not be run as root (don't use sudo)"
   exit 1
fi

# Default options
HUB_URL="${HOMEBRAIN_HUB_URL:-}"
SKIP_UPGRADE=false
SKIP_AUDIO_CONFIG=false

show_help() {
    echo "Usage: $0 [--hub <url>] [--skip-upgrade] [--skip-audio-config]"
    echo ""
    echo "  --hub <url>           HomeBrain hub base URL (e.g., http://192.168.1.10:3000)"
    echo "  --skip-upgrade        Skip full system upgrade to speed up install"
    echo "  --skip-audio-config   Do not write /etc/asound.conf"
    echo ""
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --hub)
            HUB_URL="$2"
            shift 2
            ;;
        --skip-upgrade)
            SKIP_UPGRADE=true
            shift
            ;;
        --skip-audio-config)
            SKIP_AUDIO_CONFIG=true
            shift
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        *)
            print_warning "Unknown option: $1"
            shift
            ;;
    esac
done

if [[ -z "$HUB_URL" ]]; then
    HUB_URL="http://localhost:3000"
fi

# Detect system
print_status "Detecting system..."
OS=$(uname -s)
ARCH=$(uname -m)

if [[ "$OS" != "Linux" ]]; then
    print_error "This script is designed for Linux systems"
    exit 1
fi

print_success "System detected: $OS $ARCH"

# Check for Raspberry Pi
if [[ -f /proc/device-tree/model ]]; then
    PI_MODEL=$(cat /proc/device-tree/model | tr -d '\0')
    print_success "Raspberry Pi detected: $PI_MODEL"
else
    print_warning "Raspberry Pi not detected, proceeding anyway..."
fi

# Update system
print_status "Updating system packages..."
sudo apt-get update -y
if [[ "$SKIP_UPGRADE" != true ]]; then
    sudo apt-get upgrade -y
else
    print_warning "Skipping full system upgrade (--skip-upgrade)"
fi

# Install required system packages
print_status "Installing required system packages..."
sudo apt-get install -y \
    curl \
    git \
    build-essential \
    python3 \
    python3-pip \
    alsa-utils \
    pulseaudio \
    libasound2-dev

# Install Node.js (if not present)
if ! command -v node &> /dev/null; then
    print_status "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    NODE_VERSION=$(node --version)
    print_success "Node.js already installed: $NODE_VERSION"
fi

# Verify Node.js version
NODE_MAJOR=$(node --version | cut -d. -f1 | sed 's/v//')
if [[ "$NODE_MAJOR" -lt 18 ]]; then
    print_error "Node.js version 18 or higher is required"
    exit 1
fi

# Create directory for HomeBrain remote device
INSTALL_DIR="$HOME/homebrain-remote"
print_status "Creating installation directory: $INSTALL_DIR"

if [[ -d "$INSTALL_DIR" ]]; then
    print_warning "Directory already exists, backing up..."
    mv "$INSTALL_DIR" "$INSTALL_DIR.backup.$(date +%s)"
fi

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Copy or download the remote device files
if [[ -f "$(dirname "$0")/package.json" ]]; then
    print_status "Copying local files..."
    cp -r "$(dirname "$0")"/* .
else
    print_status "Downloading HomeBrain Remote Device from ${HUB_URL}..."
    if ! curl -fsSL "${HUB_URL}/api/remote-devices/files/package.json" -o package.json; then
        print_error "Failed to download package.json from hub (${HUB_URL})"
        exit 1
    fi
    if ! curl -fsSL "${HUB_URL}/api/remote-devices/files/index.js" -o index.js; then
        print_error "Failed to download index.js from hub (${HUB_URL})"
        exit 1
    fi
fi

# Install Node.js dependencies
print_status "Installing Node.js dependencies..."
npm install --omit=dev

# Configure audio
print_status "Configuring audio system..."

# Create ALSA configuration if requested and missing
if [[ "$SKIP_AUDIO_CONFIG" == true ]]; then
    print_warning "Skipping /etc/asound.conf configuration (--skip-audio-config)"
elif [[ -f /etc/asound.conf ]]; then
    print_warning "/etc/asound.conf already exists - leaving as-is"
else
    sudo tee /etc/asound.conf > /dev/null << 'EOF'
# HomeBrain Remote Device Audio Configuration
pcm.!default {
    type asym
    playback.pcm "plughw:0,0"
    capture.pcm "plughw:0,0"
}

ctl.!default {
    type hw
    card 0
}
EOF
fi

# Add user to audio group
sudo usermod -a -G audio "$USER"

# Create systemd service
print_status "Creating systemd service..."

sudo tee /etc/systemd/system/homebrain-remote.service > /dev/null << EOF
[Unit]
Description=HomeBrain Remote Voice Device
After=network.target sound.target
Wants=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd
sudo systemctl daemon-reload

# Create default configuration
print_status "Creating default configuration..."
cat > config.json << EOF
{
  "audio": {
    "sampleRate": 16000,
    "channels": 1,
    "recordingDevice": "default",
    "playbackDevice": "default"
  },
  "wakeWords": ["anna", "henry", "home brain"],
  "wakeWordSensitivity": 0.6,
  "commandDurationMs": 6000,
  "preRollMs": 500,
  "silenceTimeoutMs": 1200,
  "silenceThreshold": 0.02,
  "hubUrl": "${HUB_URL}",
  "hubWsUrl": null,
  "deviceId": null,
  "registrationCode": null
}
EOF

# Create convenience scripts
print_status "Creating convenience scripts..."

# Start script
cat > start.sh << 'EOF'
#!/bin/bash
echo "Starting HomeBrain Remote Device..."
node index.js "$@"
EOF

chmod +x start.sh

# Register script
cat > register.sh << 'EOF'
#!/bin/bash
if [ -z "$1" ]; then
    echo "Usage: $0 <registration_code> [hub_url]"
    echo "Example: $0 ABC123 http://192.168.1.100:3000"
    exit 1
fi

REGISTRATION_CODE="$1"
HUB_URL="${2:-HUB_URL_PLACEHOLDER}"

echo "Registering device with HomeBrain hub..."
echo "Registration Code: $REGISTRATION_CODE"
echo "Hub URL: $HUB_URL"

node index.js --register "$REGISTRATION_CODE" --hub "$HUB_URL"
EOF

sed -i "s|HUB_URL_PLACEHOLDER|${HUB_URL}|g" register.sh

chmod +x register.sh

# Test audio script
cat > test-audio.sh << 'EOF'
#!/bin/bash
echo "Testing audio configuration..."
echo ""

echo "1. Testing recording devices:"
arecord -l

echo ""
echo "2. Testing playback devices:"
aplay -l

echo ""
echo "3. Testing microphone (5 seconds):"
echo "Speak into your microphone..."
timeout 5s arecord -f cd test-recording.wav 2>/dev/null || true

if [ -f "test-recording.wav" ]; then
    echo "Recording successful! Playing back..."
    aplay test-recording.wav 2>/dev/null || true
    rm test-recording.wav
    echo "Audio test completed successfully!"
else
    echo "Recording failed. Please check your microphone configuration."
fi
EOF

chmod +x test-audio.sh

# Create README
print_status "Creating README..."
cat > README.md << 'EOF'
# HomeBrain Remote Device

This is a HomeBrain remote voice device for Raspberry Pi.

## Quick Start

1. **Register your device** with the HomeBrain hub:
   ```bash
   ./register.sh YOUR_REGISTRATION_CODE
   ```

2. **Start the device**:
   ```bash
   ./start.sh
   ```

3. **Test audio** (optional):
   ```bash
   ./test-audio.sh
   ```

## Service Management

Enable automatic startup:
```bash
sudo systemctl enable homebrain-remote
sudo systemctl start homebrain-remote
```

Check service status:
```bash
sudo systemctl status homebrain-remote
```

View logs:
```bash
sudo journalctl -u homebrain-remote -f
```

## Configuration

Edit `config.json` to customize audio settings and other options.

## Troubleshooting

- **Audio issues**: Run `./test-audio.sh` to verify microphone and speaker
- **Connection issues**: Check network connectivity and hub URL
- **Service issues**: Check logs with `sudo journalctl -u homebrain-remote`

For more help, visit: https://github.com/homebrain/remote-device
EOF

print_success "Installation completed successfully!"
echo ""
print_status "Next steps:"
echo "1. Test your audio setup: ./test-audio.sh"
echo "2. Get a registration code from your HomeBrain hub"
echo "3. Register your device: ./register.sh YOUR_CODE [HUB_URL]"
echo "4. Start the device: ./start.sh"
echo ""
print_status "Optional - Enable automatic startup:"
echo "sudo systemctl enable homebrain-remote"
echo "sudo systemctl start homebrain-remote"
echo ""
print_warning "Please reboot or log out/in for audio group changes to take effect"

# Show installation summary
echo ""
echo "======================================"
echo "Installation Summary"
echo "======================================"
echo "Installation directory: $INSTALL_DIR"
echo "Service file: /etc/systemd/system/homebrain-remote.service"
echo "Audio config: /etc/asound.conf"
echo "User added to audio group: $USER"
echo ""
print_success "HomeBrain Remote Device is ready!"
