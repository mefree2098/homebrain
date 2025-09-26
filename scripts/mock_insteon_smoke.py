#!/usr/bin/env python3
"""Quick smoke-check for the HomeBrain Insteon bridge mock runtime."""

import asyncio
import json
import os
import sys
from dataclasses import replace
from pathlib import Path

# Ensure the local package is importable without installation.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str((ROOT / "remote-device" / "insteon").resolve()))

from homebrain_insteon.bridge import InsteonBridge
from homebrain_insteon.config import BridgeConfig


async def main() -> None:
    # Ensure mock mode is enabled even if the environment is not configured yet.
    os.environ.setdefault("INSTEON_ALLOW_MOCK", "1")
    os.environ.setdefault("INSTEON_FORCE_MOCK", "1")
    config = BridgeConfig.from_env()
    if not config.allow_mock_mode:
        config = replace(config, allow_mock_mode=True)

    timeout_seconds = float(os.getenv("INSTEON_SMOKE_TIMEOUT", "10"))

    bridge = InsteonBridge(config)
    await bridge.start()
    try:
        connected = await bridge.wait_until_connected(timeout=timeout_seconds)
        if not connected:
            raise RuntimeError(
                f"Mock bridge failed to signal connectivity within {timeout_seconds} seconds"
            )

        discovery = await bridge.run_discovery(refresh=False)
        print(json.dumps(discovery, indent=2))
    finally:
        await bridge.stop()


if __name__ == "__main__":
    asyncio.run(main())
