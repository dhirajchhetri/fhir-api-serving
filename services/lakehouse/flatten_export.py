"""Flatten FHIR bulk-export NDJSON into curated row dicts.

A Glue ETL job writes the same rows as Parquet in the curated zone.
This module is the pure transform, so it can be tested without Spark.
"""

from __future__ import annotations

import json
from typing import Any, Iterable


def _reference_id(reference: str | None) -> str | None:
    if not reference:
        return None
    if "/" not in reference:
        return reference
    return reference.split("/", 1)[1]


def _coding(concept: dict[str, Any] | None) -> str | None:
    if not concept:
        return None
    coding = concept.get("coding") or []
    if not coding:
        return None
    return coding[0].get("code")


def flatten_resource(resource: dict[str, Any]) -> list[dict[str, Any]]:
    resource_type = resource.get("resourceType")
    if resource_type == "Observation":
        quantity = resource.get("valueQuantity") or {}
        return [{
            "row_type": "observation",
            "resource_id": resource.get("id"),
            "patient_id": _reference_id((resource.get("subject") or {}).get("reference")),
            "code": _coding(resource.get("code")),
            "value": quantity.get("value"),
            "unit": quantity.get("unit"),
            "effective": resource.get("effectiveDateTime"),
        }]
    if resource_type == "Task":
        restriction = resource.get("restriction") or {}
        period = restriction.get("period") or {}
        return [{
            "row_type": "task",
            "resource_id": resource.get("id"),
            "patient_id": _reference_id((resource.get("for") or {}).get("reference")),
            "code": _coding(resource.get("code")),
            "status": resource.get("status"),
            "due_date": period.get("end"),
        }]
    return []


def flatten_ndjson(lines: Iterable[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in lines:
        text = line.strip()
        if not text:
            continue
        rows.extend(flatten_resource(json.loads(text)))
    return rows
