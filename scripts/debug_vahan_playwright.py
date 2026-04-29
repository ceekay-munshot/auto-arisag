from pathlib import Path
import sys

from playwright.sync_api import sync_playwright


CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
URL = "https://vahan.parivahan.gov.in/vahan4dashboard/vahan/view/reportview.xhtml"
CV_CATEGORY_LABELS = [
    "LIGHT GOODS VEHICLE",
    "MEDIUM GOODS VEHICLE",
    "HEAVY GOODS VEHICLE",
    "LIGHT PASSENGER VEHICLE",
    "MEDIUM PASSENGER VEHICLE",
    "HEAVY PASSENGER VEHICLE",
    "LIGHT MOTOR VEHICLE",
    "MEDIUM MOTOR VEHICLE",
    "HEAVY MOTOR VEHICLE",
    "OTHER THAN MENTIONED ABOVE",
]


def set_select(page, selector: str, value: str, pause: int = 1500) -> None:
    page.wait_for_selector(selector, timeout=30_000)
    page.eval_on_selector(
        selector,
        "(el, value) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; }",
        value,
    )
    page.wait_for_timeout(pause)


def primefaces_select(page, select_selector: str, value: str, ajax_script: str, pause: int = 2000) -> None:
    page.wait_for_selector(select_selector, timeout=30_000, state="attached")
    page.eval_on_selector(
        select_selector,
        f"(el, value) => {{ el.value = value; {ajax_script} }}",
        value,
    )
    page.wait_for_timeout(pause)


def main() -> None:
    selected_year = sys.argv[1] if len(sys.argv) > 1 else "2026"
    initial_year = "2026"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=CHROME_PATH)
        page = browser.new_page(viewport={"width": 1600, "height": 1200})
        page.goto(URL, wait_until="domcontentloaded", timeout=120_000)
        primefaces_select(
            page,
            "#yaxisVar_input",
            "Maker",
            "PrimeFaces.ab({s:'yaxisVar',e:'change',f:'masterLayout_formlogin',p:'yaxisVar',u:'xaxisVar'});",
            2500,
        )
        primefaces_select(
            page,
            "#xaxisVar_input",
            "Month Wise",
            "PrimeFaces.ab({s:'xaxisVar',e:'change',f:'masterLayout_formlogin',p:'xaxisVar',u:'multipleYear'});",
            2500,
        )
        selected_year_type_class = page.locator("#selectedYearType").first.get_attribute("class") or ""
        if "ui-state-disabled" not in selected_year_type_class:
            primefaces_select(
                page,
                "#selectedYearType_input",
                "C",
                "PrimeFaces.ab({s:'selectedYearType',e:'change',f:'masterLayout_formlogin',p:'selectedYearType',u:'selectedYear'});",
                1000,
            )
        if selected_year != initial_year:
            primefaces_select(
                page,
                "#selectedYear_input",
                selected_year,
                "PrimeFaces.ab({s:'selectedYear',e:'change',f:'masterLayout_formlogin',p:'selectedYear',u:'selectedYear'});",
                1500,
            )
        for label in CV_CATEGORY_LABELS:
            page.get_by_text(label, exact=True).click()
            page.wait_for_timeout(150)
        page.get_by_role("button", name="Refresh").first.click()
        page.wait_for_timeout(5000)

        print("groupingTable count", page.locator("#groupingTable").count())
        print("vchgroupTable count", page.locator("#vchgroupTable").count())
        print("xls count", page.locator("#groupingTable\\:xls").count(), page.locator("#vchgroupTable\\:xls").count())
        print("select count", page.locator("select[id$='selectCatgGrp_input']").count())
        print("select ids", page.eval_on_selector_all("select", "(els) => els.map((el) => el.id)"))
        if page.locator("select[id$='selectCatgGrp_input']").count():
            print(
                "group options",
                page.eval_on_selector_all(
                    "select[id$='selectCatgGrp_input'] option",
                    "(opts) => opts.map((opt) => ({ value: opt.value, text: opt.textContent }))",
                ),
            )

        download_path = Path("data") / "debug_vahan_grouping.xlsx"
        with page.expect_download() as download_info:
            page.locator("#groupingTable\\:xls").click()
        download = download_info.value
        download.save_as(str(download_path))
        print(f"downloaded {download_path} for {selected_year}")

        output = Path("data") / "debug_vahan_grouping.html"
        output.write_text(page.content(), encoding="utf-8")
        print(f"wrote {output}")
        browser.close()


if __name__ == "__main__":
    main()
