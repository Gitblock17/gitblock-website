"""
GitBlock Playground - Local Development Server
Serves static files + proxies AI requests to MiMo API.
Set your API key:  export MIMO_API_KEY=your_key_here
"""
import http.server
import json
import os
import sys
import requests
from urllib.parse import urlparse

PORT = 8080
MIMO_API_URL = "https://api.xiaomimimo.com/v1/chat/completions"
MIMO_API_KEY = os.environ.get("MIMO_API_KEY", "")

class PlaygroundHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # Clean URL support: /about → /about.html
        parsed = urlparse(self.path)
        path = parsed.path
        if not os.path.exists(self.translate_path(path)):
            html_path = path.rstrip("/") + ".html"
            html_fs = self.translate_path(html_path)
            if os.path.exists(html_fs):
                self.path = html_path + ("?" + parsed.query if parsed.query else "")
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/chat":
            self.handle_chat()
        else:
            self.send_error(404, "Not Found")

    def handle_chat(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body)

            # Get API key: from request header > env var
            auth_header = self.headers.get("Authorization", "")
            if auth_header.startswith("Bearer ") and len(auth_header) > 20:
                api_key = auth_header.replace("Bearer ", "")
            else:
                api_key = MIMO_API_KEY

            if not api_key:
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "error": "No API key configured. Set MIMO_API_KEY environment variable or enter your key in Settings."
                }).encode())
                return

            # Determine which API to call
            api_url = data.pop("_api_url", MIMO_API_URL)
            model = data.get("model", "mimo-v2.5-pro")

            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}"
            }

            stream = data.get("stream", False)

            if stream:
                self.handle_streaming(api_url, headers, data)
            else:
                resp = requests.post(api_url, headers=headers, json=data, timeout=120)
                self.send_response(resp.status_code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(resp.content)

        except requests.exceptions.Timeout:
            self.send_error(504, "API timeout — try again")
        except requests.exceptions.ConnectionError:
            self.send_error(502, "Cannot reach API server")
        except Exception as e:
            self.send_error(500, str(e))

    def handle_streaming(self, api_url, headers, data):
        try:
            resp = requests.post(api_url, headers=headers, json=data, stream=True, timeout=120)
            self.send_response(resp.status_code)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            for chunk in resp.iter_content(chunk_size=None):
                if chunk:
                    self.wfile.write(chunk)
                    self.wfile.flush()

        except Exception as e:
            error_data = json.dumps({"error": str(e)})
            self.wfile.write(f"data: {error_data}\n\n".encode())
            self.wfile.flush()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, format, *args):
        # Quieter logging
        if "/api/" in str(args[0]):
            sys.stderr.write(f"[API] {args[0]}\n")
        # Skip static file logs

if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    key_status = "SET ✓" if MIMO_API_KEY else "NOT SET ✗ (users must enter their own)"
    key_preview = MIMO_API_KEY[:8] + "..." if MIMO_API_KEY else "none"

    print(f"""
╔══════════════════════════════════════════════════════════════╗
║              GitBlock Playground — Local Server              ║
╠══════════════════════════════════════════════════════════════╣
║  Playground:  http://localhost:{PORT}                          ║
║  API Proxy:   http://localhost:{PORT}/api/chat                 ║
║  MiMo API:    https://api.xiaomimimo.com/v1                  ║
║  API Key:     {key_status:<42}║
║  Key Preview: {key_preview:<42}║
╠══════════════════════════════════════════════════════════════╣
║  Set key:  export MIMO_API_KEY=your_key_here                 ║
║  Get key:  https://platform.xiaomimimo.com → Console         ║
╚══════════════════════════════════════════════════════════════╝
    """)

    server = http.server.HTTPServer(("0.0.0.0", PORT), PlaygroundHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        server.server_close()
