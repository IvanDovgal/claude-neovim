#!/usr/bin/env python3

"""
WebSocket MCP Proxy using Python websockets library

Proxies connections between Claude Code and the MCP server with full logging.
Usage: python ws-mcp-proxy.py <target-port>
"""

import asyncio
import json
import os
import random
import sys
import signal
from pathlib import Path
from websockets.server import serve
from websockets.client import connect
import websockets

# Get target port from command line
if len(sys.argv) != 2:
    print("Usage: python ws-mcp-proxy.py <target-port>", file=sys.stderr)
    sys.exit(1)

try:
    target_port = int(sys.argv[1])
except ValueError:
    print("Error: target-port must be a number", file=sys.stderr)
    sys.exit(1)

# Get random port for proxy server
proxy_port = random.randint(10000, 65535)

# Read the target lock file
lock_dir = Path.home() / '.claude' / 'ide'
target_lock_path = lock_dir / f'{target_port}.lock'

try:
    with open(target_lock_path, 'r') as f:
        lock_data = json.load(f)
except Exception as e:
    print(f"Failed to read lock file at {target_lock_path}: {e}", file=sys.stderr)
    sys.exit(1)

# Create proxy lock file
proxy_lock_data = {
    **lock_data,
    'ideName': f"{lock_data['ideName']} (Proxy)",
    'port': proxy_port
}

proxy_lock_path = lock_dir / f'{proxy_port}.lock'

try:
    with open(proxy_lock_path, 'w') as f:
        json.dump(proxy_lock_data, f, indent=2)
    print(f"Created proxy lock file: {proxy_lock_path}")
except Exception as e:
    print(f"Failed to create proxy lock file: {e}", file=sys.stderr)
    sys.exit(1)

print("WebSocket MCP Proxy started (Python)")
print(f"Proxy port: {proxy_port}")
print(f"Target port: {target_port}")
print(f"Lock file: {proxy_lock_path}")
print()

# Global reference to server
server = None


async def proxy_handler(client_ws, path):
    """Handle a client connection and proxy to target server"""
    print("\n=== Client connected to proxy ===")
    print(f"Request path: {path}")
    print(f"Request headers: {dict(client_ws.request_headers)}")

    # Build target URL with same path
    target_url = f"ws://127.0.0.1:{target_port}{path}"

    # Extract subprotocols
    subprotocols = client_ws.request_headers.get('Sec-WebSocket-Protocol', '')
    protocols = [p.strip() for p in subprotocols.split(',')] if subprotocols else None

    # Pass through headers
    extra_headers = {}
    for key, value in client_ws.request_headers.items():
        key_lower = key.lower()
        if key_lower in ('authorization', 'cookie', 'user-agent') or key_lower.startswith('x-'):
            extra_headers[key] = value

    try:
        # Connect to target
        async with connect(
            target_url,
            subprotocols=protocols,
            extra_headers=extra_headers
        ) as target_ws:
            print("=== Connected to target server ===")
            print(f"Negotiated subprotocol: {target_ws.subprotocol}")
            print()

            # Create tasks for bidirectional forwarding
            async def forward_client_to_target():
                """Forward messages from client to target"""
                try:
                    async for message in client_ws:
                        print(f"[CLIENT -> TARGET] {message}")
                        await target_ws.send(message)
                except websockets.exceptions.ConnectionClosed:
                    print("\n=== Client disconnected ===")
                except Exception as e:
                    print(f"Error in client->target: {e}")

            async def forward_target_to_client():
                """Forward messages from target to client"""
                try:
                    async for message in target_ws:
                        print(f"[TARGET -> CLIENT] {message}")
                        await client_ws.send(message)
                except websockets.exceptions.ConnectionClosed:
                    print("\n=== Target connection closed ===")
                except Exception as e:
                    print(f"Error in target->client: {e}")

            # Run both forwarding tasks concurrently
            await asyncio.gather(
                forward_client_to_target(),
                forward_target_to_client(),
                return_exceptions=True
            )

    except Exception as e:
        print(f"Target connection error: {e}")


async def start_server():
    """Start the proxy server"""
    global server
    server = await serve(
        proxy_handler,
        "127.0.0.1",
        proxy_port,
        subprotocols=["mcp"]  # Support mcp subprotocol
    )
    await server.wait_closed()


def cleanup():
    """Cleanup on exit"""
    print("\nShutting down proxy...")

    try:
        proxy_lock_path.unlink()
        print("Removed proxy lock file")
    except Exception as e:
        print(f"Error removing lock file: {e}")


def signal_handler(sig, frame):
    """Handle shutdown signals"""
    cleanup()
    sys.exit(0)


# Register signal handlers
signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# Start the server
try:
    asyncio.run(start_server())
except KeyboardInterrupt:
    pass
finally:
    cleanup()
