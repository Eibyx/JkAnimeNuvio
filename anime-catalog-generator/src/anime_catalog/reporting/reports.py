"""Reportes de cada ejecución: resumen en consola, JSON, CSV y HTML auditables."""

from __future__ import annotations

import csv
import html
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.table import Table

from ..catalog.pipeline import RunReport, slugify
from ..config import CatalogConfig

LINE = "=" * 44
SUB = "-" * 44


def summary_lines(rep: RunReport, cfg: CatalogConfig) -> list[str]:
    s = rep.stats
    f = cfg.filters
    lines = [LINE, "        ANIME CATALOG GENERATOR", LINE, "", f"Catálogo: {rep.catalog}",
             f"Fuente: {cfg.source.primary}", f"Modo: {cfg.mdblist.mode.value}{' (DRY-RUN)' if rep.dry_run else ''}", "", "Filtro:"]
    intervals = f.year_intervals()
    if intervals:
        lines.append("  Años: " + ", ".join(f"{a or '…'}-{b or '…'}" for a, b in intervals))
    if f.date_from or f.date_to:
        lines.append(f"  Fechas: {f.date_from or '…'} a {f.date_to or '…'}")
    if f.seasons:
        lines.append(f"  Temporadas: {', '.join(f.seasons)}")
    lines.append(f"  Modo temporal: {f.temporal_mode.value} (metadatos: {f.metadata_scope.value if f.metadata_scope else '-'})")
    if cfg.canonical.first_only:
        lines.append("  Solo series originales (first-only)")
    if f.score and f.score.active:
        lines.append(f"  Puntuación {f.score.provider}.{f.score.field}: {f.score.min if f.score.min is not None else '…'}-{f.score.max if f.score.max is not None else '…'}"
                     + (" (normalizada 0-100)" if f.score.normalize else ""))
    if f.formats:
        lines.append(f"  Formatos: {', '.join(f.formats)}")
    for label, block in (("Géneros", f.genres), ("Tags", f.tags), ("Estudios", f.studios)):
        if block and block.active:
            lines.append(f"  {label}: +{block.include} -{block.exclude} ({block.mode.value})")
    lines += ["", SUB]

    def row(label: str, value: Any) -> str:
        return f"{label + ':':<30}{value!s:>12}"

    lines += [
        row("Animes encontrados", s.get("found", 0)),
        row("Animes filtrados", s.get("filtered", 0)),
        row("Temporadas agrupadas", s.get("seasons_grouped", 0)),
        row("Series/obras canónicas", s.get("canonical_series", 0)),
    ]
    for src in ("anibridge", "kometa", "fribb", "anime_lists", "override"):
        if rep.mapping_sources.get(src):
            lines.append(row(f"Mapping {src}", rep.mapping_sources[src]))
    lines += [
        row("Mapping mediante fallback", s.get("fallback", 0)),
        row("Sin mapping", s.get("unmapped", 0)),
        row("Pendientes de revisión", s.get("needs_review", 0)),
        row("Conflictos", s.get("conflicts", 0)),
        row("Duplicados descartados", s.get("duplicates_removed", 0)),
        SUB,
        row("Títulos válidos", s.get("valid_titles", 0)),
        row("  Series (TMDB TV)", s.get("tv", 0)),
        row("  Películas (TMDB Movie)", s.get("movies", 0)),
        row("Ya existentes en MDBList", s.get("already_in_list", 0)),
        row("Nuevos títulos", s.get("new_titles", 0)),
    ]
    if rep.plan and rep.plan.to_remove:
        lines.append(row("A eliminar (gestionados)", len(rep.plan.to_remove)))
    if not rep.dry_run:
        lines += [row("Agregados correctamente", s.get("added", 0)), row("Eliminados", s.get("removed", 0))]
    lines += [row("Errores", len(rep.errors)), LINE]
    return lines


