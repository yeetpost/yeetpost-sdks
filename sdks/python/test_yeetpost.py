"""Tests for the yeetpost Python SDK. Standard library only.

The client is exercised against a real http server on a random port, so the
request it actually puts on the wire (method, path, query, headers, body) is
what gets asserted. Nothing here reaches the network.
"""

import hashlib
import hmac
import json
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from yeetpost import (
    Yeetpost,
    YeetpostApiError,
    parse_connect_redirect,
    verify_webhook_signature,
)

STUB_RESPONSE: dict[str, Any] = {}
RECORDED_REQUESTS: list[dict[str, Any]] = []
# EXTRA_HEADERS go out with the response, for the request id and rate limit
# headers. Set them before the call.
EXTRA_HEADERS: dict[str, str] = {}

CONNECTION_ID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"

LINKEDIN_CONNECTION = {
    "id": CONNECTION_ID,
    "slug": "linkedin",
    "platformId": "linkedin",
    "description": "Alex Doe (LinkedIn)",
    "profileId": None,
    "timezone": "Europe/Helsinki",
    "queueSlots": [{"weekday": 1, "time": "09:00"}],
    "status": "active",
    "loginExpiresAt": None,
}

MEDIA_ID = "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d"

POST_ID = "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"

PROFILE_ID = "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b"

ACME_PROFILE = {
    "id": PROFILE_ID,
    "name": "Acme Coffee",
    "externalId": "cus_4821",
    "createdAt": "2026-08-29T09:24:11.412Z",
}

KEY_ID = "9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31"

# Word for word what the API answers a scoped key that tries to manage keys, so
# the stub is the real refusal rather than an approximation of one
SCOPED_KEY_MESSAGE = (
    f"This API key is scoped to profile {PROFILE_ID}, which cannot manage "
    "API keys. Use an unscoped key for that."
)

ACME_KEY = {
    "id": KEY_ID,
    "name": "Acme integration",
    "type": "live",
    "prefix": "yp_secret_4f9a2c",
    "profileId": PROFILE_ID,
    "redirectAllowlist": ["https://acme.example.com"],
    "createdAt": "2026-08-30T09:24:11.412Z",
    "lastUsedAt": None,
    "revokedAt": None,
}

# Word for word what the API attaches to a send while the account is over the
# free connection limit and the grace window is still open
GRACE_WARNING = (
    "This account has 4 connected accounts, over the free limit of 3. "
    "Subscribe or disconnect down to 3 by 2026-09-18 to keep posting."
)

CONNECT_SESSION_ID = "7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f"

CONNECT_SESSION = {
    "url": "https://yeetpost.com/connect/8Qm2rXk9vT1sB4nE6yPzL0aJdHcWfUgR",
    "expiresAt": "2026-08-29T09:39:11.412Z",
    "connectSessionId": CONNECT_SESSION_ID,
}


