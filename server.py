"""ThreadTrace server: serves the app + Google login verification + login-alert email.
Run:  python server.py        (needs only Python 3, no pip packages)
"""
import http.server, socketserver, webbrowser, os, json, ssl, smtplib, datetime, secrets, time, re, hashlib
import urllib.request, urllib.parse
from email.message import EmailMessage

PORT = int(os.environ.get("PORT", 8080))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# Tiny .env loader (so Windows users need no extra tools)
env_path = os.path.join(DIRECTORY, ".env")
if os.path.exists(env_path):
    for line in open(env_path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "").replace(" ", "")
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", 465))


def verify_google_token(credential):
    """Ask Google to validate the ID token; make sure it was issued for OUR client id."""
    url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + urllib.parse.quote(credential)
    with urllib.request.urlopen(url, timeout=10) as r:
        info = json.loads(r.read().decode())
    if info.get("aud") != CLIENT_ID:
        raise ValueError("Token was not issued for this app")
    if str(info.get("email_verified")).lower() != "true":
        raise ValueError("Google email is not verified")
    return info


OTP = {}        # email -> {"h": hash, "exp": ts, "tries": n, "sent": ts}
IP_HITS = {}    # ip -> [timestamps]

def send_otp_mail(to_addr, code):
    if not (SMTP_USER and SMTP_PASS):
        raise RuntimeError("SMTP_USER / SMTP_PASS not set in .env")
    msg = EmailMessage()
    msg["Subject"] = f"ThreadTrace login code: {code}"
    msg["From"] = f"ThreadTrace Security <{SMTP_USER}>"
    msg["To"] = to_addr
    msg.set_content(f"Your ThreadTrace login code is {code}\nIt expires in 5 minutes. Do not share it.")
    msg.add_alternative(f"""<div style="font-family:Arial;max-width:420px;margin:auto;background:#081226;color:#e2e8f0;padding:24px;border-radius:12px;border:1px solid #00f0ff55">
<h2 style="color:#00f0ff;margin:0">ThreadTrace</h2><p>Your login code:</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:bold;color:#fff">{code}</p>
<p style="font-size:12px;color:#94a3b8">Valid for 5 minutes. If you did not request this, ignore this email.</p></div>""", subtype="html")
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context(), timeout=20) as sm:
        sm.login(SMTP_USER, SMTP_PASS)
        sm.send_message(msg)

def send_login_alert(to_addr, name, ip, device):
    if not (SMTP_USER and SMTP_PASS):
        raise RuntimeError("SMTP_USER / SMTP_PASS not set in .env")
    now = datetime.datetime.now().strftime("%d %b %Y, %I:%M %p")
    msg = EmailMessage()
    msg["Subject"] = "ThreadTrace: new sign-in to your account"
    msg["From"] = f"ThreadTrace Security <{SMTP_USER}>"
    msg["To"] = to_addr
    msg.set_content(
        f"Hi {name},\n\nYou just signed in to ThreadTrace.\n\nTime: {now}\nIP address: {ip}\n"
        f"Device: {device}\n\nIf this was you, no action is needed.\n"
        f"If not, secure your Google account immediately.\n\n- ThreadTrace Security")
    msg.add_alternative(f"""\
<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;background:#081226;color:#e2e8f0;padding:24px;border-radius:12px;border:1px solid #00f0ff55">
<h2 style="color:#00f0ff;margin:0 0 8px">ThreadTrace</h2>
<p>Hi {name}, you just signed in to your account.</p>
<table style="font-size:13px;color:#cbd5e1">
<tr><td style="padding:2px 12px 2px 0">Time</td><td>{now}</td></tr>
<tr><td style="padding:2px 12px 2px 0">IP address</td><td>{ip}</td></tr>
<tr><td style="padding:2px 12px 2px 0">Device</td><td>{device[:90]}</td></tr></table>
<p style="font-size:13px">If this was you, no action is needed. If not, secure your Google account immediately.</p>
</div>""", subtype="html")
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context(), timeout=20) as s:
        s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIRECTORY, **kw)

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/config":
            return self._json(200, {"googleClientId": CLIENT_ID, "mailOn": bool(SMTP_USER and SMTP_PASS)})
        if self.path.startswith("/.env") or self.path.endswith(".py"):
            return self._json(404, {"error": "not found"})  # never serve secrets/source
        return super().do_GET()

    def do_POST(self):
        if self.path not in ("/api/google-login", "/api/send-otp", "/api/verify-otp"):
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
            if self.path == "/api/send-otp":
                email = str(data.get("email", "")).strip().lower()
                if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
                    raise ValueError("Enter a valid email address")
                ip, now = self.client_address[0], time.time()
                hits = [t for t in IP_HITS.get(ip, []) if now - t < 3600]
                if len(hits) >= 8:
                    raise ValueError("Too many requests. Try again later.")
                if email in OTP and now - OTP[email]["sent"] < 30:
                    raise ValueError("Wait 30 seconds before asking for another code")
                code = f"{secrets.randbelow(1000000):06d}"
                send_otp_mail(email, code)
                IP_HITS[ip] = hits + [now]
                OTP[email] = {"h": hashlib.sha256(code.encode()).hexdigest(), "exp": now + 300, "tries": 0, "sent": now}
                return self._json(200, {"ok": True})
            if self.path == "/api/verify-otp":
                email = str(data.get("email", "")).strip().lower()
                rec = OTP.get(email)
                if not rec or time.time() > rec["exp"]:
                    raise ValueError("Code expired. Request a new one.")
                rec["tries"] += 1
                if rec["tries"] > 5:
                    OTP.pop(email, None)
                    raise ValueError("Too many wrong attempts. Request a new code.")
                if not secrets.compare_digest(rec["h"], hashlib.sha256(str(data.get("code", "")).strip().encode()).hexdigest()):
                    raise ValueError("Wrong code")
                OTP.pop(email, None)
                return self._json(200, {"ok": True, "email": email})
            if not CLIENT_ID:
                raise ValueError("GOOGLE_CLIENT_ID not set in .env")
            info = verify_google_token(data.get("credential", ""))
            email, name = info["email"], info.get("name", info["email"].split("@")[0])
            res = {"email": email, "name": name, "mailSent": False}
            try:
                send_login_alert(email, name, self.client_address[0], data.get("device", "unknown"))
                res["mailSent"] = True
            except Exception as e:
                res["mailError"] = str(e)
            return self._json(200, res)
        except Exception as e:
            return self._json(400, {"error": str(e)})


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("", PORT), Handler) as httpd:
        print("=" * 55)
        print(f"  ThreadTrace running:  http://localhost:{PORT}")
        print(f"  Google login : {'ON' if CLIENT_ID else 'OFF (set GOOGLE_CLIENT_ID in .env)'}")
        print(f"  Email alerts : {'ON' if SMTP_USER and SMTP_PASS else 'OFF (set SMTP_USER / SMTP_PASS in .env)'}")
        print("  Ctrl+C to stop")
        print("=" * 55)
        try:
            webbrowser.open(f"http://localhost:{PORT}")
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
