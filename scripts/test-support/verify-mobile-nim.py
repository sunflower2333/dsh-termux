#!/usr/bin/env python3
"""Configure/run/clean up one isolated real DSH -> NIM mobile-tool test.

HOST-only HTTP client: no ADB, emulator control, external API client, fabricated
model responses, or standalone agent loop. --url-file contains the authenticated
DSH loopback URL forwarded by the device's QA owner. Only DSH receives prompts.
When WebView has already exchanged and removed the launch query, --cookie-file
accepts a private JSON list copied from CDP Network.getCookies result.cookies.
Only unexpired, non-Secure root cookies for this exact loopback origin are used;
cookie contents are never printed, stored in test state, or sent to the relay.
Use prepare, then run with a reviewed safe local prompt, then cleanup. The
temporary session/history is retained. Existing sessions, selected models,
credentials, access modes, and global policy are preserved. Model selection also
saves a global default upstream; the original selection is saved and restored
before removing the temporary provider. Credentials APIs
write/remove only the newly generated relay reference; no key is read back.

The report proves DSH's real tool loop; native screen/action evidence is collected
separately by the device QA owner. Neither prompts nor responses enter the report.
"""

from __future__ import annotations

import argparse
import hashlib
from http.cookiejar import Cookie, CookieJar, DefaultCookiePolicy
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time
from urllib.parse import urlsplit
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, ProxyHandler, Request, build_opener
import uuid

MODEL = "deepseek-ai/deepseek-v4.1-flash"
NS = "llm-pi-ai"
SAFE = re.compile(r"[A-Za-z][A-Za-z0-9_.:/-]{0,95}\Z")
COOKIE_NAME = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+\Z")
COOKIE_VALUE = re.compile(r"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*\Z")


class CheckFailed(RuntimeError):
    pass


def require(condition, label):
    if not condition:
        raise CheckFailed(label)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load_private(path: Path, max_bytes=None):
    # Check the opened inode, not a pathname that could change after lstat().
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "r", encoding="utf-8") as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
                "private-file-permissions")
        if max_bytes is not None:
            require(info.st_size <= max_bytes, "private-file-size")
        value = source.read() if max_bytes is None else source.read(max_bytes + 1)
        require(max_bytes is None or len(value.encode("utf-8")) <= max_bytes, "private-file-size")
        return value


def save_private(path: Path, value, *, exclusive=False):
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC) | os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(value, output, separators=(",", ":"))
        output.write("\n")


class LoopbackRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urlsplit(newurl)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.netloc != urlsplit(req.full_url).netloc:
            raise CheckFailed("non-loopback-redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class SameOriginCookiePolicy(DefaultCookiePolicy):
    """Restrict both imported and freshly exchanged cookies to one origin."""
    def __init__(self, origin):
        super().__init__()
        self.origin = origin

    def in_scope(self, cookie, request):
        parsed = urlsplit(request.full_url)
        return (parsed.scheme == "http" and "http://" + parsed.netloc == self.origin
                and cookie.domain in ("127.0.0.1", ".127.0.0.1") and cookie.path == "/"
                and not cookie.secure and not cookie.is_expired(time.time())
                and isinstance(cookie.name, str) and COOKIE_NAME.fullmatch(cookie.name)
                and isinstance(cookie.value, str) and COOKIE_VALUE.fullmatch(cookie.value))

    def set_ok(self, cookie, request):
        return bool(self.in_scope(cookie, request)) and super().set_ok(cookie, request)

    def return_ok(self, cookie, request):
        return bool(self.in_scope(cookie, request)) and super().return_ok(cookie, request)


def load_cdp_cookies(path: Path, parsed, jar):
    """Accept QA's result.cookies list; reject ambiguity without logging values."""
    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "cookie-json-duplicate-field")
            value[key] = item
        return value

    try:
        values = json.loads(load_private(path, 128 * 1024), object_pairs_hook=unique_object)
    except (ValueError, UnicodeError):
        raise CheckFailed("cookie-json-invalid") from None
    require(isinstance(values, list) and 1 <= len(values) <= 32, "cookie-file-must-be-CDP-cookie-list")
    seen = set()
    pending = []
    now = time.time()
    for item in values:
        require(isinstance(item, dict), "cookie-entry-schema")
        require(all(not any(character in value for character in ("\r", "\n", "\x00"))
                    for value in item.values() if isinstance(value, str)), "cookie-control-character")
        name, value = item.get("name"), item.get("value")
        require(isinstance(name, str) and len(name) <= 256 and COOKIE_NAME.fullmatch(name), "cookie-name-invalid")
        require(isinstance(value, str) and len(value) <= 8192 and COOKIE_VALUE.fullmatch(value), "cookie-value-invalid")
        # IP domain spelling from CDP may have a leading dot. Narrow either
        # spelling to host-only 127.0.0.1 instead of granting a domain suffix.
        require(item.get("domain") in (parsed.hostname, "." + parsed.hostname), "cookie-domain-mismatch")
        require(item.get("path") == "/", "cookie-path-must-match-loopback-root")
        require(item.get("secure") is False, "Secure-cookie-not-valid-for-http-loopback")
        require(type(item.get("httpOnly")) is bool and type(item.get("session")) is bool, "cookie-flags-invalid")
        require(item.get("sourceScheme", "Unset") in ("Unset", "NonSecure"), "cookie-source-scheme-mismatch")
        source_port = item.get("sourcePort", -1)
        require(type(source_port) is int and source_port in (-1, parsed.port), "cookie-source-port-mismatch")
        require(item.get("partitionKey") is None and item.get("partitionKeyOpaque", False) is False, "partitioned-cookie-not-supported")
        require(item.get("sameSite") in (None, "Strict", "Lax", "None"), "cookie-samesite-invalid")
        expiration = item.get("expires")
        require(type(expiration) in (int, float) and math.isfinite(expiration), "cookie-expiration-invalid")
        if item["session"]:
            require(expiration in (-1, 0), "cookie-session-expiration-invalid")
            expires = None
        else:
            require(expiration > now and int(expiration) > int(now), "cookie-expired")
            expires = int(expiration)
        require(name not in seen, "cookie-duplicate-name")
        seen.add(name)
        rest = {"HttpOnly": None} if item["httpOnly"] else {}
        if item.get("sameSite"):
            rest["SameSite"] = item["sameSite"]
        pending.append(Cookie(
            version=0, name=name, value=value, port=str(parsed.port), port_specified=True,
            domain=parsed.hostname, domain_specified=False, domain_initial_dot=False,
            path="/", path_specified=True, secure=False, expires=expires,
            discard=item["session"], comment=None, comment_url=None, rest=rest, rfc2109=False,
        ))
    # A rejected export must never leave a partially imported jar.
    for cookie in pending:
        jar.set_cookie(cookie)


class Dsh:
    def __init__(self, url_file, cookie_file=None):
        url = load_private(url_file).strip()
        parsed = urlsplit(url)
        require(parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port
                and parsed.netloc == f"127.0.0.1:{parsed.port}" and not parsed.fragment
                and not any(character in url for character in ("\r", "\n", "\t", "\x00"))
                and not parsed.username and not parsed.password and parsed.path in ("", "/"),
                "dsh-url-must-be-forwarded-loopback-root")
        self.origin = "http://" + parsed.netloc
        jar = CookieJar(policy=SameOriginCookiePolicy(self.origin))
        if cookie_file is not None:
            load_cdp_cookies(cookie_file, parsed, jar)
        # This client reaches only forwarded loopback DSH, never an upstream.
        self.opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(jar), LoopbackRedirect())
        with self.opener.open(url, timeout=30) as response:
            require(response.status == 200, "dsh-authentication")

    def rpc(self, method, args):
        request_id = str(uuid.uuid4())
        envelope = {"type": "client-request", "rpcId": request_id, "method": method,
                    "payload": {"args": args}}
        request = Request(self.origin + "/api/" + method, method="POST",
                          data=json.dumps(envelope).encode(),
                          headers={"Content-Type": "application/json", "Origin": self.origin})
        with self.opener.open(request, timeout=45) as response:
            result = json.load(response)
        require(result.get("rpcId") == request_id and result.get("type") == "server-response", "rpc-envelope")
        result = result.get("result", {})
        if not result.get("ok"):
            # Never expose server error message/details, which can contain data.
            code = result.get("error", {}).get("code", "unknown")
            raise CheckFailed("rpc-" + method + "-" + (code if SAFE.fullmatch(str(code)) else "redacted"))
        return result.get("value")

    def settings(self):
        result = self.rpc("settings/describe", {})
        require(result.get("writable"), "settings-must-be-writable")
        return result["namespaces"]

    def ns(self):
        values = [item for item in self.settings() if item["ns"] == NS]
        require(len(values) == 1, "pi-ai-namespace")
        return values[0]

    def mutate(self, view, operation):
        return self.rpc("settings/mutate", {"ns": NS, "ops": [operation], "expectedRevision": view["revision"]})

    def sessions(self):
        return self.rpc("session/list", {"_request": {}})["items"]


