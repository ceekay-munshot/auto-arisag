from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
import json
import math
from pathlib import Path
from typing import Any

from .config import (
    CATEGORY_LABELS,
    CATEGORY_ORDER,
    CHART_COLORS,
    FUEL_ORDER,
    LISTED_COMPANY_MAP,
    MODULE_TITLES,
    OEM_TO_LISTED,
    RETAIL_CATEGORY_ORDER,
    COMPANY_UNIT_TRENDS,
    VAHAN_STATE_SOURCE_URL,
    VAHAN_CLASS_MARKET_SOURCE_URL,
    SEGMENT_SHARE_CLASS_MAP,
    WHOLESALE_CATEGORY_ORDER,
)


def build_payload(
    snapshot: dict[str, Any],
    source_health: list[dict[str, Any]],
    vahan_rows: list[dict[str, Any]],
    state_registration_rows: list[dict[str, Any]],
    state_registration_message: str,
    segment_market_rows: list[dict[str, Any]],
    segment_market_message: str,
    segment_market_meta: dict[str, Any],
    ev_preview_rows: list[dict[str, Any]],
    vahan_oem_cache: dict[str, Any] | None = None,
    news_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    validations: list[dict[str, str]] = []

    retail = build_retail_module(snapshot["fada"], validations, vahan_oem_cache)
    wholesale = build_wholesale_module(snapshot["siam"], retail, validations)
    components = build_components_module(snapshot["acma"])
    registration = build_registration_module(vahan_rows, validations)
    state_registration = build_state_registration_module(state_registration_rows, state_registration_message, validations)
    segment_share = build_segment_share_module(segment_market_rows, segment_market_message, segment_market_meta, validations)
    official_ev = build_official_ev_module(ev_preview_rows, validations)
    insights = build_investor_insights(retail, wholesale, components, registration)
    summary = build_summary(retail, wholesale, components, registration, state_registration, official_ev, source_health)
    filters = build_filters(retail, wholesale, registration)

    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "as_of_date": snapshot["as_of_date"],
        "title": "India Auto Demand Monitor",
        "subtitle": "Official-first dashboard for listed Indian auto and auto-component investors.",
        "summary": summary,
        "filters": filters,
        "modules": {
            "retail": retail,
            "registration": registration,
            "state_registration": state_registration,
            "segment_share": segment_share,
            "official_ev": official_ev,
            "wholesale": wholesale,
            "components": components,
        },
        "insights": insights,
        "company_map": build_company_map(),
        "news": news_snapshot or {"available": False, "groups": [], "generated_at": None},
        "qa": validations,
        "chart_colors": CHART_COLORS,
    }


def build_retail_module(
    fada: dict[str, Any],
    validations: list[dict[str, str]],
    vahan_oem_cache: dict[str, Any] | None = None,
) -> dict[str, Any]:
    monthly_series = sorted(fada["monthly_series"], key=lambda item: item["month"])
    validate_month_continuity([item["month"] for item in monthly_series], "FADA retail", validations)

    months: list[dict[str, Any]] = []
    monthly_lookup: dict[str, dict[str, Any]] = {}
    for record in monthly_series:
        total_units = record["categories"]["TOTAL"]["units"]
        categories: list[dict[str, Any]] = []
        for category in RETAIL_CATEGORY_ORDER:
            values = record["categories"][category]
            share_pct = round(values["units"] / total_units * 100, 2) if total_units else 0.0
            categories.append(
                {
                    "category": category,
                    "label": CATEGORY_LABELS[category],
                    "units": values["units"],
                    "mom_pct": values["mom_pct"],
                    "yoy_pct": values["yoy_pct"],
                    "share_pct": share_pct,
                }
            )

        point = {
            "month": record["month"],
            "label": month_label(record["month"]),
            "source_url": record["source_url"],
            "release_date": record["release_date"],
            "total_units": total_units,
            "total_mom_pct": record["categories"]["TOTAL"]["mom_pct"],
            "total_yoy_pct": record["categories"]["TOTAL"]["yoy_pct"],
            "categories": categories,
        }
        months.append(point)
        monthly_lookup[record["month"]] = point

    latest_point = months[-1]
    latest_categories = {item["category"]: item for item in latest_point["categories"]}

    ev_share_lookup: dict[tuple[str, str], float] = {}
    for item in fada["ev_share_series"]:
        ev_share_lookup[(item["month"], item["category"])] = item["ev_share_pct"]

    ev_penetration_series: list[dict[str, Any]] = []
    for point in months:
        ev_units_total = 0.0
        by_category: list[dict[str, Any]] = []
        for category in ["2W", "3W", "PV", "CV"]:
            units = next(item["units"] for item in point["categories"] if item["category"] == category)
            share_pct = ev_share_lookup.get((point["month"], category), 0.0)
            ev_units = round(units * share_pct / 100)
            ev_units_total += ev_units
            by_category.append(
                {
                    "category": category,
                    "label": CATEGORY_LABELS[category],
                    "ev_share_pct": share_pct,
                    "ev_units": ev_units,
                }
            )

        overall_pct = round(ev_units_total / point["total_units"] * 100, 2) if point["total_units"] else 0.0
        ev_penetration_series.append(
            {
                "month": point["month"],
                "label": point["label"],
                "overall_ev_units": int(ev_units_total),
                "overall_ev_pct": overall_pct,
                "by_category": by_category,
            }
        )

    inventory_trend = [
        {
            "month": item["month"],
            "label": month_label(item["month"]),
            "days_low": item["days_low"],
            "days_high": item["days_high"],
            "days_mid": round((item["days_low"] + item["days_high"]) / 2, 1),
        }
        for item in fada["inventory_days_pv"]
    ]

    expectation_trend = [
        {
            "month": item["month"],
            "label": month_label(item["month"]),
            "next_month_growth_pct": item["next_month_growth_pct"],
            "next_three_months_growth_pct": item["next_three_months_growth_pct"],
        }
        for item in fada["dealer_growth_expectation"]
    ]

    latest_fuel_mix = []
    for category in RETAIL_CATEGORY_ORDER:
        raw_mix = fada["latest_fuel_mix"].get(category, {})
        ordered_mix = [{"fuel": fuel, "share_pct": raw_mix[fuel]} for fuel in FUEL_ORDER if fuel in raw_mix]
        latest_fuel_mix.append(
            {
                "category": category,
                "label": CATEGORY_LABELS[category],
                "fuels": ordered_mix,
            }
        )

    latest_oem_tables: dict[str, dict[str, Any]] = {}
    for category, table_payload in fada["latest_oem_tables"].items():
        table_meta = {}
        rows = table_payload
        if isinstance(table_payload, dict):
            table_meta = {
                "source_meta": table_payload.get("source_meta") or {},
                "label": table_payload.get("label"),
                "category": table_payload.get("category"),
            }
            rows = table_payload.get("rows") or []
        enriched_rows = []
        for row in rows:
            share_change = round(row["share_pct"] - row["prior_share_pct"], 2)
            unit_growth_pct = None
            if row["prior_units"]:
                unit_growth_pct = round((row["units"] - row["prior_units"]) / row["prior_units"] * 100, 2)
            enriched_rows.append(
                {
                    **row,
                    "share_change_pp": share_change,
                    "unit_growth_pct": unit_growth_pct,
                    "listed_companies": OEM_TO_LISTED.get(row["oem"], []),
                }
            )
        latest_oem_tables[category] = {
            "category": category,
            "label": table_meta.get("label") or CATEGORY_LABELS.get(category, category),
            "rows": enriched_rows,
            **({"source_meta": table_meta["source_meta"]} if table_meta.get("source_meta") else {}),
        }

    pv_history = load_pv_oem_history()
    if pv_history and len(pv_history) >= 2:
        pv_source_meta = latest_oem_tables["PV"].get("source_meta", {})
        latest_oem_tables["PV"] = build_periodized_pv_oem_table_from_history(
            "PV",
            latest_oem_tables["PV"]["rows"],
            pv_history,
            pv_source_meta.get("latest_month") or fada["latest_month"],
            pv_source_meta.get("url") or fada["source_url"],
        )

    for live_category in ["2W", "3W", "CV", "TRACTOR", "CE", "E2W", "E3W", "EPV", "ECV"]:
        live_table = build_live_vahan_oem_table(vahan_oem_cache, live_category, validations)
        if live_table:
            latest_oem_tables[live_category] = live_table

    category_cards = [
        {
            **item,
            "listed_companies": mapped_companies_for_category(item["category"]),
        }
        for item in latest_point["categories"]
    ]

    return {
        "available": True,
        "title": MODULE_TITLES["retail"],
        "source_meta": {
            "name": fada["source_name"],
            "latest_month": fada["latest_month"],
            "latest_release_date": fada["latest_release_date"],
            "url": fada["source_url"],
            "note": fada["coverage_note"],
        },
        "latest_month": fada["latest_month"],
        "months": months,
        "category_cards": category_cards,
        "latest_mix": sorted(
            (
                {
                    "category": item["category"],
                    "label": item["label"],
                    "share_pct": item["share_pct"],
                }
                for item in latest_point["categories"]
            ),
            key=lambda item: item["share_pct"],
            reverse=True,
        ),
        "ev_penetration_series": ev_penetration_series,
        "fuel_mix_latest": latest_fuel_mix,
        "inventory_trend": inventory_trend,
        "dealer_expectation_trend": expectation_trend,
        "latest_oem_tables": latest_oem_tables,
        "latest_subsegments": fada["latest_subsegments"],
        "company_unit_trends": [
            {
                "company": company,
                "label": details["label"],
                "concept": details["concept"],
                "source_name": details["source_name"],
                "series": [
                    {
                        "month": point["month"] if "month" in point else point["label"],
                        "label": point["label"] if "label" in point else month_label(point["month"]),
                        "units": point["units"],
                        "source_url": point["source_url"],
                    }
                    for point in details["series"]
                ],
            }
            for company, details in COMPANY_UNIT_TRENDS.items()
        ],
        "latest_channel_pulse": {
            **fada["latest_commentary"],
            "urban_rural_growth": fada["latest_urban_rural_growth"],
        },
        "latest_snapshot": {
            "total_units": latest_point["total_units"],
            "total_yoy_pct": latest_point["total_yoy_pct"],
            "total_mom_pct": latest_point["total_mom_pct"],
            "ev_penetration_pct": ev_penetration_series[-1]["overall_ev_pct"],
            "ev_units": ev_penetration_series[-1]["overall_ev_units"],
            "top_category_yoy": max(latest_point["categories"], key=lambda item: item["yoy_pct"]),
            "bottom_category_yoy": min(latest_point["categories"], key=lambda item: item["yoy_pct"]),
            "inventory_days": inventory_trend[-1],
            "monthly_lookup": monthly_lookup,
            "latest_categories": latest_categories,
        },
    }


def build_wholesale_module(
    siam: dict[str, Any],
    retail: dict[str, Any],
    validations: list[dict[str, str]],
) -> dict[str, Any]:
    monthly_series = sorted(siam["monthly_series"], key=lambda item: item["month"])
    validate_month_continuity([item["month"] for item in monthly_series], "SIAM wholesale", validations)

    months = []
    for record in monthly_series:
        domestic_sales = []
        total_domestic = 0
        for category in WHOLESALE_CATEGORY_ORDER:
            values = record["domestic_sales"][category]
            total_domestic += values["units"]
            domestic_sales.append(
                {
                    "category": category,
                    "label": CATEGORY_LABELS[category],
                    "units": values["units"],
                    "yoy_pct": values["yoy_pct"],
                }
            )
        months.append(
            {
                "month": record["month"],
                "label": month_label(record["month"]),
                "release_date": record["release_date"],
                "source_url": record["source_url"],
                "production_total": record["production_total"],
                "domestic_sales": domestic_sales,
                "domestic_total": total_domestic,
            }
        )

    latest_point = months[-1]
    retail_lookup = retail["latest_snapshot"]["monthly_lookup"][retail["latest_month"]]["categories"]
    retail_latest_lookup = {item["category"]: item for item in retail_lookup}
    retail_vs_wholesale = []
    for category in ["PV", "2W"]:
        retail_units = retail_latest_lookup[category]["units"]
        wholesale_units = next(item["units"] for item in latest_point["domestic_sales"] if item["category"] == category)
        retail_vs_wholesale.append(
            {
                "category": category,
                "label": CATEGORY_LABELS[category],
                "retail_units": retail_units,
                "wholesale_units": wholesale_units,
                "gap_units": retail_units - wholesale_units,
                "ratio_pct": round(retail_units / wholesale_units * 100, 1) if wholesale_units else None,
            }
        )

    return {
        "available": True,
        "title": MODULE_TITLES["wholesale"],
        "source_meta": {
            "name": siam["source_name"],
            "latest_month": siam["latest_month"],
            "latest_release_date": siam["latest_release_date"],
            "url": siam["source_url"],
            "note": siam["coverage_note"],
        },
        "latest_month": siam["latest_month"],
        "months": months,
        "latest_snapshot": latest_point,
        "retail_vs_wholesale": retail_vs_wholesale,
        "quarter_summary": siam["q3_2025_26"],
        "calendar_year_summary": siam["cy_2025"],
    }


