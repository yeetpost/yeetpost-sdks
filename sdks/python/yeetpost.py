"""Python client for the yeetpost API. Standard library only.

Everything here is hand-written against yeetpost-api/src/lib/openapi.json. The
TypedDicts are copies of the schemas in that spec, so they stay portable and
self-contained.
"""

import hashlib
import hmac
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from email.message import Message
from typing import Any, Literal, TypedDict, cast

DEFAULT_BASE_URL = "https://api.yeetpost.com/api/v2"

DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300

SIGNATURE_HEADER_PATTERN = re.compile(r"^t=(\d+),v1=([0-9a-f]{64})$")

# What a request field is set to when it has to reach the API as null. The
# request builder drops None to mean "left out", which is what an optional
# argument nobody passed means, so "set this to nothing" needs a value of its
# own.
_NULL = object()

#
# Errors
#


class YeetpostApiError(Exception):
    """Every non-2xx answer from the API.

    The API answers a failure with {"error", "message"}, plus "req_id" on
    platform_rejected and internal_server_error. The one exception is 429, whose
    body is {"error": "too many requests"} and carries no message and no code
    from the vocabulary, so on a 429 the code is that literal string and the
    thing to branch on is status.

    request_id is the x-request-id header, and the body's req_id when the header
    was not sent. rate_limit_limit, rate_limit_remaining and rate_limit_reset
    are the x-ratelimit-* headers: the requests allowed in the current window,
    the requests left in it, and the unix second it has room again. Each is -1
    when the response did not carry the header, which is the case on 401 and on
    500.
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        request_id: str | None = None,
        rate_limit_limit: int = -1,
        rate_limit_remaining: int = -1,
        rate_limit_reset: int = -1,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.request_id = request_id
        self.rate_limit_limit = rate_limit_limit
        self.rate_limit_remaining = rate_limit_remaining
        self.rate_limit_reset = rate_limit_reset


#
# Responses
#


class QueueSlot(TypedDict):
    """A posting slot on the connection's own clock.

    weekday 0 is Sunday, and time is 24 hour "HH:MM".
    """

    weekday: int
    time: str


class Connection(TypedDict):
    # The connection's id, which the queue endpoints take in their path
    id: str
    # The identifier you post to, for example "linkedin" or "alexdoe_x"
    slug: str
    # Which platform is behind the slug, such as "linkedin" or "x". Branch on
    # this rather than on the wording of description: sms, email and slack are
    # messaging channels, the rest are places you broadcast to. It is a str
    # rather than a closed set, because the set grows as platforms land.
    platformId: str
    description: str
    # The profile the connection belongs to. None when it is one of your own
    # accounts rather than an end customer's.
    profileId: str | None
    # The IANA zone the posting slots are read in. "UTC" until you set one.
    timezone: str
    # The connection's posting slots, in the order they were set. Empty when the
    # connection has no queue.
    queueSlots: list[QueueSlot]
    # "reconnect_required" once the stored login has actually failed,
    # "expiring" while it still works but will stop soon, "active" otherwise
    status: Literal["active", "reconnect_required", "expiring"]
    # Set only while status is "expiring": when the login runs out. None the
    # rest of the time, including once it already needs a reconnect.
    loginExpiresAt: str | None


class ConnectionsResponse(TypedDict):
    connections: list[Connection]


class GetConnectionResponse(TypedDict):
    connection: Connection


# A connection exactly as update_connection answers it, without status or
# loginExpiresAt: only list_connections and get_connection add those two.
class MovedConnection(TypedDict):
    id: str
    slug: str
    platformId: str
    description: str
    profileId: str | None
    timezone: str
    queueSlots: list[QueueSlot]


class UpdateConnectionResponse(TypedDict):
    connection: MovedConnection


class DeleteConnectionResponse(TypedDict):
    id: str
    deleted: Literal[True]


class Profile(TypedDict):
    """One of your end customers, and the connections you made for them."""

    id: str
    # What you call this end customer. Shown in the console, never sent to a
    # platform.
    name: str
    # Your own id for the same end customer, unique across your account. None
    # when you did not give one.
    externalId: str | None
    createdAt: str


class CreateProfileResponse(TypedDict):
    profile: Profile


class GetProfilesResponse(TypedDict):
    profiles: list[Profile]
    limit: int
    offset: int


class GetProfileResponse(TypedDict):
    profile: Profile


class UpdateProfileResponse(TypedDict):
    profile: Profile


class DeleteProfileResponse(TypedDict):
    id: str
    deleted: Literal[True]
    # How many connections went with the profile
    removedConnections: int


class ApiKey(TypedDict):
    """One key of your account, without its secret.

    The secret is answered once, by create_profile_key. No API endpoint
    reads the secret back, though the account owner can reveal any key in
    the console.
    """

    id: str
    # What you call this key. Shown in the console, never sent to a platform.
    name: str
    # A live key posts for real, a test key reaches the sandbox only.
    type: Literal["live", "test"]
    # The readable head of the key, which is what the console lists it by.
    prefix: str
    # The profile the key is scoped to. None on an account key.
    profileId: str | None
    # The origins a connect redirect from this key may land on. None when the
    # key has none and any https url on a public host is accepted.
    redirectAllowlist: list[str] | None
    createdAt: str
    # When the key last made a request, None while it never has.
    lastUsedAt: str | None
    # When the key was revoked, None while it still works.
    revokedAt: str | None


class CreateApiKeyResponse(TypedDict):
    key: ApiKey
    # The raw key. It is answered here and nowhere else: no API endpoint reads
    # the secret back, though the account owner can reveal any key in the
    # console. Store it now.
    secret: str


class GetApiKeysResponse(TypedDict):
    keys: list[ApiKey]
    limit: int
    offset: int


class RevokeApiKeyResponse(TypedDict):
    id: str
    revoked: Literal[True]


# The platforms a connect link can be opened for. A test key may only name
# "sandbox", which is how the whole flow runs in CI. Reddit, Facebook,
# Instagram and Threads are listed only once the API has an app for them: a
# platform it cannot connect raises a 400 invalid_request.
ConnectPlatform = Literal[
    "linkedin",
    "x",
    "bluesky",
    "mastodon",
    "discord",
    "telegram",
    "sandbox",
    "reddit",
    "facebook",
    "instagram",
    "threads",
    "google_business",
]


class CreateConnectSessionResponse(TypedDict):
    # The page to send your end customer to. It carries a single use token, and
    # this is the only time it is shown: only its hash is stored, so it cannot
    # be read back.
    url: str
    # When the link stops working. Fifteen minutes out.
    expiresAt: str
    # Comes back on the redirect and on the connection.created event, and is
    # what get_connect_session answers for.
    connectSessionId: str


class ConnectSession(TypedDict):
    """How one connect link ended."""

    id: str
    profileId: str
    # The platform the link was opened for, None when the end customer picks
    # one on the page.
    platform: ConnectPlatform | None
    # "pending" while the customer still has the link open, "connected" once an
    # account came in, "failed" when they cancelled or the platform refused,
    # "expired" when the fifteen minutes ran out with nothing happening.
    status: Literal["pending", "connected", "failed", "expired"]
    # The connection that was made, None until one is.
    connectionId: str | None
    # Why the customer came back without a connection: "cancelled" when they
    # backed out, "connect_failed" when the platform refused. None otherwise.
    error: Literal["cancelled", "connect_failed"] | None
    redirectUrl: str
    headless: bool
    expiresAt: str
    createdAt: str


class GetConnectSessionResponse(TypedDict):
    connectSession: ConnectSession


class QueuedPost(TypedDict):
    id: str
    text: str
    scheduledFor: str
    mediaCount: int


class GetConnectionQueueResponse(TypedDict):
    queue: list[QueuedPost]
    # True while the queue is paused: nothing waiting here goes out until it
    # is resumed. A post scheduled by hand, rather than taking one of these
    # slots, still goes out on time regardless.
    paused: bool


class ConnectionQueue(TypedDict):
    id: str
    slug: str
    timezone: str
    queueSlots: list[QueueSlot]
    paused: bool


class UpdateConnectionQueueResponse(TypedDict):
    connection: ConnectionQueue


class LegacyLinkPostResponse(TypedDict):
    """A post that went out on a platform with a permalink."""

    platform: Literal[
        "linkedin",
        "x",
        "bluesky",
        "discord",
        "telegram",
        "mastodon",
        "reddit",
        "facebook",
        "instagram",
        "threads",
        "google_business",
    ]
    link: str


class LegacySentPostResponse(TypedDict):
    """A message that went out on a messaging channel, which has no link."""

    platform: Literal["sms", "email", "slack"]
    sent: Literal[True]


class LegacyScheduledPostResponse(TypedDict):
    """A post stored to go out later."""

    scheduled: Literal[True]
    scheduled_for: str


# POST /post/{connectionSlug} answers with one of three shapes, depending on the
# platform and on whether the post was scheduled. Read whichever key is there.
LegacyPostResponse = (
    LegacyLinkPostResponse
    | LegacySentPostResponse
    | LegacyScheduledPostResponse
)


class PostError(TypedDict):
    code: str
    message: str


class _PostResultOptional(TypedDict, total=False):
    """The keys a per-connection result may leave out. NotRequired needs 3.11."""

    # Present only when AI polish was asked for and failed: the post went out
    # under its original text. Absent on every other result.
    warning: str


class PostResult(_PostResultOptional):
    connectionSlug: str
    status: Literal["sent", "scheduled", "draft", "failed"]
    postId: str | None
    url: str | None
    scheduledFor: str | None
    # How many replies actually went out under the head post
    threadCount: int
    # Whether the first comment landed. False when none was asked for, and false
    # when the platform refused it, which does not fail the post.
    hasFirstComment: bool
    error: PostError | None


class CreatePostsResponse(TypedDict):
    results: list[PostResult]


class PublishPostResponse(TypedDict):
    """One draft turned into a real send.

    The item is the one create_posts answers with for that connection, so both
    surfaces read the same.
    """

    result: PostResult


# A post exactly as update_draft answers it, without media, thread,
# firstComment or publishedAt: only get_post and list_posts add those four.
class UpdatedPost(TypedDict):
    id: str
    connectionSlug: str
    # The profile the post's connection belongs to. None when it is one of your
    # own accounts.
    profileId: str | None
    text: str
    # What the caller actually sent, equal to text unless AI polish rewrote
    # this post
    originalText: str
    # None: AI polish never touched this post. "rewritten": text above is the
    # model's own words. "failed": AI polish tried and failed, and text is
    # the original after all. "skipped": the post's shape does not support a
    # rewrite.
    aiRewriteStatus: Literal["rewritten", "failed", "skipped"] | None
    status: Literal[
        "sent",
        "scheduled",
        "processing",
        "draft",
        "failed",
        "cancelled",
        "deleted",
    ]
    url: str | None
    scheduledFor: str | None
    createdAt: str
    # Your own labels for the post, lowercase and deduped
    tags: list[str]
    # The platform's own id for the head post, which is what a delete works
    # from. None on a post that never reached a platform.
    platformPostId: str | None
    # When the post was deleted on its platform, None while it is still up
    deletedAt: str | None
    error: PostError | None


class PostMedia(TypedDict):
    """One image already attached to a post, as get_post and list_posts answer
    it.
    """

    id: str
    altText: str | None


class Post(UpdatedPost):
    # The images attached to the post, in posting order
    media: list[PostMedia]
    # The reply chain under the head post, as it was given. Empty for a single
    # post, which is every post made before shapes shipped.
    thread: list[str]
    # The author's own comment under the share, None when there is none
    firstComment: str | None
    # When the post actually went out, None while it is still a draft, still
    # pending, or never sent at all
    publishedAt: str | None


class GetPostsResponse(TypedDict):
    posts: list[Post]
    limit: int
    offset: int


class GetPostResponse(TypedDict):
    post: Post


class UpdatePostResponse(TypedDict):
    post: UpdatedPost


class CancelPostResponse(TypedDict):
    id: str
    status: Literal["cancelled"]


class DeleteDraftResponse(TypedDict):
    id: str
    deleted: Literal[True]


# delete_post answers with this when the post had already been sent: it comes
# down on its platform rather than being cancelled
class DeletePostResponse(TypedDict):
    id: str
    status: Literal["deleted"]
    deletedAt: str


class _RetryPostResponseOptional(TypedDict, total=False):
    """The keys retry_post may leave out. NotRequired needs 3.11."""

    # Set only on a retry sent inside the connection-limit grace window
    warning: str


class RetryPostResponse(_RetryPostResponseOptional):
    id: str
    status: Literal["sent"]


MediaContentType = Literal["image/png", "image/jpeg", "image/gif", "image/webp"]


class _PostMediaItemOptional(TypedDict, total=False):
    """The keys one image on a post may leave out."""

    # Description of the image for screen readers. Overrides the alt text given
    # at upload, and is passed to X, Bluesky, Mastodon and LinkedIn; Telegram
    # has no field for it, so it is dropped there.
    altText: str


class PostMediaItem(_PostMediaItemOptional):
    """One image on a post, with the alt text it gets there."""

    # Media id from upload_media
    id: str


class CreateMediaResponse(TypedDict):
    # The id you attach to a post. Uploading the same bytes again answers with
    # this same id.
    mediaId: str
    contentType: MediaContentType
    # Size of the stored image in bytes
    sizeBytes: int


class GetMediaResponse(TypedDict):
    """The image itself.

    The API answers this one with the bytes rather than with JSON, so the client
    builds it from the response.
    """

    bytes: bytes
    contentType: MediaContentType


class DeleteMediaResponse(TypedDict):
    id: str
    deleted: Literal[True]


# The events a webhook can be subscribed to, and the values the deliveries
# carry in x-yeetpost-event.
WebhookEventName = Literal[
    "post.sent",
    "post.failed",
    "post.deleted",
    "post.metrics",
    "connection.created",
    "connection.removed",
    "connection.reconnect_required",
]


class WebhookWithSecret(TypedDict):
    id: str
    url: str
    events: list[WebhookEventName]
    secret: str
    createdAt: str


class CreateWebhookResponse(TypedDict):
    webhook: WebhookWithSecret


class Webhook(TypedDict):
    id: str
    url: str
    events: list[WebhookEventName]
    createdAt: str


class GetWebhooksResponse(TypedDict):
    webhooks: list[Webhook]


class DeleteWebhookResponse(TypedDict):
    id: str
    deleted: Literal[True]


class WebhookDelivery(TypedDict):
    id: str
    # What the delivery carries in x-yeetpost-event-id and in the eventId field
    # of its body. It is the delivery id: one event, one id, every attempt and
    # every replay of it.
    eventId: str
    event: WebhookEventName
    status: Literal["pending", "processing", "delivered", "failed", "dead"]
    attempts: int
    createdAt: str
    nextAttemptAt: str
    deliveredAt: str | None
    deadAt: str | None
    lastStatusCode: int | None
    lastError: str | None


class GetWebhookDeliveriesResponse(TypedDict):
    deliveries: list[WebhookDelivery]
    limit: int
    hasMore: bool


class ReplayWebhookDeliveryResponse(TypedDict):
    delivery: WebhookDelivery


class SendWebhookTestEventResponse(TypedDict):
    delivery: WebhookDelivery


class WebhookEventPost(TypedDict):
    id: str
    connectionSlug: str
    # The profile the post's connection belongs to. None when it is one of your
    # own accounts.
    profileId: str | None
    text: str
    status: Literal["sent", "failed"]
    url: str | None
    scheduledFor: str | None
    createdAt: str
    tags: list[str]
    # How many images the post carried. The ids are left out on purpose: read
    # the bytes back with get_media if you need them.
    mediaCount: int
    # How many replies went out under the head post
    threadCount: int
    # Whether the first comment landed
    hasFirstComment: bool
    error: PostError | None


class _WebhookEventOptional(TypedDict, total=False):
    """The keys a webhook body may leave out. NotRequired needs Python 3.11."""

    test: Literal[True]


class WebhookEvent(_WebhookEventOptional):
    """The body of a webhook delivery, for the receiver that verified it.

    eventId leads the body, and matches the x-yeetpost-event-id header: it is
    the same value on every attempt and every replay, so it is what you dedupe
    on. test is set only on the event that POST /webhooks/{webhookId}/test
    enqueues.
    """

    eventId: str
    event: Literal["post.sent", "post.failed"]
    timestamp: str
    post: WebhookEventPost


class PostDeletedWebhookEventPost(TypedDict):
    id: str
    connectionSlug: str
    # The profile the post's connection belongs to. None when it is one of your
    # own accounts.
    profileId: str | None
    platformId: str
    deletedAt: str


class PostDeletedWebhookEvent(TypedDict):
    """The body of a post.deleted delivery.

    A deleted post is no longer a post, so the event says which one is gone and
    where it stood rather than repeating its text one last time.
    """

    eventId: str
    event: Literal["post.deleted"]
    timestamp: str
    post: PostDeletedWebhookEventPost


class PostMetricsRead(TypedDict):
    """One read of a post's numbers.

    Every counter is a running total, so the newest read is the post's numbers
    now. None means the platform does not report that number, which is not the
    same as zero: Bluesky and Mastodon give likes, reposts and replies;
    LinkedIn gives likes and comments on any share, and impressions and clicks
    only on a page; X gives impressions, likes, reposts and replies, and only
    when X analytics is on for the account, because X charges for the read.
    """

    fetchedAt: str
    impressions: int | None
    likes: int | None
    reposts: int | None
    replies: int | None
    clicks: int | None


class GetPostMetricsResponse(TypedDict):
    # None until the first read, an hour after the post goes out
    latest: PostMetricsRead | None
    # Every read, oldest first. A post is read hourly for 48 hours and then
    # daily until it is 30 days old.
    history: list[PostMetricsRead]


class AnalyticsTotals(TypedDict):
    posts: int
    impressions: int
    likes: int
    reposts: int
    replies: int
    clicks: int


class AnalyticsDay(TypedDict):
    day: str
    posts: int
    impressions: int
    likes: int
    reposts: int
    replies: int


class AnalyticsPlatform(TypedDict):
    platformId: str
    posts: int
    impressions: int
    likes: int
    reposts: int
    replies: int
    clicks: int


# "from" is a Python keyword, so this one is written with the functional syntax
# rather than as a class: the key on the wire is what the API sends, and a
# response type that renamed it would not describe the response.
#
# days is one entry per UTC day of the window, gaps included, so it charts as it
# comes, and a post counts on the day it went out. byPlatform is the same window
# split by platform, and a platform with no posts in it is not listed. from and
# to are whole UTC days, both ends included.
GetAnalyticsResponse = TypedDict(
    "GetAnalyticsResponse",
    {
        "totals": AnalyticsTotals,
        "days": list[AnalyticsDay],
        "byPlatform": list[AnalyticsPlatform],
        "from": str,
        "to": str,
    },
)


class PostMetricsWebhookEventPost(TypedDict):
    id: str
    connectionSlug: str
    # The profile the post's connection belongs to. None when it is one of your
    # own accounts.
    profileId: str | None
    platformId: str
    url: str | None


class PostMetricsWebhookEvent(TypedDict):
    """The body of a post.metrics delivery.

    A day's reading of a post's numbers. It fires on the first read of each UTC
    day, for as long as the post is being refreshed, so it is one delivery per
    post per day rather than one per hourly read.
    """

    eventId: str
    event: Literal["post.metrics"]
    timestamp: str
    post: PostMetricsWebhookEventPost
    metrics: PostMetricsRead


class ConnectionWebhookEventConnection(TypedDict):
    id: str
    # The profile the connection belongs to. None when it is one of your own
    # accounts. This pair of ids is the mapping to persist.
    profileId: str | None
    # The connect session the account came in through, None when the connection
    # was made in the console. It lets you file the connection against the
    # customer you made the link for without waiting for their browser to come
    # back.
    connectSessionId: str | None
    platformId: str
    slug: str


class ConnectionWebhookEvent(TypedDict):
    """The body of a connection.created, connection.removed or
    connection.reconnect_required delivery.

    connection.created and connection.removed fire when an account is
    connected or disconnected, whether it went into one of your profiles or
    into your own account. Reconnecting an account that is already there
    replaces its credentials rather than making a new connection, so it fires
    nothing, and deleting a profile fires one connection.removed per account
    inside it. connection.reconnect_required fires once, the moment a stored
    login actually fails rather than on every post that runs into it.
    """

    eventId: str
    event: Literal[
        "connection.created",
        "connection.removed",
        "connection.reconnect_required",
    ]
    timestamp: str
    connection: ConnectionWebhookEventConnection


# Any delivery body, discriminated on "event". Narrow on it, or on the
# x-yeetpost-event header, before reading "post" or "connection": a post.deleted
# event says which post is gone rather than repeating its text, and a connection
# event carries no post at all.
AnyWebhookEvent = (
    WebhookEvent
    | PostDeletedWebhookEvent
    | PostMetricsWebhookEvent
    | ConnectionWebhookEvent
)


class HealthDatabaseCheck(TypedDict):
    ok: bool
    # How long the health query took
    latencyMs: int


class HealthWorkerCheck(TypedDict):
    """One background worker loop.

    ok is False when the loop has not finished an iteration within three of its
    own intervals, and when it has never finished one at all.
    """

    ok: bool
    # When the loop last ran, whether or not that iteration finished
    lastRunAt: str | None
    # When the loop last finished an iteration
    lastOkAt: str | None


class HealthChecks(TypedDict):
    database: HealthDatabaseCheck
    scheduledPosts: HealthWorkerCheck
    webhookDeliveries: HealthWorkerCheck
    xUsageSweep: HealthWorkerCheck
    postMetrics: HealthWorkerCheck


class GetHealthResponse(TypedDict):
    """Whether the API answers and whether its background loops are keeping up.

    The status code is 200 whether the API is ok or degraded, so read status
    rather than catching an error.
    """

    status: Literal["ok", "degraded"]
    checks: HealthChecks
    # The API version that answered
    version: str
    # When the health was measured. The answer is cached for 10 seconds, so this
    # can be that much behind.
    time: str


class HealthDay(TypedDict):
    """One UTC day of uptime.

    What is measured is minutes, not samples: a day owes 1440 of them, today
    owes the ones already behind it, and a minute with no sample counts as
    degraded exactly like a sample that came back degraded.
    """

    # The UTC day, YYYY-MM-DD
    day: str
    # Ok minutes over the minutes the day owed, to two decimals. None when the
    # day was over before the first sample was ever taken: nobody was watching
    # it, so it is unmeasured rather than down.
    uptimePercent: float | None
    # How many of that day's minutes got a sample. A full day is 1440.
    samples: int
    # Minutes of that day that were not ok, the ones with no sample included
    degradedMinutes: int


class GetHealthHistoryResponse(TypedDict):
    days: list[HealthDay]


class GetStatsResponse(TypedDict):
    """Public numbers about yeetpost as a whole.

    It is what the marketing site's proof pill draws, and nothing here is
    about one account.
    """

    # Posts that reached a platform in the last 7 days, and ever: no error,
    # not a draft, not taken down, not still waiting in a queue. Sandbox
    # connections and test-key traffic are left out. Whole numbers exactly as
    # counted, so round them yourself.
    postsThisWeek: int
    postsAllTime: int
    # Connections that can be posted to right now, sandbox ones left out
    liveConnections: int
    # The platform ids a post can go out to today, such as "linkedin" or "x"
    platformsLive: list[str]
    # When the counts were taken. The answer is cached for 60 seconds, so this
    # can be that much behind.
    time: str


#
# Client
#


def _get_header_number(headers: Message, name: str) -> int:
    """One of the numeric headers, or -1 when the response did not carry it."""
    value = headers.get(name)

    if value is None:
        return -1

    try:
        return int(value)
    except ValueError:
        return -1


def _get_api_error(
    status: int, headers: Message, response_text: str
) -> YeetpostApiError:
    header_request_id = headers.get("x-request-id")
    limit = _get_header_number(headers, "x-ratelimit-limit")
    remaining = _get_header_number(headers, "x-ratelimit-remaining")
    reset = _get_header_number(headers, "x-ratelimit-reset")

    try:
        body = json.loads(response_text)
    except json.JSONDecodeError:
        return YeetpostApiError(
            status,
            "internal_server_error",
            "the yeetpost api returned an error that was not json",
            header_request_id,
            limit,
            remaining,
            reset,
        )

    if not isinstance(body, dict) or not isinstance(body.get("error"), str):
        return YeetpostApiError(
            status,
            "internal_server_error",
            "the yeetpost api returned an error without a code",
            header_request_id,
            limit,
            remaining,
            reset,
        )

    code = body["error"]

    # The 429 body has no message field, so the code stands in for it there.
    message = body["message"] if isinstance(body.get("message"), str) else code
    # The header leads, and the body's req_id stands in when it was not sent.
    body_request_id = (
        body["req_id"] if isinstance(body.get("req_id"), str) else None
    )
    request_id = header_request_id or body_request_id

    return YeetpostApiError(
        status, code, message, request_id, limit, remaining, reset
    )


class Yeetpost:
    """The yeetpost API client. One instance per API key."""

    # An empty api_key is allowed: get_health, get_health_history, get_stats
    # and get_openapi_spec need no key. Every other call is refused before the
    # request goes out, rather than coming back as a 401 from the API.
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    # Every method funnels through here: it sets auth, sends the body, and turns
    # any non-2xx into a YeetpostApiError before the caller sees it. The answer
    # comes back as its status, its content type and its raw bytes, since
    # get_media answers with an image rather than with JSON.
    def _send(
        self,
        method: str,
        path: str,
        query: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        text_body: str | None = None,
        bytes_body: tuple[bytes, str] | None = None,
        idempotency_key: str | None = None,
        is_public_endpoint: bool = False,
        timeout_seconds: float = 30.0,
    ) -> tuple[int, str, bytes]:
        if not self.api_key and not is_public_endpoint:
            raise ValueError("api_key is required for this call")

        url = f"{self.base_url}{path}"

        given_query = {
            name: value
            for name, value in (query or {}).items()
            if value is not None
        }
        # doseq puts a repeatable parameter, such as tag, on once per value:
        # the API reads the repeats as a list to narrow by, not as one string
        if given_query:
            url = f"{url}?{urllib.parse.urlencode(given_query, doseq=True)}"

        # An empty key goes out as no header at all, which is what the
        # endpoints that need no key expect to see.
        headers: dict[str, str] = {}

        if self.api_key:
            headers["x-api-key"] = self.api_key

        body: bytes | None = None

        if json_body is not None:
            headers["content-type"] = "application/json"
            given_body = {
                name: (None if value is _NULL else value)
                for name, value in json_body.items()
                if value is not None
            }
            body = json.dumps(given_body).encode("utf-8")

        if text_body is not None:
            headers["content-type"] = "text/plain"
            body = text_body.encode("utf-8")

        # The raw file and the type the API checks it against always travel
        # together, so they arrive as one pair
        if bytes_body is not None:
            body, headers["content-type"] = bytes_body

        if idempotency_key is not None:
            headers["idempotency-key"] = idempotency_key

        request = urllib.request.Request(
            url, data=body, headers=headers, method=method
        )

        try:
            with urllib.request.urlopen(
                request, timeout=timeout_seconds
            ) as response:
                # Any parameters the header carries, such as a charset, are
                # dropped: the media type on its own is what get_media wants
                media_type = response.headers.get_content_type()

                return response.status, media_type, response.read()
        except urllib.error.HTTPError as err:
            raise _get_api_error(
                err.code, err.headers, err.read().decode("utf-8", "replace")
            ) from None

    # _send plus decoding, which is every endpoint but get_media.
    def _request(
        self,
        method: str,
        path: str,
        query: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        text_body: str | None = None,
        bytes_body: tuple[bytes, str] | None = None,
        idempotency_key: str | None = None,
        is_public_endpoint: bool = False,
        timeout_seconds: float = 30.0,
    ) -> Any:
        status, _media_type, response_bytes = self._send(
            method,
            path,
            query=query,
            json_body=json_body,
            text_body=text_body,
            bytes_body=bytes_body,
            idempotency_key=idempotency_key,
            is_public_endpoint=is_public_endpoint,
            timeout_seconds=timeout_seconds,
        )

        try:
            return json.loads(response_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise YeetpostApiError(
                status,
                "internal_server_error",
                "the yeetpost api returned a response that was not json",
            ) from None

    # Every connection of yours, or only the ones inside one profile. A
    # profile_id that is not one of yours raises a 400 invalid_request rather
    # than answering with an empty list.
    def list_connections(
        self, profile_id: str | None = None
    ) -> ConnectionsResponse:
        return self._request(
            "GET", "/connections", query={"profileId": profile_id}
        )

    def get_connection(self, connection_id: str) -> GetConnectionResponse:
        return self._request(
            "GET",
            f"/connections/{urllib.parse.quote(connection_id, safe='')}",
        )

    # Moves a connection into one of your profiles, or back out to your own
    # with profile_id=None. The slug, the queue and every post already written
    # stay where they are, and so does the billed connection count: only the
    # routing changes. It fires connection.removed for the profile it left and
    # connection.created for the one it arrived at, and LinkedIn pages move
    # with the personal account that administers them.
    #
    # A profile that already holds the same account raises a
    # 409 connection_conflict naming the connection in the way (SMS and email
    # are exempt, because their connect flows do not deduplicate either). A
    # profile-scoped key raises a 403 forbidden, and so does the connection you
    # sign in with: the move is the account owner's call.
    def update_connection(
        self, connection_id: str, profile_id: str | None
    ) -> UpdateConnectionResponse:
        return self._request(
            "PATCH",
            f"/connections/{urllib.parse.quote(connection_id, safe='')}",
            json_body={
                "profileId": _NULL if profile_id is None else profile_id
            },
        )

    # Deletes the stored credentials, same as disconnecting it from the
    # console. The connection you sign in with cannot be disconnected: that
    # raises a 403 forbidden.
    def delete_connection(self, connection_id: str) -> DeleteConnectionResponse:
        return self._request(
            "DELETE",
            f"/connections/{urllib.parse.quote(connection_id, safe='')}",
        )

    # The posts waiting in the connection's queue, earliest slot first.
    def list_connection_queue(
        self, connection_id: str
    ) -> GetConnectionQueueResponse:
        return self._request(
            "GET",
            f"/connections/{urllib.parse.quote(connection_id, safe='')}/queue",
        )

    # Replaces the slot list, the timezone, pauses or resumes the queue, or a
    # combination. Posts already queued keep the times they were given.
    def update_connection_queue(
        self,
        connection_id: str,
        slots: list[QueueSlot] | None = None,
        timezone: str | None = None,
        *,
        paused: bool | None = None,
    ) -> UpdateConnectionQueueResponse:
        return self._request(
            "PATCH",
            f"/connections/{urllib.parse.quote(connection_id, safe='')}/queue",
            json_body={"slots": slots, "timezone": timezone, "paused": paused},
        )

    # One profile is one of your end customers. Connect their accounts into it
    # and post with its id, and a post of theirs can never reach another
    # customer's account. An account can have 1000 profiles at once; over that,
    # this raises a 403 limit_exceeded.
    def create_profile(
        self, name: str, external_id: str | None = None
    ) -> CreateProfileResponse:
        return self._request(
            "POST",
            "/profiles",
            json_body={"name": name, "externalId": external_id},
        )

    # Your profiles, newest first. A deleted profile is not in the list.
    def list_profiles(
        self, limit: int | None = None, offset: int | None = None
    ) -> GetProfilesResponse:
        return self._request(
            "GET", "/profiles", query={"limit": limit, "offset": offset}
        )

    def get_profile(self, profile_id: str) -> GetProfileResponse:
        return self._request(
            "GET", f"/profiles/{urllib.parse.quote(profile_id, safe='')}"
        )

    # Renames a profile, sets its external id, or both. Only what you pass is
    # written, so a field left out keeps what the profile had.
    # external_id=None is "leave it alone" like every other argument, so taking
    # an external id off is clear_external_id=True, which sends the explicit
    # null the API reads as "no external id any more". An external id another
    # live profile of yours already carries raises a 409
    # profile_external_id_conflict. A call that names no field is refused here,
    # before the request goes out: the API needs at least one of them.
    def update_profile(
        self,
        profile_id: str,
        name: str | None = None,
        *,
        external_id: str | None = None,
        clear_external_id: bool = False,
    ) -> UpdateProfileResponse:
        if clear_external_id and external_id is not None:
            raise ValueError(
                "pass either external_id or clear_external_id, not both"
            )

        if name is None and external_id is None and not clear_external_id:
            raise ValueError("pass a name, an external_id, or both")

        return self._request(
            "PATCH",
            f"/profiles/{urllib.parse.quote(profile_id, safe='')}",
            json_body={
                "name": name,
                "externalId": _NULL if clear_external_id else external_id,
            },
        )

    # Disconnects every account in the profile: the credentials are deleted,
    # anything still waiting to be sent is cancelled, the drafts written in it
    # are deleted, and the posts that already went out stay readable. The
    # answer says how many connections went with it. The profile itself is kept
    # out of sight rather than erased, so list_posts(profile_id=...) still
    # lists the history of a customer you have offboarded.
    def delete_profile(self, profile_id: str) -> DeleteProfileResponse:
        return self._request(
            "DELETE", f"/profiles/{urllib.parse.quote(profile_id, safe='')}"
        )

    # Mints a key for one end customer. A key made here is always scoped to the
    # profile in the path, so it reaches that customer and nothing else,
    # whatever a call made with it says. key_type goes on the wire as "type",
    # which is a builtin here. redirect_allowlist is the origins a connect
    # redirect from this key may land on, at most 20, each a bare origin such
    # as "https://acme.example.com" with no path, query or fragment; they are
    # normalized and deduped, and an empty list means no allowlist at all.
    #
    # Only an unscoped key of yours may call this: a key that is itself scoped
    # to a profile raises a 403 forbidden. A test key can only mint test keys,
    # and asking it for a live one raises a 403 forbidden too. A profile holds
    # at most 50 live and 50 test keys, and over that this raises a 403
    # limit_exceeded; a revoked key does not count against either. The secret
    # is answered exactly once, in this response.
    def create_profile_key(
        self,
        profile_id: str,
        name: str,
        key_type: Literal["live", "test"],
        redirect_allowlist: list[str] | None = None,
    ) -> CreateApiKeyResponse:
        return self._request(
            "POST",
            f"/profiles/{urllib.parse.quote(profile_id, safe='')}/keys",
            json_body={
                "name": name,
                "type": key_type,
                "redirectAllowlist": redirect_allowlist,
            },
        )

    # The keys scoped to one profile, oldest first, without their secrets. Only
    # an unscoped key of yours may call this, and a test key sees the test keys
    # and no live ones. Paged like list_profiles: limit is 1 to 100 and the API
    # defaults it to 25.
    def list_profile_keys(
        self,
        profile_id: str,
        include_revoked: bool | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> GetApiKeysResponse:
        # urlencode writes a Python bool as "True", and the API takes the
        # literal "true" and "false", so the flag goes out as one of those.
        given_include_revoked = None

        if include_revoked is not None:
            given_include_revoked = "true" if include_revoked else "false"

        return self._request(
            "GET",
            f"/profiles/{urllib.parse.quote(profile_id, safe='')}/keys",
            query={
                "includeRevoked": given_include_revoked,
                "limit": limit,
                "offset": offset,
            },
        )

    # Revokes one of the profile's keys. It stops working everywhere at once,
    # on the next request, except that a connect url it already issued keeps
    # working for the rest of its fifteen minutes. Revoking a key that is
    # already revoked is the same 200, so a retry is safe. Only an unscoped key
    # of yours may call this, and a test key may only revoke test keys: a live
    # key answers 404 to one.
    def revoke_profile_key(
        self, profile_id: str, key_id: str
    ) -> RevokeApiKeyResponse:
        profile_path = urllib.parse.quote(profile_id, safe="")
        key_path = urllib.parse.quote(key_id, safe="")

        return self._request(
            "DELETE", f"/profiles/{profile_path}/keys/{key_path}"
        )

    # Every key of your account, oldest first: the unscoped ones and every
    # profile's, with no secrets. Only an unscoped key of yours may call this,
    # and a test key sees the test keys and no live ones. Paged like
    # list_profiles: limit is 1 to 100 and the API defaults it to 25.
    def list_keys(
        self,
        include_revoked: bool | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> GetApiKeysResponse:
        # urlencode writes a Python bool as "True", and the API takes the
        # literal "true" and "false", so the flag goes out as one of those.
        given_include_revoked = None

        if include_revoked is not None:
            given_include_revoked = "true" if include_revoked else "false"

        return self._request(
            "GET",
            "/keys",
            query={
                "includeRevoked": given_include_revoked,
                "limit": limit,
                "offset": offset,
            },
        )

    # Revokes any key of your account, scoped or not, including the key making
    # the call: that one answers 200 and the next request with it raises a 401.
    # Only an unscoped key of yours may call this, and a test key may only
    # revoke test keys: a live key answers 404 to one, the same answer a key
    # that is not yours gets.
    def revoke_key(self, key_id: str) -> RevokeApiKeyResponse:
        return self._request(
            "DELETE", f"/keys/{urllib.parse.quote(key_id, safe='')}"
        )

    # A page yeetpost hosts, where your end customer connects one of their own
    # accounts into this profile. The link works once and lasts fifteen
    # minutes, and the token in it carries the whole authorization: nobody
    # signs in to yeetpost, and the page never shows your key, your email or
    # anything about your other customers. Leave platform out and the page
    # shows a picker. headless=True draws it with no yeetpost header or footer,
    # for a popup with your own branding around it. A test key opens a session
    # that offers the sandbox and nothing else, which is how the whole flow
    # runs in CI.
    def create_connect_url(
        self,
        profile_id: str,
        redirect_url: str,
        platform: ConnectPlatform | None = None,
        *,
        headless: bool | None = None,
    ) -> CreateConnectSessionResponse:
        return self._request(
            "POST",
            f"/profiles/{urllib.parse.quote(profile_id, safe='')}/connect",
            json_body={
                "platform": platform,
                "redirectUrl": redirect_url,
                "headless": headless,
            },
        )

    # How a connect link ended, for when you would rather poll than read the
    # query your customer came back on. Both say the same thing, and a link
    # that has been used or has run out sends nobody anywhere, which is why
    # polling exists: there is no redirect left to carry the news.
    def get_connect_session(
        self, connect_session_id: str
    ) -> GetConnectSessionResponse:
        session_path = urllib.parse.quote(connect_session_id, safe="")

        return self._request("GET", f"/connect-sessions/{session_path}")

    # The one-liner endpoint: the body is the post. It has nowhere to name a
    # profile, so it reaches your own accounts and nothing else. Prefer
    # create_posts for anything that is not a shell script.
    def post_to_connection(
        self,
        connection_slug: str,
        text: str,
        scheduled_for: str | None = None,
    ) -> LegacyPostResponse:
        return self._request(
            "POST",
            f"/post/{urllib.parse.quote(connection_slug, safe='')}",
            query={"scheduled_for": scheduled_for},
            text_body=text,
        )

    # A connection that fails comes back as a failed item in results, not as a
    # raised error. Read the per-item status.
    #
    # idempotency_key stays the fourth positional argument it has always been,
    # so timezone and queue are keyword-only: a caller who passed the key
    # positionally keeps passing the key.
    #
    # profile_id is the end customer this post is going out for. Every slug in
    # connection_slugs has to belong to that profile, and one that does not
    # fails that item with invalid_connection. Leave it out and every slug has
    # to be one of your own connections, so a post can never reach a profile by
    # accident.
    #
    # media_ids, media and media_urls are three ways to say the same thing, so
    # send only one: media_ids is the short one, media carries alt text per
    # image, and media_urls skips uploading first and has yeetpost fetch the
    # bytes itself.
    def create_posts(
        self,
        text: str,
        connection_slugs: list[str],
        scheduled_for: str | None = None,
        idempotency_key: str | None = None,
        *,
        timezone: str | None = None,
        queue: bool | None = None,
        media_ids: list[str] | None = None,
        media: list[PostMediaItem] | None = None,
        media_urls: list[str] | None = None,
        thread: list[str] | None = None,
        first_comment: str | None = None,
        is_draft: bool | None = None,
        tags: list[str] | None = None,
        profile_id: str | None = None,
        rewrite: bool | None = None,
        text_by_platform: dict[str, str] | None = None,
    ) -> CreatePostsResponse:
        return self._request(
            "POST",
            "/posts",
            json_body={
                "text": text,
                "connectionSlugs": connection_slugs,
                "profileId": profile_id,
                "scheduledFor": scheduled_for,
                "timezone": timezone,
                "queue": queue,
                "mediaIds": media_ids,
                "media": media,
                "mediaUrls": media_urls,
                "thread": thread,
                "firstComment": first_comment,
                "isDraft": is_draft,
                "tags": tags,
                "rewrite": rewrite,
                "textByPlatform": text_by_platform,
            },
            idempotency_key=idempotency_key,
        )

    # Turns a draft into a real send: now, at a time, or into the connection's
    # next free slot. The post keeps the id it had as a draft, and the mode it
    # was created with. A refusal comes back in result["error"], and the ones
    # you can still settle leave the draft where it was to be published again:
    # queue_empty, queue_full, payment_method_required, spend_cap_reached,
    # fair_use_reached, connection_limit_exceeded and platform_unavailable.
    # Every other refusal is the post's outcome, so the draft becomes a
    # failed post. A post that is not a draft any more raises a 404 not_found.
    def publish_post(
        self,
        post_id: str,
        scheduled_for: str | None = None,
        idempotency_key: str | None = None,
        *,
        timezone: str | None = None,
        queue: bool | None = None,
    ) -> PublishPostResponse:
        return self._request(
            "POST",
            f"/posts/{urllib.parse.quote(post_id, safe='')}/publish",
            json_body={
                "scheduledFor": scheduled_for,
                "timezone": timezone,
                "queue": queue,
            },
            idempotency_key=idempotency_key,
        )

    # Edits a draft, or a pending scheduled post, in place. Only what you pass
    # is written, so a field left out keeps what it had. thread and
    # first_comment describe one shape between them, so passing either
    # replaces both, and thread=[] clears it. first_comment=None is "leave it
    # alone" like every other argument, so taking a comment off a draft is
    # clear_first_comment=True, which sends the explicit null the API reads as
    # "no comment any more". media_ids or media replaces the whole image list,
    # so an id you leave out is taken off it.
    #
    # scheduled_for (with an optional timezone) or queue moves a pending
    # scheduled post's own time, the same two ways publish_post reads them. A
    # draft raises a 400 invalid_request on all three, since it has nowhere to
    # be sent at yet. A text edit on a scheduled post is stored as final: any
    # AI polish it already carried is cleared rather than run again.
    #
    # Anything else is a record of what already happened, so editing it raises
    # a 400 invalid_request, and a post the worker has already claimed raises
    # a 409 post_not_editable.
    def update_draft(
        self,
        post_id: str,
        text: str | None = None,
        *,
        thread: list[str] | None = None,
        first_comment: str | None = None,
        clear_first_comment: bool = False,
        media_ids: list[str] | None = None,
        media: list[PostMediaItem] | None = None,
        tags: list[str] | None = None,
        scheduled_for: str | None = None,
        timezone: str | None = None,
        queue: bool | None = None,
    ) -> UpdatePostResponse:
        if clear_first_comment and first_comment is not None:
            raise ValueError(
                "pass either first_comment or clear_first_comment, not both"
            )

        return self._request(
            "PATCH",
            f"/posts/{urllib.parse.quote(post_id, safe='')}",
            json_body={
                "text": text,
                "thread": thread,
                "firstComment": _NULL if clear_first_comment else first_comment,
                "mediaIds": media_ids,
                "media": media,
                "tags": tags,
                "scheduledFor": scheduled_for,
                "timezone": timezone,
                "queue": queue,
            },
        )

    # The same bytes uploaded twice are one image: the second upload answers
    # with the id of the first and costs nothing against your allowance. The
    # body is the raw file, not a multipart form.
    def upload_media(
        self,
        image_bytes: bytes,
        content_type: MediaContentType,
        alt_text: str | None = None,
    ) -> CreateMediaResponse:
        return self._request(
            "POST",
            "/media",
            query={"alt_text": alt_text},
            bytes_body=(image_bytes, content_type),
        )

    # Reads an image back, with the content type it was uploaded as.
    def get_media(self, media_id: str) -> GetMediaResponse:
        _status, media_type, response_bytes = self._send(
            "GET", f"/media/{urllib.parse.quote(media_id, safe='')}"
        )

        # The API only ever answers this one with one of the four image types,
        # and it is the authority on what it sent, so this is the one place a
        # cast is needed.
        return {
            "bytes": response_bytes,
            "contentType": cast(MediaContentType, media_type),
        }

    # Deletes an image and frees the storage. Posts that used it keep their text
    # and lose the image, so delete one only once the posts that need it have
    # gone out.
    def delete_media(self, media_id: str) -> DeleteMediaResponse:
        return self._request(
            "DELETE", f"/media/{urllib.parse.quote(media_id, safe='')}"
        )

    # tag is repeatable: a post has to carry every tag you name, not any of
    # them. profile_id narrows to the posts that went out for one end customer,
    # and answers for a deleted profile too, so an offboarded customer keeps
    # its history. scheduled_after and scheduled_before are ISO 8601
    # timestamps, both inclusive, read against scheduledFor: they answer
    # nothing for a post that was never scheduled.
    def list_posts(
        self,
        status: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        *,
        tag: list[str] | None = None,
        profile_id: str | None = None,
        scheduled_after: str | None = None,
        scheduled_before: str | None = None,
        connection_slug: str | None = None,
        platform: str | None = None,
        send_group_id: str | None = None,
    ) -> GetPostsResponse:
        return self._request(
            "GET",
            "/posts",
            query={
                "status": status,
                "tag": tag,
                "profileId": profile_id,
                "scheduledAfter": scheduled_after,
                "scheduledBefore": scheduled_before,
                "connectionSlug": connection_slug,
                "platform": platform,
                "sendGroupId": send_group_id,
                "limit": limit,
                "offset": offset,
            },
        )

    def get_post(self, post_id: str) -> GetPostResponse:
        return self._request(
            "GET", f"/posts/{urllib.parse.quote(post_id, safe='')}"
        )

    # The numbers yeetpost has read back off the platform for one post: the
    # newest read, and every read before it. "latest" is None until the first
    # read, an hour after the post goes out.
    def get_post_metrics(self, post_id: str) -> GetPostMetricsResponse:
        return self._request(
            "GET", f"/posts/{urllib.parse.quote(post_id, safe='')}/metrics"
        )

    # Every post that went out in a window, with the newest numbers read for
    # each of them: totals, a per-day series and a per-platform split. Counters
    # are running totals, so a post counts once, at whatever its newest read
    # said. The window is whole UTC days, both ends included; left out, it is
    # the last 30 days, which is exactly as long as a post is refreshed for.
    def get_analytics(
        self,
        *,
        from_: str | None = None,
        to: str | None = None,
        profile_id: str | None = None,
        platform: str | None = None,
        connection_slug: str | None = None,
    ) -> GetAnalyticsResponse:
        return self._request(
            "GET",
            "/analytics",
            query={
                "from": from_,
                "to": to,
                "profileId": profile_id,
                "platform": platform,
                "connectionSlug": connection_slug,
            },
        )

    # One verb, three meanings, decided by what the post is: a post still
    # waiting to be sent is cancelled, a draft is really deleted (it never went
    # out, so there is no record to keep), and one that already went out comes
    # down on its platform. The answer says which happened: a cancelled or a
    # taken-down post carries a "status", a deleted draft carries "deleted".
    def delete_post(
        self, post_id: str
    ) -> CancelPostResponse | DeleteDraftResponse | DeletePostResponse:
        return self._request(
            "DELETE", f"/posts/{urllib.parse.quote(post_id, safe='')}"
        )

    # The same call under the name a caller reaches for when the post is a
    # draft. It is the same endpoint, so the answer is the same union: a post
    # that stopped being a draft between your read and this call comes back
    # cancelled or deleted, and the type says so.
    def delete_draft(
        self, post_id: str
    ) -> CancelPostResponse | DeleteDraftResponse | DeletePostResponse:
        return self._request(
            "DELETE", f"/posts/{urllib.parse.quote(post_id, safe='')}"
        )

    # The name this call had before it could delete a draft and a published post
    # too
    def cancel_post(
        self, post_id: str
    ) -> CancelPostResponse | DeleteDraftResponse | DeletePostResponse:
        return self.delete_post(post_id)

    # Sends a failed post again. Only a post that actually failed can be
    # retried, and anything but a post of yours in that state raises a 404
    # not_found or a 400 invalid_request.
    def retry_post(self, post_id: str) -> RetryPostResponse:
        return self._request(
            "POST", f"/posts/{urllib.parse.quote(post_id, safe='')}/retry"
        )

    # The secret in the response is shown exactly once. Store it now.
    def create_webhook(
        self, url: str, events: list[str] | None = None
    ) -> CreateWebhookResponse:
        return self._request(
            "POST", "/webhooks", json_body={"url": url, "events": events}
        )

    def list_webhooks(self) -> GetWebhooksResponse:
        return self._request("GET", "/webhooks")

    def delete_webhook(self, webhook_id: str) -> DeleteWebhookResponse:
        return self._request(
            "DELETE", f"/webhooks/{urllib.parse.quote(webhook_id, safe='')}"
        )

    # starting_after is a delivery id. The page continues from the delivery
    # after that one, which is steadier than an offset while new deliveries
    # land at the top of the log.
    def list_webhook_deliveries(
        self,
        webhook_id: str,
        limit: int | None = None,
        status: Literal["pending", "delivered", "failed", "dead"] | None = None,
        starting_after: str | None = None,
    ) -> GetWebhookDeliveriesResponse:
        return self._request(
            "GET",
            f"/webhooks/{urllib.parse.quote(webhook_id, safe='')}/deliveries",
            query={
                "status": status,
                "limit": limit,
                "startingAfter": starting_after,
            },
        )

    # Queues the delivery again as a fresh attempt chain, keeping its event id
    # and its body. Allowed on failed, dead and delivered; a delivery already
    # waiting for an attempt is a 400 invalid_request.
    def replay_delivery(
        self, webhook_id: str, delivery_id: str
    ) -> ReplayWebhookDeliveryResponse:
        webhook_path = urllib.parse.quote(webhook_id, safe="")
        delivery_path = urllib.parse.quote(delivery_id, safe="")

        return self._request(
            "POST",
            f"/webhooks/{webhook_path}/deliveries/{delivery_path}/replay",
        )

    # Enqueues a synthetic post.sent delivery, so a receiver can be checked
    # without posting. Its body carries "test": True and nothing was posted.
    def send_test_event(self, webhook_id: str) -> SendWebhookTestEventResponse:
        return self._request(
            "POST",
            f"/webhooks/{urllib.parse.quote(webhook_id, safe='')}/test",
        )

    # Whether the database answers and whether each background worker has
    # finished a loop recently. The endpoint needs no API key, and the status
    # code is 200 whether the API is ok or degraded, so read "status" rather
    # than catching an exception. The answer is cached for 10 seconds, so
    # polling faster than that buys nothing.
    def get_health(self) -> GetHealthResponse:
        return self._request("GET", "/health", is_public_endpoint=True)

    # The same health aggregated per UTC day, oldest first, from a sample taken
    # once a minute and kept for 90 days. days is 1 to 90 and defaults to 90.
    # This one needs no API key either, and its answer is cached for 60 seconds.
    def get_health_history(
        self, days: int | None = None
    ) -> GetHealthHistoryResponse:
        return self._request(
            "GET",
            "/health/history",
            query={"days": days},
            is_public_endpoint=True,
        )

    # Public counts about yeetpost as a whole, and the platforms a post can go
    # out to today. Nothing here is about one account, so it needs no API key
    # either. The answer is cached for 60 seconds, and the endpoint has its own
    # limit of 60 requests a minute per IP.
    def get_stats(self) -> GetStatsResponse:
        return self._request("GET", "/stats", is_public_endpoint=True)

    # The OpenAPI document this module was written against. It needs no API key
    # either, so a client built with an empty one can read it.
    def get_openapi_spec(self) -> dict[str, Any]:
        return self._request("GET", "/openapi.json", is_public_endpoint=True)


#
# Connect redirects
#


class _ConnectRedirectOptional(TypedDict, total=False):
    """The keys a connect redirect may leave out.

    connectionId, profileId, slug and platform are there when an account was
    connected, and error instead when it was not, so a redirect never carries
    both. NotRequired needs Python 3.11.
    """

    connectionId: str
    profileId: str
    slug: str
    platform: str
    # "cancelled" when the customer backed out, "connect_failed" when the
    # platform refused. Both mean the same thing to you: show the button again.
    error: str


class ConnectRedirect(_ConnectRedirectOptional):
    """What the hosted page adds to your redirect_url."""

    # Empty when the query carried none, which means it did not come from a
    # connect link.
    connectSessionId: str


def _get_query_value(query: Mapping[str, str | list[str]], name: str) -> str:
    """One query parameter, empty when the query did not carry it.

    urllib.parse.parse_qs answers with a list per name and most web frameworks
    answer with the string itself, so both are read here. A repeated parameter
    is read as its first value, which is the one the hosted page put there.
    """
    value = query.get(name)

    if isinstance(value, list):
        return value[0] if value else ""

    return value or ""


def parse_connect_redirect(
    query: Mapping[str, str | list[str]],
) -> ConnectRedirect:
    """Read what the hosted page put on the query your customer landed on.

    query is the parsed query string, either the dict of lists
    urllib.parse.parse_qs answers with or the dict of strings a web framework
    hands you.

    This is a browser coming back, so nothing here is proof of anything: read
    the connection off get_connect_session or off the connection.created
    webhook before you store it against a customer.
    """
    redirect: ConnectRedirect = {
        "connectSessionId": _get_query_value(query, "connectSessionId")
    }

    connection_id = _get_query_value(query, "connectionId")
    profile_id = _get_query_value(query, "profileId")
    slug = _get_query_value(query, "slug")
    platform = _get_query_value(query, "platform")
    error = _get_query_value(query, "error")

    if connection_id:
        redirect["connectionId"] = connection_id

    if profile_id:
        redirect["profileId"] = profile_id

    if slug:
        redirect["slug"] = slug

    if platform:
        redirect["platform"] = platform

    if error:
        redirect["error"] = error

    return redirect


#
# Webhooks
#


def verify_webhook_signature(
    body: str | bytes,
    signature_header: str,
    secret: str,
    tolerance_seconds: int = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
) -> bool:
    """Verify a webhook delivery.

    The signature must match the body, and the delivery must be recent enough
    that a captured one cannot be replayed at you later.

    body is the raw request body, before any JSON parsing. Re-serialising it
    changes the bytes that were signed. signature_header is the
    x-yeetpost-signature header, "t=<unix seconds>,v1=<hex hmac-sha256>".
    secret is the "yp_whsec_…" value from the create-webhook response.
    """
    match = SIGNATURE_HEADER_PATTERN.match(signature_header)

    if match is None:
        return False

    timestamp_seconds = int(match.group(1))
    signature = match.group(2)

    age_seconds = abs(time.time() - timestamp_seconds)

    if age_seconds > tolerance_seconds:
        return False

    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    signed_payload = f"{timestamp_seconds}.".encode("utf-8") + body_bytes

    expected = hmac.new(
        secret.encode("utf-8"), signed_payload, hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(signature, expected)