class StubHandler(BaseHTTPRequestHandler):
    def _handle(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else ""

        RECORDED_REQUESTS.append(
            {
                "method": self.command,
                "path": self.path,
                "headers": {
                    name.lower(): value for name, value in self.headers.items()
                },
                "body": body,
            }
        )

        response_body = STUB_RESPONSE["body"].encode("utf-8")

        self.send_response(STUB_RESPONSE["status"])
        self.send_header("content-type", STUB_RESPONSE["content_type"])
        self.send_header("content-length", str(len(response_body)))

        for name, value in EXTRA_HEADERS.items():
            self.send_header(name, value)

        self.end_headers()
        self.wfile.write(response_body)

    do_GET = _handle
    do_POST = _handle
    do_PATCH = _handle
    do_DELETE = _handle

    def log_message(self, format: str, *args: Any) -> None:
        pass


def set_stub_response(
    status: int, body: Any, content_type: str = "application/json"
) -> None:
    STUB_RESPONSE["status"] = status
    # separators keeps the bytes the same as the node sdk's JSON.stringify,
    # which is what the shared webhook vector is signed over.
    STUB_RESPONSE["body"] = (
        body
        if isinstance(body, str)
        else json.dumps(body, separators=(",", ":"))
    )
    STUB_RESPONSE["content_type"] = content_type


class YeetpostClientTest(unittest.TestCase):
    server: ThreadingHTTPServer
    base_url: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}/api/v2"
        threading.Thread(
            target=cls.server.serve_forever, daemon=True
        ).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        RECORDED_REQUESTS.clear()
        EXTRA_HEADERS.clear()
        set_stub_response(200, {})
        self.client = Yeetpost("yp_secret_test", base_url=self.base_url)

    def test_sends_the_api_key_as_the_x_api_key_header(self) -> None:
        set_stub_response(200, {"connections": [LINKEDIN_CONNECTION]})

        response = self.client.list_connections()

        self.assertEqual(len(RECORDED_REQUESTS), 1)
        self.assertEqual(RECORDED_REQUESTS[0]["method"], "GET")
        self.assertEqual(RECORDED_REQUESTS[0]["path"], "/api/v2/connections")
        self.assertEqual(
            RECORDED_REQUESTS[0]["headers"]["x-api-key"], "yp_secret_test"
        )
        self.assertEqual(response, {"connections": [LINKEDIN_CONNECTION]})

    def test_get_connection_reads_one_connection(self) -> None:
        set_stub_response(200, {"connection": LINKEDIN_CONNECTION})

        response = self.client.get_connection(CONNECTION_ID)

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/connections/{CONNECTION_ID}"
        )
        self.assertEqual(response, {"connection": LINKEDIN_CONNECTION})

    def test_get_connection_reads_an_expiring_login(self) -> None:
        set_stub_response(
            200,
            {
                "connection": {
                    **LINKEDIN_CONNECTION,
                    "status": "expiring",
                    "loginExpiresAt": "2026-09-20T09:24:11.412Z",
                }
            },
        )

        response = self.client.get_connection(CONNECTION_ID)

        self.assertEqual(response["connection"]["status"], "expiring")
        self.assertEqual(
            response["connection"]["loginExpiresAt"],
            "2026-09-20T09:24:11.412Z",
        )

    def test_list_connections_reads_a_reconnect_required_login(self) -> None:
        set_stub_response(
            200,
            {
                "connections": [
                    {
                        **LINKEDIN_CONNECTION,
                        "status": "reconnect_required",
                        "loginExpiresAt": None,
                    }
                ]
            },
        )

        response = self.client.list_connections()

        self.assertEqual(
            response["connections"][0]["status"], "reconnect_required"
        )

    def test_delete_connection_disconnects_it(self) -> None:
        set_stub_response(200, {"id": CONNECTION_ID, "deleted": True})

        response = self.client.delete_connection(CONNECTION_ID)

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "DELETE")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/connections/{CONNECTION_ID}"
        )
        self.assertEqual(response, {"id": CONNECTION_ID, "deleted": True})

    def test_update_connection_moves_it_into_a_profile(self) -> None:
        set_stub_response(
            200,
            {"connection": {**LINKEDIN_CONNECTION, "profileId": PROFILE_ID}},
        )

        response = self.client.update_connection(CONNECTION_ID, PROFILE_ID)

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "PATCH")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/connections/{CONNECTION_ID}"
        )
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {"profileId": PROFILE_ID},
        )
        self.assertEqual(response["connection"]["profileId"], PROFILE_ID)

    def test_update_connection_moves_it_back_out_with_none(self) -> None:
        set_stub_response(200, {"connection": LINKEDIN_CONNECTION})

        response = self.client.update_connection(CONNECTION_ID, None)

        # An explicit null, not an omitted field: null is what moves the
        # connection back out to your own
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]), {"profileId": None}
        )
        self.assertEqual(response["connection"]["profileId"], None)

    def test_moving_into_a_profile_that_holds_the_account_raises(self) -> None:
        set_stub_response(
            409,
            {
                "error": "connection_conflict",
                "message": (
                    "That profile already holds a connection to this account."
                ),
            },
        )

        with self.assertRaises(YeetpostApiError) as raised:
            self.client.update_connection(CONNECTION_ID, PROFILE_ID)

        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(raised.exception.code, "connection_conflict")

    def test_list_connection_queue_returns_what_is_waiting(self) -> None:
        set_stub_response(
            200,
            {
                "queue": [
                    {
                        "id": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                        "text": "goes out at the next open slot",
                        "scheduledFor": "2026-09-07T06:00:00.000Z",
                        "mediaCount": 0,
                    }
                ]
            },
        )

        response = self.client.list_connection_queue(CONNECTION_ID)

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "GET")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            f"/api/v2/connections/{CONNECTION_ID}/queue",
        )
        self.assertEqual(
            response["queue"][0]["scheduledFor"], "2026-09-07T06:00:00.000Z"
        )

    def test_update_connection_queue_patches_the_slots(self) -> None:
        set_stub_response(
            200,
            {
                "connection": {
                    "id": CONNECTION_ID,
                    "slug": "linkedin",
                    "timezone": "Europe/Helsinki",
                    "queueSlots": [{"weekday": 1, "time": "09:00"}],
                }
            },
        )

        response = self.client.update_connection_queue(
            CONNECTION_ID,
            slots=[{"weekday": 1, "time": "09:00"}],
            timezone="Europe/Helsinki",
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "PATCH")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            f"/api/v2/connections/{CONNECTION_ID}/queue",
        )
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "slots": [{"weekday": 1, "time": "09:00"}],
                "timezone": "Europe/Helsinki",
            },
        )
        self.assertEqual(
            response["connection"]["timezone"], "Europe/Helsinki"
        )

    def test_list_connections_narrows_to_one_profile(self) -> None:
        acme_connection = {
            **LINKEDIN_CONNECTION,
            "slug": "acme_linkedin",
            "profileId": PROFILE_ID,
        }
        set_stub_response(200, {"connections": [acme_connection]})

        response = self.client.list_connections(profile_id=PROFILE_ID)

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            f"/api/v2/connections?profileId={PROFILE_ID}",
        )
        self.assertEqual(
            response["connections"][0]["profileId"], PROFILE_ID
        )

    def test_create_profile_sends_the_name_and_the_external_id(self) -> None:
        set_stub_response(200, {"profile": ACME_PROFILE})

        response = self.client.create_profile("Acme Coffee", "cus_4821")

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "POST")
        self.assertEqual(RECORDED_REQUESTS[0]["path"], "/api/v2/profiles")
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {"name": "Acme Coffee", "externalId": "cus_4821"},
        )
        self.assertEqual(response, {"profile": ACME_PROFILE})

    def test_create_profile_leaves_out_an_external_id_it_was_not_given(
        self,
    ) -> None:
        set_stub_response(
            200, {"profile": {**ACME_PROFILE, "externalId": None}}
        )

        response = self.client.create_profile("Acme Coffee")

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]), {"name": "Acme Coffee"}
        )
        self.assertEqual(response["profile"]["externalId"], None)

    def test_list_profiles_puts_its_paging_in_the_query_string(self) -> None:
        set_stub_response(
            200, {"profiles": [ACME_PROFILE], "limit": 10, "offset": 0}
        )

        response = self.client.list_profiles(limit=10, offset=0)

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "GET")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], "/api/v2/profiles?limit=10&offset=0"
        )
        self.assertEqual(
            response, {"profiles": [ACME_PROFILE], "limit": 10, "offset": 0}
        )

    def test_list_profiles_sends_no_query_string_without_paging(self) -> None:
        set_stub_response(200, {"profiles": [], "limit": 25, "offset": 0})

        self.client.list_profiles()

        self.assertEqual(RECORDED_REQUESTS[0]["path"], "/api/v2/profiles")

    def test_get_profile_reads_one_profile(self) -> None:
        set_stub_response(200, {"profile": ACME_PROFILE})

        response = self.client.get_profile(PROFILE_ID)

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/profiles/{PROFILE_ID}"
        )
        self.assertEqual(response, {"profile": ACME_PROFILE})

    def test_update_profile_sends_only_the_fields_it_was_given(self) -> None:
        set_stub_response(
            200, {"profile": {**ACME_PROFILE, "name": "Acme Coffee Oy"}}
        )

        response = self.client.update_profile(PROFILE_ID, "Acme Coffee Oy")

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "PATCH")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/profiles/{PROFILE_ID}"
        )
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {"name": "Acme Coffee Oy"},
        )
        self.assertEqual(response["profile"]["name"], "Acme Coffee Oy")

    def test_update_profile_clears_the_external_id_with_a_null(self) -> None:
        set_stub_response(
            200, {"profile": {**ACME_PROFILE, "externalId": None}}
        )

        self.client.update_profile(PROFILE_ID, clear_external_id=True)

        # An explicit null, not an omitted field: the API reads the two
        # differently, and only the null takes the external id off
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]), {"externalId": None}
        )

    def test_update_profile_refuses_an_external_id_and_a_clear(self) -> None:
        with self.assertRaises(ValueError):
            self.client.update_profile(
                PROFILE_ID,
                external_id="cus_4821",
                clear_external_id=True,
            )

    def test_update_profile_refuses_a_call_that_names_no_field(self) -> None:
        with self.assertRaises(ValueError):
            self.client.update_profile(PROFILE_ID)

        # Refused here rather than by the API: nothing went out
        self.assertEqual(RECORDED_REQUESTS, [])

    def test_delete_profile_says_how_many_connections_went(self) -> None:
        set_stub_response(
            200, {"id": PROFILE_ID, "deleted": True, "removedConnections": 2}
        )

        response = self.client.delete_profile(PROFILE_ID)

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "DELETE")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/profiles/{PROFILE_ID}"
        )
        self.assertEqual(
            response,
            {"id": PROFILE_ID, "deleted": True, "removedConnections": 2},
        )

    def test_a_second_profile_with_the_same_external_id_raises(self) -> None:
        set_stub_response(
            409,
            {
                "error": "profile_external_id_conflict",
                "message": "A profile with this externalId already exists.",
            },
        )

        with self.assertRaises(YeetpostApiError) as raised:
            self.client.create_profile("Acme Coffee", "cus_4821")

        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(
            raised.exception.code, "profile_external_id_conflict"
        )

    def test_create_profile_key_sends_the_name_type_and_allowlist(
        self,
    ) -> None:
        set_stub_response(
            201, {"key": ACME_KEY, "secret": "yp_secret_4f9a2c8e"}
        )

        response = self.client.create_profile_key(
            PROFILE_ID,
            "Acme integration",
            "live",
            ["https://acme.example.com"],
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "POST")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/profiles/{PROFILE_ID}/keys"
        )
        self.assertEqual(
            RECORDED_REQUESTS[0]["headers"]["content-type"],
            "application/json",
        )
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "name": "Acme integration",
                "type": "live",
                "redirectAllowlist": ["https://acme.example.com"],
            },
        )
        self.assertEqual(
            response, {"key": ACME_KEY, "secret": "yp_secret_4f9a2c8e"}
        )

    def test_create_profile_key_leaves_out_an_allowlist_it_was_not_given(
        self,
    ) -> None:
        set_stub_response(
            201,
            {
                "key": {**ACME_KEY, "redirectAllowlist": None},
                "secret": "yp_secret_4f9a2c8e",
            },
        )

        response = self.client.create_profile_key(
            PROFILE_ID, "Acme integration", "live"
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {"name": "Acme integration", "type": "live"},
        )
        self.assertEqual(response["key"]["redirectAllowlist"], None)

    def test_list_profile_keys_puts_include_revoked_in_the_query(self) -> None:
        revoked_key = {**ACME_KEY, "revokedAt": "2026-08-30T10:00:00.000Z"}
        set_stub_response(
            200, {"keys": [ACME_KEY, revoked_key], "limit": 25, "offset": 0}
        )

        response = self.client.list_profile_keys(
            PROFILE_ID, include_revoked=True
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "GET")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            f"/api/v2/profiles/{PROFILE_ID}/keys?includeRevoked=true",
        )
        self.assertEqual(
            response["keys"][1]["revokedAt"], "2026-08-30T10:00:00.000Z"
        )

    def test_list_profile_keys_puts_its_paging_in_the_query(self) -> None:
        set_stub_response(200, {"keys": [ACME_KEY], "limit": 10, "offset": 20})

        response = self.client.list_profile_keys(PROFILE_ID, limit=10, offset=20)

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            f"/api/v2/profiles/{PROFILE_ID}/keys?limit=10&offset=20",
        )
        self.assertEqual(
            response, {"keys": [ACME_KEY], "limit": 10, "offset": 20}
        )

    def test_list_profile_keys_sends_no_query_string_without_it(self) -> None:
        set_stub_response(200, {"keys": [ACME_KEY], "limit": 25, "offset": 0})

        response = self.client.list_profile_keys(PROFILE_ID)

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/profiles/{PROFILE_ID}/keys"
        )
        self.assertEqual(
            response, {"keys": [ACME_KEY], "limit": 25, "offset": 0}
        )

    def test_an_id_with_a_slash_is_escaped_into_one_path_segment(self) -> None:
        set_stub_response(200, {"id": "acme/key", "revoked": True})

        self.client.revoke_key("acme/key")

        # The slash is %2F, so the id cannot open a path of its own
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], "/api/v2/keys/acme%2Fkey"
        )

    def test_revoke_profile_key_deletes_the_key_under_its_profile(
        self,
    ) -> None:
        set_stub_response(200, {"id": KEY_ID, "revoked": True})

        response = self.client.revoke_profile_key(PROFILE_ID, KEY_ID)

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "DELETE")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            f"/api/v2/profiles/{PROFILE_ID}/keys/{KEY_ID}",
        )
        self.assertEqual(response, {"id": KEY_ID, "revoked": True})

    def test_list_keys_reads_every_key_of_the_account(self) -> None:
        account_key = {**ACME_KEY, "profileId": None}
        set_stub_response(
            200, {"keys": [account_key, ACME_KEY], "limit": 25, "offset": 0}
        )

        response = self.client.list_keys()

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "GET")
        self.assertEqual(RECORDED_REQUESTS[0]["path"], "/api/v2/keys")
        self.assertEqual(response["keys"][0]["profileId"], None)
        self.assertEqual(response["keys"][1]["profileId"], PROFILE_ID)

    def test_list_keys_puts_include_revoked_in_the_query_string(self) -> None:
        set_stub_response(200, {"keys": [ACME_KEY], "limit": 25, "offset": 0})

        self.client.list_keys(include_revoked=False)

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], "/api/v2/keys?includeRevoked=false"
        )

    def test_list_keys_puts_its_paging_in_the_query_string(self) -> None:
        set_stub_response(200, {"keys": [ACME_KEY], "limit": 50, "offset": 100})

        response = self.client.list_keys(limit=50, offset=100)

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], "/api/v2/keys?limit=50&offset=100"
        )
        self.assertEqual(response["limit"], 50)
        self.assertEqual(response["offset"], 100)

    def test_revoke_key_revokes_any_key_of_the_account_by_id(self) -> None:
        set_stub_response(200, {"id": KEY_ID, "revoked": True})

        response = self.client.revoke_key(KEY_ID)

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "DELETE")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/keys/{KEY_ID}"
        )
        self.assertEqual(response, {"id": KEY_ID, "revoked": True})

    def test_minting_a_key_with_a_key_scoped_to_a_profile_raises(self) -> None:
        set_stub_response(
            403,
            {"error": "forbidden", "message": SCOPED_KEY_MESSAGE},
        )

        with self.assertRaises(YeetpostApiError) as raised:
            self.client.create_profile_key(
                PROFILE_ID, "Acme integration", "live"
            )

        self.assertEqual(raised.exception.status, 403)
        self.assertEqual(raised.exception.code, "forbidden")
        self.assertEqual(str(raised.exception), SCOPED_KEY_MESSAGE)

    def test_create_connect_url_posts_the_platform_and_redirect_url(
        self,
    ) -> None:
        set_stub_response(200, CONNECT_SESSION)

        response = self.client.create_connect_url(
            PROFILE_ID,
            "https://acme.example.com/settings/social",
            "linkedin",
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "POST")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            f"/api/v2/profiles/{PROFILE_ID}/connect",
        )
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "platform": "linkedin",
                "redirectUrl": "https://acme.example.com/settings/social",
            },
        )
        self.assertEqual(response, CONNECT_SESSION)

    def test_create_connect_url_leaves_the_platform_out_for_a_picker(
        self,
    ) -> None:
        set_stub_response(200, CONNECT_SESSION)

        self.client.create_connect_url(
            PROFILE_ID,
            "https://acme.example.com/settings/social",
            headless=True,
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "redirectUrl": "https://acme.example.com/settings/social",
                "headless": True,
            },
        )

    def test_create_connect_url_opens_a_link_for_a_meta_platform(self) -> None:
        set_stub_response(200, CONNECT_SESSION)

        self.client.create_connect_url(
            PROFILE_ID,
            "https://acme.example.com/settings/social",
            "threads",
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "platform": "threads",
                "redirectUrl": "https://acme.example.com/settings/social",
            },
        )

    def test_get_connect_session_reads_how_a_link_ended(self) -> None:
        set_stub_response(
            200,
            {
                "connectSession": {
                    "id": CONNECT_SESSION_ID,
                    "profileId": PROFILE_ID,
                    "platform": "linkedin",
                    "status": "connected",
                    "connectionId": CONNECTION_ID,
                    "error": None,
                    "redirectUrl": "https://acme.example.com/settings/social",
                    "headless": False,
                    "expiresAt": "2026-08-29T09:39:11.412Z",
                    "createdAt": "2026-08-29T09:24:11.412Z",
                }
            },
        )

        response = self.client.get_connect_session(CONNECT_SESSION_ID)

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "GET")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            f"/api/v2/connect-sessions/{CONNECT_SESSION_ID}",
        )
        self.assertEqual(response["connectSession"]["status"], "connected")
        self.assertEqual(
            response["connectSession"]["connectionId"], CONNECTION_ID
        )

    def test_create_posts_sends_the_body_and_idempotency_key(self) -> None:
        set_stub_response(
            200,
            {
                "results": [
                    {
                        "connectionSlug": "linkedin",
                        "status": "sent",
                        "postId": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                        "url": "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
                        "scheduledFor": None,
                        "error": None,
                    },
                    {
                        "connectionSlug": "x",
                        "status": "failed",
                        "postId": "0b7e4a52-9f0c-4a1c-8b3a-6d2f5b1c0e44",
                        "url": None,
                        "scheduledFor": None,
                        "error": {
                            "code": "platform_rejected",
                            "message": "X: duplicate post was detected",
                        },
                    },
                ]
            },
        )

        response = self.client.create_posts(
            text="shipped the new api docs today",
            connection_slugs=["linkedin", "x"],
            idempotency_key="release-v2.4.0-announcement",
        )

        self.assertEqual(len(RECORDED_REQUESTS), 1)
        self.assertEqual(RECORDED_REQUESTS[0]["method"], "POST")
        self.assertEqual(RECORDED_REQUESTS[0]["path"], "/api/v2/posts")
        self.assertEqual(
            RECORDED_REQUESTS[0]["headers"]["content-type"], "application/json"
        )
        self.assertEqual(
            RECORDED_REQUESTS[0]["headers"]["idempotency-key"],
            "release-v2.4.0-announcement",
        )
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "text": "shipped the new api docs today",
                "connectionSlugs": ["linkedin", "x"],
            },
        )
        self.assertEqual(len(response["results"]), 2)
        self.assertEqual(
            response["results"][1],
            {
                "connectionSlug": "x",
                "status": "failed",
                "postId": "0b7e4a52-9f0c-4a1c-8b3a-6d2f5b1c0e44",
                "url": None,
                "scheduledFor": None,
                "error": {
                    "code": "platform_rejected",
                    "message": "X: duplicate post was detected",
                },
            },
        )

    def test_create_posts_reads_the_warning_inside_the_grace_window(
        self,
    ) -> None:
        set_stub_response(
            200,
            {
                "results": [
                    {
                        "connectionSlug": "linkedin",
                        "status": "sent",
                        "postId": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                        "url": "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
                        "scheduledFor": None,
                        "threadCount": 0,
                        "hasFirstComment": False,
                        "warning": GRACE_WARNING,
                        "error": None,
                    }
                ]
            },
        )

        response = self.client.create_posts(
            text="shipped the new api docs today",
            connection_slugs=["linkedin"],
        )

        self.assertEqual(response["results"][0]["status"], "sent")
        self.assertEqual(response["results"][0]["warning"], GRACE_WARNING)

    def test_create_posts_reads_a_connection_limit_refusal_as_failed(
        self,
    ) -> None:
        set_stub_response(
            200,
            {
                "results": [
                    {
                        "connectionSlug": "linkedin",
                        "status": "failed",
                        "postId": None,
                        "url": None,
                        "scheduledFor": None,
                        "threadCount": 0,
                        "hasFirstComment": False,
                        "error": {
                            "code": "connection_limit_exceeded",
                            "message": (
                                "This account has 4 connected accounts, over "
                                "the free limit of 3. Subscribe or disconnect "
                                "down to 3 to keep posting."
                            ),
                        },
                    }
                ]
            },
        )

        response = self.client.create_posts(
            text="shipped the new api docs today",
            connection_slugs=["linkedin"],
        )

        self.assertEqual(response["results"][0]["status"], "failed")
        self.assertEqual("warning" in response["results"][0], False)
        self.assertEqual(
            response["results"][0]["error"]["code"],
            "connection_limit_exceeded",
        )

    def test_create_posts_sends_the_profile_it_goes_out_for(self) -> None:
        set_stub_response(200, {"results": []})

        self.client.create_posts(
            text="our new roast is out",
            connection_slugs=["acme_linkedin"],
            profile_id=PROFILE_ID,
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "text": "our new roast is out",
                "connectionSlugs": ["acme_linkedin"],
                "profileId": PROFILE_ID,
            },
        )

    def test_list_posts_narrows_to_one_profile(self) -> None:
        set_stub_response(200, {"posts": [], "limit": 25, "offset": 0})

        self.client.list_posts(profile_id=PROFILE_ID)

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            f"/api/v2/posts?profileId={PROFILE_ID}",
        )

    def test_create_posts_sends_scheduled_for_when_it_is_given(self) -> None:
        set_stub_response(200, {"results": []})

        self.client.create_posts(
            text="scheduled from a real integration",
            connection_slugs=["linkedin"],
            scheduled_for="2026-09-15T15:00:00Z",
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "text": "scheduled from a real integration",
                "connectionSlugs": ["linkedin"],
                "scheduledFor": "2026-09-15T15:00:00Z",
            },
        )

    def test_create_posts_reads_a_fourth_positional_as_the_idempotency_key(
        self,
    ) -> None:
        set_stub_response(200, {"results": []})

        self.client.create_posts(
            "v2.4.0 is out",
            ["linkedin"],
            None,
            "release-v2.4.0-announcement",
        )

        self.assertEqual(
            RECORDED_REQUESTS[0]["headers"]["idempotency-key"],
            "release-v2.4.0-announcement",
        )
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "text": "v2.4.0 is out",
                "connectionSlugs": ["linkedin"],
            },
        )

    def test_create_posts_sends_a_timezone_with_a_local_time(self) -> None:
        set_stub_response(200, {"results": []})

        self.client.create_posts(
            text="nine in the morning, helsinki",
            connection_slugs=["linkedin"],
            scheduled_for="2026-09-15T09:00:00",
            timezone="Europe/Helsinki",
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "text": "nine in the morning, helsinki",
                "connectionSlugs": ["linkedin"],
                "scheduledFor": "2026-09-15T09:00:00",
                "timezone": "Europe/Helsinki",
            },
        )

    def test_create_posts_sends_queue_and_reads_back_the_slot(self) -> None:
        set_stub_response(
            200,
            {
                "results": [
                    {
                        "connectionSlug": "linkedin",
                        "status": "scheduled",
                        "postId": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                        "url": None,
                        "scheduledFor": "2026-09-07T06:00:00.000Z",
                        "error": None,
                    }
                ]
            },
        )

        response = self.client.create_posts(
            text="goes out at the next open slot",
            connection_slugs=["linkedin"],
            queue=True,
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "text": "goes out at the next open slot",
                "connectionSlugs": ["linkedin"],
                "queue": True,
            },
        )
        self.assertEqual(response["results"][0]["status"], "scheduled")
        self.assertEqual(
            response["results"][0]["scheduledFor"], "2026-09-07T06:00:00.000Z"
        )

    def test_create_posts_sends_media_ids_thread_and_first_comment(
        self,
    ) -> None:
        set_stub_response(200, {"results": []})

        self.client.create_posts(
            text="the head post",
            connection_slugs=["x", "bluesky"],
            media_ids=[MEDIA_ID],
            thread=["second", "third"],
            first_comment="the link is here",
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "text": "the head post",
                "connectionSlugs": ["x", "bluesky"],
                "mediaIds": [MEDIA_ID],
                "thread": ["second", "third"],
                "firstComment": "the link is here",
            },
        )

    def test_create_posts_sends_media_with_its_own_alt_text(self) -> None:
        set_stub_response(200, {"results": []})

        self.client.create_posts(
            text="with a described image",
            connection_slugs=["bluesky"],
            media=[{"id": MEDIA_ID, "altText": "the new docs page"}],
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "text": "with a described image",
                "connectionSlugs": ["bluesky"],
                "media": [{"id": MEDIA_ID, "altText": "the new docs page"}],
            },
        )

    def test_create_posts_sends_media_urls(self) -> None:
        set_stub_response(200, {"results": []})

        self.client.create_posts(
            text="fetched by yeetpost itself",
            connection_slugs=["bluesky"],
            media_urls=["https://example.com/shot.png"],
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "text": "fetched by yeetpost itself",
                "connectionSlugs": ["bluesky"],
                "mediaUrls": ["https://example.com/shot.png"],
            },
        )

    def test_upload_media_sends_the_raw_bytes_with_the_content_type(
        self,
    ) -> None:
        set_stub_response(
            200,
            {
                "mediaId": MEDIA_ID,
                "contentType": "image/png",
                "sizeBytes": 4,
            },
        )

        # The stub records the body as utf8, so these bytes are ascii ones:
        # what is asserted is that the body is the bytes themselves, with no
        # multipart around them
        response = self.client.upload_media(
            b"PNGB", "image/png", alt_text="the new docs page"
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "POST")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/media?alt_text=the+new+docs+page",
        )
        self.assertEqual(
            RECORDED_REQUESTS[0]["headers"]["content-type"], "image/png"
        )
        self.assertEqual(RECORDED_REQUESTS[0]["body"], "PNGB")
        self.assertEqual(response["mediaId"], MEDIA_ID)

    def test_get_media_reads_the_bytes_back_with_the_content_type(self) -> None:
        set_stub_response(200, "PNGB", content_type="image/png")

        response = self.client.get_media(MEDIA_ID)

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "GET")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/media/{MEDIA_ID}"
        )
        self.assertEqual(
            response, {"bytes": b"PNGB", "contentType": "image/png"}
        )

    def test_get_media_keeps_only_the_media_type_of_the_header(self) -> None:
        set_stub_response(
            200, "PNGB", content_type="image/png; charset=binary"
        )

        response = self.client.get_media(MEDIA_ID)

        self.assertEqual(response["contentType"], "image/png")

    def test_delete_media_sends_a_delete(self) -> None:
        set_stub_response(200, {"id": MEDIA_ID, "deleted": True})

        response = self.client.delete_media(MEDIA_ID)

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "DELETE")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/media/{MEDIA_ID}"
        )
        self.assertEqual(response, {"id": MEDIA_ID, "deleted": True})

    def test_list_posts_puts_its_filters_in_the_query_string(self) -> None:
        set_stub_response(200, {"posts": [], "limit": 10, "offset": 0})

        self.client.list_posts(status="scheduled", limit=10)

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/posts?status=scheduled&limit=10",
        )

    def test_list_posts_repeats_tag_once_per_label(self) -> None:
        set_stub_response(200, {"posts": [], "limit": 25, "offset": 0})

        self.client.list_posts(status="draft", tag=["launch", "q3"])

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/posts?status=draft&tag=launch&tag=q3",
        )

    def test_list_posts_sends_the_schedule_connection_and_send_group_filters(
        self,
    ) -> None:
        set_stub_response(200, {"posts": [], "limit": 25, "offset": 0})

        self.client.list_posts(
            scheduled_after="2026-09-01T00:00:00Z",
            scheduled_before="2026-09-30T00:00:00Z",
            connection_slug="linkedin",
            platform="linkedin",
            send_group_id=PROFILE_ID,
        )

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/posts"
            "?scheduledAfter=2026-09-01T00%3A00%3A00Z"
            "&scheduledBefore=2026-09-30T00%3A00%3A00Z"
            "&connectionSlug=linkedin"
            "&platform=linkedin"
            f"&sendGroupId={PROFILE_ID}",
        )

    def test_get_post_reads_media_thread_first_comment_and_published_at(
        self,
    ) -> None:
        set_stub_response(
            200,
            {
                "post": {
                    "id": POST_ID,
                    "connectionSlug": "x",
                    "profileId": None,
                    "text": "the head post",
                    "originalText": "the head post",
                    "aiRewriteStatus": None,
                    "status": "sent",
                    "url": "https://x.com/alexdoe/status/1234567890",
                    "scheduledFor": None,
                    "createdAt": "2026-08-26T09:24:11.412Z",
                    "tags": [],
                    "platformPostId": "1234567890",
                    "deletedAt": None,
                    "error": None,
                    "media": [{"id": MEDIA_ID, "altText": "the new docs page"}],
                    "thread": ["second segment", "third segment"],
                    "firstComment": "the link is here",
                    "publishedAt": "2026-08-26T09:24:30.000Z",
                }
            },
        )

        response = self.client.get_post(POST_ID)

        self.assertEqual(
            response["post"]["media"],
            [{"id": MEDIA_ID, "altText": "the new docs page"}],
        )
        self.assertEqual(
            response["post"]["thread"], ["second segment", "third segment"]
        )
        self.assertEqual(response["post"]["firstComment"], "the link is here")
        self.assertEqual(
            response["post"]["publishedAt"], "2026-08-26T09:24:30.000Z"
        )

    def test_get_post_metrics_reads_the_latest_and_the_history(self) -> None:
        set_stub_response(
            200,
            {
                "latest": {
                    "fetchedAt": "2026-08-30T10:00:00.000Z",
                    "impressions": None,
                    "likes": 12,
                    "reposts": 3,
                    "replies": 1,
                    "clicks": None,
                },
                "history": [
                    {
                        "fetchedAt": "2026-08-29T10:00:00.000Z",
                        "impressions": None,
                        "likes": 4,
                        "reposts": 1,
                        "replies": 0,
                        "clicks": None,
                    },
                    {
                        "fetchedAt": "2026-08-30T10:00:00.000Z",
                        "impressions": None,
                        "likes": 12,
                        "reposts": 3,
                        "replies": 1,
                        "clicks": None,
                    },
                ],
            },
        )

        response = self.client.get_post_metrics(POST_ID)

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "GET")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/posts/{POST_ID}/metrics"
        )
        latest = response["latest"]
        assert latest is not None
        self.assertEqual(latest["likes"], 12)
        # Bluesky reports no impressions, and None says so rather than
        # claiming zero
        self.assertIsNone(latest["impressions"])
        self.assertEqual(len(response["history"]), 2)

    def test_get_post_metrics_answers_none_before_the_first_read(self) -> None:
        set_stub_response(200, {"latest": None, "history": []})

        response = self.client.get_post_metrics(POST_ID)

        self.assertIsNone(response["latest"])
        self.assertEqual(response["history"], [])

    def test_get_analytics_puts_its_window_in_the_query_string(self) -> None:
        set_stub_response(
            200,
            {
                "totals": {
                    "posts": 2,
                    "impressions": 0,
                    "likes": 16,
                    "reposts": 4,
                    "replies": 1,
                    "clicks": 0,
                },
                "days": [
                    {
                        "day": "2026-08-29",
                        "posts": 1,
                        "impressions": 0,
                        "likes": 4,
                        "reposts": 1,
                        "replies": 0,
                    },
                    {
                        "day": "2026-08-30",
                        "posts": 1,
                        "impressions": 0,
                        "likes": 12,
                        "reposts": 3,
                        "replies": 1,
                    },
                ],
                "byPlatform": [
                    {
                        "platformId": "bluesky",
                        "posts": 2,
                        "impressions": 0,
                        "likes": 16,
                        "reposts": 4,
                        "replies": 1,
                        "clicks": 0,
                    }
                ],
                "from": "2026-08-29",
                "to": "2026-08-30",
            },
        )

        response = self.client.get_analytics(
            from_="2026-08-29", to="2026-08-30", platform="bluesky"
        )

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/analytics?from=2026-08-29&to=2026-08-30"
            "&platform=bluesky",
        )
        self.assertEqual(response["totals"]["likes"], 16)
        self.assertEqual(len(response["days"]), 2)
        self.assertEqual(response["byPlatform"][0]["platformId"], "bluesky")

    def test_get_analytics_with_no_window_asks_for_the_default(self) -> None:
        set_stub_response(
            200,
            {
                "totals": {
                    "posts": 0,
                    "impressions": 0,
                    "likes": 0,
                    "reposts": 0,
                    "replies": 0,
                    "clicks": 0,
                },
                "days": [],
                "byPlatform": [],
                "from": "2026-08-01",
                "to": "2026-08-30",
            },
        )

        self.client.get_analytics()

        self.assertEqual(RECORDED_REQUESTS[0]["path"], "/api/v2/analytics")

    def test_create_posts_sends_is_draft_and_tags(self) -> None:
        set_stub_response(
            200,
            {
                "results": [
                    {
                        "connectionSlug": "linkedin",
                        "status": "draft",
                        "postId": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                        "url": None,
                        "scheduledFor": None,
                        "error": None,
                    }
                ]
            },
        )

        response = self.client.create_posts(
            text="half an idea",
            connection_slugs=["linkedin"],
            is_draft=True,
            tags=["launch"],
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "text": "half an idea",
                "connectionSlugs": ["linkedin"],
                "isDraft": True,
                "tags": ["launch"],
            },
        )
        self.assertEqual(response["results"][0]["status"], "draft")

    def test_publish_post_sends_an_empty_body(self) -> None:
        set_stub_response(
            200,
            {
                "result": {
                    "connectionSlug": "linkedin",
                    "status": "sent",
                    "postId": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                    "url": "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
                    "scheduledFor": None,
                    "error": None,
                }
            },
        )

        response = self.client.publish_post(
            "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "POST")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10/publish",
        )
        self.assertEqual(json.loads(RECORDED_REQUESTS[0]["body"]), {})
        self.assertEqual(response["result"]["status"], "sent")

    def test_publish_post_reads_the_warning_inside_the_grace_window(
        self,
    ) -> None:
        set_stub_response(
            200,
            {
                "result": {
                    "connectionSlug": "linkedin",
                    "status": "sent",
                    "postId": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                    "url": "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
                    "scheduledFor": None,
                    "threadCount": 0,
                    "hasFirstComment": False,
                    "warning": GRACE_WARNING,
                    "error": None,
                }
            },
        )

        response = self.client.publish_post(
            "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"
        )

        self.assertEqual(response["result"]["status"], "sent")
        self.assertEqual(response["result"]["warning"], GRACE_WARNING)

    def test_publish_post_sends_a_time_and_an_idempotency_key(self) -> None:
        set_stub_response(200, {"result": {}})

        self.client.publish_post(
            "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
            "2026-09-15T09:00:00",
            "publish-the-launch-post",
            timezone="Europe/Helsinki",
        )

        self.assertEqual(
            RECORDED_REQUESTS[0]["headers"]["idempotency-key"],
            "publish-the-launch-post",
        )
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "scheduledFor": "2026-09-15T09:00:00",
                "timezone": "Europe/Helsinki",
            },
        )

    def test_update_draft_sends_only_the_fields_it_was_given(self) -> None:
        set_stub_response(
            200,
            {
                "post": {
                    "id": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                    "connectionSlug": "linkedin",
                    "text": "a better idea",
                    "status": "draft",
                    "url": None,
                    "scheduledFor": None,
                    "createdAt": "2026-08-26T09:24:11.412Z",
                    "tags": ["launch"],
                    "error": None,
                }
            },
        )

        response = self.client.update_draft(
            "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
            "a better idea",
            tags=["launch"],
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "PATCH")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        )
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {"text": "a better idea", "tags": ["launch"]},
        )
        self.assertEqual(response["post"]["tags"], ["launch"])

    def test_update_draft_clears_the_first_comment_with_a_null(self) -> None:
        set_stub_response(
            200,
            {
                "post": {
                    "id": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                    "connectionSlug": "linkedin",
                    "text": "a better idea",
                    "status": "draft",
                    "url": None,
                    "scheduledFor": None,
                    "createdAt": "2026-08-26T09:24:11.412Z",
                    "tags": [],
                    "error": None,
                }
            },
        )

        self.client.update_draft(
            "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
            clear_first_comment=True,
        )

        # An explicit null, not an omitted field: the API reads the two
        # differently, and only the null takes the comment off
        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {"firstComment": None},
        )

    def test_update_draft_replaces_the_images_with_media(self) -> None:
        set_stub_response(200, {"post": {}})

        self.client.update_draft(
            "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
            media=[{"id": MEDIA_ID, "altText": "the new docs page"}],
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {"media": [{"id": MEDIA_ID, "altText": "the new docs page"}]},
        )

    def test_update_draft_refuses_a_first_comment_and_a_clear(self) -> None:
        with self.assertRaises(ValueError):
            self.client.update_draft(
                "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                first_comment="what do you think?",
                clear_first_comment=True,
            )

    def test_update_draft_moves_a_scheduled_posts_time(self) -> None:
        set_stub_response(
            200,
            {
                "post": {
                    "id": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                    "connectionSlug": "linkedin",
                    "text": "a better idea",
                    "status": "scheduled",
                    "url": None,
                    "scheduledFor": "2026-09-20T15:00:00.000Z",
                    "createdAt": "2026-08-26T09:24:11.412Z",
                    "tags": [],
                    "error": None,
                }
            },
        )

        response = self.client.update_draft(
            "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
            scheduled_for="2026-09-20T18:00:00",
            timezone="Europe/Helsinki",
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {"scheduledFor": "2026-09-20T18:00:00", "timezone": "Europe/Helsinki"},
        )
        self.assertEqual(response["post"]["status"], "scheduled")
        self.assertEqual(
            response["post"]["scheduledFor"], "2026-09-20T15:00:00.000Z"
        )

    def test_update_draft_takes_the_next_free_slot_with_queue(self) -> None:
        set_stub_response(200, {"post": {}})

        self.client.update_draft(
            "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
            queue=True,
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {"queue": True},
        )

    def test_delete_draft_sends_a_delete(self) -> None:
        set_stub_response(
            200,
            {"id": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", "deleted": True},
        )

        response = self.client.delete_draft(
            "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "DELETE")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        )
        self.assertEqual(
            response,
            {"id": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", "deleted": True},
        )

    def test_delete_post_really_deletes_a_draft(self) -> None:
        set_stub_response(
            200,
            {"id": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", "deleted": True},
        )

        response = self.client.delete_post(
            "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "DELETE")
        self.assertEqual(
            response,
            {"id": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", "deleted": True},
        )

    def test_post_to_connection_sends_the_text_as_the_body(self) -> None:
        set_stub_response(
            200,
            {
                "platform": "linkedin",
                "link": "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
            },
        )

        response = self.client.post_to_connection(
            "linkedin", "shipped the new api docs today"
        )

        self.assertEqual(RECORDED_REQUESTS[0]["path"], "/api/v2/post/linkedin")
        self.assertEqual(
            RECORDED_REQUESTS[0]["headers"]["content-type"], "text/plain"
        )
        self.assertEqual(
            RECORDED_REQUESTS[0]["body"], "shipped the new api docs today"
        )
        self.assertEqual(
            response,
            {
                "platform": "linkedin",
                "link": "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
            },
        )

    def test_post_to_connection_reads_a_reddit_link_back(self) -> None:
        set_stub_response(
            200,
            {
                "platform": "reddit",
                "link": "https://www.reddit.com/r/yeetpost/comments/1abc2de/shipped_the_new_api_docs_today/",
            },
        )

        response = self.client.post_to_connection(
            "reddit", "shipped the new api docs today"
        )

        self.assertEqual(RECORDED_REQUESTS[0]["path"], "/api/v2/post/reddit")
        self.assertEqual(
            response,
            {
                "platform": "reddit",
                "link": "https://www.reddit.com/r/yeetpost/comments/1abc2de/shipped_the_new_api_docs_today/",
            },
        )

    def test_cancel_post_sends_a_delete(self) -> None:
        set_stub_response(
            200,
            {"id": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", "status": "cancelled"},
        )

        response = self.client.cancel_post(
            "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "DELETE")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        )
        self.assertEqual(
            response,
            {"id": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", "status": "cancelled"},
        )

    def test_delete_post_answers_with_the_deleted_post(self) -> None:
        set_stub_response(
            200,
            {
                "id": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                "status": "deleted",
                "deletedAt": "2026-08-29T11:02:44.108Z",
            },
        )

        response = self.client.delete_post(
            "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "DELETE")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        )
        self.assertEqual(
            response,
            {
                "id": "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
                "status": "deleted",
                "deletedAt": "2026-08-29T11:02:44.108Z",
            },
        )

    def test_retry_post_resends_a_failed_post(self) -> None:
        set_stub_response(200, {"id": POST_ID, "status": "sent"})

        response = self.client.retry_post(POST_ID)

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "POST")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], f"/api/v2/posts/{POST_ID}/retry"
        )
        self.assertEqual(response, {"id": POST_ID, "status": "sent"})

    def test_retry_post_reads_the_warning_inside_the_grace_window(
        self,
    ) -> None:
        set_stub_response(
            200,
            {"id": POST_ID, "status": "sent", "warning": GRACE_WARNING},
        )

        response = self.client.retry_post(POST_ID)

        self.assertEqual(response["status"], "sent")
        self.assertEqual(response["warning"], GRACE_WARNING)

    def test_retry_post_on_a_post_that_did_not_fail_raises(self) -> None:
        set_stub_response(
            400,
            {
                "error": "invalid_request",
                "message": "Only a post that failed can be retried.",
            },
        )

        with self.assertRaises(YeetpostApiError) as raised:
            self.client.retry_post(POST_ID)

        self.assertEqual(raised.exception.status, 400)
        self.assertEqual(raised.exception.code, "invalid_request")

    def test_create_webhook_returns_the_secret(self) -> None:
        set_stub_response(
            200,
            {
                "webhook": {
                    "id": "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
                    "url": "https://example.com/hooks/yeetpost",
                    "events": ["post.sent", "post.failed"],
                    "secret": "yp_whsec_3f1a",
                    "createdAt": "2026-08-26T09:24:11.412Z",
                }
            },
        )

        response = self.client.create_webhook(
            url="https://example.com/hooks/yeetpost", events=["post.sent"]
        )

        self.assertEqual(
            json.loads(RECORDED_REQUESTS[0]["body"]),
            {
                "url": "https://example.com/hooks/yeetpost",
                "events": ["post.sent"],
            },
        )
        self.assertEqual(response["webhook"]["secret"], "yp_whsec_3f1a")

    def test_list_webhook_deliveries_hits_the_deliveries_path(self) -> None:
        set_stub_response(
            200, {"deliveries": [], "limit": 10, "hasMore": False}
        )

        self.client.list_webhook_deliveries(
            "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90", limit=10
        )

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90/deliveries?limit=10",
        )

    def test_list_webhook_deliveries_filters_by_status_and_pages(self) -> None:
        set_stub_response(
            200, {"deliveries": [], "limit": 10, "hasMore": True}
        )

        response = self.client.list_webhook_deliveries(
            "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
            status="dead",
            limit=10,
            starting_after="9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "GET")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90/deliveries"
            "?status=dead&limit=10"
            "&startingAfter=9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
        )
        self.assertEqual(response["hasMore"], True)

    def test_replay_delivery_posts_to_the_replay_path(self) -> None:
        set_stub_response(
            200,
            {
                "delivery": {
                    "id": "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
                    "eventId": "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
                    "event": "post.sent",
                    "status": "pending",
                    "attempts": 0,
                    "createdAt": "2026-08-26T09:24:12.004Z",
                    "nextAttemptAt": "2026-08-26T11:02:41.880Z",
                    "deliveredAt": None,
                    "deadAt": None,
                    "lastStatusCode": None,
                    "lastError": None,
                }
            },
        )

        response = self.client.replay_delivery(
            "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
            "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "POST")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90"
            "/deliveries/9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68/replay",
        )
        self.assertEqual(
            response["delivery"],
            {
                "id": "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
                "eventId": "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
                "event": "post.sent",
                "status": "pending",
                "attempts": 0,
                "createdAt": "2026-08-26T09:24:12.004Z",
                "nextAttemptAt": "2026-08-26T11:02:41.880Z",
                "deliveredAt": None,
                "deadAt": None,
                "lastStatusCode": None,
                "lastError": None,
            },
        )

    def test_replaying_a_delivery_that_is_already_queued_raises(self) -> None:
        set_stub_response(
            400,
            {
                "error": "invalid_request",
                "message": "This delivery is already queued for another attempt.",
            },
        )

        with self.assertRaises(YeetpostApiError) as caught:
            self.client.replay_delivery(
                "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
                "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
            )

        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.code, "invalid_request")
        self.assertEqual(
            caught.exception.message,
            "This delivery is already queued for another attempt.",
        )

    def test_send_test_event_posts_to_the_test_path(self) -> None:
        set_stub_response(
            200,
            {
                "delivery": {
                    "id": "4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b",
                    "eventId": "4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b",
                    "event": "post.sent",
                    "status": "pending",
                    "attempts": 0,
                    "createdAt": "2026-08-26T09:24:12.004Z",
                    "nextAttemptAt": "2026-08-26T09:24:12.004Z",
                    "deliveredAt": None,
                    "deadAt": None,
                    "lastStatusCode": None,
                    "lastError": None,
                }
            },
        )

        response = self.client.send_test_event(
            "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90"
        )

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "POST")
        self.assertEqual(
            RECORDED_REQUESTS[0]["path"],
            "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90/test",
        )
        self.assertEqual(response["delivery"]["status"], "pending")
        self.assertEqual(
            response["delivery"]["eventId"],
            "4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b",
        )

    def test_get_health_reads_the_checks_behind_the_status(self) -> None:
        health = {
            "status": "degraded",
            "checks": {
                "database": {"ok": True, "latencyMs": 3},
                "scheduledPosts": {
                    "ok": False,
                    "lastRunAt": "2026-08-29T11:04:58.120Z",
                    "lastOkAt": None,
                },
                "webhookDeliveries": {
                    "ok": True,
                    "lastRunAt": "2026-08-29T11:04:57.870Z",
                    "lastOkAt": "2026-08-29T11:04:57.870Z",
                },
                "xUsageSweep": {
                    "ok": True,
                    "lastRunAt": "2026-08-29T11:04:31.004Z",
                    "lastOkAt": "2026-08-29T11:04:31.004Z",
                },
            },
            "version": "2.0.0",
            "time": "2026-08-29T11:05:00.512Z",
        }

        set_stub_response(200, health)

        response = self.client.get_health()

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "GET")
        self.assertEqual(RECORDED_REQUESTS[0]["path"], "/api/v2/health")
        self.assertEqual(response, health)

    def test_get_health_history_puts_the_window_in_the_query_string(
        self,
    ) -> None:
        history = {
            "days": [
                {
                    "day": "2026-08-27",
                    "uptimePercent": None,
                    "samples": 0,
                    "degradedMinutes": 0,
                },
                {
                    "day": "2026-08-28",
                    "uptimePercent": 100,
                    "samples": 1440,
                    "degradedMinutes": 0,
                },
                {
                    "day": "2026-08-29",
                    "uptimePercent": 99.72,
                    "samples": 718,
                    "degradedMinutes": 2,
                },
            ]
        }

        set_stub_response(200, history)

        response = self.client.get_health_history(days=3)

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], "/api/v2/health/history?days=3"
        )
        self.assertEqual(response, history)

    def test_get_health_history_sends_no_query_string_without_a_window(
        self,
    ) -> None:
        set_stub_response(200, {"days": []})

        self.client.get_health_history()

        self.assertEqual(
            RECORDED_REQUESTS[0]["path"], "/api/v2/health/history"
        )

    def test_get_stats_reads_the_public_counts_without_an_api_key(
        self,
    ) -> None:
        stats = {
            "postsThisWeek": 100,
            "postsAllTime": 1000,
            "liveConnections": 10,
            "platformsLive": [
                "linkedin",
                "x",
                "bluesky",
                "mastodon",
                "reddit",
                "google_business",
            ],
            "time": "2026-09-06T11:05:00.512Z",
        }

        set_stub_response(200, stats)

        response = Yeetpost("", base_url=self.base_url).get_stats()

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "GET")
        self.assertEqual(RECORDED_REQUESTS[0]["path"], "/api/v2/stats")
        self.assertEqual(
            RECORDED_REQUESTS[0]["headers"].get("x-api-key"), None
        )
        self.assertEqual(response, stats)

    def test_get_openapi_spec_reads_the_document_without_an_api_key(
        self,
    ) -> None:
        spec = {
            "openapi": "3.1.0",
            "info": {"title": "yeetpost API", "version": "2.0.0"},
        }

        set_stub_response(200, spec)

        response = Yeetpost("", base_url=self.base_url).get_openapi_spec()

        self.assertEqual(RECORDED_REQUESTS[0]["method"], "GET")
        self.assertEqual(RECORDED_REQUESTS[0]["path"], "/api/v2/openapi.json")
        self.assertEqual(
            RECORDED_REQUESTS[0]["headers"].get("x-api-key"), None
        )
        self.assertEqual(response, spec)

    def test_get_health_needs_no_api_key_and_sends_no_header(self) -> None:
        set_stub_response(200, {"status": "ok"})

        response = Yeetpost("", base_url=self.base_url).get_health()

        self.assertEqual(RECORDED_REQUESTS[0]["path"], "/api/v2/health")
        self.assertEqual(
            RECORDED_REQUESTS[0]["headers"].get("x-api-key"), None
        )
        self.assertEqual(response, {"status": "ok"})

    def test_a_call_that_needs_a_key_is_refused_before_the_request(
        self,
    ) -> None:
        client = Yeetpost("", base_url=self.base_url)

        with self.assertRaises(ValueError) as caught:
            client.list_connections()

        self.assertEqual(
            str(caught.exception), "api_key is required for this call"
        )
        self.assertEqual(len(RECORDED_REQUESTS), 0)

    def test_an_error_response_becomes_a_yeetpost_api_error(self) -> None:
        set_stub_response(
            400,
            {
                "error": "invalid_connection",
                "message": "Connection 'linkedn' not found. Available connections: linkedin, x",
            },
        )

        with self.assertRaises(YeetpostApiError) as caught:
            self.client.create_posts(
                text="hello", connection_slugs=["linkedn"]
            )

        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.code, "invalid_connection")
        self.assertEqual(
            caught.exception.message,
            "Connection 'linkedn' not found. Available connections: linkedin, x",
        )
        self.assertEqual(caught.exception.request_id, None)

    def test_req_id_on_an_error_is_exposed_as_request_id(self) -> None:
        set_stub_response(
            422,
            {
                "error": "platform_rejected",
                "message": "LinkedIn: duplicate post was detected",
                "req_id": "req_12345678",
            },
        )

        with self.assertRaises(YeetpostApiError) as caught:
            self.client.post_to_connection("linkedin", "hello")

        self.assertEqual(caught.exception.status, 422)
        self.assertEqual(caught.exception.code, "platform_rejected")
        self.assertEqual(caught.exception.request_id, "req_12345678")

    def test_the_x_request_id_header_leads_the_body_req_id(self) -> None:
        EXTRA_HEADERS["x-request-id"] = "req_from_the_header"
        set_stub_response(
            422,
            {
                "error": "platform_rejected",
                "message": "LinkedIn: duplicate post was detected",
                "req_id": "req_from_the_body",
            },
        )

        with self.assertRaises(YeetpostApiError) as caught:
            self.client.post_to_connection("linkedin", "hello")

        self.assertEqual(caught.exception.request_id, "req_from_the_header")

    def test_the_429_body_which_has_no_message_still_raises(self) -> None:
        EXTRA_HEADERS["x-ratelimit-limit"] = "60"
        EXTRA_HEADERS["x-ratelimit-remaining"] = "0"
        EXTRA_HEADERS["x-ratelimit-reset"] = "1787653500"
        set_stub_response(429, {"error": "too many requests"})

        with self.assertRaises(YeetpostApiError) as caught:
            self.client.list_posts()

        self.assertEqual(caught.exception.status, 429)
        self.assertEqual(caught.exception.code, "too many requests")
        self.assertEqual(caught.exception.message, "too many requests")
        self.assertEqual(caught.exception.request_id, None)
        self.assertEqual(caught.exception.rate_limit_limit, 60)
        self.assertEqual(caught.exception.rate_limit_remaining, 0)
        self.assertEqual(caught.exception.rate_limit_reset, 1787653500)

    def test_the_rate_limit_fields_are_minus_one_without_the_headers(
        self,
    ) -> None:
        set_stub_response(
            401, {"error": "unauthorized", "message": "invalid api key"}
        )

        with self.assertRaises(YeetpostApiError) as caught:
            self.client.list_posts()

        self.assertEqual(caught.exception.rate_limit_limit, -1)
        self.assertEqual(caught.exception.rate_limit_remaining, -1)
        self.assertEqual(caught.exception.rate_limit_reset, -1)

    def test_an_error_body_that_is_not_json_still_raises(self) -> None:
        set_stub_response(
            502, "<html>bad gateway</html>", content_type="text/html"
        )

        with self.assertRaises(YeetpostApiError) as caught:
            self.client.list_connections()

        self.assertEqual(caught.exception.status, 502)
        self.assertEqual(caught.exception.code, "internal_server_error")
        self.assertEqual(
            caught.exception.message,
            "the yeetpost api returned an error that was not json",
        )