def print_summary(console: Console, rep: RunReport, cfg: CatalogConfig, *, show_titles: int = 30) -> None:
    for line in summary_lines(rep, cfg):
        console.print(line, markup=False, highlight=False)
    plan = rep.plan
    if plan:
        state = f"id {plan.list_id}" if plan.list_id else ("se creará" if rep.dry_run else "creada")
        if rep.sync and rep.sync.created:
            state = f"creada (id {rep.sync.list_id})"
        console.print(f"Lista MDBList: {plan.list_name!r} ({state})", markup=False)
        for n in plan.notes:
            console.print(f"  nota: {n}", markup=False)
    if rep.plan and rep.plan.to_add and show_titles:
        t = Table(title=f"Títulos a añadir ({len(rep.plan.to_add)})" if rep.dry_run else f"Títulos añadidos ({len(rep.plan.to_add)})")
        for col in ("Tipo", "TMDB", "Título", "Año", "Fuente", "Estado", "Conf."):
            t.add_column(col)
        for ident in rep.plan.to_add[:show_titles]:
            rt = rep.plan.desired[ident]
            t.add_row(ident[0], str(ident[1]), rt.title, str(rt.canonical_year or ""), rt.mapping_source or "",
                      rt.mapping_status.value, f"{rt.confidence:.2f}")
        console.print(t)
        if len(rep.plan.to_add) > show_titles:
            console.print(f"… y {len(rep.plan.to_add) - show_titles} más (ver reporte)", markup=False)
    if rep.plan and rep.plan.to_remove:
        t = Table(title=f"Vista previa de ELIMINACIONES ({len(rep.plan.to_remove)})", style="red")
        t.add_column("Tipo")
        t.add_column("TMDB")
        t.add_column("Título")
        for m, i in rep.plan.to_remove[:200]:
            t.add_row(m, str(i), str((rep.plan.existing.get((m, i)) or {}).get("title") or ""))
        console.print(t)
    for n in rep.notes:
        console.print(f"nota: {n}", markup=False)
    for e in rep.errors[:20]:
        console.print(f"[red]error:[/red] {html.escape(e)}")


# ---------------------------------------------------------------------- archivos


def _title_row(t: Any) -> dict[str, Any]:
    return {
        "title": t.title, "canonical_uid": t.canonical_uid, "canonical_anilist_id": t.canonical_anilist_id, "mal_id": t.mal_id,
        "media_type": t.media_type, "tmdb_id": t.tmdb_id, "tvdb_id": t.tvdb_id, "imdb_id": t.imdb_id,
        "canonical_year": t.canonical_year, "format": t.canonical_format, "mapping_source": t.mapping_source,
        "mapping_status": t.mapping_status.value, "confidence": t.confidence, "members": " ".join(t.members),
        "grouping": " | ".join(t.grouping), "evidence": " | ".join(t.evidence), "conflicts": " | ".join(t.conflicts),
        "validation": json.dumps(t.validation.checks, ensure_ascii=False) if t.validation.performed else "",
    }


def _write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        if not rows:
            fh.write("")
            return
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def report_payload(rep: RunReport, cfg: CatalogConfig) -> dict[str, Any]:
    plan = rep.plan
    added = rep.sync.added if rep.sync else []
    return {
        "run_id": rep.run_id,
        "catalog": rep.catalog,
        "description": rep.description,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "started_at": rep.started_at,
        "finished_at": rep.finished_at,
        "dry_run": rep.dry_run,
        "mode": cfg.mdblist.mode.value,
        "stats": rep.stats,
        "mapping_sources": rep.mapping_sources,
        "dataset_versions": rep.dataset_versions,
        "list": {
            "name": plan.list_name if plan else None,
            "id": (rep.sync.list_id if rep.sync else None) or (plan.list_id if plan else None),
            "to_add": [list(i) for i in plan.to_add] if plan else [],
            "to_remove": [list(i) for i in plan.to_remove] if plan else [],
            "already_present": [list(i) for i in plan.already_present] if plan else [],
            "unmanaged_kept": len(plan.unmanaged_kept) if plan else 0,
            "notes": plan.notes if plan else [],
        },
        "added": [list(i) for i in added],
        "not_found": [list(i) for i in (rep.sync.not_found if rep.sync else [])],
        "titles": [_title_row(t) for t in rep.titles],
        "review": [_title_row(t) for t in rep.review],
        "excluded": [e.__dict__ for e in rep.excluded],
        "duplicates": [d.__dict__ for d in rep.duplicates],
        "errors": rep.errors,
        "notes": rep.notes,
        "anilist_partitions": rep.partitions,
        "config": rep.config,
    }


