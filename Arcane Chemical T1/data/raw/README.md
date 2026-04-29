# Raw data inputs

These files are intentionally minimal templates. The dashboard hides modules that do not have enough validated data to render truthfully.

## Files

### `company_profile.json`

Use for company identity, description, and top-level metadata.

```json
{
  "company_name": "Arcane Chemical",
  "display_name": "Arcane Chemical Investor Dashboard",
  "as_of_date": null,
  "description": "",
  "website": "",
  "exchange": "",
  "ticker": "",
  "location": "",
  "sector": "",
  "ir_notes": "",
  "source_ids": []
}
```

### `financials.json`

Use for numeric time-series data. Keep the periods in the order you want the filter to show them, usually latest first.

```json
{
  "currency": "INR",
  "default_unit": "crore",
  "metrics": [
    {
      "key": "revenue",
      "label": "Revenue",
      "unit": "crore",
      "points": [
        {
          "period": "FY2025",
          "value": 0,
          "source_id": "",
          "as_of_date": "",
          "note": "",
          "caveat": ""
        }
      ]
    }
  ]
}
```

Delete example points with `0` before entering real figures. The build intentionally skips metrics without meaningful numeric values.

### `commentary.json`

Use for management or analyst-style notes that can be tied back to official sources.

```json
{
  "items": [
    {
      "title": "",
      "summary": "",
      "period": "",
      "source_id": "",
      "as_of_date": "",
      "caveat": ""
    }
  ]
}
```

### `sources.json`

Register the official source records used across the project.

```json
{
  "sources": [
    {
      "id": "fy25-ar",
      "name": "FY2025 Annual Report",
      "type": "annual_report",
      "url": "https://example.com",
      "latest_period": "FY2025",
      "refresh_date": "2026-03-28",
      "note": ""
    }
  ]
}
```