def build_components_module(acma: dict[str, Any]) -> dict[str, Any]:
    component_companies = [
        {
            "company": company,
            "summary": details["summary"],
            "categories": details["categories"],
        }
        for company, details in LISTED_COMPANY_MAP.items()
        if "components" in details["lens"] or "ev" in details["lens"]
    ]

    return {
        "available": True,
        "title": MODULE_TITLES["components"],
        "source_meta": {
            "name": acma["source_name"],
            "period": acma["period_label"],
            "latest_release_date": acma["release_date"],
            "url": acma["source_url"],
            "note": acma["scope_note"],
        },
        "headline": acma["headline"],
        "metrics": acma["metrics"],
        "insights": acma["insights"],
        "listed_beneficiaries": component_companies,
        "raw_material_prices": build_raw_material_price_module(),
        "company_segment_trends": build_company_segment_trend_module(),
    }


def build_raw_material_price_module() -> dict[str, Any]:
    world_bank_url = (
        "https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/"
        "related/CMO-Pink-Sheet-April-2026.pdf"
    )
    # Mar 2026 monthly averages: aluminum / copper / nickel / lead / iron ore values
    # are FRED's IMF–World Bank-aligned monthly series (PALUMUSDM, PCOPPUSDM,
    # PNICKUSDM, PLEADUSDM, PIORECRUSDM). Natural rubber TSR20 USD/kg is estimated
    # from converging public TSR20 observations; FRED's PRUBBUSDM tracks RSS3 in
    # cents/lb so it's not a direct substitute.
    materials = [
        {
            "id": "aluminum",
            "label": "Aluminum",
            "unit_label": "USD / metric ton",
            "axis_suffix": "/mt",
            "series": [
                {"period": "2022", "label": "2022", "value": 2705},
                {"period": "2023", "label": "2023", "value": 2256},
                {"period": "2024", "label": "2024", "value": 2419},
                {"period": "2025", "label": "2025", "value": 2632},
                {"period": "2026-02", "label": "Feb 2026", "value": 3065},
                {"period": "2026-03", "label": "Mar 2026", "value": 3373},
            ],
        },
        {
            "id": "copper",
            "label": "Copper",
            "unit_label": "USD / metric ton",
            "axis_suffix": "/mt",
            "series": [
                {"period": "2022", "label": "2022", "value": 8822},
                {"period": "2023", "label": "2023", "value": 8490},
                {"period": "2024", "label": "2024", "value": 9142},
                {"period": "2025", "label": "2025", "value": 9947},
                {"period": "2026-02", "label": "Feb 2026", "value": 12951},
                {"period": "2026-03", "label": "Mar 2026", "value": 12529},
            ],
        },
        {
            "id": "nickel",
            "label": "Nickel",
            "unit_label": "USD / metric ton",
            "axis_suffix": "/mt",
            "series": [
                {"period": "2022", "label": "2022", "value": 25834},
                {"period": "2023", "label": "2023", "value": 21521},
                {"period": "2024", "label": "2024", "value": 16814},
                {"period": "2025", "label": "2025", "value": 15091},
                {"period": "2026-02", "label": "Feb 2026", "value": 15635},
                {"period": "2026-03", "label": "Mar 2026", "value": 17076},
            ],
        },
        {
            "id": "lead",
            "label": "Lead",
            "unit_label": "USD / metric ton",
            "axis_suffix": "/mt",
            "series": [
                {"period": "2022", "label": "2022", "value": 2150},
                {"period": "2023", "label": "2023", "value": 2139},
                {"period": "2024", "label": "2024", "value": 2053},
                {"period": "2025", "label": "2025", "value": 1975},
                {"period": "2026-02", "label": "Feb 2026", "value": 1948},
                {"period": "2026-03", "label": "Mar 2026", "value": 1878},
            ],
        },
        {
            "id": "natural_rubber",
            "label": "Natural Rubber (TSR20)",
            "unit_label": "USD / kg",
            "axis_suffix": "/kg",
            "series": [
                {"period": "2022", "label": "2022", "value": 1.54},
                {"period": "2023", "label": "2023", "value": 1.38},
                {"period": "2024", "label": "2024", "value": 1.75},
                {"period": "2025", "label": "2025", "value": 1.77},
                {"period": "2026-02", "label": "Feb 2026", "value": 1.93},
                {"period": "2026-03", "label": "Mar 2026", "value": 1.92},
            ],
        },
        {
            "id": "iron_ore",
            "label": "Iron Ore (steel proxy)",
            "unit_label": "USD / dry metric ton",
            "axis_suffix": "/dmt",
            "series": [
                {"period": "2022", "label": "2022", "value": 121.3},
                {"period": "2023", "label": "2023", "value": 120.6},
                {"period": "2024", "label": "2024", "value": 109.4},
                {"period": "2025", "label": "2025", "value": 100.2},
                {"period": "2026-02", "label": "Feb 2026", "value": 98.8},
                {"period": "2026-03", "label": "Mar 2026", "value": 107.6},
            ],
        },
    ]

    enriched_materials = []
    for material in materials:
        latest_value = material["series"][-1]["value"]
        base_value = material["series"][0]["value"]
        change_pct = round((latest_value - base_value) / base_value * 100, 2) if base_value else None
        enriched_materials.append(
            {
                **material,
                "latest_value": latest_value,
                "latest_period": material["series"][-1]["label"],
                "change_since_base_pct": change_pct,
            }
        )

    material_lookup = {item["id"]: item for item in enriched_materials}

    def basket_for_company(company: str, categories: list[str], lens: list[str]) -> list[str]:
        category_set = set(categories)
        lens_set = set(lens)
        if company in {"Exide Industries", "Amara Raja Energy & Mobility"}:
            return ["lead", "nickel", "copper", "aluminum"]
        if company in {"Sona BLW Precision Forgings"}:
            return ["copper", "nickel", "aluminum", "iron_ore"]
        if company in {"JBM Auto", "Olectra Greentech"}:
            return ["aluminum", "copper", "nickel", "iron_ore"]
        if company in {"Bharat Forge", "Samvardhana Motherson", "Uno Minda"}:
            return ["iron_ore", "aluminum", "copper", "natural_rubber"]
        if company in {"Greaves Cotton"}:
            return ["copper", "aluminum", "natural_rubber", "nickel"]
        if "EV_SUPPLY" in category_set or "ev" in lens_set:
            return ["copper", "nickel", "aluminum", "lead"]
        if category_set & {"PV", "CV", "2W", "3W", "TRACTOR", "CE"}:
            basket = ["iron_ore", "aluminum", "copper"]
            if category_set & {"PV", "2W", "3W", "CV", "TRACTOR"}:
                basket.append("natural_rubber")
            return basket
        return ["aluminum", "copper", "iron_ore"]

    company_baskets = []
    for company, details in sorted(LISTED_COMPANY_MAP.items()):
        material_ids = basket_for_company(company, details["categories"], details["lens"])
        materials_for_company = [material_lookup[material_id] for material_id in material_ids if material_id in material_lookup]
        if not materials_for_company:
            continue
        company_baskets.append(
            {
                "company": company,
                "label": company,
                "material_ids": material_ids,
                "materials": materials_for_company,
                "category_labels": [CATEGORY_LABELS.get(category, category) for category in details["categories"]],
                "note": (
                    "Directional raw-material basket aligned to the company's main vehicle, battery or component exposure. "
                    "Commodity prices are benchmark series, not company-specific procurement prices."
                ),
            }
        )

    return {
        "available": True,
        "title": "Key raw-material prices",
        "default_company": "Tata Motors",
        "source_meta": {
            "name": "World Bank Pink Sheet",
            "latest_release_date": "2026-04-02",
            "url": world_bank_url,
            "note": (
                "Annual averages for 2022 to 2025 plus monthly quotes for Feb 2026 and Mar 2026. "
                "Metals and iron ore use the IMF–World Bank monthly series (PALUMUSDM, PCOPPUSDM, "
                "PNICKUSDM, PLEADUSDM, PIORECRUSDM via FRED); rubber TSR20 uses converging public "
                "TSR20 observations. Iron ore is shown as a steel-input proxy for auto materials."
            ),
        },
        "materials": enriched_materials,
        "companies": company_baskets,
    }


def build_company_segment_trend_module() -> dict[str, Any]:
    siam_url = "https://www.siam.in/annualreports.aspx?mpgid=20&pgidtrail=50"
    fada_url = "https://fada.in/images/press-release/169a8f8bd834feFADA%20releases%20February%202026%20Vehicle%20Retail%20Data.pdf"
    segment_library = {
        "PV": {
            "label": CATEGORY_LABELS["PV"],
            "source_name": "SIAM annual domestic sales",
            "source_url": siam_url,
            "series": [
                {"period": "2021-22", "label": "2021-22", "units": 2920084},
                {"period": "2022-23", "label": "2022-23", "units": 3890114},
                {"period": "2023-24", "label": "2023-24", "units": 4218746},
                {"period": "2024-25", "label": "2024-25", "units": 4301848},
            ],
        },
        "2W": {
            "label": CATEGORY_LABELS["2W"],
            "source_name": "SIAM annual domestic sales",
            "source_url": siam_url,
            "series": [
                {"period": "2021-22", "label": "2021-22", "units": 13494214},
                {"period": "2022-23", "label": "2022-23", "units": 15862771},
                {"period": "2023-24", "label": "2023-24", "units": 17974365},
                {"period": "2024-25", "label": "2024-25", "units": 19607332},
            ],
        },
        "3W": {
            "label": CATEGORY_LABELS["3W"],
            "source_name": "FADA annual retail",
            "source_url": fada_url,
            "series": [
                {"period": "2021-22", "label": "2021-22", "units": 417108},
                {"period": "2022-23", "label": "2022-23", "units": 767071},
                {"period": "2023-24", "label": "2023-24", "units": 1167986},
                {"period": "2024-25", "label": "2024-25", "units": 1220981},
            ],
        },
        "CV": {
            "label": CATEGORY_LABELS["CV"],
            "source_name": "FADA annual retail",
            "source_url": fada_url,
            "series": [
                {"period": "2021-22", "label": "2021-22", "units": 707186},
                {"period": "2022-23", "label": "2022-23", "units": 939741},
                {"period": "2023-24", "label": "2023-24", "units": 1010324},
                {"period": "2024-25", "label": "2024-25", "units": 1008623},
            ],
        },
        "TRACTOR": {
            "label": CATEGORY_LABELS["TRACTOR"],
            "source_name": "FADA annual retail",
            "source_url": fada_url,
            "series": [
                {"period": "2021-22", "label": "2021-22", "units": 766545},
                {"period": "2022-23", "label": "2022-23", "units": 827403},
                {"period": "2023-24", "label": "2023-24", "units": 892410},
                {"period": "2024-25", "label": "2024-25", "units": 883095},
            ],
        },
    }
    company_segments = {
        "Maruti Suzuki": ["PV", "CV"],
        "Tata Motors": ["PV", "CV"],
        "Mahindra & Mahindra": ["PV", "3W", "CV", "TRACTOR"],
        "Hyundai Motor India": ["PV"],
        "Hero MotoCorp": ["2W"],
        "TVS Motor": ["2W", "3W"],
        "Bajaj Auto": ["2W", "3W"],
        "Eicher Motors": ["2W", "CV"],
        "Ashok Leyland": ["CV"],
        "Escorts Kubota": ["TRACTOR"],
        "Atul Auto": ["3W"],
        "Exide Industries": ["2W", "PV", "CV"],
        "Amara Raja Energy & Mobility": ["2W", "PV", "CV"],
        "Sona BLW Precision Forgings": ["PV", "2W"],
        "Bharat Forge": ["CV", "PV"],
        "Uno Minda": ["2W", "PV"],
        "Samvardhana Motherson": ["PV", "CV"],
        "JBM Auto": ["CV"],
        "Olectra Greentech": ["CV"],
        "Greaves Cotton": ["2W", "3W"],
    }

    companies = []
    for company, categories in company_segments.items():
        segments = [segment_library[category] | {"category": category} for category in categories if category in segment_library]
        sources = [
            {
                "label": segment["source_name"].replace(" annual domestic sales", "").replace(" annual retail", ""),
                "url": segment["source_url"],
            }
            for segment in segments
        ]
        unique_sources: list[dict[str, str]] = []
        seen_urls: set[str] = set()
        for source in sources:
            if source["url"] not in seen_urls:
                seen_urls.add(source["url"])
                unique_sources.append(source)
        companies.append(
            {
                "company": company,
                "label": company,
                "segments": segments,
                "sources": unique_sources,
                "latest_period": segments[0]["series"][-1]["label"] if segments else None,
                "note": (
                    "Industry segment annual volumes for the markets this company participates in. "
                    "This is not company-reported unit volume."
                ),
                "is_directional_mapping": any("EV_SUPPLY" in details["categories"] for name, details in LISTED_COMPANY_MAP.items() if name == company),
            }
        )

    return {
        "available": True,
        "title": "End-market volume trend by company exposure",
        "default_company": "Maruti Suzuki",
        "latest_period": "2024-25",
        "source_meta": {
            "note": "Uses SIAM for passenger vehicles and two-wheelers, and FADA annual retail for three-wheelers, commercial vehicles and tractors.",
        },
        "companies": companies,
    }


