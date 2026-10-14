"""Validación estricta del YAML y de las combinaciones incompatibles."""

from __future__ import annotations

from pathlib import Path

import pytest

from anime_catalog.cli import build_config
from anime_catalog.config import ConfigError, MetadataScope, SyncMode, TemporalMode, load_config, parse_config

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("path", sorted((ROOT / "filters").glob("*.yaml")))
def test_shipped_profiles_are_valid(path):
    cfg = load_config(path)
    assert cfg.catalog.name


def test_defaults():
    cfg = parse_config({"catalog": {"name": "A"}})
    assert cfg.filters.formats == ["TV", "MOVIE"]
    assert cfg.filters.temporal_mode == TemporalMode.ORIGINAL_RELEASE_YEAR
    assert cfg.filters.metadata_scope == MetadataScope.CANONICAL
    assert cfg.mdblist.mode == SyncMode.APPEND
    assert cfg.mdblist.dry_run is True
    assert cfg.mapping.source_order() == ["anibridge", "kometa", "fribb", "anime_lists", "tmdb"]


@pytest.mark.parametrize("data,msg", [
    ({"catalog": {"name": "A"}, "filters": {"unknown_field": 1}}, "unknown_field"),
    ({"catalog": {"name": "A"}, "filters": {"formats": ["CINEMA"]}}, "formato"),
    ({"catalog": {"name": "A"}, "filters": {"start_year": 2026, "end_year": 2020}}, "start_year"),
    ({"catalog": {"name": "A"}, "filters": {"seasons": ["MONSOON"]}}, "temporada"),
    ({"catalog": {"name": "A"}, "filters": {"year_ranges": ["2020/2026"]}}, "rango"),
    ({"catalog": {"name": "A"}, "filters": {"finished_only": True, "airing_only": True}}, "incompatible"),
    ({"catalog": {"name": "A"}, "filters": {"temporal_mode": "entry_release_year", "metadata_scope": "canonical"}}, "entry"),
    ({"catalog": {"name": "A"}, "filters": {"score": {"provider": "myanimelist", "min": 8}}}, "enrich_mal_scores"),
    ({"catalog": {"name": "A"}, "canonical": {"enabled": False}}, "canonical"),
    ({"catalog": {"name": " "}}, "vacío"),
    ({"catalog": {"name": "A"}, "mdblist": {"batch_size": 0}}, "batch_size"),
])
def test_invalid_configs(data, msg):
    with pytest.raises(ConfigError) as err:
        parse_config(data)
    assert msg in str(err.value)


def test_hybrid_enables_mal_scores():
    cfg = parse_config({"catalog": {"name": "A"}, "source": {"primary": "hybrid"},
                        "filters": {"score": {"provider": "myanimelist", "min": 8}}})
    assert cfg.source.enrich_mal_scores is True


def test_entry_mode_without_canonical_allowed():
    cfg = parse_config({"catalog": {"name": "A"}, "filters": {"temporal_mode": "entry_release_year"},
                        "canonical": {"enabled": False, "first_only": False}})
    assert cfg.filters.metadata_scope == MetadataScope.ENTRY


def test_cli_flags_override_yaml(tmp_path):
    y = tmp_path / "c.yaml"
    y.write_text("catalog: {name: Base}\nfilters: {start_year: 2000, formats: [TV]}\n", encoding="utf-8")
    cfg = build_config(y, {"filters.start_year": 2010, "filters.end_year": 2019, "catalog.name": "Otro", "filters.score.min": 85})
    assert (cfg.filters.start_year, cfg.filters.end_year, cfg.catalog.name) == (2010, 2019, "Otro")
    assert cfg.filters.score is not None and cfg.filters.score.min == 85
    assert cfg.filters.formats == ["TV"]


def test_cli_requires_name():
    with pytest.raises(ConfigError):
        build_config(None, {"filters.start_year": 2010})
