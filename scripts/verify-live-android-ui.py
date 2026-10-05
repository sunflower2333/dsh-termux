#!/usr/bin/env python3
"""Check the real DSH WebUI against a running backend in portrait Chromium.

Install the Python dependency with `python -m pip install playwright`.
Run DSH with a disposable test HOME: this script dismisses onboarding, changes
language/appearance, and edits an unsent draft. On success it leaves the UI in
English and restores the original appearance. It never sends a model request. Screenshots
and JSON describe browser checks, not Android Activity/WebView execution.
"""

import argparse
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit


class VerificationFailure(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise VerificationFailure(message)


def redact(value):
    # Playwright errors can contain goto URLs, including the authentication token.
    return re.sub(r"(?:https?|wss?)://[^\s\"'<>]+", "[redacted URL]", str(value))


def parse_args():
    parser = argparse.ArgumentParser(
        description="Verify the live DSH WebUI at 360/390/412px using real backend data.",
        epilog="Use a disposable DSH test HOME. Does not test an Android Activity, "
        "APK lifecycle, or model requests. The authenticated URL is never printed.",
    )
    parser.add_argument("--url-file", type=Path, required=True,
                        help="UTF-8 file containing the authenticated running DSH URL")
    parser.add_argument("--output-dir", type=Path, default=Path("/tmp/dsh-live-android-ui"),
                        help="directory for screenshots and report.json")
    parser.add_argument("--chromium", default="/usr/bin/chromium",
                        help="installed Chromium executable (default: /usr/bin/chromium)")
    return parser.parse_args()


def run(args, report):
    from playwright.sync_api import expect, sync_playwright

    url = args.url_file.read_text(encoding="utf-8").strip()
    parsed = urlsplit(url)
    require(parsed.scheme in ("http", "https") and parsed.hostname,
            "URL file must contain an HTTP(S) DSH backend URL")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=args.chromium, headless=True, args=["--no-sandbox"])
        context = browser.new_context(
            viewport={"width": 360, "height": 800}, is_mobile=True,
            has_touch=True, color_scheme="light")
        page = context.new_page()
        page.set_default_timeout(15000)
        errors = []
        page.on("pageerror", lambda error: errors.append(redact(error)))
        report["pageErrors"] = errors

        report["onboardingDismissals"] = []

        def dismiss_onboarding(button):
            # These are genuine upstream UI buttons. Their overlay can arrive
            # after Host settings load, including after reload/while Settings
            # is open, so handle it at actionability checks instead of sleeping
            # once and assuming all startup work has finished.
            label = button.inner_text()
            button.click()
            report["onboardingDismissals"].append(label)

        for label in (r"^(Continue|继续)$", r"^(Configure later|稍后配置)$"):
            page.add_locator_handler(
                page.get_by_role("button", name=re.compile(label)), dismiss_onboarding)

        def clear_late_onboarding():
            # A trial body action invokes the handlers without clicking the UI
            # or disturbing an open menu/dialog. No force clicks are used.
            page.locator("body").click(trial=True)

        def screenshot(name):
            clear_late_onboarding()
            page.screenshot(path=str(args.output_dir / f"{name}.png"))

        def ready():
            page.locator("[data-composer-input]").wait_for(state="visible", timeout=30000)
            # Allow the initial Host response, then verify the real launcher is
            # actionable. Handlers also remain active for later Host responses.
            page.wait_for_timeout(1500)
            page.locator('[data-slot="settings.launcher"] button').click(trial=True)
            require(not page.get_by_text("Unable to create default workspace.",
                                         exact=False).count(),
                    "Backend failed to create the default workspace")

        def open_settings():
            page.locator('[data-slot="settings.launcher"] button').click()
            dialog = page.locator('[data-shortcut-modal="settings"]')
            expect(dialog).to_be_visible()
            return dialog

        def close_settings():
            page.locator('[data-shortcut-modal="settings"]').get_by_role(
                "button", name=re.compile(r"^(Close|关闭)$")).click()
            expect(page.locator('[data-shortcut-modal="settings"]')).to_be_hidden()

        def bounds(selector):
            return page.locator(selector).evaluate_all("""els => els
              .filter(e => e.getBoundingClientRect().width > 0)
              .map(e => ({name: e.getAttribute('aria-label') || e.innerText.slice(0, 80),
                rect: e.getBoundingClientRect().toJSON(),
                scrollWidth: e.scrollWidth, clientWidth: e.clientWidth}))""")

        def bounded(items, label, horizontal_scroll=False):
            require(bool(items), f"{label}: expected visible elements")
            viewport = page.viewport_size
            for item in items:
                rect = item["rect"]
                require(rect["left"] >= -1 and rect["right"] <= viewport["width"] + 1,
                        f"{label}: element extends outside the viewport")
                if not horizontal_scroll:
                    require(item["scrollWidth"] <= item["clientWidth"] + 1,
                            f"{label}: content overflows horizontally")

        def menu_check(button, name):
            button.click()
            menus = page.locator('[role="menu"]:visible, [role="listbox"]:visible')
            expect(menus.first).to_be_visible()
            measurements = bounds('[role="menu"]:visible, [role="listbox"]:visible')
            bounded(measurements, name)
            screenshot(name)
            report["menus"][name] = measurements
            clear_late_onboarding()
            page.keyboard.press("Escape")
            expect(menus).to_have_count(0)

        def reload_until(predicate, label):
            # Wait for server-side settings persistence, not merely optimistic UI.
            deadline = time.monotonic() + 20
            while True:
                page.reload(wait_until="domcontentloaded")
                ready()
                if predicate():
                    return
                require(time.monotonic() < deadline, f"{label} did not survive reload")
                page.wait_for_timeout(500)

        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            ready()
            open_settings()
            language = page.locator('[data-shortcut-modal="settings"]').get_by_role(
                "button", name=re.compile(r"^(English|中文)$"))
            require(language.count() == 1,
                    "Expected English/Chinese language control in test settings")
            if language.inner_text() != "English":
                language.click()
                page.get_by_role("menuitem", name="English", exact=True).click()
                expect(page.get_by_role("button", name="General", exact=True)).to_be_visible()
                page.wait_for_timeout(2000)
            selected_theme = page.locator('[data-shortcut-modal="settings"]').locator('button[aria-pressed="true"]')
            require(selected_theme.count() == 1, "Expected one selected appearance")
            original_theme = selected_theme.inner_text()
            require(original_theme in ("Light", "Dark", "System"),
                    "Unexpected appearance control in test settings")
            close_settings()
            expanded = page.get_by_role("button", name="Collapse sidebar", exact=True)
            if expanded.count():
                expanded.click()
                expect(page.get_by_role("button", name="Open sidebar", exact=True)).to_be_visible()
            require("Default workspace" in page.get_by_role(
                "button", name="Choose workspace", exact=True).inner_text(),
                "Expected a selected default workspace in the disposable test HOME")

            report["viewports"] = {}
            for width, height in ((360, 800), (390, 844), (412, 915)):
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(200)
                widths = page.evaluate("""() => ({html: document.documentElement.scrollWidth,
                                                body: document.body.scrollWidth})""")
                require(widths["html"] <= width and widths["body"] <= width,
                        f"{width}px: document overflows horizontally")
                composer = bounds("[data-composer-card]")
                bounded(composer, f"{width}px composer")
                toolbar = bounds('[data-slot="sidebar"] button')
                bounded(toolbar, f"{width}px toolbar")
                for item in toolbar:
                    require(item["rect"]["width"] >= 44 and item["rect"]["height"] >= 44,
                            f"{width}px: toolbar touch target is smaller than 44px")
                screenshot(f"main-{width}")
                open_settings()
                settings = bounds('[data-shortcut-modal="settings"]')
                bounded(settings, f"{width}px settings")
                screenshot(f"settings-{width}")
                close_settings()
                report["viewports"][str(width)] = {
                    "height": height, "documentWidths": widths,
                    "composer": composer, "toolbar": toolbar, "settings": settings}

            page.set_viewport_size({"width": 360, "height": 800})
            page.get_by_role("button", name="Open sidebar", exact=True).click()
            expect(page.get_by_role("button", name="Collapse sidebar", exact=True)).to_be_visible()
            screenshot("drawer-360")
            page.get_by_role("button", name="Collapse sidebar", exact=True).click()
            expect(page.get_by_role("button", name="Open sidebar", exact=True)).to_be_visible()
            report["drawerOpenClose"] = True
            report["menus"] = {}
            menu_check(page.get_by_role("button", name="Choose workspace", exact=True), "workspace-menu")
            menu_check(page.get_by_role("button", name=re.compile(r"^Select model, current")), "model-menu")
            menu_check(page.get_by_role("button", name="Standard mode", exact=True), "agent-menu")

            composer = page.locator("[data-composer-input]")
            composer.fill("Mobile layout verification draft")
            expect(page.get_by_role("button", name="Send message", exact=True)).to_be_enabled()
            page.get_by_role("button", name="New session", exact=True).click()
            expect(composer).to_be_visible()
            # An unsent, sessionless composer legitimately keeps its draft.
            # Do not assert that clicking this button created a persisted session.
            composer.fill("")
            report["composerEditing"] = True

            open_settings()
            page.get_by_role("button", name="Dark", exact=True).click()
            page.wait_for_function("document.querySelector('[data-ds-dark-theme]') !== null")
            reload_until(lambda: page.locator("[data-ds-dark-theme]").count() > 0, "Dark appearance")
            report["darkSaved"] = True
            open_settings()
            page.get_by_role("button", name="Light", exact=True).click()
            page.wait_for_function("document.querySelector('[data-ds-dark-theme]') === null")
            page.get_by_role("button", name="English", exact=True).click()
            page.get_by_role("menuitem", name="中文", exact=True).click()
            reload_until(lambda: page.locator("[data-ds-dark-theme]").count() == 0
                         and page.get_by_role("button", name="设置", exact=True).count() == 1,
                         "Light appearance and Chinese language")
            report["lightSaved"] = True
            report["chineseSaved"] = True
            screenshot("main-chinese-360")
            dialog = open_settings()
            dialog.get_by_role("button", name="中文", exact=True).click()
            page.get_by_role("menuitem", name="English", exact=True).click()
            reload_until(lambda: page.get_by_role("button", name="Settings", exact=True).count() == 1,
                         "English language")
            report["englishSaved"] = True
            open_settings()
            page.get_by_role("button", name="Models", exact=True).click()
            bounded(bounds('[data-shortcut-modal="settings"]'), "Models settings")
            expect(page.locator('[data-shortcut-modal="settings"]').get_by_placeholder("Enter your API key", exact=True)).to_be_visible()
            screenshot("models-360")
            close_settings()
            open_settings()
            page.get_by_role("button", name=original_theme, exact=True).click()
            close_settings()

            def original_appearance_saved():
                current = open_settings().get_by_role("button", name=original_theme, exact=True)
                saved = current.get_attribute("aria-pressed") == "true"
                close_settings()
                return saved

            reload_until(original_appearance_saved, "Original appearance")
            report["originalAppearanceRestored"] = True
            require(not errors, "The real WebUI emitted JavaScript page errors")
            report["status"] = "passed"
        except Exception:
            try:
                screenshot("failure")
            except Exception:
                pass
            raise
        finally:
            browser.close()


def main():
    args = parse_args()
    report = {
        "status": "failed",
        "scope": "Real DSH backend and browser WebUI; no synthetic HTML",
        "notCovered": ["Android Activity/WebView and APK lifecycle", "Model requests",
                       "Persisted session creation from an unsent draft"],
        "testHome": "Must be disposable; onboarding/preferences/draft are modified",
    }
    try:
        run(args, report)
    except Exception as error:
        report["failure"] = redact(error)
        print(f"FAILED: {report['failure']}", file=sys.stderr)
    finally:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        target = args.output_dir / "report.json"
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{report['status'].upper()}: {target}")
    print("Browser WebUI check only; Android Activity and model requests were not tested.")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
