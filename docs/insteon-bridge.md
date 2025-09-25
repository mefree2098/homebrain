# Insteon Bridge Service

HomeBrain communicates with the Insteon PowerLinc Modem (PLM) through a small Python bridge that keeps a serial connection open and exposes a local WebSocket API the Node server can query. The bridge is not bundled in the demo build, so you need to install and run it on the Jetson that is connected to the PLM.

## One-time setup

`ash
sudo apt update
sudo apt install -y python3-venv python3-pip
python3 -m venv /opt/homebrain/insteon
source /opt/homebrain/insteon/bin/activate
pip install pyinsteon aiohttp
`

Create the bridge script /opt/homebrain/insteon/bridge.py with the following contents:

`python
#!/usr/bin/env python3
import asyncio
import logging
from aiohttp import web
from pyinsteon import async_connect

logging.basicConfig(level=logging.INFO)

async def start_bridge(device):
    logging.info("Starting Insteon bridge on %s", device)
    modem, conn = await async_connect(device=device)

    async def status(_: web.Request) -> web.Response:
        return web.json_response({"success": True, "port": device, "devices": len(modem.devices)} )

    app = web.Application()
    app.router.add_get('/status', status)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', 8765)
    await site.start()

    try:
        await asyncio.Event().wait()
    finally:
        await conn.close()

if __name__ == '__main__':
    asyncio.run(start_bridge('/dev/ttyUSB0'))
`

Make it executable and create a systemd service so the bridge starts on boot:

`ash
chmod +x /opt/homebrain/insteon/bridge.py
sudo tee /etc/systemd/system/homebrain-insteon.service <<'EOF'
[Unit]
Description=HomeBrain Insteon PLM Bridge
After=network.target

[Service]
Type=simple
User=homebrain
WorkingDirectory=/opt/homebrain/insteon
ExecStart=/opt/homebrain/insteon/bin/python /opt/homebrain/insteon/bridge.py
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now homebrain-insteon.service
`

## Manual start / stop

`
sudo systemctl start homebrain-insteon.service
sudo systemctl stop homebrain-insteon.service
sudo journalctl -u homebrain-insteon.service -f
`

When the service is running, you can use the new **Test INSTEON Connection** button in Settings → Maintenance, or call POST /api/maintenance/test-insteon to verify that the PLM is reachable.

To include the bridge whenever you run the UI and API locally, extend the root package.json start script:

`json
"start": "concurrently -n \"client,server,plm\" \"npm run client\" \"npm run server\" \"systemctl --user start homebrain-insteon.service && journalctl -fu homebrain-insteon.service\""
`

> **Note**: the sample JSON command assumes you have a user-level systemd unit. On the Jetson you should rely on the system service defined above.

