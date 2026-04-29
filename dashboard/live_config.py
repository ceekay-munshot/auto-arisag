from __future__ import annotations

from dataclasses import dataclass


RECENT_WINDOW_DAYS = 60
MAX_ARTICLES = 180


@dataclass(frozen=True)
class SourceConfig:
    name: str
    kind: str
    url: str
    description: str
    source_type: str
    module_hint: str
    max_items: int = 25


@dataclass(frozen=True)
class TrackedCompany:
    label: str
    bse_code: str
    segments: tuple[str, ...]


SOURCES = [
    SourceConfig(
        name="BSE Corporate Announcements",
        kind="bse_detail",
        url="https://m.bseindia.com/MAnnDet.aspx?newsid=88007210-28f3-4231-8c6f-a9ad29a9c5a5&Form=STR&scrpcd=532500",
        description="Official company disclosure from BSE, including the latest validated investor-presentation filing.",
        source_type="official_filing",
        module_hint="filings",
        max_items=1,
    ),
    SourceConfig(
        name="SIAM Monthly Performance",
        kind="siam_detail",
        url="https://www.siam.in/news-&-updates/press-releases/auto-industry-performance-of-february-2026/603",
        description="Official monthly industry dispatch release from SIAM.",
        source_type="official_industry",
        module_hint="sales",
        max_items=1,
    ),
    SourceConfig(
        name="ET Auto",
        kind="rss",
        url="https://auto.economictimes.indiatimes.com/rss/topstories",
        description="Policy, OEM capex, supplier developments, and management commentary.",
        source_type="trade_media",
        module_hint="newsflow",
        max_items=40,
    ),
    SourceConfig(
        name="RushLane",
        kind="rss",
        url="https://www.rushlane.com/feed",
        description="Monthly sales commentary, launches, OEM channel checks, and luxury tracking.",
        source_type="trade_media",
        module_hint="newsflow",
        max_items=40,
    ),
    SourceConfig(
        name="Autocar Professional Sales",
        kind="rss",
        url="https://www.autocarpro.in/rssfeeds/analysis-sales",
        description="Trade-media sales analysis and demand read-through.",
        source_type="trade_media",
        module_hint="sales",
        max_items=20,
    ),
    SourceConfig(
        name="Autocar Professional EV",
        kind="rss",
        url="https://www.autocarpro.in/rssfeeds/category-ev",
        description="EV and transition coverage from an industry publication.",
        source_type="trade_media",
        module_hint="policy",
        max_items=20,
    ),
    SourceConfig(
        name="Autocar Professional Components",
        kind="rss",
        url="https://www.autocarpro.in/rssfeeds/category-auto-components",
        description="Auto-component and supplier coverage.",
        source_type="trade_media",
        module_hint="supplier",
        max_items=20,
    ),
    SourceConfig(
        name="EVreporter",
        kind="rss",
        url="https://evreporter.com/feed/",
        description="EV supply chain, batteries, charging, and powertrain transition themes.",
        source_type="specialist_ev",
        module_hint="supplier",
        max_items=30,
    ),
]


TRACKED_BSE_COMPANIES = [TrackedCompany("Maruti Suzuki", "532500", ("Passenger Vehicles",))]


BRAND_ALIASES = {
    "Maruti Suzuki": [r"\bmaruti(?:\s+suzuki)?\b", r"\bnexa\b", r"\bbrezza\b", r"\bfronx\b"],
    "Tata Motors": [r"\btata motors?\b", r"\btata\.ev\b", r"\btata ev\b", r"\bnexon\b", r"\bharrier\b", r"\bsierra\b"],
    "Mahindra": [r"\bmahindra\b", r"\bscorpio\b", r"\bthar\b", r"\bxuv\b", r"\bxev\b", r"\bbe\s?6\b"],
    "Hyundai": [r"\bhyundai\b"],
    "Kia": [r"\bkia\b"],
    "Toyota": [r"\btoyota\b"],
    "Honda": [r"\bhonda\b"],
    "MG Motor": [r"\b(?:jsw\s+)?mg motor\b", r"\bmg select\b"],
    "Renault": [r"\brenault\b", r"\bduster\b"],
    "Nissan": [r"\bnissan\b"],
    "Skoda": [r"\bskoda\b"],
    "Volkswagen": [r"\bvolkswagen\b", r"\bvw\b"],
    "Mercedes-Benz": [r"\bmercedes(?:-benz| benz)?\b", r"\bmaybach\b"],
    "BMW": [r"\bbmw\b", r"\bmini cooper\b"],
    "Audi": [r"\baudi\b"],
    "JLR": [r"\bjaguar land rover\b", r"\bjlr\b", r"\brange rover\b", r"\bland rover\b"],
    "Volvo": [r"\bvolvo\b"],
    "Porsche": [r"\bporsche\b"],
    "BYD": [r"\bbyd\b"],
    "Ather": [r"\bather\b"],
    "Ola Electric": [r"\bola electric\b"],
    "TVS Motor": [r"\btvs\b", r"\biqube\b", r"\bntorq\b", r"\bjupiter\b", r"\bapache\b"],
    "Bajaj Auto": [r"\bbajaj auto\b", r"\bbajaj\b", r"\bchetak\b"],
    "Hero MotoCorp": [r"\bhero motocorp\b", r"\bhero\b"],
    "Ashok Leyland": [r"\bashok leyland\b"],
    "VE Commercial": [r"\bvecv\b", r"\bve commercial\b", r"\beicher trucks\b"],
    "Euler Motors": [r"\beuler motors?\b", r"\beuler\b"],
    "Samvardhana Motherson": [r"\bsamvardhana motherson\b", r"\bmotherson\b"],
    "Sona BLW": [r"\bsona blw\b", r"\bsona comstar\b"],
    "Amara Raja": [r"\bamara raja\b"],
}