def build_company_revenue_breakdowns() -> dict[str, dict[str, Any]]:
    source_name = "Official annual-report segment disclosures"
    note = (
        "Revenue rows are aligned to official reportable segments disclosed in annual reports. "
        "Where a company reports as a single operating segment, the table shows that disclosed business line at 100% share."
    )
    raw_histories: dict[str, dict[str, Any]] = {
        "Action Construction Equipment": {
            "source_url": "https://www.screener.in/company/ACE/",
            "history": [("FY20", 1156), ("FY21", 1227), ("FY22", 1630), ("FY23", 2158), ("FY24", 2912), ("FY25", 3320)],
        },
        "Amara Raja Energy & Mobility": {
            "source_url": "https://www.screener.in/company/ARE%26M/consolidated/",
            "history": [("FY20", 6839), ("FY21", 7150), ("FY22", 8697), ("FY23", 10392), ("FY24", 11708), ("FY25", 12846)],
        },
        "Ashok Leyland": {
            "source_url": "https://www.screener.in/company/ASHOKLEY/consolidated/",
            "history": [("FY20", 21951), ("FY21", 19454), ("FY22", 26237), ("FY23", 41673), ("FY24", 45703), ("FY25", 48535)],
        },
        "Atul Auto": {
            "source_url": "https://www.screener.in/company/ATULAUTO/consolidated/",
            "history": [("FY20", 625), ("FY21", 296), ("FY22", 315), ("FY23", 513), ("FY24", 527), ("FY25", 723)],
        },
        "Bajaj Auto": {
            "source_url": "https://www.screener.in/company/BAJAJ-AUTO/",
            "history": [("FY20", 29919), ("FY21", 27741), ("FY22", 33145), ("FY23", 36428), ("FY24", 44685), ("FY25", 50010)],
        },
        "Bharat Forge": {
            "source_url": "https://www.screener.in/company/BHARATFORG/consolidated/",
            "history": [("FY20", 8056), ("FY21", 6336), ("FY22", 10461), ("FY23", 12910), ("FY24", 15682), ("FY25", 15123)],
        },
        "Eicher Motors": {
            "source_url": "https://www.screener.in/company/EICHERMOT/consolidated/",
            "history": [("FY20", 9154), ("FY21", 8720), ("FY22", 10298), ("FY23", 14442), ("FY24", 16536), ("FY25", 18870)],
        },
        "Escorts Kubota": {
            "source_url": "https://www.screener.in/company/ESCORTS/consolidated/",
            "history": [("FY20", 5810), ("FY21", 7014), ("FY22", 7283), ("FY23", 8429), ("FY24", 9804), ("FY25", 10244)],
        },
        "Exide Industries": {
            "source_url": "https://www.screener.in/company/EXIDEIND/consolidated/",
            "history": [("FY20", 14471), ("FY21", 15297), ("FY22", 12789), ("FY23", 15078), ("FY24", 16770), ("FY25", 17238)],
        },
        "Greaves Cotton": {
            "source_url": "https://www.screener.in/company/GREAVESCOT/consolidated/",
            "history": [("FY20", 1911), ("FY21", 1500), ("FY22", 1710), ("FY23", 2699), ("FY24", 2633), ("FY25", 2918)],
        },
        "Hero MotoCorp": {
            "source_url": "https://www.screener.in/company/HEROMOTOCO/",
            "history": [("FY20", 28836), ("FY21", 30801), ("FY22", 29245), ("FY23", 33806), ("FY24", 37456), ("FY25", 40756)],
        },
        "Hyundai Motor India": {
            "source_url": "https://www.screener.in/company/HYUNDAI/consolidated/",
            "history": [("FY21", 40972), ("FY22", 47378), ("FY23", 60308), ("FY24", 69829), ("FY25", 69193)],
        },
        "JBM Auto": {
            "source_url": "https://www.screener.in/company/JBMA/consolidated/",
            "history": [("FY20", 1947), ("FY21", 1982), ("FY22", 3193), ("FY23", 3857), ("FY24", 5009), ("FY25", 5472)],
        },
        "Mahindra & Mahindra": {
            "source_url": "https://www.screener.in/company/M%26M/consolidated/",
            "history": [("FY20", 75382), ("FY21", 74278), ("FY22", 90171), ("FY23", 121269), ("FY24", 139078), ("FY25", 159211)],
        },
        "Maruti Suzuki": {
            "source_url": "https://www.screener.in/company/MARUTI/",
            "history": [("FY20", 75611), ("FY21", 70332), ("FY22", 88296), ("FY23", 117523), ("FY24", 140933), ("FY25", 151900)],
        },
        "Olectra Greentech": {
            "source_url": "https://www.screener.in/company/OLECTRA/consolidated/",
            "history": [("FY20", 201), ("FY21", 281), ("FY22", 593), ("FY23", 1091), ("FY24", 1154), ("FY25", 1802)],
        },
        "Samvardhana Motherson": {
            "source_url": "https://www.screener.in/company/MOTHERSON/consolidated/",
            "history": [("FY20", 60729), ("FY21", 57370), ("FY22", 63536), ("FY23", 78788), ("FY24", 98692), ("FY25", 113663)],
        },
        "Sona BLW Precision Forgings": {
            "source_url": "https://www.screener.in/company/SONACOMS/consolidated/",
            "history": [("FY20", 1038), ("FY21", 1566), ("FY22", 2131), ("FY23", 2676), ("FY24", 3185), ("FY25", 3546)],
        },
        "TVS Motor": {
            "source_url": "https://www.screener.in/company/TVSMOTOR/consolidated/",
            "history": [("FY20", 18849), ("FY21", 19421), ("FY22", 24355), ("FY23", 31974), ("FY24", 38779), ("FY25", 44089)],
        },
        "Tata Motors": {
            "source_url": "https://www.screener.in/company/500570/consolidated/",
            "history": [("FY20", 261068), ("FY21", 249795), ("FY22", 278454), ("FY23", 345967), ("FY24", 434016), ("FY25", 439695)],
        },
        "Uno Minda": {
            "source_url": "https://www.screener.in/company/UNOMINDA/consolidated/",
            "history": [("FY20", 6222), ("FY21", 6374), ("FY22", 8313), ("FY23", 11236), ("FY24", 14031), ("FY25", 16775)],
        },
    }

    single_segment_profiles: dict[str, dict[str, Any]] = {
        "Action Construction Equipment": {
            "segment": "Construction equipment and material handling",
            "source_url": "https://www.ace-cranes.com/public/front/pdf/Annual%20Report%20FY%202024-25_ACE_FF.pdf",
            "source_label": "Annual report FY25",
            "market_categories": ["CE"],
        },
        "Amara Raja Energy & Mobility": {
            "segment": "Energy and mobility solutions",
            "source_url": "https://www.amararaja.com/annual-reports/",
            "source_label": "Annual reports",
            "market_categories": [],
        },
        "Ashok Leyland": {
            "segment": "Commercial vehicles and related products",
            "source_url": "https://www.ashokleyland.com/backend/wp-content/uploads/2025/07/Annual-Report-FY-2024-25.pdf",
            "source_label": "Annual report FY25",
            "market_categories": ["CV"],
        },
        "Atul Auto": {
            "segment": "Three-wheelers and related products",
            "source_url": "https://atulauto.co.in/wp-content/uploads/2025/08/Final_AtulAutoAR_2025_compressed.pdf",
            "source_label": "Annual report FY25",
            "market_categories": ["3W"],
        },
        "Bharat Forge": {
            "segment": "Forgings and engineered products",
            "source_url": "https://www.bharatforge.com/AR2025/index.html",
            "source_label": "Annual report FY25",
            "market_categories": [],
        },
        "Eicher Motors": {
            "segment": "Motorcycles and commercial vehicles",
            "source_url": "https://www.eicher.in/content/dam/eicher-motors/investor/annual-reports/annual-report-2024-25.pdf",
            "source_label": "Annual report FY25",
            "market_categories": ["2W", "CV"],
        },
        "Escorts Kubota": {
            "segment": "Farm and construction equipment",
            "source_url": "https://static.escortskubota.com/new/pdf/2025/june/EKL_Annual_Report_FY_2024-25.pdf",
            "source_label": "Annual report FY25",
            "market_categories": ["TRACTOR", "CE"],
        },
        "Exide Industries": {
            "segment": "Storage batteries and allied products",
            "source_url": "https://www.exideindustries.com/investors/annual-reports.aspx",
            "source_label": "Annual reports",
            "market_categories": [],
        },
        "Greaves Cotton": {
            "segment": "Engineering and mobility solutions",
            "source_url": "https://greavescotton.com/wp-content/uploads/2025/07/Annual-Report-2024-25.pdf",
            "source_label": "Annual report FY25",
            "market_categories": [],
        },
        "Hero MotoCorp": {
            "segment": "Motorcycles and scooters",
            "source_url": "https://www.heromotocorp.com/en-in/investors/annual-reports.html",
            "source_label": "Annual reports",
            "market_categories": ["2W"],
        },
        "Hyundai Motor India": {
            "segment": "Passenger vehicles",
            "source_url": "https://www.hyundai.com/content/dam/hyundai/in/en/images/investor-relations/annualreports/annual-report2024-25.pdf",
            "source_label": "Annual report FY25",
            "market_categories": ["PV"],
        },
        "Maruti Suzuki": {
            "segment": "Passenger vehicles",
            "source_url": "https://www.marutisuzuki.com/corporate/media/press-releases/2025/april/maruti-suzuki-announces-financial-results-for-fy2024-25",
            "source_label": "FY25 results",
            "market_categories": ["PV", "CV"],
        },
        "Samvardhana Motherson": {
            "segment": "Automotive components and systems",
            "source_url": "https://www.motherson.com/storage/Corporate%20Announcements/FY2025-26/Disclosure_Annual_Report_FY_2024-25-06Aug.pdf",
            "source_label": "Annual report FY25",
            "market_categories": [],
        },
        "Sona BLW Precision Forgings": {
            "segment": "Automotive systems and components",
            "source_url": "https://sonacomstar.com/annual-report-24-25/index.html",
            "source_label": "Annual report FY25",
            "market_categories": [],
        },
        "TVS Motor": {
            "segment": "Two-wheelers, three-wheelers and parts",
            "source_url": "https://www.tvsmotor.com/investors/annual-reports",
            "source_label": "Annual reports",
            "market_categories": ["2W", "3W"],
        },
        "Tata Motors": {
            "segment": "Automotive operations",
            "source_url": "https://www.tatamotors.com/investors/annual-reports/",
            "source_label": "Annual reports",
            "market_categories": ["PV", "CV"],
        },
        "Uno Minda": {
            "segment": "Automotive components and systems",
            "source_url": "https://www.unominda.com/investors/annual-reports",
            "source_label": "Annual reports",
            "market_categories": [],
        },
    }

    multi_segment_profiles: dict[str, dict[str, Any]] = {
        "Bajaj Auto": {
            "source_url": "https://investors.bajajauto.com/ar25/segment-information-2/",
            "source_label": "Annual report FY25",
            "rows": [
                {
                    "segment": "Automotive",
                    "year_0": 36665.03,
                    "year_1": 44870.14,
                    "year_2": 49982.13,
                    "share_pct": round((49982.13 / 52468.96) * 100, 2),
                    "cagr_5y_pct": round((((49982.13 / 27750.12) ** (1 / 4)) - 1) * 100, 2),
                    "market_categories": ["2W", "3W"],
                },
                {
                    "segment": "Investments",
                    "year_0": 977.87,
                    "year_1": 1419.66,
                    "year_2": 1445.98,
                    "share_pct": round((1445.98 / 52468.96) * 100, 2),
                    "cagr_5y_pct": round((((1445.98 / 1267.42) ** (1 / 4)) - 1) * 100, 2),
                    "market_categories": [],
                },
                {
                    "segment": "Financing",
                    "year_0": None,
                    "year_1": 16.65,
                    "year_2": 1040.85,
                    "share_pct": round((1040.85 / 52468.96) * 100, 2),
                    "cagr_5y_pct": None,
                    "market_categories": [],
                },
            ],
        },
        "JBM Auto": {
            "source_url": "https://www.jbmbuses.com/wp-content/uploads/2025/08/JBM-Auto-Annual-Report-2024-25.pdf",
            "source_label": "Annual report FY25",
            "rows": [
                {
                    "segment": "Component division",
                    "year_0": 2332.38,
                    "year_1": 2746.45,
                    "year_2": 3144.95,
                    "share_pct": round((3144.95 / 5471.33) * 100, 2),
                    "cagr_5y_pct": round((((3144.95 / 1295.12) ** (1 / 4)) - 1) * 100, 2),
                    "market_categories": [],
                },
                {
                    "segment": "OEM division",
                    "year_0": 1305.38,
                    "year_1": 1917.68,
                    "year_2": 1832.22,
                    "share_pct": round((1832.22 / 5471.33) * 100, 2),
                    "cagr_5y_pct": round((((1832.22 / 459.01) ** (1 / 4)) - 1) * 100, 2),
                    "market_categories": ["CV"],
                },
                {
                    "segment": "Tool room division",
                    "year_0": 219.51,
                    "year_1": 344.20,
                    "year_2": 494.16,
                    "share_pct": round((494.16 / 5471.33) * 100, 2),
                    "cagr_5y_pct": round((((494.16 / 228.99) ** (1 / 4)) - 1) * 100, 2),
                    "market_categories": [],
                },
            ],
        },
        "Mahindra & Mahindra": {
            "source_url": "https://www.mahindra.com/sites/default/files/2025-06/MM-Annual-Report-2024-25.pdf",
            "source_label": "Annual report FY25",
            "rows": [
                {
                    "segment": "Automotive",
                    "year_0": 59251.14,
                    "year_1": 73471.12,
                    "year_2": 87287.47,
                    "share_pct": round((87287.47 / 118624.53) * 100, 2),
                    "cagr_5y_pct": None,
                    "market_categories": ["PV", "3W", "CV"],
                },
                {
                    "segment": "Farm Equipment",
                    "year_0": 25709.12,
                    "year_1": 25292.30,
                    "year_2": 29196.21,
                    "share_pct": round((29196.21 / 118624.53) * 100, 2),
                    "cagr_5y_pct": None,
                    "market_categories": ["TRACTOR"],
                },
                {
                    "segment": "Auto investments",
                    "year_0": 63.99,
                    "year_1": 243.75,
                    "year_2": 18.83,
                    "share_pct": round((18.83 / 118624.53) * 100, 2),
                    "cagr_5y_pct": None,
                    "market_categories": [],
                },
                {
                    "segment": "Farm investments",
                    "year_0": 61.20,
                    "year_1": 293.65,
                    "year_2": 65.49,
                    "share_pct": round((65.49 / 118624.53) * 100, 2),
                    "cagr_5y_pct": None,
                    "market_categories": [],
                },
                {
                    "segment": "Industrial businesses and consumer services",
                    "year_0": 2343.60,
                    "year_1": 1918.60,
                    "year_2": 2056.53,
                    "share_pct": round((2056.53 / 118624.53) * 100, 2),
                    "cagr_5y_pct": None,
                    "market_categories": [],
                },
            ],
        },
        "Olectra Greentech": {
            "source_url": "https://olectra.com/wp-content/uploads/Olectra-Annual-Report-2024-25.pdf",
            "source_label": "Annual report FY25",
            "rows": [
                {
                    "segment": "Electric vehicles",
                    "year_0": 1010.59,
                    "year_1": 1006.84,
                    "year_2": 1582.95,
                    "share_pct": round((1582.95 / 1763.06) * 100, 2),
                    "cagr_5y_pct": round((((1582.95 / 154.96) ** (1 / 4)) - 1) * 100, 2),
                    "market_categories": ["CV"],
                },
                {
                    "segment": "Insulators",
                    "year_0": 123.82,
                    "year_1": 148.19,
                    "year_2": 180.11,
                    "share_pct": round((180.11 / 1763.06) * 100, 2),
                    "cagr_5y_pct": round((((180.11 / 122.26) ** (1 / 4)) - 1) * 100, 2),
                    "market_categories": [],
                },
            ],
        },
    }

    result: dict[str, dict[str, Any]] = {}
    for company, details in raw_histories.items():
        history = details["history"]
        if len(history) < 3:
            continue
        display_history = history[-3:]
        base_label, base_value = history[0]
        latest_label, latest_value = history[-1]
        periods = len(history) - 1
        cagr_pct = round((((latest_value / base_value) ** (1 / periods)) - 1) * 100, 2) if base_value and periods > 0 else None
        single_profile = single_segment_profiles.get(company)
        if not single_profile:
            continue
        result[company] = {
            "source_name": source_name,
            "source_url": single_profile["source_url"],
            "source_label": single_profile["source_label"],
            "note": note,
            "years": [label for label, _ in display_history],
            "rows": [
                {
                    "segment": single_profile["segment"],
                    "year_0": display_history[0][1],
                    "year_1": display_history[1][1],
                    "year_2": display_history[2][1],
                    "share_pct": 100.0,
                    "cagr_5y_pct": cagr_pct,
                    "market_categories": single_profile["market_categories"],
                }
            ],
            "base_period_label": base_label,
            "latest_period_label": latest_label,
        }

    for company, details in multi_segment_profiles.items():
        result[company] = {
            "source_name": source_name,
            "source_url": details["source_url"],
            "source_label": details["source_label"],
            "note": note,
            "years": ["FY23", "FY24", "FY25"],
            "rows": details["rows"],
            "base_period_label": "FY21",
            "latest_period_label": "FY25",
        }
    return result