def settings_fingerprints(views, omit_provider=None):
    result = {}
    for view in views:
        value = view.get("value")
        if view["ns"] == NS and omit_provider:
            value = dict(value)
            value["providers"] = {k: v for k, v in value.get("providers", {}).items() if k != omit_provider}
        result[view["ns"]] = digest(value)
    return result


def provider_profile(control, ref):
    return {
        "displayName": "Temporary Android NIM test",
        "apiKeyEnv": ref,
        "api": "openai-completions",
        "baseURL": f"http://127.0.0.1:{control['port']}/v1",
        "models": [{"id": MODEL, "name": "NIM mobile acceptance test", "maxTokens": control["max_tokens"], "input": ["text"]}],
        "compat": {"maxTokensField": "max_tokens", "supportsStore": False,
                   "supportsDeveloperRole": False, "supportsReasoningEffort": False,
                   "supportsUsageInStreaming": True},
        "transport": "sse", "timeoutMs": 60000, "streamIdleTimeoutMs": 60000,
        "retryPolicy": {"mode": "normal", "maxRetries": 0},
    }


def original_default(catalog):
    """Capture only restorable model metadata before any test mutation."""
    value = catalog.get("default") if isinstance(catalog, dict) else None
    require(isinstance(value, dict) and {"provider", "model"} <= set(value)
            and set(value) <= {"provider", "model", "reasoningEffort"}, "original-default-selection-required")
    require(all(isinstance(item, str) and 0 < len(item) <= 512
                and not any(ord(character) < 32 or ord(character) == 127 for character in item)
                for item in value.values()), "original-default-selection-invalid")
    groups = catalog.get("groups", [])
    models = [model for group in groups if isinstance(group, dict) and group.get("id") == value["provider"]
              for model in group.get("models", []) if isinstance(model, dict) and model.get("id") == value["model"]]
    require(len(models) == 1, "original-default-model-not-routable")
    reasoning = models[0].get("reasoning") or {}
    if "reasoningEffort" in value:
        require(any(isinstance(effort, dict) and effort.get("id") == value["reasoningEffort"]
                    for effort in reasoning.get("efforts", [])), "original-default-reasoning-invalid")
    else:
        # selectModel resolves omitted reasoning to the catalog default. Such a
        # selection cannot restore an originally absent value exactly.
        require(not reasoning.get("defaultEffort"), "original-default-not-exactly-restorable")
    return dict(value)


def restore_default(client, state):
    """Restore through the owned SID; keep provider/ref until restoration settles."""
    selection = state.get("baseline_default_selection")
    require(isinstance(selection, dict) and {"provider", "model"} <= set(selection)
            and set(selection) <= {"provider", "model", "reasoningEffort"}
            and all(isinstance(value, str) and value for value in selection.values())
            and digest(selection) == state["baseline_default"], "original-default-snapshot-invalid")
    if state.get("session_id"):
        selected = client.rpc("session/selectModel", {"request": {"sessionId": state["session_id"], **selection}})
        require(isinstance(selected, dict) and digest(selected.get("selected")) == state["baseline_default"],
                "original-default-restore-selection-mismatch")
    deadline = time.monotonic() + 15
    while True:
        current = client.rpc("session/modelCatalog", {})
        default_matches = isinstance(current, dict) and digest(current.get("default")) == state["baseline_default"]
        settings_match = settings_fingerprints(client.settings(), omit_provider=state["provider"]) == state["baseline_settings"]
        if default_matches and settings_match:
            return
        require(time.monotonic() < deadline, "original-default-restore-timeout")
        time.sleep(0.25)