LUXURY_BRANDS = {"Mercedes-Benz", "BMW", "Audi", "JLR", "Volvo", "Porsche"}


SEGMENT_ALIASES = {
    "Passenger Vehicles": [r"\bpassenger vehicles?\b", r"\bpv\b", r"\bcars?\b", r"\bsuvs?\b", r"\bsedan\b", r"\bhatchback\b", r"\bmpv\b", r"\bcrossover\b"],
    "Two-Wheelers": [r"\btwo[- ]wheelers?\b", r"\b2w\b", r"\bmotorcycles?\b", r"\bbikes?\b", r"\bscooters?\b", r"\bmoped\b", r"\be-?2w\b"],
    "Commercial Vehicles": [r"\bcommercial vehicles?\b", r"\bcv\b", r"\blcv\b", r"\bmhcv\b", r"\btrucks?\b", r"\bbuses?\b", r"\bthree[- ]wheelers?\b", r"\b3w\b", r"\be-?rickshaw\b", r"\btractors?\b"],
    "EV": [r"\belectric vehicles?\b", r"\bevs?\b", r"\belectric mobility\b", r"\be-?2w\b", r"\be-?3w\b", r"\belectric\b", r"\bbattery\b", r"\bcharging\b", r"\bcharger\b", r"\bcell(?:s)?\b", r"\blithium\b", r"\bpm e-drive\b", r"\bfame\b"],
    "Components": [r"\bcomponent(?:s)?\b", r"\bauto components?\b", r"\bancillar(?:y|ies)\b", r"\bsupplier(?:s)?\b", r"\btyres?\b", r"\brubber\b", r"\bforging\b", r"\bbearings?\b", r"\bsemiconductors?\b", r"\belectronics\b", r"\bpowertrain\b"],
    "Luxury": [r"\bluxury\b", r"\bmaybach\b", r"\bmercedes(?:-benz| benz)?\b", r"\bbmw\b", r"\baudi\b", r"\brange rover\b", r"\bporsche\b"],
}


SIGNAL_ALIASES = {
    "Monthly Sales / Demand": [r"\bmonthly performance\b", r"\bdomestic sales\b", r"\bretail sales?\b", r"\bwholesale sales?\b", r"\bsales breakup\b", r"\bvehicle registrations?\b", r"\bretail registrations?\b", r"\bvehicle retail\b", r"\bchannel checks?\b"],
    "Capacity / Capex": [r"\bcapacity addition\b", r"\bcapacity expansion\b", r"\bcapex\b", r"\bnew plant\b", r"\bplant\b", r"\bexpansion\b", r"\bmanufacturing\b", r"\bfactory\b", r"\binvest(?:ment|ing)\b"],
    "Policy / Regulation": [r"\bpolicy\b", r"\bregulatory\b", r"\bnotification\b", r"\bscheme\b", r"\bsubsid(?:y|ies)\b", r"\bpli\b", r"\bpm e-drive\b", r"\bfame\b", r"\bgst\b", r"\bscrappage\b", r"\bemission norms?\b", r"\bsafety regulations?\b"],
    "Product / Launch": [r"\blaunch(?:es|ed)?\b", r"\bunveil(?:s|ed)?\b", r"\bdebut(?:s|ed)?\b", r"\bfacelift\b", r"\bvariant\b", r"\bfirst drive\b", r"\bspied testing\b"],
    "Management / Governance": [r"\bchange in management\b", r"\bmanagement reshuffle\b", r"\bappoint(?:ment|ed)\b", r"\bboard meeting\b", r"\banalyst meet\b", r"\binvestor meet\b", r"\bcon[- ]?call\b", r"\bconference call\b"],
    "Filing / Disclosure": [r"\binvestor presentation\b", r"\bannual report\b", r"\btranscript\b", r"\bresults?\b", r"\bdisclosure\b", r"\bregulation 30\b", r"\bpress release\b"],
    "Funding / M&A": [r"\bfunding\b", r"\braises?\b", r"\bstake\b", r"\bacquisition\b", r"\bmerger\b", r"\bjoint venture\b", r"\binfuse\b"],
    "Supply Chain / Components": [r"\bsupply chain\b", r"\bcomponent(?:s)?\b", r"\bsupplier(?:s)?\b", r"\bbattery\b", r"\bcell(?:s)?\b", r"\bcharging\b", r"\bsemiconductor(?:s)?\b", r"\bpowertrain\b"],
    "Input Costs / Commodities": [r"\brubber\b", r"\bsteel\b", r"\baluminium\b", r"\bcopper\b", r"\blead\b", r"\bnickel\b", r"\blithium\b", r"\bcommodity\b", r"\binput cost(?:s)?\b"],
}


HIGH_SIGNAL_PATTERNS = [
    r"\binvestor presentation\b",
    r"\bannual report\b",
    r"\btranscript\b",
    r"\bmonthly performance\b",
    r"\bcapacity addition\b",
    r"\bcapacity expansion\b",
    r"\bretail sales?\b",
    r"\bdomestic sales\b",
    r"\bpolicy\b",
    r"\bsubsid(?:y|ies)\b",
    r"\bplant\b",
    r"\bcapex\b",
]


BSE_DETAIL_KEYWORDS = [
    r"\binvestor presentation\b",
    r"\bannual report\b",
    r"\btranscript\b",
    r"\bcon[- ]?call\b",
    r"\bconference call\b",
    r"\bcapacity\b",
    r"\bcapex\b",
    r"\bplant\b",
    r"\bresults?\b",
    r"\bmanagement\b",
    r"\bregulation 30\b",
    r"\banalyst\b",
    r"\binvestor\b",
]