def build_registration_module(vahan_rows: list[dict[str, Any]], validations: list[dict[str, str]]) -> dict[str, Any]:
    if not vahan_rows:
        validations.append({"status": "warning", "message": "Registration lens hidden because no validated Vahan import was found."})
        return {
            "available": False,
            "title": MODULE_TITLES["registration"],
            "hidden_reason": "No validated Vahan import found in data/vahan.",
        }

    month_totals: dict[str, int] = defaultdict(int)
    month_maker_totals: dict[tuple[str, str], int] = defaultdict(int)
    states: set[str] = set()
    fuels: set[str] = set()

    for row in vahan_rows:
        month_totals[row["month"]] += row["registrations"]
        month_maker_totals[(row["month"], row["maker"])] += row["registrations"]
        if row.get("state"):
            states.add(row["state"])
        if row.get("fuel"):
            fuels.add(row["fuel"])

    months = sorted(month_totals)
    if len(months) < 2:
        validations.append({"status": "warning", "message": "Registration lens hidden because Vahan import has fewer than two monthly points."})
        return {
            "available": False,
            "title": MODULE_TITLES["registration"],
            "hidden_reason": "Need at least two Vahan months to render a trustworthy registration trend.",
        }

    validate_month_continuity(months, "Vahan registration import", validations)
    latest_month = months[-1]
    monthly = [
        {
            "month": month,
            "label": month_label(month),
            "total_units": month_totals[month],
        }
        for month in months
    ]
    latest_makers = [
        {"maker": maker, "units": units}
        for (month, maker), units in month_maker_totals.items()
        if month == latest_month
    ]
    latest_makers.sort(key=lambda item: item["units"], reverse=True)

    return {
        "available": True,
        "title": MODULE_TITLES["registration"],
        "source_meta": {
            "name": "Vahan import",
            "latest_month": latest_month,
            "latest_release_date": None,
            "url": None,
            "note": "User-supplied import. Preserve strict separation from FADA retail and SIAM wholesale data.",
        },
        "latest_month": latest_month,
        "months": monthly,
        "top_makers": latest_makers[:12],
        "states": sorted(states),
        "fuels": sorted(fuels),
    }


def build_state_registration_module(
    state_registration_rows: list[dict[str, Any]],
    source_message: str,
    validations: list[dict[str, str]],
) -> dict[str, Any]:
    if not state_registration_rows:
        validations.append({"status": "warning", "message": "Statewise Vahan explorer hidden because no validated all-state dump was found."})
        return {
            "available": False,
            "title": "Statewise Vahan registrations",
            "hidden_reason": "No validated all-state Vahan dump was available.",
        }

    month_segment_totals: dict[tuple[str, str, str], int] = defaultdict(int)
    state_totals: dict[str, int] = defaultdict(int)
    months = sorted({row["month"] for row in state_registration_rows})
    states = sorted({row["state"] for row in state_registration_rows})
    segments = ["PV", "2W", "3W", "CV"]

    if len(months) < 2:
        validations.append({"status": "warning", "message": "Statewise Vahan explorer hidden because the all-state dump has fewer than two monthly points."})
        return {
            "available": False,
            "title": "Statewise Vahan registrations",
            "hidden_reason": "Need at least two monthly points for a trustworthy state trend.",
        }

    for row in state_registration_rows:
        key = (row["state"], row["month"], row["segment"])
        month_segment_totals[key] += row["registrations"]
        state_totals[row["state"]] += row["registrations"]

    validate_month_continuity(months, "Vahan state registration rollup", validations)
    latest_month = months[-1]
    latest_year, latest_month_num = (int(part) for part in latest_month.split("-"))
    current_utc = datetime.now(UTC)
    months_stale = (current_utc.year - latest_year) * 12 + (current_utc.month - latest_month_num)

    if months_stale > 12:
        validations.append(
            {
                "status": "warning",
                "message": (
                    f"Statewise Vahan explorer hidden because the latest validated all-state raw month is "
                    f"{month_label(latest_month)}, which is too stale for a client-facing live dashboard."
                ),
            }
        )
        return {
            "available": False,
            "title": "Statewise Vahan registrations",
            "hidden_reason": (
                f"The latest validated all-state statewise raw month available in this pipeline is {month_label(latest_month)}. "
                "Recent 2026 state-level raw rows could not be fetched reliably enough to keep this module on the page."
            ),
        }

    state_items = []
    for state_name in states:
        segment_items = []
        for segment in segments:
            series = [
                {
                    "month": month,
                    "label": month_label(month),
                    "units": month_segment_totals.get((state_name, month, segment), 0),
                }
                for month in months
            ]
            latest_units = series[-1]["units"]
            segment_items.append(
                {
                    "segment": segment,
                    "label": CATEGORY_LABELS[segment],
                    "latest_units": latest_units,
                    "series": series,
                }
            )

        state_items.append(
            {
                "state": state_name,
                "label": state_name,
                "latest_total_units": sum(item["latest_units"] for item in segment_items),
                "segments": segment_items,
            }
        )

    state_items.sort(key=lambda item: item["label"])
    default_state = "Maharashtra" if any(item["state"] == "Maharashtra" for item in state_items) else state_items[0]["state"]

    return {
        "available": True,
        "title": "Statewise Vahan registrations",
        "source_meta": {
            "name": "Vahan all-state registration rollup",
            "latest_month": latest_month,
            "latest_release_date": latest_month,
            "url": VAHAN_STATE_SOURCE_URL,
            "note": (
                f"Latest validated all-state raw month in this pipeline is {month_label(latest_month)}. "
                "PV, 2W, 3W and CV are conservative rollups from the Vahan vehicle-class dump; "
                "tractors, construction equipment and special classes stay excluded."
            ),
        },
        "method_note": source_message,
        "latest_month": latest_month,
        "default_state": default_state,
        "default_segment": "PV",
        "segments": [{"id": segment, "label": CATEGORY_LABELS[segment]} for segment in segments],
        "states": state_items,
    }