def prepare(client, args):
    require(not args.state_file.exists(), "test-state-already-exists")
    control = json.loads(load_private(args.relay_control))
    require(control.get("model") == MODEL and control.get("expires_at", 0) > time.time(), "relay-control-expired-or-model")
    require(type(control.get("port")) is int and 1 <= control["port"] <= 65535, "relay-port")
    require(control.get("max_tokens") in (256, 512) and 1 <= control.get("max_requests", 0) <= 8, "relay-budget")
    suffix = secrets.token_hex(8)
    provider, ref = "android-nim-test-" + suffix, "DSH_TEST_NIM_RELAY_" + suffix.upper()
    views = client.settings()
    namespace = next((item for item in views if item["ns"] == NS), None)
    require(namespace is not None and provider not in namespace["value"].get("providers", {}), "test-provider-collision")
    selection = original_default(client.rpc("session/modelCatalog", {}))
    sessions = client.sessions()
    # Unattached sessions without cwd are deliberately hidden by session/list;
    # refuse before mutation rather than falsely report them deleted later.
    require(all(isinstance(item.get("cwd"), str) and item["cwd"] for item in sessions),
            "baseline-session-cwd-required")
    profile = provider_profile(control, ref)
    state = {"version": 1, "provider": provider, "credential_ref": ref, "model": MODEL,
             "max_requests": control["max_requests"], "max_tokens": control["max_tokens"],
             "metadata_file": control["metadata_file"], "session_id": None,
             "baseline_settings": settings_fingerprints(views),
             "baseline_default": digest(selection), "baseline_default_selection": selection,
             "baseline_sessions": sorted(digest(item["sessionId"]) for item in sessions),
             "profile_digest": None, "phase": "preparing"}
    # Save recovery identities before any mutation; no NIM or relay key is saved.
    save_private(args.state_file, state, exclusive=True)
    try:
        client.rpc("credentials/set", {"ref": ref, "value": control["relay_token"]})
        view = client.mutate(namespace, {"op": "set", "path": ["providers", provider], "value": profile})
        state["profile_digest"] = digest(view["value"]["providers"][provider])
        save_private(args.state_file, state)
        request = {}
        if args.agent_preset:
            request["agentPreset"] = args.agent_preset
        created = client.rpc("session/create", {"request": request})
        state["session_id"] = created["sessionId"]
        save_private(args.state_file, state)
        client.rpc("session/rename", {"request": {"sessionId": state["session_id"], "title": "Android NIM mobile acceptance test"}})
        client.rpc("session/selectModel", {"request": {"sessionId": state["session_id"], "provider": provider, "model": MODEL}})
        state["phase"] = "prepared"
        save_private(args.state_file, state)
        print(json.dumps({"phase": "prepared", "model": MODEL, "max_tokens": state["max_tokens"],
                          "max_requests": state["max_requests"], "existing_sessions_untouched": True}))
    except BaseException:
        cleanup(client, args)
        raise


def summarize_records(records):
    calls, results, events = {}, {}, {}
    end_reason = None
    for record in records:
        event = record.get("event", {})
        kind, data = event.get("type"), event.get("data", {})
        if kind in ("turn/start", "turn/end", "step/start", "step/end", "assistant/message", "assistant/attempt", "tool/call", "tool/result"):
            events[kind] = events.get(kind, 0) + 1
        if not isinstance(data, dict):
            continue
        if kind == "turn/end":
            reason = data.get("reason", {})
            value = reason.get("kind") if isinstance(reason, dict) else None
            end_reason = value if value in ("completed", "aborted", "blocked", "error", "max-tokens") else "other"
        if kind == "tool/call":
            name = data.get("name", "")
            calls[data.get("callId")] = name if isinstance(name, str) and SAFE.fullmatch(name) else "redacted"
        if kind == "tool/result":
            message = data.get("message", {})
            results[message.get("toolCallId")] = not message.get("isError", False)
    return {"events": events, "end_reason": end_reason, "tool_calls": sorted(calls.values()),
            "successful_tools": sorted(name for key, name in calls.items() if results.get(key) is True),
            "failed_tool_count": sum(value is False for value in results.values())}