class ParseConnectRedirectTest(unittest.TestCase):
    def test_it_reads_the_query_a_connected_customer_came_back_on(
        self,
    ) -> None:
        query = urllib.parse.parse_qs(
            f"connectSessionId={CONNECT_SESSION_ID}"
            f"&connectionId={CONNECTION_ID}"
            f"&profileId={PROFILE_ID}"
            "&slug=acme_linkedin&platform=linkedin"
        )

        self.assertEqual(
            parse_connect_redirect(query),
            {
                "connectSessionId": CONNECT_SESSION_ID,
                "connectionId": CONNECTION_ID,
                "profileId": PROFILE_ID,
                "slug": "acme_linkedin",
                "platform": "linkedin",
            },
        )

    def test_it_reads_a_cancelled_redirect(self) -> None:
        query = urllib.parse.parse_qs(
            f"connectSessionId={CONNECT_SESSION_ID}&error=cancelled"
        )

        # No connection was made, so the connection keys are not there at all
        self.assertEqual(
            parse_connect_redirect(query),
            {
                "connectSessionId": CONNECT_SESSION_ID,
                "error": "cancelled",
            },
        )

    def test_it_takes_the_dict_of_strings_a_framework_hands_you(self) -> None:
        query = {
            "connectSessionId": CONNECT_SESSION_ID,
            "error": "connect_failed",
        }

        self.assertEqual(
            parse_connect_redirect(query),
            {
                "connectSessionId": CONNECT_SESSION_ID,
                "error": "connect_failed",
            },
        )

    def test_it_leaves_the_session_id_empty_on_a_query_that_is_not_ours(
        self,
    ) -> None:
        query = urllib.parse.parse_qs("utm_source=newsletter")

        self.assertEqual(
            parse_connect_redirect(query), {"connectSessionId": ""}
        )