def build_segment_share_module(
    segment_market_rows: list[dict[str, Any]],
    source_message: str,
    source_meta: dict[str, Any],
    validations: list[dict[str, str]],
) -> dict[str, Any]:
    recent_years = ["2022-23", "2023-24", "2024-25"]
    latest_full_year = recent_years[-1]
    cagr_periods = len(recent_years) - 1

    def build_option(
        option_id: str,
        label: str,
        rows: list[dict[str, Any]],
        source_name: str,
        source_url: str,
        latest_release_date: str,
        note: str,
    ) -> dict[str, Any]:
        latest_total = sum(item["units_by_year"][latest_full_year] for item in rows)
        enriched_rows: list[dict[str, Any]] = []
        for item in rows:
            current_units = item["units_by_year"][latest_full_year]
            base_units = item["units_by_year"][recent_years[0]]
            cagr_pct = (
                round((((current_units / base_units) ** (1 / cagr_periods)) - 1) * 100, 2)
                if base_units and current_units and cagr_periods > 0
                else None
            )
            enriched_rows.append(
                {
                    "id": item["id"],
                    "label": item["label"],
                    "trend": [{"year": year, "label": year, "units": item["units_by_year"][year]} for year in recent_years],
                    "share_pct": round(current_units / latest_total * 100, 2) if latest_total else 0.0,
                    "cagr_pct": cagr_pct,
                    **{f"units_{year}": item["units_by_year"][year] for year in recent_years},
                }
            )

        return {
            "id": option_id,
            "label": label,
            "rows": enriched_rows,
            "source_name": source_name,
            "source_url": source_url,
            "latest_release_date": latest_release_date,
            "latest_full_year_label": latest_full_year,
            "note": note,
        }

    option_items = [
        build_option(
            "TOTAL",
            "Total market",
            [
                {"id": "2W", "label": "Two-Wheelers", "units_by_year": {"2022-23": 15995968, "2023-24": 17527115, "2024-25": 18877812}},
                {"id": "PV", "label": "Passenger Vehicles", "units_by_year": {"2022-23": 3620039, "2023-24": 3960602, "2024-25": 4153432}},
                {"id": "CV", "label": "Commercial Vehicles", "units_by_year": {"2022-23": 939741, "2023-24": 1010324, "2024-25": 1008623}},
                {"id": "3W", "label": "Three-Wheelers", "units_by_year": {"2022-23": 767071, "2023-24": 1167986, "2024-25": 1220981}},
                {"id": "TRACTOR", "label": "Tractors", "units_by_year": {"2022-23": 827403, "2023-24": 892410, "2024-25": 883095}},
            ],
            "FADA annual retail",
            "https://fada.in/images/press-release/169a8f8bd834feFADA%20releases%20February%202026%20Vehicle%20Retail%20Data.pdf",
            "2025-04-04",
            "Recent annual mix uses official FADA retail totals for FY23, FY24 and FY25. This keeps the market-share view current and conceptually aligned with dealer retail.",
        ),
        build_option(
            "PV",
            "Passenger Vehicles",
            [
                {"id": "utility_vehicles", "label": "Utility Vehicles", "units_by_year": {"2022-23": 2003718, "2023-24": 2520691, "2024-25": 2797229}},
                {"id": "passenger_cars", "label": "Passenger Cars", "units_by_year": {"2022-23": 1747376, "2023-24": 1548943, "2024-25": 1353287}},
                {"id": "vans", "label": "Vans", "units_by_year": {"2022-23": 139020, "2023-24": 149112, "2024-25": 151332}},
            ],
            "SIAM annual domestic sales",
            "https://www.siam.in/annualreports.aspx?mpgid=20&pgidtrail=50",
            "2025-08-31",
            "Passenger-vehicle mix uses SIAM annual domestic sales for FY23 to FY25, broken into cars, utility vehicles and vans.",
        ),
        build_option(
            "2W",
            "Two-Wheelers",
            [
                {"id": "motorcycles", "label": "Motorcycles", "units_by_year": {"2022-23": 10230502, "2023-24": 11653237, "2024-25": 12252305}},
                {"id": "scooters", "label": "Scooters", "units_by_year": {"2022-23": 5190702, "2023-24": 5839325, "2024-25": 6853214}},
                {"id": "mopeds", "label": "Mopeds", "units_by_year": {"2022-23": 441567, "2023-24": 481803, "2024-25": 501813}},
            ],
            "SIAM annual domestic sales",
            "https://www.siam.in/annualreports.aspx?mpgid=20&pgidtrail=50",
            "2025-08-31",
            "Two-wheeler mix uses SIAM annual domestic sales for FY23 to FY25, split across motorcycles, scooters and mopeds.",
        ),
        build_option(
            "3W",
            "Three-Wheelers",
            [
                {"id": "three_w_passenger", "label": "3W passenger", "units_by_year": {"2022-23": 301877, "2023-24": 513328, "2024-25": 557693}},
                {"id": "e_rickshaw_passenger", "label": "E-rickshaw passenger", "units_by_year": {"2022-23": 350247, "2023-24": 490662, "2024-25": 474635}},
                {"id": "three_w_goods", "label": "3W goods", "units_by_year": {"2022-23": 90111, "2023-24": 122298, "2024-25": 122624}},
                {"id": "e_rickshaw_goods", "label": "E-rickshaw with cart", "units_by_year": {"2022-23": 24224, "2023-24": 40785, "2024-25": 65038}},
                {"id": "three_w_personal", "label": "3W personal", "units_by_year": {"2022-23": 612, "2023-24": 913, "2024-25": 991}},
            ],
            "FADA annual retail",
            "https://fada.in/images/press-release/169a8f8bd834feFADA%20releases%20February%202026%20Vehicle%20Retail%20Data.pdf",
            "2025-04-04",
            "Three-wheeler mix uses official FADA annual retail rows, including electric rickshaw passenger and cargo splits.",
        ),
        build_option(
            "CV",
            "Commercial Vehicles",
            [
                {"id": "lcv", "label": "LCV", "units_by_year": {"2022-23": 554585, "2023-24": 562026, "2024-25": 563189}},
                {"id": "hcv", "label": "HCV", "units_by_year": {"2022-23": 293796, "2023-24": 326150, "2024-25": 312892}},
                {"id": "mcv", "label": "MCV", "units_by_year": {"2022-23": 60818, "2023-24": 73142, "2024-25": 77568}},
                {"id": "others", "label": "Others", "units_by_year": {"2022-23": 30542, "2023-24": 49006, "2024-25": 54974}},
            ],
            "FADA annual retail",
            "https://fada.in/images/press-release/169a8f8bd834feFADA%20releases%20February%202026%20Vehicle%20Retail%20Data.pdf",
            "2025-04-04",
            "Commercial-vehicle mix uses official FADA annual retail rows for LCV, MCV, HCV and others.",
        ),
    ]

    validations.append({"status": "ok", "message": "Segment-share explorer rebuilt with recent FY23-FY25 official annual FADA and SIAM data."})

    return {
        "available": True,
        "title": "Segment-wise market share",
        "source_meta": {
            "name": "Recent official annual mix",
            "latest_month": None,
            "latest_release_date": "2025-08-31",
            "url": "https://www.siam.in/annualreports.aspx?mpgid=20&pgidtrail=50",
            "note": "This module now uses recent annual official data instead of the older Vahan class rollup. Source switches cleanly by category: FADA for total, 3W and CV retail mix; SIAM for PV and 2W domestic-sales mix.",
        },
        "method_note": source_message,
        "latest_full_year": latest_full_year,
        "latest_full_year_label": latest_full_year,
        "cagr_label": "FY23-25 CAGR",
        "table_years": [{"id": year, "label": year} for year in reversed(recent_years)],
        "trend_years": [{"id": year, "label": year} for year in recent_years],
        "default_option": "TOTAL",
        "options": option_items,
    }


def build_official_ev_module(ev_preview_rows: list[dict[str, Any]], validations: list[dict[str, str]]) -> dict[str, Any]:
    if not ev_preview_rows:
        validations.append({"status": "warning", "message": "Official EV preview stayed hidden because no recent public EV page snapshot was available."})
        return {
            "available": False,
            "title": "Official EV registrations preview",
            "hidden_reason": "No recent public EV preview snapshot was available.",
        }

    by_dataset = {item["dataset"]: item for item in ev_preview_rows}
    norms = by_dataset.get("norms")
    categories = by_dataset.get("category")
    latest_months = sorted(
        {
            item["latest_month"]
            for item in ev_preview_rows
            if item.get("latest_month")
        }
    )
    latest_month = latest_months[-1] if latest_months else None

    if latest_month:
        validations.append({"status": "ok", "message": f"Official EV preview updated through {month_label(latest_month)}."})

    top_norms = []
    if norms:
        top_norms = [
            {
                "label": f"{row['norms']} | {row['fuel']}",
                "value": row["value"],
                "month": row["month_key"],
            }
            for row in norms["rows"][:5]
        ]

    top_categories = []
    if categories:
        top_categories = [
            {
                "label": f"{row['vehicle_category']} | {row['fuel']}",
                "value": row["value"],
                "month": row["month_key"],
            }
            for row in categories["rows"][:5]
        ]

    return {
        "available": bool(top_norms or top_categories),
        "title": "Official EV registrations preview",
        "source_meta": {
            "name": "Dataful / Parivahan EV public pages",
            "latest_month": latest_month,
            "latest_release_date": norms.get("last_updated") if norms else categories.get("last_updated") if categories else None,
            "url": norms.get("url") if norms else categories.get("url") if categories else None,
            "note": (
                "This panel uses the latest public preview rows from the 2026 EV pages. "
                "It is a recent directional read, not the full downloadable EV table."
            ),
        },
        "norms_preview": top_norms,
        "category_preview": top_categories,
        "links": [item["url"] for item in ev_preview_rows if item.get("url")],
    }


def build_summary(
    retail: dict[str, Any],
    wholesale: dict[str, Any],
    components: dict[str, Any],
    registration: dict[str, Any],
    state_registration: dict[str, Any],
    official_ev: dict[str, Any],
    source_health: list[dict[str, Any]],
) -> dict[str, Any]:
    retail_snapshot = retail["latest_snapshot"]
    best_segment = retail_snapshot["top_category_yoy"]
    ev_snapshot = retail["ev_penetration_series"][-1]
    inventory = retail_snapshot["inventory_days"]
    pv_compare = next(item for item in wholesale["retail_vs_wholesale"] if item["category"] == "PV")

    inventory_first = retail["inventory_trend"][0]
    inventory_detail = (
        f"Improved from {inventory_first['days_low']}-{inventory_first['days_high']} days in "
        f"{inventory_first['label']} to {format_inventory_range(inventory)} now."
    )
    retail_month_label = month_label(retail["latest_month"])
    wholesale_month_label = month_label(wholesale["latest_month"])
    if retail["latest_month"] == wholesale["latest_month"]:
        rw_detail = f"FADA {retail_month_label} retail vs SIAM {wholesale_month_label} wholesale."
    else:
        rw_detail = (
            f"FADA {retail_month_label} retail vs SIAM {wholesale_month_label} wholesale "
            "— SIAM is one cycle behind, so this gap mixes months."
        )

    cards = [
        {
            "id": "latest_retail",
            "label": "Latest Retail",
            "value": retail_snapshot["total_units"],
            "display": format_lakh(retail_snapshot["total_units"]),
            "change": f"{retail_snapshot['total_yoy_pct']:+.2f}% YoY",
            "detail": f"{retail_snapshot['total_mom_pct']:+.2f}% MoM | FADA {retail_month_label}",
            "tone": "primary",
        },
        {
            "id": "latest_ev_penetration",
            "label": "Derived EV Penetration",
            "value": ev_snapshot["overall_ev_pct"],
            "display": format_pct(ev_snapshot["overall_ev_pct"]),
            "change": f"{format_lakh(ev_snapshot['overall_ev_units'])} EV retail units",
            "detail": (
                "EV units summed from FADA's 2W/3W/PV/CV fuel-mix shares (tractors and CE "
                "have negligible EV share); denominator is total retail."
            ),
            "tone": "good",
        },
        {
            "id": "strongest_segment",
            "label": "Strongest Segment",
            "value": best_segment["yoy_pct"],
            "display": best_segment["label"],
            "change": f"{best_segment['yoy_pct']:+.2f}% YoY",
            "detail": f"{format_lakh(best_segment['units'])} in {retail_month_label}",
            "tone": "warm",
        },
        {
            "id": "pv_inventory",
            "label": "PV Inventory",
            "value": inventory["days_mid"],
            "display": format_inventory_range(inventory),
            "change": "FADA dealer channel view",
            "detail": inventory_detail,
            "tone": "neutral",
        },
        {
            "id": "pv_retail_vs_wholesale",
            "label": "PV Retail / Wholesale",
            "value": pv_compare["ratio_pct"],
            "display": format_pct(pv_compare["ratio_pct"]),
            "change": f"{pv_compare['gap_units']:+,} unit gap",
            "detail": rw_detail,
            "tone": "neutral",
        },
        {
            "id": "dealer_outlook",
            "label": "Dealer Growth View",
            "value": retail["latest_channel_pulse"]["growth_expectation_next_month_pct"],
            "display": format_pct(retail["latest_channel_pulse"]["growth_expectation_next_month_pct"]),
            "change": "Expect growth next month",
            "detail": f"{format_pct(retail['latest_channel_pulse']['growth_expectation_next_three_months_pct'])} expect growth over the next three months.",
            "tone": "good",
        },
    ]

    source_badges = [
        {
            "source": retail["source_meta"]["name"],
            "status": "active",
            "module": "Retail",
            "last_updated": retail["source_meta"]["latest_release_date"],
            "detail": retail["source_meta"]["note"],
            "url": retail["source_meta"]["url"],
        },
        {
            "source": wholesale["source_meta"]["name"],
            "status": "active",
            "module": "Wholesale",
            "last_updated": wholesale["source_meta"]["latest_release_date"],
            "detail": wholesale["source_meta"]["note"],
            "url": wholesale["source_meta"]["url"],
        },
        {
            "source": components["source_meta"]["name"],
            "status": "active",
            "module": "Components",
            "last_updated": components["source_meta"]["latest_release_date"],
            "detail": components["source_meta"]["note"],
            "url": components["source_meta"]["url"],
        },
    ]
    if registration["available"]:
        source_badges.append(
            {
                "source": "Vahan",
                "status": "active",
                "module": "Registrations",
                "last_updated": registration["source_meta"]["latest_release_date"],
                "detail": registration["source_meta"]["note"],
                "url": registration["source_meta"]["url"],
            }
        )
    if state_registration["available"]:
        source_badges.append(
            {
                "source": state_registration["source_meta"]["name"],
                "status": "active",
                "module": "State registrations",
                "last_updated": state_registration["source_meta"]["latest_release_date"],
                "detail": state_registration["source_meta"]["note"],
                "url": state_registration["source_meta"]["url"],
            }
        )
    for item in source_health:
        if item["source"] not in {"Vahan", "Vahan state registrations", "Official EV preview", "Vahan segment market share"}:
            source_badges.append(
                {
                    "source": item["source"],
                    "status": item["status"],
                    "module": "Context",
                    "last_updated": None,
                    "detail": item["message"],
                    "url": None,
                }
            )

    return {
        "cards": cards,
        "source_badges": source_badges,
        "active_module_count": 3 + int(registration["available"]) + int(state_registration["available"]),
        "hidden_modules": [],
    }


def build_filters(retail: dict[str, Any], wholesale: dict[str, Any], registration: dict[str, Any]) -> dict[str, Any]:
    months = sorted({item["month"] for item in retail["months"]} | {item["month"] for item in wholesale["months"]})
    if registration["available"]:
        months = sorted({*months, *(item["month"] for item in registration["months"])})

    lenses = [
        {"id": "all", "label": "All lenses"},
        {"id": "retail", "label": "Retail"},
        {"id": "wholesale", "label": "Wholesale"},
        {"id": "components", "label": "Components"},
        {"id": "ev", "label": "EV"},
    ]
    if registration["available"]:
        lenses.insert(2, {"id": "registration", "label": "Registrations"})

    return {
        "months": [{"id": month, "label": month_label(month)} for month in months],
        "window_options": [
            {"id": "3m", "label": "Last 3 months", "count": 3},
            {"id": "5m", "label": "Last 5 months", "count": 5},
            {"id": "all", "label": "All available", "count": len(months)},
        ],
        "default_window": "5m",
        "categories": [{"id": key, "label": CATEGORY_LABELS[key]} for key in CATEGORY_ORDER],
        "fuels": [{"id": fuel, "label": fuel} for fuel in FUEL_ORDER],
        "lenses": lenses,
        "companies": [
            {"id": company, "label": company, "categories": details["categories"], "lens": details["lens"]}
            for company, details in sorted(LISTED_COMPANY_MAP.items())
        ],
    }