def run(client, args):
    state = json.loads(load_private(args.state_file))
    require(state.get("phase") == "prepared", "test-is-not-prepared-or-already-ran")
    require(args.prompt_file and args.expect_tool, "reviewed-safe-prompt-and-expected-tools-required")
    prompt = load_private(args.prompt_file).strip()
    require(0 < len(prompt) <= 4000, "prompt-size")
    require(all(SAFE.fullmatch(name) for name in args.expect_tool), "expected-tool-name")
    sid = state["session_id"]
    state["phase"] = "running"
    save_private(args.state_file, state)
    client.rpc("session/prompt", {"request": {"requestId": str(uuid.uuid4()), "sessionId": sid,
                                             "mode": "queue", "content": [{"type": "text", "text": prompt}],
                                             "clientTimeZone": "Etc/UTC"}})
    deadline = time.monotonic() + args.timeout_seconds
    summary = {}
    try:
        while time.monotonic() < deadline:
            projection = client.rpc("session/projections", {"request": {"sessionId": sid}})
            require(projection is not None, "test-session-missing")
            page = client.rpc("session/page", {"request": {"address": {"kind": "session", "sessionId": sid},
                                                            "throughSeq": projection["asOfSeq"], "maxMessages": 100}})
            summary = summarize_records(page["records"])
            require(not page["hasMore"], "test-history-exceeds-window")
            require(summary["events"].get("step/start", 0) <= state["max_requests"], "step-budget-exceeded")
            if summary["events"].get("turn/end"):
                break
            time.sleep(1)
        else:
            raise CheckFailed("dsh-turn-timeout-or-awaiting-approval")
        require(summary["end_reason"] == "completed", "dsh-turn-not-completed")
        require(set(args.expect_tool) <= set(summary["successful_tools"]), "expected-native-tool-results-missing")
        require(summary["failed_tool_count"] == 0, "tool-result-failed")
        events = [json.loads(line) for line in Path(state["metadata_file"]).read_text().splitlines()]
        responses = [event for event in events if event.get("event") == "response"]
        require(responses and all(event.get("status") == 200 and event.get("outcome") == "complete" for event in responses), "nim-transport-not-successful")
        require(any(set(args.expect_tool) & set(event.get("tools", [])) for event in responses), "nim-did-not-emit-expected-tools")
        state["phase"] = "dsh-loop-complete"
        report = {"phase": state["phase"], "model": MODEL, **summary,
                  "upstream_requests": len(responses), "native_ui_validation": "required-separately",
                  "vision_validation": "not-tested-text-accessibility-route",
                  "usage": [event.get("usage", {}) for event in responses]}
        print(json.dumps(report, separators=(",", ":")))
    except Exception:
        state["phase"] = "stopped-without-pass"
        try:
            client.rpc("session/cancel", {"request": {"sessionId": sid}})
        except Exception:
            pass
        raise
    finally:
        save_private(args.state_file, state)


def cleanup(client, args):
    state = json.loads(load_private(args.state_file))
    require(state.get("version") == 1 and state.get("provider", "").startswith("android-nim-test-")
            and state.get("credential_ref", "").startswith("DSH_TEST_NIM_RELAY_"), "invalid-test-state")
    if state.get("session_id") and any(item["sessionId"] == state["session_id"] and item.get("running") for item in client.sessions()):
        client.rpc("session/cancel", {"request": {"sessionId": state["session_id"]}})
    restore_default(client, state)
    view = client.ns()
    profile = view["value"].get("providers", {}).get(state["provider"])
    if profile is not None:
        require(state["profile_digest"] == digest(profile), "test-provider-changed-cleanup-refused")
        client.mutate(view, {"op": "unset", "path": ["providers", state["provider"]]})
    client.rpc("credentials/unset", {"ref": state["credential_ref"]})
    require(settings_fingerprints(client.settings()) == state["baseline_settings"], "settings-changed-since-prepare")
    require(digest(client.rpc("session/modelCatalog", {})["default"]) == state["baseline_default"], "default-model-changed")
    require(set(state["baseline_sessions"]) <= {digest(item["sessionId"]) for item in client.sessions()}, "original-session-missing")
    state["phase"] = "cleaned"
    save_private(args.state_file, state)
    print(json.dumps({"phase": "cleaned", "test_provider_removed": True, "test_credential_removed": True,
                      "test_session_retained": bool(state.get("session_id")), "baseline_settings_preserved": True,
                      "original_default_restored": True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("prepare", "run", "cleanup"))
    parser.add_argument("--url-file", type=Path, required=True)
    parser.add_argument("--cookie-file", type=Path, help="private CDP Network.getCookies result.cookies JSON list")
    parser.add_argument("--state-file", type=Path, required=True)
    parser.add_argument("--relay-control", type=Path)
    parser.add_argument("--agent-preset")
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--expect-tool", action="append", default=[])
    parser.add_argument("--timeout-seconds", type=int, default=180)
    args = parser.parse_args()
    require(30 <= args.timeout_seconds <= 480, "timeout-budget")
    if args.phase == "prepare":
        require(args.relay_control is not None, "relay-control-required")
    client = Dsh(args.url_file, args.cookie_file)
    {"prepare": prepare, "run": run, "cleanup": cleanup}[args.phase](client, args)


if __name__ == "__main__":
    try:
        main()
    except CheckFailed as error:
        print(json.dumps({"phase": "failed", "check": str(error)}))
        raise SystemExit(1)
    except Exception:
        print(json.dumps({"phase": "failed", "check": "private-diagnostics-omitted"}))
        raise SystemExit(1)
