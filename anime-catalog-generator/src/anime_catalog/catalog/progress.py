"""Informe de progreso y cancelación cooperativa del pipeline.

El pipeline llama a `phase()`, `advance()` y `check()` en puntos seguros (entre páginas de AniList,
entre grupos, entre lotes de MDBList). `check()` lanza `Cancelled` si se pidió cancelar: nunca se
interrumpe a mitad de un lote de escritura, así que la lista queda en un estado coherente y la
siguiente ejecución reanuda sin duplicados.
"""

from __future__ import annotations


class Cancelled(Exception):
    """El usuario canceló el trabajo."""


class Progress:
    """Implementación nula: el CLI la usa cuando no hay interfaz que informar."""

    def phase(self, name: str, total: int | None = None) -> None:
        return None

    def advance(self, n: int = 1, item: str | None = None) -> None:
        return None

    def set_total(self, total: int | None) -> None:
        return None

    def error(self, message: str) -> None:
        return None

    def pending(self, items: list[str]) -> None:
        return None

    def log(self, message: str) -> None:
        return None

    def check(self) -> None:
        return None


NULL_PROGRESS = Progress()