def build_company_map() -> list[dict[str, Any]]:
    revenue_tables = build_company_revenue_breakdowns()
    return [
        {
            "company": company,
            "summary": details.get("management_commentary", details["summary"]),
            "is_management_commentary": bool(details.get("management_commentary")),
            "summary_source_url": details.get("management_source_url"),
            "summary_source_label": details.get("management_source_label"),
            "categories": details["categories"],
            "category_labels": [CATEGORY_LABELS.get(category, category) for category in details["categories"]],
            "lens": details["lens"],
            "revenue_table": revenue_tables.get(company),
        }
        for company, details in sorted(LISTED_COMPANY_MAP.items())
    ]


def build_investor_insights(
    retail: dict[str, Any],
    wholesale: dict[str, Any],
    components: dict[str, Any],
    registration: dict[str, Any],
) -> list[dict[str, Any]]:
    latest_categories = [item for item in retail["category_cards"] if item["category"] != "TOTAL"]
    fastest = max(latest_categories, key=lambda item: item["yoy_pct"])
    slowest = min(latest_categories, key=lambda item: item["yoy_pct"])

    pv_rows = [row for row in table_rows(retail["latest_oem_tables"]["PV"]) if row["oem"] != "Others"]
    two_w_rows = [row for row in table_rows(retail["latest_oem_tables"]["2W"]) if row["oem"] != "Others"]
    pv_gainer = max(pv_rows, key=lambda item: item["share_change_pp"])
    pv_loser = min(pv_rows, key=lambda item: item["share_change_pp"])
    two_w_gainer = max(two_w_rows, key=lambda item: item["share_change_pp"])
    two_w_loser = min(two_w_rows, key=lambda item: item["share_change_pp"])

    pv_compare = next(item for item in wholesale["retail_vs_wholesale"] if item["category"] == "PV")
    two_w_compare = next(item for item in wholesale["retail_vs_wholesale"] if item["category"] == "2W")
    ev_snapshot = retail["ev_penetration_series"][-1]
    ev_leader = max(ev_snapshot["by_category"], key=lambda item: item["ev_share_pct"])

    retail_month = month_label(retail["latest_month"])
    inventory_latest = retail["latest_snapshot"]["inventory_days"]
    inventory_signal = format_inventory_range(inventory_latest)
    if retail["latest_month"] == wholesale["latest_month"]:
        rw_period_phrase = f"in {retail_month}"
    else:
        rw_period_phrase = (
            f"with FADA {retail_month} retail over SIAM {month_label(wholesale['latest_month'])} wholesale"
        )

    insights = [
        {
            "title": "Segment speed",
            "body": f"{fastest['label']} were the fastest-growing retail category in {retail_month} at {fastest['yoy_pct']:+.2f}% YoY, while {slowest['label']} stayed weakest at {slowest['yoy_pct']:+.2f}% YoY.",
            "tags": ["retail"],
        },
        {
            "title": "OEM share shifts",
            "body": f"In PV retail, {pv_gainer['oem']} gained the most share at {pv_gainer['share_change_pp']:+.2f} pp YoY, while {pv_loser['oem']} lost {pv_loser['share_change_pp']:+.2f} pp. In 2W, the biggest gainer was {two_w_gainer['oem']} at {two_w_gainer['share_change_pp']:+.2f} pp, while {two_w_loser['oem']} was the sharpest loser at {two_w_loser['share_change_pp']:+.2f} pp.",
            "tags": ["retail", "oem"],
        },
        {
            "title": "Retail vs wholesale",
            "body": f"PV retail ran at {pv_compare['ratio_pct']:.1f}% of wholesale {rw_period_phrase}, versus {two_w_compare['ratio_pct']:.1f}% for 2W. The tighter PV ratio sits alongside FADA's {inventory_signal} inventory signal, suggesting channel conditions have improved materially.",
            "tags": ["retail", "wholesale"],
        },
        {
            "title": "EV transition",
            "body": f"Derived EV penetration in {retail_month} was {ev_snapshot['overall_ev_pct']:.2f}% of retail volume. The strongest EV mix remains in {ev_leader['label']} at {ev_leader['ev_share_pct']:.2f}%, while PV EV share stayed below 4%, which keeps battery, drivetrain and power-electronics suppliers more leveraged than OEM headline units alone.",
            "tags": ["ev"],
        },
        {
            "title": "Component read-across",
            "body": "ACMA's FY25 review still points to a healthy ancillary backdrop: OEM supplies grew 10% YoY, exports grew 8%, and aftermarket grew 6%. That supports continued interest in export-capable, value-added suppliers even if near-term OEM mix shifts month to month.",
            "tags": ["components"],
        },
    ]

    return insights


def validate_month_continuity(months: list[str], label: str, validations: list[dict[str, str]]) -> None:
    parsed = [datetime.strptime(month, "%Y-%m") for month in months]
    gap_found = False
    for previous, current in zip(parsed, parsed[1:], strict=False):
        expected_year = previous.year + (1 if previous.month == 12 else 0)
        expected_month = 1 if previous.month == 12 else previous.month + 1
        if (current.year, current.month) != (expected_year, expected_month):
            gap_found = True
            break
    validations.append({"status": "ok" if not gap_found else "warning", "message": f"{label} month continuity {'validated' if not gap_found else 'has gaps'}."})


def mapped_companies_for_category(category: str) -> list[str]:
    return sorted(
        company
        for company, details in LISTED_COMPANY_MAP.items()
        if category in details["categories"]
    )


def month_label(month: str) -> str:
    return datetime.strptime(month, "%Y-%m").strftime("%b %Y")


def month_offset(month: str, delta_months: int) -> str:
    parsed = datetime.strptime(month, "%Y-%m")
    total = parsed.year * 12 + (parsed.month - 1) + delta_months
    return f"{total // 12:04d}-{(total % 12) + 1:02d}"


PV_OEM_HISTORY_PATH = Path("data/pv_oem_history.json")


