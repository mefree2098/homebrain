Insteon Bridge Service Setup (Jetson Orin Nano)

This sets up the Insteon PLM bridge so HomeBrain can talk to your Insteon PowerLinc Modem. Follow these steps exactly. No Linux knowledge required — everything is copy/paste.

1. Update packages and install basics
sudo apt update
sudo apt install -y python3-venv python3-pip nano

2. Create homebrain user and give serial access
# Create the user if it doesn’t already exist
sudo useradd -m -s /bin/bash homebrain || true

# Give both your current user and the homebrain user access to serial ports
sudo usermod -aG dialout $USER
sudo usermod -aG dialout homebrain

# Re-open your SSH session so the dialout group is applied
exit
# (then SSH back in)


Check with:

groups
# You must see "dialout" listed.

3. Find your PLM device

Plug in the PLM, then:

lsusb


You should see something like:

Bus 001 Device 005: ID 0403:6001 Future Technology Devices International, Ltd FT232 Serial (UART) IC


Note the IDs: idVendor=0403, idProduct=6001.

4. Create a stable /dev/insteon symlink
sudo tee /etc/udev/rules.d/99-insteon.rules >/dev/null <<'EOF'
SUBSYSTEM=="tty", KERNEL=="ttyUSB*", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", SYMLINK+="insteon", GROUP="dialout", MODE="0660"
EOF

sudo udevadm control --reload
sudo udevadm trigger
# If symlink doesn’t appear yet, unplug/replug the PLM
ls -l /dev/insteon


You should see something like:

lrwxrwxrwx 1 root root 7 ... /dev/insteon -> ttyUSB0

5. Create Python virtual environment and install deps
sudo mkdir -p /opt/homebrain/insteon
sudo chown -R homebrain:homebrain /opt/homebrain

sudo -u homebrain bash -lc '
python3 -m venv /opt/homebrain/insteon
source /opt/homebrain/insteon/bin/activate
pip install --upgrade pip
pip install pyinsteon aiohttp
'

6. Create the bridge script

Open the file in nano:

sudo -u homebrain nano /opt/homebrain/insteon/bridge.py


Paste the full script below (Ctrl+Shift+V to paste in SSH):

#!/usr/bin/env python3
import os
import asyncio
import logging
from typing import Tuple
from aiohttp import web
from pyinsteon import async_connect

# -------- Logging --------
root_level = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, root_level, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logging.getLogger("pyinsteon").setLevel(logging.DEBUG)
log = logging.getLogger("insteon-bridge")

CONNECT_RETRY_SECONDS = int(os.getenv("CONNECT_RETRY_SECONDS", "5"))
CONNECT_TIMEOUT_SECONDS = int(os.getenv("CONNECT_TIMEOUT_SECONDS", "10"))

# -------- App Factory --------
def create_app() -> web.Application:
    app = web.Application()
    app["state"] = {
        "connected": False,
        "port": os.getenv("INSTEON_TTY", "/dev/insteon"),
        "last_error": None,
        "connect_attempts": 0,
        "successful_connects": 0,
    }
    app["modem"] = None
    app["conn"] = None
    app["stop_evt"] = asyncio.Event()

    async def status(_: web.Request) -> web.Response:
        devices = -1
        try:
            if app["modem"] is not None and app["state"]["connected"]:
                devices = len(app["modem"].devices)
        except Exception:
            pass
        return web.json_response({
            "success": True,
            "connected": app["state"]["connected"],
            "port": app["state"]["port"],
            "devices": devices,
            "connect_attempts": app["state"]["connect_attempts"],
            "successful_connects": app["state"]["successful_connects"],
            "last_error": app["state"]["last_error"],
        })

    app.router.add_get("/status", status)
    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)
    return app

# -------- Lifecycle --------
async def _on_startup(app: web.Application):
    log.info("Starting Insteon bridge (port=%s)", app["state"]["port"])
    app["connect_task"] = asyncio.create_task(_connect_loop(app))
    log.info("HTTP up at http://0.0.0.0:8765/status")

async def _on_cleanup(app: web.Application):
    app["stop_evt"].set()
    try:
        if app["conn"]:
            await app["conn"].close()
    except Exception:
        pass

# -------- Connect/Reconnect --------
async def _try_connect(port: str) -> Tuple[object, object]:
    return await asyncio.wait_for(async_connect(device=port), timeout=CONNECT_TIMEOUT_SECONDS)

async def _connect_loop(app: web.Application):
    state = app["state"]
    while not app["stop_evt"].is_set():
        try:
            state["connect_attempts"] += 1
            log.info("Connecting to Insteon PLM on %s (attempt %s)...", state["port"], state["connect_attempts"])
            modem, conn = await _try_connect(state["port"])
            app["modem"], app["conn"] = modem, conn
            state["connected"] = True
            state["last_error"] = None
            state["successful_connects"] += 1
            log.info("Connected to PLM on %s. Devices: %s", state["port"], len(modem.devices))
            await app["stop_evt"].wait()
        except asyncio.TimeoutError:
            state["connected"] = False
            state["last_error"] = "connect_timeout"
            log.warning("Timed out; retrying in %ss", CONNECT_RETRY_SECONDS)
            await asyncio.sleep(CONNECT_RETRY_SECONDS)
        except Exception as ex:
            state["connected"] = False
            state["last_error"] = f"{type(ex).__name__}: {ex}"
            log.warning("Connect failed: %s; retrying in %ss", state["last_error"], CONNECT_RETRY_SECONDS)
            await asyncio.sleep(CONNECT_RETRY_SECONDS)

# -------- Entrypoint --------
if __name__ == "__main__":
    app = create_app()
    web.run_app(app, host="0.0.0.0", port=8765)


Save (Ctrl+O, Enter) → Exit (Ctrl+X).

Make executable:

sudo chmod +x /opt/homebrain/insteon/bridge.py

7. Manual test
INSTEON_TTY=/dev/insteon /opt/homebrain/insteon/bin/python /opt/homebrain/insteon/bridge.py


In another terminal:

curl http://127.0.0.1:8765/status


You should see JSON like:

{"success": true, "connected": true, "port": "/dev/insteon", "devices": 0, ...}


Stop the script with Ctrl+C.

8. Create systemd service (auto-start on boot)
sudo tee /etc/systemd/system/homebrain-insteon.service >/dev/null <<'EOF'
[Unit]
Description=HomeBrain Insteon PLM Bridge
After=network.target

[Service]
Type=simple
User=homebrain
WorkingDirectory=/opt/homebrain/insteon
Environment=INSTEON_TTY=/dev/insteon
Environment=LOG_LEVEL=INFO
ExecStart=/opt/homebrain/insteon/bin/python /opt/homebrain/insteon/bridge.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now homebrain-insteon.service
systemctl status homebrain-insteon.service --no-pager

9. Allow npm start to control the service without sudo

Create a polkit rule so user matt can manage this unit:

sudo install -d -m 700 /etc/polkit-1/rules.d

sudo tee /etc/polkit-1/rules.d/50-homebrain-insteon.rules >/dev/null <<'EOF'
polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      subject.user == "matt" &&
      action.lookup("unit") == "homebrain-insteon.service") {
    return polkit.Result.YES;
  }
});
EOF

sudo chmod 644 /etc/polkit-1/rules.d/50-homebrain-insteon.rules
sudo systemctl restart polkit

10. Final test
cd /opt/homebrain
npm start


You should see the insteon service start automatically, with no password prompt.

✅ That’s it. These steps get you from zero → working Insteon bridge, with systemd autostart and npm integration.