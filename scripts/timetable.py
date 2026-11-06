# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "beautifulsoup4"]
# ///
"""Pull a child's timetable from My School Portal (perse.myschoolportal.co.uk).

The timetable page embeds its data as an inline script:

    var timetableData = {"timetables": [ {...lesson...}, ... ]};

covering this week and next. We log in, fetch the page, and decode that blob.

Login flow (reverse-engineered from the portal's site.min.js):
  1. GET  /login                  -> sets MSP_ID / MSP_TOKEN cookies; form holds a
                                     hidden `stryver` token and `target_once_logged_in`.
  2. POST /api/v2/login-attempt   -> JSON {type, id: email, attributes:{action:init,
                                     provider:local}}; response meta.next_action is
                                     "password" (local account) or "access-login" (SSO).
  3. POST /api/auth               -> the login form fields as URL-encoded JSON;
                                     response {"success": true, "redirectTo": ...}.

Usage:
  MSP_EMAIL=... MSP_PASSWORD=... uv run scripts/timetable.py [timetable_id]
or reuse a browser session:
  MSP_ID=... MSP_TOKEN=... uv run scripts/timetable.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse

import requests
from bs4 import BeautifulSoup

BASE = "https://perse.myschoolportal.co.uk"
DEFAULT_TIMETABLE_ID = 47  # Robbie
# Same UA as the kitchen tablet's Fully Kiosk browser (see NOTES.md).
USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 11; KFRAWI Build/RS8338.3339N; wv) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.181 Safari/537.36"
)
XHR = {"X-Requested-With": "XmlHttpRequest"}


class LoginError(RuntimeError):
    pass


def new_session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    # The API 500s without these (presumably a CSRF check), so look like the browser.
    s.headers["Origin"] = BASE
    s.headers["Referer"] = f"{BASE}/login"
    return s


def login(s: requests.Session, email: str, password: str, stay_logged_in: bool = True) -> None:
    # Step 1: login page for cookies + hidden fields.
    r = s.get(f"{BASE}/login", timeout=20)
    r.raise_for_status()
    form = BeautifulSoup(r.text, "html.parser").find("form", action="/login")
    if form is None:
        raise LoginError("login form not found on /login")
    hidden = {i["name"]: i.get("value", "") for i in form.find_all("input", type="hidden")}

    # Step 2: tell the portal who we are; it decides password vs SSO.
    r = s.post(
        f"{BASE}/api/v2/login-attempt",
        data=json.dumps({
            "type": "login-attempt",
            "id": email,
            "attributes": {"action": "init", "provider": "local"},
        }),
        # jQuery's default content type, which the site's $.ajax call leaves in place.
        headers={**XHR, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                 "Accept": "application/json"},
        timeout=20,
    )
    r.raise_for_status()
    next_action = (r.json().get("meta") or {}).get("next_action")
    if next_action != "password":
        raise LoginError(f"portal wants next_action={next_action!r}, not a password login "
                         "(SSO accounts aren't supported by this script)")

    # Step 3: submit credentials. The site JS sends encodeURIComponent(JSON.stringify(form))
    # with a JSON content type, so mirror that exactly.
    payload = {
        **hidden,
        "client_id": email,
        "client_secret": password,
        "stay_logged_in": stay_logged_in,
    }
    r = s.post(
        f"{BASE}/api/auth",
        data=urllib.parse.quote(json.dumps(payload, separators=(",", ":")), safe="~()*!.'"),
        headers={**XHR, "Content-Type": "application/json", "Accept": "application/json"},
        timeout=20,
    )
    r.raise_for_status()
    body = r.json()
    if not body.get("success"):
        raise LoginError(f"login rejected: {body}")


def parse_timetable(html: str) -> list[dict]:
    """Extract the `var timetableData = {...}` blob from the timetable page."""
    marker = "var timetableData"
    for script in BeautifulSoup(html, "html.parser").find_all("script"):
        text = script.string or ""
        i = text.find(marker)
        if i == -1:
            continue
        start = text.index("{", i)
        data, _ = json.JSONDecoder().raw_decode(text, start)
        return data.get("timetables", [])
    raise ValueError("timetableData not found in page (not logged in?)")


def fetch_timetable(s: requests.Session, timetable_id: int = DEFAULT_TIMETABLE_ID) -> list[dict]:
    r = s.get(f"{BASE}/timetables/{timetable_id}", timeout=20)
    r.raise_for_status()
    if r.url.rstrip("/").endswith("/login"):
        raise LoginError("redirected to /login: session missing or expired")
    return parse_timetable(r.text)


def simplify(lesson: dict) -> dict:
    # Times come back as e.g. "2026-11-03T08:35:00Z" but match UK wall-clock time on the
    # page, so keep them as naive local times. (Check this holds once BST starts.)
    return {
        "date": lesson["startTime"][:10],
        "start": lesson["startTime"][11:16],
        "end": lesson["endTime"][11:16],
        "period": lesson.get("periodName") or f"Period {lesson.get('startPeriod')}",
        "subject": lesson.get("name"),
        "teacher": lesson.get("staffName"),
        "room": lesson.get("location"),
        "group": lesson.get("groupName"),
    }


def main() -> None:
    timetable_id = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_TIMETABLE_ID
    s = new_session()
    if os.environ.get("MSP_ID") and os.environ.get("MSP_TOKEN"):
        for name in ("MSP_ID", "MSP_TOKEN"):
            s.cookies.set(name, os.environ[name], domain="perse.myschoolportal.co.uk")
    else:
        try:
            login(s, os.environ["MSP_EMAIL"], os.environ["MSP_PASSWORD"])
        except KeyError:
            sys.exit("set MSP_EMAIL and MSP_PASSWORD (or MSP_ID and MSP_TOKEN)")
    lessons = [simplify(l) for l in fetch_timetable(s, timetable_id)]
    json.dump(lessons, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