def load_pv_oem_history() -> list[dict[str, Any]]:
    if not PV_OEM_HISTORY_PATH.exists():
        return []
    try:
        payload = json.loads(PV_OEM_HISTORY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    months = payload.get("months") if isinstance(payload, dict) else None
    if not isinstance(months, list):
        return []
    return [item for item in months if isinstance(item, dict) and item.get("month")]


def _safe_pct_change(current: float | int | None, prior: float | int | None) -> float | None:
    if current is None or prior is None:
        return None
    try:
        prior_value = float(prior)
        current_value = float(current)
    except (TypeError, ValueError):
        return None
    if not prior_value:
        return None
    return round((current_value / prior_value - 1) * 100, 2)


def _safe_cagr(current: float | int | None, prior: float | int | None, periods: int) -> float | None:
    if current is None or prior is None or periods <= 0:
        return None
    try:
        prior_value = float(prior)
        current_value = float(current)
    except (TypeError, ValueError):
        return None
    if prior_value <= 0 or current_value <= 0:
        return None
    return round(((current_value / prior_value) ** (1 / periods) - 1) * 100, 2)


def build_periodized_pv_oem_table_from_history(
    category: str,
    latest_rows: list[dict[str, Any]],
    history: list[dict[str, Any]],
    latest_month: str,
    source_url: str | None,
) -> dict[str, Any]:
    """Build a periodized PV OEM table whose growth columns are computed from
    real monthly OEM history rather than left as n.m. Currently exposes the
    monthly view; quarterly/yearly come once we have richer history."""
    history_by_month = {
        item["month"]: {row["oem"]: row for row in item.get("rows") or []}
        for item in history
        if item.get("month")
    }

    def lookup_units(month_back: int, oem: str) -> int | None:
        target = month_offset(latest_month, -month_back)
        record = history_by_month.get(target, {}).get(oem)
        return record.get("units") if record else None

    rows: list[dict[str, Any]] = []
    for row in latest_rows:
        oem = row["oem"]
        units = row.get("units")
        prior_units = row.get("prior_units")

        u1 = lookup_units(1, oem)
        u3 = lookup_units(3, oem)
        u12 = lookup_units(12, oem) or prior_units
        u24 = lookup_units(24, oem)

        rows.append(
            {
                "oem": oem,
                "current_units": units,
                "mom_pct": _safe_pct_change(units, u1),
                "yoy_pct": row.get("unit_growth_pct"),
                "growth_3m_pct": _safe_pct_change(units, u3),
                "growth_12m_pct": _safe_pct_change(units, u12),
                "cagr_12m_pct": _safe_cagr(units, u12, 1),
                "cagr_24m_pct": _safe_cagr(units, u24, 2),
                "share_pct": row.get("share_pct"),
                "share_change_pp": row.get("share_change_pp"),
                "listed_companies": row.get("listed_companies", []),
            }
        )

    available_months = sorted(history_by_month.keys())
    coverage_note = (
        f"Computed from FADA's monthly PV OEM annexure across {len(available_months)} months "
        f"({available_months[0]} → {available_months[-1]}). Some columns may be n.m. for OEMs "
        "that didn't exist in the comparison month."
    ) if available_months else "PV OEM annexure history pending; add months via the backfill workflow."

    return {
        "category": category,
        "label": CATEGORY_LABELS.get(category, category),
        "mode": "periodized",
        "default_period": "M",
        "periods": {
            "M": {
                "id": "M",
                "label": "Monthly",
                "period_label": month_label(latest_month),
                "columns": [
                    {"key": "oem", "label": "OEM"},
                    {"key": "current_units", "label": "Current Units", "type": "int"},
                    {"key": "mom_pct", "label": "MoM%", "type": "pct"},
                    {"key": "yoy_pct", "label": "YoY%", "type": "pct"},
                    {"key": "growth_3m_pct", "label": "3M Growth", "type": "pct"},
                    {"key": "growth_12m_pct", "label": "12M Growth", "type": "pct"},
                    {"key": "cagr_12m_pct", "label": "12M CAGR", "type": "pct"},
                    {"key": "cagr_24m_pct", "label": "24M CAGR", "type": "pct"},
                    {"key": "share_pct", "label": "Current Market Share", "type": "pct"},
                    {"key": "share_change_pp", "label": "Share Chg", "type": "pp"},
                ],
                "rows": rows,
                "note": coverage_note,
            },
        },
        "source_meta": {
            "name": "FADA",
            "url": source_url,
            "latest_month": latest_month,
            "latest_label": month_label(latest_month),
            "note": "Periodized growth metrics computed from FADA's monthly OEM annexure history.",
        },
    }


def quarter_key(month: str) -> str:
    parsed = datetime.strptime(month, "%Y-%m")
    quarter = (parsed.month - 1) // 3 + 1
    return f"{parsed.year}-Q{quarter}"


def quarter_label(quarter: str) -> str:
    year, quarter_name = quarter.split("-")
    return f"{quarter_name} {year}"


def previous_year_quarter(quarter: str) -> str:
    year_text, quarter_name = quarter.split("-")
    return f"{int(year_text) - 1}-{quarter_name}"


def fiscal_year_key(month: str) -> str:
    parsed = datetime.strptime(month, "%Y-%m")
    if parsed.month >= 4:
        return f"{parsed.year}-{str(parsed.year + 1)[-2:]}"
    return f"{parsed.year - 1}-{str(parsed.year)[-2:]}"


def fiscal_year_sort_key(fiscal_year: str) -> int:
    return int(fiscal_year.split("-")[0])


def format_lakh(value: float | int) -> str:
    return f"{value / 100000:.2f} lakh"


def format_pct(value: float | int) -> str:
    return f"{value:.1f}%"


def format_inventory_range(inventory: dict[str, Any]) -> str:
    low, high = inventory["days_low"], inventory["days_high"]
    if low == high:
        return f"~{low} days"
    return f"{low}-{high} days"


def table_rows(table: dict[str, Any]) -> list[dict[str, Any]]:
    if not table:
        return []
    if table.get("mode") not in {"vahan_live", "periodized"}:
        return list(table.get("rows") or [])

    periods = table.get("periods") or {}
    selected_period = periods.get(table.get("default_period")) if table.get("default_period") else None
    if not selected_period and periods:
        selected_period = next(iter(periods.values()))
    return list((selected_period or {}).get("rows") or [])


def build_periodized_fada_oem_table(
    category: str,
    rows: list[dict[str, Any]],
    latest_month: str,
    source_url: str | None,
) -> dict[str, Any]:
    month_period_rows = []
    quarter_period_rows = []
    year_period_rows = []

    for row in rows:
        month_period_rows.append(
            {
                "oem": row["oem"],
                "current_units": row["units"],
                "mom_pct": None,
                "yoy_pct": row.get("unit_growth_pct"),
                "growth_3m_pct": None,
                "growth_12m_pct": None,
                "cagr_12m_pct": None,
                "cagr_24m_pct": None,
                "share_pct": row.get("share_pct"),
                "share_change_pp": row.get("share_change_pp"),
                "listed_companies": row.get("listed_companies", []),
            }
        )
        quarter_period_rows.append(
            {
                "oem": row["oem"],
                "current_units": row["units"],
                "qoq_pct": None,
                "yoy_pct": row.get("unit_growth_pct"),
                "growth_2q_pct": None,
                "growth_4q_pct": None,
                "cagr_4q_pct": None,
                "cagr_8q_pct": None,
                "cagr_12q_pct": None,
                "share_pct": row.get("share_pct"),
                "share_change_pp": row.get("share_change_pp"),
                "listed_companies": row.get("listed_companies", []),
            }
        )
        year_period_rows.append(
            {
                "oem": row["oem"],
                "current_units": row["units"],
                "yoy_pct": row.get("unit_growth_pct"),
                "growth_3y_pct": None,
                "growth_5y_pct": None,
                "cagr_2y_pct": None,
                "cagr_3y_pct": None,
                "cagr_5y_pct": None,
                "share_pct": row.get("share_pct"),
                "listed_companies": row.get("listed_companies", []),
            }
        )

    return {
        "category": category,
        "label": CATEGORY_LABELS.get(category, category),
        "mode": "periodized",
        "default_period": "M",
        "periods": {
            "M": {
                "id": "M",
                "label": "Monthly",
                "period_label": month_label(latest_month),
                "columns": [
                    {"key": "oem", "label": "OEM"},
                    {"key": "current_units", "label": "Current Units", "type": "int"},
                    {"key": "mom_pct", "label": "MoM%", "type": "pct"},
                    {"key": "yoy_pct", "label": "YoY%", "type": "pct"},
                    {"key": "growth_3m_pct", "label": "3M Growth", "type": "pct"},
                    {"key": "growth_12m_pct", "label": "12M Growth", "type": "pct"},
                    {"key": "cagr_12m_pct", "label": "12M CAGR / Annualized Growth", "type": "pct"},
                    {"key": "cagr_24m_pct", "label": "24M CAGR", "type": "pct"},
                    {"key": "share_pct", "label": "Current Market Share", "type": "pct"},
                    {"key": "share_change_pp", "label": "Share Chg", "type": "pp"},
                ],
                "rows": month_period_rows,
                "note": (
                    "FADA remains the anchor source for the latest PV OEM retail snapshot. "
                    "YoY, current market share and share change come from the validated FADA annexure. "
                    "Additional monthly-window fields stay as n.m. until broader structured OEM history is wired across FADA, SIAM, Rushlane and Parivahan."
                ),
            },
            "Q": {
                "id": "Q",
                "label": "Quarterly",
                "period_label": month_label(latest_month),
                "columns": [
                    {"key": "oem", "label": "OEM"},
                    {"key": "current_units", "label": "Current Units", "type": "int"},
                    {"key": "qoq_pct", "label": "QoQ%", "type": "pct"},
                    {"key": "yoy_pct", "label": "YoY%", "type": "pct"},
                    {"key": "growth_2q_pct", "label": "2Q Growth", "type": "pct"},
                    {"key": "growth_4q_pct", "label": "4Q Growth", "type": "pct"},
                    {"key": "cagr_4q_pct", "label": "4Q CAGR", "type": "pct"},
                    {"key": "cagr_8q_pct", "label": "8Q CAGR", "type": "pct"},
                    {"key": "cagr_12q_pct", "label": "12Q CAGR", "type": "pct"},
                    {"key": "share_pct", "label": "Current Market Share", "type": "pct"},
                    {"key": "share_change_pp", "label": "Share Chg", "type": "pp"},
                ],
                "rows": quarter_period_rows,
                "note": (
                    "The quarterly PV view keeps the current validated FADA OEM retail ranking in place and exposes the requested quarter-window schema. "
                    "Quarter-window growth fields will populate as we add structured OEM history from the public source chain."
                ),
            },
            "Y": {
                "id": "Y",
                "label": "Yearly",
                "period_label": f"YTD through {month_label(latest_month)}",
                "columns": [
                    {"key": "oem", "label": "OEM"},
                    {"key": "current_units", "label": "Current Units", "type": "int"},
                    {"key": "yoy_pct", "label": "YoY%", "type": "pct"},
                    {"key": "growth_3y_pct", "label": "3 Year Growth", "type": "pct"},
                    {"key": "growth_5y_pct", "label": "5 Year Growth", "type": "pct"},
                    {"key": "cagr_2y_pct", "label": "2Y CAGR", "type": "pct"},
                    {"key": "cagr_3y_pct", "label": "3Y CAGR", "type": "pct"},
                    {"key": "cagr_5y_pct", "label": "5Y CAGR", "type": "pct"},
                    {"key": "share_pct", "label": "Current Market Share", "type": "pct"},
                ],
                "rows": year_period_rows,
                "note": (
                    "The yearly PV view keeps the latest validated FADA OEM retail table as the anchor while reserving long-horizon growth columns for structured OEM history. "
                    "This avoids inventing annual growth where the current snapshot does not yet carry a validated multi-year OEM series."
                ),
            },
        },
        "source_meta": {
            "name": "FADA",
            "url": source_url,
            "validation_url": "https://analytics.parivahan.gov.in/analytics/publicdashboard/vahan?lang=en",
            "latest_month": latest_month,
            "latest_label": month_label(latest_month),
            "note": "Primary source is FADA. SIAM, Rushlane and Parivahan remain the supporting source chain for future PV OEM history enrichment.",
        },
    }


def build_live_vahan_oem_table(
    cache: dict[str, Any] | None,
    segment_id: str,
    validations: list[dict[str, str]],
) -> dict[str, Any] | None:
    if not cache:
        return None

    segment_bucket = (((cache or {}).get("segments") or {}).get(segment_id) or {})
    year_buckets = segment_bucket.get("years") or {}
    if not year_buckets:
        return None

    maker_months = collect_vahan_maker_months(year_buckets)
    if not maker_months:
        return None

    totals_by_month = aggregate_month_totals(maker_months)
    latest_month = latest_nonzero_month(totals_by_month)
    if not latest_month:
        return None

    validate_month_continuity(sorted(totals_by_month), f"Parivahan {segment_bucket.get('label', segment_id)} OEM", validations)

    if segment_id == "2W":
        rolling_quarter_period = build_live_rolling_quarter_period(maker_months, totals_by_month, latest_month)
        available_periods = {
            period["id"]: period
            for period in [rolling_quarter_period]
            if period and period.get("rows")
        }
        default_period = "Q"
        source_note = (
            "Primary source: non-www analytics.parivahan.gov.in public dashboard. "
            "Validation and export fallback: vahan.parivahan.gov.in report view. "
            "2W tracker uses the latest rolling quarter ending the latest live month, so one refresh updates the table as soon as a new month lands."
        )
    else:
        monthly_period = build_live_month_period(maker_months, totals_by_month, latest_month)
        quarterly_period = build_live_quarter_period(maker_months, totals_by_month)
        yearly_period = build_live_year_period(maker_months, totals_by_month, latest_month)
        available_periods = {
            period["id"]: period
            for period in [monthly_period, quarterly_period, yearly_period]
            if period and period.get("rows")
        }
        default_period = "M" if "M" in available_periods else next(iter(available_periods), "M")
        source_note = "Official maker-wise registrations from Parivahan Vahan. M uses live month, Q uses latest completed quarter, and Y uses current YTD against the same month-cut in prior years."

    if not available_periods:
        return None

    validations.append({"status": "ok", "message": f"Official Parivahan {segment_bucket.get('label', segment_id)} maker-wise tracker refreshed through {month_label(latest_month)}."})

    return {
        "category": segment_id,
        "label": segment_bucket.get("label", CATEGORY_LABELS.get(segment_id, segment_id)),
        "mode": "vahan_live",
        "default_period": default_period,
        "periods": available_periods,
        "source_meta": {
            "name": "Parivahan Vahan",
            "url": cache.get("source_url"),
            "validation_url": cache.get("validation_url"),
            "latest_month": latest_month,
            "latest_label": month_label(latest_month),
            "generated_at": cache.get("generated_at"),
            "note": source_note,
        },
    }


def collect_vahan_maker_months(year_buckets: dict[str, Any]) -> dict[str, dict[str, int]]:
    maker_months: dict[str, dict[str, int]] = defaultdict(dict)
    for _, year_bucket in sorted(year_buckets.items(), key=lambda item: int(item[0])):
        for row in year_bucket.get("rows", []):
            maker = str(row.get("maker") or "").strip()
            if not maker:
                continue
            for month, units in (row.get("months") or {}).items():
                maker_months[maker][month] = int(units or 0)
    return dict(maker_months)


def aggregate_month_totals(maker_months: dict[str, dict[str, int]]) -> dict[str, int]:
    totals: dict[str, int] = defaultdict(int)
    for months in maker_months.values():
        for month, units in months.items():
            totals[month] += int(units or 0)
    return dict(sorted(totals.items()))


def latest_nonzero_month(totals_by_month: dict[str, int]) -> str | None:
    for month, total in sorted(totals_by_month.items(), reverse=True):
        if total > 0:
            return month
    return None


def previous_month_key(month: str, steps: int = 1) -> str:
    parsed = datetime.strptime(month, "%Y-%m")
    year = parsed.year
    month_number = parsed.month
    for _ in range(steps):
        month_number -= 1
        if month_number == 0:
            month_number = 12
            year -= 1
    return f"{year}-{month_number:02d}"


def same_month_prior_year(month: str, years_back: int = 1) -> str:
    parsed = datetime.strptime(month, "%Y-%m")
    return f"{parsed.year - years_back}-{parsed.month:02d}"


def quarter_months(year: int, quarter: int) -> list[str]:
    start_month = (quarter - 1) * 3 + 1
    return [f"{year}-{month:02d}" for month in range(start_month, start_month + 3)]


def quarter_sequence_key(quarter: str) -> int:
    year_text, quarter_text = quarter.split("-Q")
    return int(year_text) * 4 + int(quarter_text)


def shift_quarter(quarter: str, delta: int) -> str:
    sequence = quarter_sequence_key(quarter) + delta
    year = (sequence - 1) // 4
    quarter_number = (sequence - 1) % 4 + 1
    return f"{year}-Q{quarter_number}"


def aggregate_quarter_totals(
    maker_months: dict[str, dict[str, int]],
    totals_by_month: dict[str, int],
) -> tuple[dict[str, dict[str, int]], list[str], str | None]:
    complete_quarters: list[str] = []
    quarter_totals_by_maker: dict[str, dict[str, int]] = defaultdict(dict)

    month_keys = sorted(totals_by_month)
    seen_quarters = sorted({quarter_key(month) for month in month_keys}, key=quarter_sequence_key)
    for quarter in seen_quarters:
        year_text, quarter_text = quarter.split("-Q")
        months = quarter_months(int(year_text), int(quarter_text))
        if all(totals_by_month.get(month, 0) > 0 for month in months):
            complete_quarters.append(quarter)

    latest_completed = complete_quarters[-1] if complete_quarters else None
    for maker, months in maker_months.items():
        for quarter in complete_quarters:
            quarter_totals_by_maker[maker][quarter] = sum(int(months.get(month, 0)) for month in quarter_months(int(quarter[:4]), int(quarter[-1])))

    return dict(quarter_totals_by_maker), complete_quarters, latest_completed


def aggregate_ytd_totals(
    maker_months: dict[str, dict[str, int]],
    cutoff_month: int,
) -> dict[str, dict[int, int]]:
    year_totals: dict[str, dict[int, int]] = defaultdict(dict)
    years = sorted({int(month[:4]) for months in maker_months.values() for month in months})
    for maker, months in maker_months.items():
        for year in years:
            total = sum(int(months.get(f"{year}-{month_number:02d}", 0)) for month_number in range(1, cutoff_month + 1))
            year_totals[maker][year] = total
    return dict(year_totals)


def pct_change(current: int | float | None, base: int | float | None) -> float | None:
    if current is None or base in (None, 0):
        return None
    return round(((current - base) / base) * 100, 2)


def cagr_pct(current: int | float | None, base: int | float | None, years: float) -> float | None:
    if current is None or base in (None, 0) or years <= 0:
        return None
    if current <= 0 or base <= 0:
        return None
    return round((math.pow(current / base, 1 / years) - 1) * 100, 2)


def share_pct(units: int | float, total: int | float) -> float | None:
    if not total:
        return None
    return round((units / total) * 100, 2)


def trailing_month_window(end_month: str, length: int) -> list[str]:
    months = [end_month]
    while len(months) < length:
        months.append(previous_month_key(months[-1], 1))
    return list(reversed(months))


def rolling_window_units(months: dict[str, int], end_month: str, length: int = 3) -> int:
    return sum(int(months.get(month, 0)) for month in trailing_month_window(end_month, length))


def rolling_window_total(
    maker_months: dict[str, dict[str, int]],
    end_month: str,
    length: int = 3,
) -> int:
    return sum(rolling_window_units(months, end_month, length) for months in maker_months.values())


def rolling_window_label(end_month: str, length: int = 3) -> str:
    months = trailing_month_window(end_month, length)
    return f"{month_label(months[0])} to {month_label(months[-1])}"


def maker_listed_companies(maker: str) -> list[str]:
    direct = OEM_TO_LISTED.get(maker)
    if direct:
        return direct

    normalized = maker.upper()
    if "TATA" in normalized:
        return ["Tata Motors"]
    if "MAHINDRA" in normalized:
        return ["Mahindra & Mahindra"]
    if "ASHOK" in normalized:
        return ["Ashok Leyland"]
    if "VE COMMERCIAL" in normalized or "VECV" in normalized or "EICHER" in normalized:
        return ["Eicher Motors"]
    if "MARUTI" in normalized:
        return ["Maruti Suzuki"]
    return []


def build_live_month_period(
    maker_months: dict[str, dict[str, int]],
    totals_by_month: dict[str, int],
    latest_month: str,
) -> dict[str, Any]:
    current_total = totals_by_month.get(latest_month, 0)
    prior_month = previous_month_key(latest_month, 1)
    prior_year_month = same_month_prior_year(latest_month, 1)
    prior_3m = previous_month_key(latest_month, 3)
    prior_12m = same_month_prior_year(latest_month, 1)
    prior_24m = same_month_prior_year(latest_month, 2)
    prior_year_total = totals_by_month.get(prior_year_month, 0)

    rows = []
    for maker, months in maker_months.items():
        current_units = int(months.get(latest_month, 0))
        if current_units <= 0:
            continue
        share_now = share_pct(current_units, current_total)
        share_prev = share_pct(int(months.get(prior_year_month, 0)), prior_year_total)
        rows.append(
            {
                "oem": maker.title() if maker.isupper() else maker,
                "current_units": current_units,
                "mom_pct": pct_change(current_units, int(months.get(prior_month, 0))),
                "yoy_pct": pct_change(current_units, int(months.get(prior_year_month, 0))),
                "growth_3m_pct": pct_change(current_units, int(months.get(prior_3m, 0))),
                "growth_12m_pct": pct_change(current_units, int(months.get(prior_12m, 0))),
                "cagr_24m_pct": cagr_pct(current_units, int(months.get(prior_24m, 0)), 2),
                "share_pct": share_now,
                "share_change_pp": round((share_now or 0) - (share_prev or 0), 2) if share_now is not None and share_prev is not None else None,
                "listed_companies": maker_listed_companies(maker),
            }
        )

    rows.sort(key=lambda item: item["current_units"], reverse=True)
    return {
        "id": "M",
        "label": "Monthly",
        "period_label": month_label(latest_month),
        "columns": [
            {"key": "oem", "label": "OEM"},
            {"key": "current_units", "label": "Current Units", "type": "int"},
            {"key": "mom_pct", "label": "MoM%", "type": "pct"},
            {"key": "yoy_pct", "label": "YoY%", "type": "pct"},
            {"key": "growth_3m_pct", "label": "3M growth", "type": "pct"},
            {"key": "growth_12m_pct", "label": "12M growth", "type": "pct"},
            {"key": "cagr_24m_pct", "label": "24M CAGR", "type": "pct"},
            {"key": "share_pct", "label": "Current Market Share", "type": "pct"},
            {"key": "share_change_pp", "label": "Share chg", "type": "pp"},
        ],
        "rows": rows,
        "note": f"Official Parivahan maker-wise registrations for {month_label(latest_month)}. Growth and share change are calculated in dashboard logic.",
    }


def build_live_quarter_period(
    maker_months: dict[str, dict[str, int]],
    totals_by_month: dict[str, int],
) -> dict[str, Any] | None:
    quarter_totals_by_maker, complete_quarters, latest_completed = aggregate_quarter_totals(maker_months, totals_by_month)
    if not latest_completed:
        return None

    current_total = sum(values.get(latest_completed, 0) for values in quarter_totals_by_maker.values())
    prior_quarter = shift_quarter(latest_completed, -1)
    prior_year_quarter = shift_quarter(latest_completed, -4)
    prior_2q = shift_quarter(latest_completed, -2)
    prior_4q = shift_quarter(latest_completed, -4)
    prior_8q = shift_quarter(latest_completed, -8)
    prior_12q = shift_quarter(latest_completed, -12)
    prior_year_total = sum(values.get(prior_year_quarter, 0) for values in quarter_totals_by_maker.values())

    rows = []
    for maker, values in quarter_totals_by_maker.items():
        current_units = int(values.get(latest_completed, 0))
        if current_units <= 0:
            continue
        share_now = share_pct(current_units, current_total)
        share_prev = share_pct(int(values.get(prior_year_quarter, 0)), prior_year_total)
        rows.append(
            {
                "oem": maker.title() if maker.isupper() else maker,
                "current_units": current_units,
                "qoq_pct": pct_change(current_units, int(values.get(prior_quarter, 0))),
                "yoy_pct": pct_change(current_units, int(values.get(prior_year_quarter, 0))),
                "growth_2q_pct": pct_change(current_units, int(values.get(prior_2q, 0))),
                "growth_4q_pct": pct_change(current_units, int(values.get(prior_4q, 0))),
                "cagr_4q_pct": cagr_pct(current_units, int(values.get(prior_4q, 0)), 1),
                "cagr_8q_pct": cagr_pct(current_units, int(values.get(prior_8q, 0)), 2),
                "cagr_12q_pct": cagr_pct(current_units, int(values.get(prior_12q, 0)), 3),
                "share_pct": share_now,
                "share_change_pp": round((share_now or 0) - (share_prev or 0), 2) if share_now is not None and share_prev is not None else None,
                "listed_companies": maker_listed_companies(maker),
            }
        )

    rows.sort(key=lambda item: item["current_units"], reverse=True)
    return {
        "id": "Q",
        "label": "Quarterly",
        "period_label": quarter_label(latest_completed),
        "columns": [
            {"key": "oem", "label": "OEM"},
            {"key": "current_units", "label": "Current Units", "type": "int"},
            {"key": "qoq_pct", "label": "QoQ%", "type": "pct"},
            {"key": "yoy_pct", "label": "YoY%", "type": "pct"},
            {"key": "growth_2q_pct", "label": "2Q growth", "type": "pct"},
            {"key": "growth_4q_pct", "label": "4Q growth", "type": "pct"},
            {"key": "cagr_4q_pct", "label": "4Q CAGR", "type": "pct"},
            {"key": "cagr_8q_pct", "label": "8Q CAGR", "type": "pct"},
            {"key": "cagr_12q_pct", "label": "12Q CAGR", "type": "pct"},
            {"key": "share_pct", "label": "Current Market Share", "type": "pct"},
            {"key": "share_change_pp", "label": "Share Chg", "type": "pp"},
        ],
        "rows": rows,
        "note": f"Official Parivahan maker-wise registrations aggregated into completed calendar quarters. Latest completed quarter shown is {quarter_label(latest_completed)}.",
    }


def build_live_rolling_quarter_period(
    maker_months: dict[str, dict[str, int]],
    totals_by_month: dict[str, int],
    latest_month: str,
) -> dict[str, Any] | None:
    current_total = rolling_window_total(maker_months, latest_month, 3)
    if current_total <= 0:
        return None

    prior_quarter_end = previous_month_key(latest_month, 3)
    prior_year_end = previous_month_key(latest_month, 12)
    prior_2q_end = previous_month_key(latest_month, 6)
    prior_4q_end = previous_month_key(latest_month, 12)
    prior_8q_end = previous_month_key(latest_month, 24)
    prior_12q_end = previous_month_key(latest_month, 36)
    prior_year_total = rolling_window_total(maker_months, prior_year_end, 3)

    rows = []
    for maker, months in maker_months.items():
        current_units = rolling_window_units(months, latest_month, 3)
        if current_units <= 0:
            continue
        prior_year_units = rolling_window_units(months, prior_year_end, 3)
        share_now = share_pct(current_units, current_total)
        share_prev = share_pct(prior_year_units, prior_year_total)
        rows.append(
            {
                "oem": maker.title() if maker.isupper() else maker,
                "current_units": current_units,
                "qoq_pct": pct_change(current_units, rolling_window_units(months, prior_quarter_end, 3)),
                "yoy_pct": pct_change(current_units, prior_year_units),
                "growth_2q_pct": pct_change(current_units, rolling_window_units(months, prior_2q_end, 3)),
                "growth_4q_pct": pct_change(current_units, rolling_window_units(months, prior_4q_end, 3)),
                "cagr_4q_pct": cagr_pct(current_units, rolling_window_units(months, prior_4q_end, 3), 1),
                "cagr_8q_pct": cagr_pct(current_units, rolling_window_units(months, prior_8q_end, 3), 2),
                "cagr_12q_pct": cagr_pct(current_units, rolling_window_units(months, prior_12q_end, 3), 3),
                "share_pct": share_now,
                "share_change_pp": round((share_now or 0) - (share_prev or 0), 2) if share_now is not None and share_prev is not None else None,
                "listed_companies": maker_listed_companies(maker),
            }
        )

    rows.sort(key=lambda item: item["current_units"], reverse=True)
    if not rows:
        return None

    return {
        "id": "Q",
        "label": "Rolling quarter",
        "period_label": rolling_window_label(latest_month, 3),
        "columns": [
            {"key": "oem", "label": "OEM"},
            {"key": "current_units", "label": "Current Units", "type": "int"},
            {"key": "qoq_pct", "label": "QoQ%", "type": "pct"},
            {"key": "yoy_pct", "label": "YoY%", "type": "pct"},
            {"key": "growth_2q_pct", "label": "2Q Growth", "type": "pct"},
            {"key": "growth_4q_pct", "label": "4Q Growth", "type": "pct"},
            {"key": "cagr_4q_pct", "label": "4Q CAGR", "type": "pct"},
            {"key": "cagr_8q_pct", "label": "8Q CAGR", "type": "pct"},
            {"key": "cagr_12q_pct", "label": "12Q CAGR", "type": "pct"},
            {"key": "share_pct", "label": "Current Market Share", "type": "pct"},
            {"key": "share_change_pp", "label": "Share Chg", "type": "pp"},
        ],
        "rows": rows,
        "note": (
            f"Official Parivahan 2W maker-wise registrations rolled into a live trailing 3-month window ending {month_label(latest_month)}. "
            "QoQ compares with the prior 3-month window, while YoY and share change compare with the same 3-month window one year back."
        ),
    }


def build_live_year_period(
    maker_months: dict[str, dict[str, int]],
    totals_by_month: dict[str, int],
    latest_month: str,
) -> dict[str, Any] | None:
    current_year = int(latest_month[:4])
    cutoff_month = int(latest_month[5:7])
    ytd_totals_by_maker = aggregate_ytd_totals(maker_months, cutoff_month)
    current_total = sum(values.get(current_year, 0) for values in ytd_totals_by_maker.values())
    prior_year_total = sum(values.get(current_year - 1, 0) for values in ytd_totals_by_maker.values())

    rows = []
    for maker, values in ytd_totals_by_maker.items():
        current_units = int(values.get(current_year, 0))
        if current_units <= 0:
            continue
        share_now = share_pct(current_units, current_total)
        share_prev = share_pct(int(values.get(current_year - 1, 0)), prior_year_total)
        rows.append(
            {
                "oem": maker.title() if maker.isupper() else maker,
                "current_units": current_units,
                "yoy_pct": pct_change(current_units, int(values.get(current_year - 1, 0))),
                "growth_3y_pct": pct_change(current_units, int(values.get(current_year - 3, 0))),
                "growth_5y_pct": pct_change(current_units, int(values.get(current_year - 5, 0))),
                "cagr_2y_pct": cagr_pct(current_units, int(values.get(current_year - 2, 0)), 2),
                "cagr_3y_pct": cagr_pct(current_units, int(values.get(current_year - 3, 0)), 3),
                "cagr_5y_pct": cagr_pct(current_units, int(values.get(current_year - 5, 0)), 5),
                "share_pct": share_now,
                "share_change_pp": round((share_now or 0) - (share_prev or 0), 2) if share_now is not None and share_prev is not None else None,
                "listed_companies": maker_listed_companies(maker),
            }
        )

    rows.sort(key=lambda item: item["current_units"], reverse=True)
    return {
        "id": "Y",
        "label": "Yearly",
        "period_label": f"CY {current_year} YTD",
        "columns": [
            {"key": "oem", "label": "OEM"},
            {"key": "current_units", "label": "Current Units", "type": "int"},
            {"key": "yoy_pct", "label": "YoY%", "type": "pct"},
            {"key": "growth_3y_pct", "label": "3 year growth", "type": "pct"},
            {"key": "growth_5y_pct", "label": "5 year growth", "type": "pct"},
            {"key": "cagr_2y_pct", "label": "2Y CAGR", "type": "pct"},
            {"key": "cagr_3y_pct", "label": "3Y CAGR", "type": "pct"},
            {"key": "cagr_5y_pct", "label": "5Y CAGR", "type": "pct"},
            {"key": "share_pct", "label": "Current Market Share", "type": "pct"},
        ],
        "rows": rows,
        "note": f"Official Parivahan maker-wise registrations rolled into CY {current_year} year-to-date through {month_label(latest_month)} and compared with the same cutoff in prior years.",
    }
