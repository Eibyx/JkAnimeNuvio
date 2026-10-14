"""Cliente HTTP común: límites de solicitudes, reintentos con backoff exponencial y Retry-After."""

from __future__ import annotations

import logging
import random
import re
import time
from collections.abc import Callable
from typing import Any

import httpx

from . import USER_AGENT

log = logging.getLogger(__name__)

RETRY_STATUSES = {429, 500, 502, 503, 504}


class HttpError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class RateLimitError(HttpError):
    """Límite agotado que no conviene reintentar (p. ej. cuota diaria)."""


_SECRET_PARAMS = re.compile(r"(api_?key|apikey|token|access_token)=([^&\s]+)", re.I)


def redact(text: str, secrets: list[str] | None = None) -> str:
    text = _SECRET_PARAMS.sub(r"\1=***", text)
    for s in secrets or []:
        if s:
            text = text.replace(s, "***")
    return text


class RateLimiter:
    """Intervalo mínimo entre solicitudes + pausa explícita hasta un instante."""

    def __init__(self, min_interval: float = 0.0, sleep: Callable[[float], None] = time.sleep):
        self.min_interval = min_interval
        self._last = 0.0
        self._until = 0.0
        self._sleep = sleep

    def wait(self) -> None:
        now = time.monotonic()
        target = max(self._last + self.min_interval, self._until)
        if target > now:
            self._sleep(target - now)
        self._last = time.monotonic()

    def pause_for(self, seconds: float) -> None:
        self._until = max(self._until, time.monotonic() + max(0.0, seconds))


def parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime

        dt = parsedate_to_datetime(value)
        return max(0.0, dt.timestamp() - time.time())
    except (TypeError, ValueError):
        return None


class HttpClient:
    """Envoltorio de httpx.Client con política de reintentos uniforme."""

    def __init__(
        self,
        base_url: str = "",
        *,
        timeout: float = 60.0,
        min_interval: float = 0.0,
        max_retries: int = 5,
        backoff_base: float = 2.0,
        max_backoff: float = 120.0,
        headers: dict[str, str] | None = None,
        transport: httpx.BaseTransport | None = None,
        secrets: list[str] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        name: str = "http",
    ):
        self.name = name
        self.client = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})},
            transport=transport,
            follow_redirects=True,
        )
        self.limiter = RateLimiter(min_interval, sleep=sleep)
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.max_backoff = max_backoff
        self.secrets = secrets or []
        self._sleep = sleep
        self.request_count = 0
        # Hook para que cada cliente decida si un 429 es definitivo (p. ej. cuota diaria).
        self.fatal_429: Callable[[httpx.Response], str | None] | None = None

    def close(self) -> None:
        self.client.close()

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        attempt = 0
        while True:
            self.limiter.wait()
            try:
                self.request_count += 1
                resp = self.client.request(method, url, **kwargs)
            except (httpx.TransportError, httpx.TimeoutException) as err:
                if attempt >= self.max_retries:
                    raise HttpError(f"{self.name}: error de red tras {attempt + 1} intentos: {redact(str(err), self.secrets)}") from err
                delay = self._backoff(attempt)
                log.warning("%s: error de red (%s); reintento en %.1fs", self.name, type(err).__name__, delay)
                self._sleep(delay)
                attempt += 1
                continue

            if resp.status_code == 429 and self.fatal_429 is not None:
                reason = self.fatal_429(resp)
                if reason:
                    raise RateLimitError(f"{self.name}: {reason}", status=429, body=_safe_body(resp))

            if resp.status_code in RETRY_STATUSES and attempt < self.max_retries:
                retry_after = parse_retry_after(resp.headers.get("Retry-After"))
                delay = retry_after if retry_after is not None else self._backoff(attempt)
                delay = min(delay + 0.5, self.max_backoff * 5)
                log.warning("%s: HTTP %s en %s; reintento %d/%d en %.1fs", self.name, resp.status_code,
                            redact(str(resp.request.url.path), self.secrets), attempt + 1, self.max_retries, delay)
                self.limiter.pause_for(delay)
                attempt += 1
                continue
            return resp

    def _backoff(self, attempt: int) -> float:
        return min(self.max_backoff, self.backoff_base * (2**attempt)) * (0.75 + random.random() * 0.5)

    def get_json(self, url: str, **kwargs: Any) -> Any:
        resp = self.request("GET", url, **kwargs)
        return self._json_or_raise(resp)

    def post_json(self, url: str, **kwargs: Any) -> Any:
        resp = self.request("POST", url, **kwargs)
        return self._json_or_raise(resp)

    def _json_or_raise(self, resp: httpx.Response) -> Any:
        if not 200 <= resp.status_code < 300:
            raise HttpError(
                f"{self.name}: HTTP {resp.status_code} en {resp.request.method} "
                f"{redact(str(resp.request.url), self.secrets)}: {redact(resp.text[:300], self.secrets)}",
                status=resp.status_code,
                body=_safe_body(resp),
            )
        try:
            return resp.json()
        except ValueError as err:
            raise HttpError(f"{self.name}: respuesta no JSON ({resp.status_code})", status=resp.status_code) from err


def _safe_body(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return resp.text[:500]