WEBHOOK_SECRET = "yp_whsec_3f1a"
# The fixture the node and go sdks sign, byte for byte: separators makes
# json.dumps write what node's JSON.stringify writes, so the three clients
# agree on the bytes that get signed.
WEBHOOK_BODY = json.dumps(
    {"event": "post.sent", "timestamp": "2026-08-26T09:24:12.004Z"},
    separators=(",", ":"),
)


def get_signature_header(body: str, timestamp_seconds: int) -> str:
    signature = hmac.new(
        WEBHOOK_SECRET.encode("utf-8"),
        f"{timestamp_seconds}.{body}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    return f"t={timestamp_seconds},v1={signature}"


class VerifyWebhookSignatureTest(unittest.TestCase):
    def test_a_valid_signature_verifies(self) -> None:
        timestamp_seconds = int(time.time())

        self.assertEqual(
            verify_webhook_signature(
                WEBHOOK_BODY,
                get_signature_header(WEBHOOK_BODY, timestamp_seconds),
                WEBHOOK_SECRET,
            ),
            True,
        )

    # The vector the go sdk pins too, computed by the node sdk's own hmac, so a
    # signature one client accepts is one the other two accept. The timestamp
    # is fixed, so it needs a tolerance wide enough to reach it.
    def test_the_shared_cross_sdk_vector_verifies(self) -> None:
        signature = (
            "f1d967b462aab2a3e8bf662c933d9e2181dc0a09271f22e27076c509c791c9b3"
        )
        header = f"t=1787653452,v1={signature}"

        self.assertEqual(
            verify_webhook_signature(
                WEBHOOK_BODY,
                header,
                WEBHOOK_SECRET,
                tolerance_seconds=100 * 365 * 24 * 60 * 60,
            ),
            True,
        )

    def test_a_tampered_body_does_not_verify(self) -> None:
        timestamp_seconds = int(time.time())

        self.assertEqual(
            verify_webhook_signature(
                f"{WEBHOOK_BODY} ",
                get_signature_header(WEBHOOK_BODY, timestamp_seconds),
                WEBHOOK_SECRET,
            ),
            False,
        )

    def test_the_wrong_secret_does_not_verify(self) -> None:
        timestamp_seconds = int(time.time())

        self.assertEqual(
            verify_webhook_signature(
                WEBHOOK_BODY,
                get_signature_header(WEBHOOK_BODY, timestamp_seconds),
                "yp_whsec_someoneelse",
            ),
            False,
        )

    def test_an_expired_timestamp_does_not_verify(self) -> None:
        timestamp_seconds = int(time.time()) - 400

        self.assertEqual(
            verify_webhook_signature(
                WEBHOOK_BODY,
                get_signature_header(WEBHOOK_BODY, timestamp_seconds),
                WEBHOOK_SECRET,
            ),
            False,
        )

    def test_an_expired_timestamp_verifies_with_a_wider_tolerance(
        self,
    ) -> None:
        timestamp_seconds = int(time.time()) - 400

        self.assertEqual(
            verify_webhook_signature(
                WEBHOOK_BODY,
                get_signature_header(WEBHOOK_BODY, timestamp_seconds),
                WEBHOOK_SECRET,
                tolerance_seconds=600,
            ),
            True,
        )

    def test_a_malformed_signature_header_does_not_verify(self) -> None:
        self.assertEqual(
            verify_webhook_signature(
                WEBHOOK_BODY, "v1=deadbeef", WEBHOOK_SECRET
            ),
            False,
        )

    def test_raw_body_bytes_verify_the_same_as_a_string(self) -> None:
        timestamp_seconds = int(time.time())

        self.assertEqual(
            verify_webhook_signature(
                WEBHOOK_BODY.encode("utf-8"),
                get_signature_header(WEBHOOK_BODY, timestamp_seconds),
                WEBHOOK_SECRET,
            ),
            True,
        )


if __name__ == "__main__":
    unittest.main()