def write_reports(rep: RunReport, cfg: CatalogConfig, base_dir: Path) -> Path:
    out = base_dir / slugify(rep.catalog) / rep.run_id
    out.mkdir(parents=True, exist_ok=True)
    payload = report_payload(rep, cfg)
    rc = cfg.reports
    if rc.json_:
        (out / "summary.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        shutil.copyfile(out / "summary.json", out.parent / "latest-summary.json")
    if rc.csv:
        _write_csv(out / "titles.csv", [_title_row(t) for t in rep.titles])
        _write_csv(out / "review.csv", [_title_row(t) for t in rep.review])
        added = set(rep.sync.added) if rep.sync else set(rep.plan.to_add if rep.plan else [])
        _write_csv(out / ("added.csv" if rep.sync else "to_add.csv"),
                   [_title_row(t) for t in rep.titles if t.identity in added])
        _write_csv(out / "excluded.csv", [{**e.__dict__, "reasons": " | ".join(e.reasons)} for e in rep.excluded])
        _write_csv(out / "duplicates.csv", [{**d.__dict__, "dropped": " ".join(d.dropped)} for d in rep.duplicates])
        _write_csv(out / "errors.csv", [{"error": e} for e in rep.errors])
        _write_csv(out / "summary.csv", [{"metric": k, "value": v} for k, v in rep.stats.items()]
                   + [{"metric": f"mapping_{k}", "value": v} for k, v in rep.mapping_sources.items()]
                   + [{"metric": f"dataset_{k}", "value": v} for k, v in rep.dataset_versions.items()])
    if rc.html:
        (out / "report.html").write_text(render_html(rep, cfg, payload), encoding="utf-8")
    return out


def _table(rows: list[dict[str, Any]], cols: list[str], limit: int = 5000) -> str:
    if not rows:
        return "<p class='empty'>Sin elementos.</p>"
    head = "".join(f"<th>{html.escape(c)}</th>" for c in cols)
    body = []
    for r in rows[:limit]:
        body.append("<tr>" + "".join(f"<td>{html.escape(str(r.get(c, '') if r.get(c) is not None else ''))}</td>" for c in cols) + "</tr>")
    more = f"<p>… {len(rows) - limit} filas más en los CSV.</p>" if len(rows) > limit else ""
    return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>{more}"


def render_html(rep: RunReport, cfg: CatalogConfig, payload: dict[str, Any]) -> str:
    summary = "\n".join(summary_lines(rep, cfg))
    titles = payload["titles"]
    tcols = ["title", "canonical_year", "format", "media_type", "tmdb_id", "mapping_source", "mapping_status", "confidence", "members", "grouping", "evidence"]
    excl = [{**e, "reasons": " | ".join(e["reasons"])} for e in payload["excluded"]]
    dups = [{**d, "dropped": " ".join(d["dropped"])} for d in payload["duplicates"]]
    versions = [{"dataset": k, "versión": v} for k, v in rep.dataset_versions.items()]
    return f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(rep.catalog)} · Anime Catalog Generator</title>
<style>
:root{{--bg:#fff;--fg:#1d1d1f;--muted:#666;--line:#ddd;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d}}}}
body{{font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0 auto;max-width:1400px;padding:16px}}
pre{{background:rgba(127,127,127,.08);padding:12px;overflow:auto}} table{{border-collapse:collapse;width:100%;font-size:12px}}
th,td{{border:1px solid var(--line);padding:4px 6px;vertical-align:top;text-align:left}} th{{position:sticky;top:0;background:var(--bg)}}
details{{margin:12px 0}} summary{{cursor:pointer;font-weight:600}} .empty{{color:var(--muted)}}
</style></head><body>
<h1>{html.escape(rep.catalog)}</h1>
<p>{html.escape(rep.description or '')}</p>
<p>Ejecución <code>{html.escape(rep.run_id)}</code> · {'DRY-RUN (sin cambios en MDBList)' if rep.dry_run else 'aplicada'}</p>
<pre>{html.escape(summary)}</pre>
<details open><summary>Títulos ({len(titles)})</summary>{_table(titles, tcols)}</details>
<details><summary>Pendientes de revisión / sin mapping / conflictos ({len(payload['review'])})</summary>{_table(payload['review'], tcols + ['conflicts'])}</details>
<details><summary>Excluidos y motivos ({len(excl)})</summary>{_table(excl, ['uid', 'title', 'year', 'format', 'stage', 'reasons'])}</details>
<details><summary>Duplicados y agrupaciones ({len(dups)})</summary>{_table(dups, ['kind', 'key', 'kept', 'dropped', 'reason'])}</details>
<details><summary>Versiones de datasets</summary>{_table(versions, ['dataset', 'versión'])}</details>
<details><summary>Errores ({len(rep.errors)})</summary>{_table([{'error': e} for e in rep.errors], ['error'])}</details>
<details><summary>Configuración</summary><pre>{html.escape(json.dumps(rep.config, ensure_ascii=False, indent=2))}</pre></details>
</body></html>"""
