"""GET /_factory/login on a preview: mint a fresh single-use sign-in link for
the founder's staging account and redirect to it. Runs in the preview's own
api image (same code, same database), port 8090, reachable only through the
gateway behind the preview password. Links expire in 15 minutes, so the PR
comment points here instead of at a link."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FOUNDER_UID = 1000000000000001


async def mint() -> str | None:
    from app.application.web_auth import WebAuth
    from app.platform import composition

    c = composition.build(offline=True)
    s = c.settings
    if s.cc_env != "staging":
        return None
    auth = WebAuth(c.sessions, session_secret=s.web_session_secret, base_url=s.web_base_url)
    return await auth.mint_link(FOUNDER_UID)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] != "/_factory/login":
            self.send_error(404)
            return
        url = asyncio.run(mint())
        if not url:
            self.send_error(503, "could not mint a sign-in link")
            return
        self.send_response(302)
        self.send_header("Location", url)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
