"""Protecciones del servidor local.

- Por defecto solo escucha en 127.0.0.1 y solo acepta cabeceras Host de loopback (evita ataques de
  DNS rebinding: una web externa no puede hacerse pasar por 127.0.0.1).
- Toda operación que modifica algo (POST/PUT/PATCH/DELETE) exige la cabecera `X-CSRF-Token` con un
  token aleatorio generado al arrancar e incrustado en la página. Otra web no puede leerlo (misma
  política de origen), así que no puede forjar solicitudes de escritura.
- Si llega cabecera Origin, debe ser la del propio servidor.
- Acceso remoto: solo con `--allow-remote` y un token (`ANIME_CATALOG_UI_TOKEN`) que se exige en
  todas las rutas.
- Cabeceras de seguridad (CSP sin recursos externos, sin iframes, nosniff, no-referrer).
"""

from __future__ import annotations

import hmac
import ipaddress
import secrets
from dataclasses import dataclass, field

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
    "font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
)


@dataclass
class SecurityConfig:
    host: str = "127.0.0.1"
    port: int = 8765
    allow_remote: bool = False
    access_token: str | None = None  # obligatorio si allow_remote
    csrf_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    extra_hosts: list[str] = field(default_factory=list)

    def allowed_hosts(self) -> set[str]:
        names = {"127.0.0.1", "localhost", "[::1]", "::1"}
        if self.allow_remote:
            names.add(self.host)
            names.update(self.extra_hosts)
        out = set()
        for n in names:
            out.add(n)
            out.add(f"{n}:{self.port}")
        return out


def is_loopback(host: str) -> bool:
    if host in ("localhost",):
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


class SecurityMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, config: SecurityConfig):  # type: ignore[no-untyped-def]
        super().__init__(app)
        self.config = config
        self.hosts = config.allowed_hosts()

    async def dispatch(self, request: Request, call_next):  # type: ignore[no-untyped-def]
        host = (request.headers.get("host") or "").lower()
        if host not in self.hosts:
            return JSONResponse({"detail": "Host no permitido"}, status_code=421)
        origin = request.headers.get("origin")
        if origin and origin != "null":
            ohost = origin.split("://", 1)[-1].lower()
            if ohost not in self.hosts:
                return JSONResponse({"detail": "Origen no permitido"}, status_code=403)
        if self.config.allow_remote and self.config.access_token:
            supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip() or request.cookies.get("ac_token", "")
            if not supplied:
                supplied = request.query_params.get("token", "")
            if not hmac.compare_digest(supplied, self.config.access_token):
                if request.url.path.startswith("/api/"):
                    return JSONResponse({"detail": "Se requiere el token de acceso"}, status_code=401)
                return Response("Acceso remoto protegido: abre la URL con ?token=…", status_code=401, media_type="text/plain")
        if request.method not in SAFE_METHODS:
            token = request.headers.get("x-csrf-token", "")
            if not hmac.compare_digest(token, self.config.csrf_token):
                return JSONResponse({"detail": "Token CSRF ausente o inválido"}, status_code=403)
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = CSP
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        if self.config.allow_remote and self.config.access_token and request.query_params.get("token") == self.config.access_token:
            response.set_cookie("ac_token", self.config.access_token, httponly=True, samesite="strict")
        return response
