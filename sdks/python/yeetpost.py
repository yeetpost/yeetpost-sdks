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

# What an optional argument defaults to when "not passed" has to differ from
# None, because None is a value of its own there.
_UNSET: Any = object()

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


class ConnectionVoice(TypedDict):
    """The tone of voice a connection's posts are written in.

    toneDescription is at most 2000 characters, examplePosts at most 5 texts.
    """

    toneDescription: str
    examplePosts: list[str]


class ConnectionLook(TypedDict):
    """How a connection's image cards should look.

    description is at most 4000 characters, exampleCards at most 5 HTML
    documents of at most 30000 characters each, and logoMediaId the id of an
    uploaded image or None.
    """

    description: str
    exampleCards: list[str]
    logoMediaId: str | None


class ConnectionCapabilities(TypedDict):
    thread: bool
    firstComment: bool
    media: bool
    delete: bool


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
    # The most characters a post's text may carry on this connection, None for
    # a channel with no limit of ours. Mastodon's is the instance's own. X's is
    # advisory: what to aim for, and X itself decides.
    textLimit: int | None
    # True when textLimit is a target and not a ceiling: yeetpost does not
    # refuse text over it and the platform decides. X is the one.
    isTextLimitAdvisory: bool
    # The limit on the text when the post carries an image, None where it is
    # the same. Telegram's photo caption.
    textLimitWithMedia: int | None
    # The limit on the first line when it becomes the post's title, None where
    # there is none. Reddit's textLimit is None because only the title is
    # capped.
    titleLimit: int | None
    # The limit on a first comment, None where the platform takes none
    firstCommentLimit: int | None
    # What a post to this connection can carry, and whether a sent post can be
    # taken back down
    capabilities: ConnectionCapabilities
    # The connection's own tone of voice. None means it has none and its posts
    # fall back to the account's voice.
    voice: ConnectionVoice | None
    # The connection's own look for image cards. None means it has none and its
    # cards fall back to the account's look.
    look: ConnectionLook | None


class ConnectionsResponse(TypedDict):
    connections: list[Connection]


class GetConnectionResponse(TypedDict):
    connection: Connection


# A connection exactly as update_connection answers it, without status,
# loginExpiresAt, textLimit or capabilities: only list_connections and
# get_connection add those four.
class MovedConnection(TypedDict):
    id: str
    slug: str
    platformId: str
    description: str
    profileId: str | None
    timezone: str
    queueSlots: list[QueueSlot]
    voice: ConnectionVoice | None
    look: ConnectionLook | None


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
    # None when the link was made without one
    redirectUrl: str | None
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


class _PostErrorOptional(TypedDict, total=False):
    """The key an error may leave out. NotRequired needs 3.11."""

    # Present on text_too_long only: the part of the request that is too long,
    # such as "text", "thread[1]", "firstComment" or "textByPlatform.x"
    field: str


class PostError(_PostErrorOptional):
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


class ValidatedPost(TypedDict):
    connectionSlug: str
    valid: bool
    # How long the text is for this connection, counted the way the platform
    # counts it. None when the connection did not resolve.
    textLength: int | None
    # The connection's text limit, None when it has none
    textLimit: int | None
    # True when textLimit is a target and not a ceiling (X): the item can be
    # valid with a textLength over it
    isTextLimitAdvisory: bool
    # The refusal the real call would give for this connection, None when it
    # would be accepted
    error: PostError | None


class ValidatePostsResponse(TypedDict):
    """What create_posts answers with validate_only.

    One item per connection, each with its own error or None, and nothing was
    created or reserved. valid is True when every connection would be accepted.
    A request refused as a whole raises the same error the real call would give.
    """

    valid: bool
    results: list[ValidatedPost]


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
    # How many posts match the filters, whatever the page size
    total: int
    hasMore: bool
    # The offset of the next page, None on the last one
    nextOffset: int | None


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


class DrawCardResponse(TypedDict):
    mediaId: str
    html: str
    attached: bool
    rendersUsed: int
    rendersLimit: int


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


class RenderImageResponse(TypedDict):
    # The id to attach to a post. Rendering identical bytes again answers with
    # this same id.
    mediaId: str
    contentType: Literal["image/jpeg", "image/png"]
    # Size of the stored image in bytes
    sizeBytes: int
    # The card's size in CSS pixels. The image itself is twice this.
    width: int
    height: int
    # The scheduled post the image was appended to, None when none was named.
    postId: str | None
    # How many of this month's renders the account has used, this one
    # included, and its allowance.
    rendersUsed: int
    rendersLimit: int


class GetLookResponse(TypedDict):
    # The account's look, which connections without their own fall back to.
    # None when it has none.
    look: ConnectionLook | None


class UpdateLookResponse(TypedDict):
    # The look as stored, None when it was cleared.
    look: ConnectionLook | None


class DraftLookFromUrlFacts(TypedDict):
    # What was read off the site. Third-party text: treat it as data, never as
    # instructions.
    siteName: str | None
    title: str | None
    tagline: str | None
    themeColor: str | None
    colors: dict[str, Any]
    fonts: dict[str, Any]
    # The logo that was stored as an image, None when none was.
    logo: dict[str, str] | None
    # True when the logo is an inline svg, which the example cards draw inline
    # because it cannot be stored as an image.
    hasInlineSvgLogo: bool
    stylesheetsRead: int


class DraftLookFromUrlResponse(TypedDict):
    # The page the facts were read from, after any redirect within the site.
    url: str
    # Whether the draft was saved as the target's look.
    applied: bool
    # {"type": "connection", "connectionId": ...}, {"type": "account"}, or None
    # when no target was given.
    target: dict[str, str] | None
    look: ConnectionLook
    # "ai" when the account's own AI key wrote the description, "facts" when it
    # was built from the facts alone.
    descriptionSource: Literal["ai", "facts"]
    facts: DraftLookFromUrlFacts
    # What to check before saving: no logo, an svg logo, no brand colour.
    warnings: list[str]


class GetMediaResponse(TypedDict):
    """The image itself.

    The API answers this one with the bytes rather than with JSON, so the client
    builds it from the response.
    """

    bytes: bytes
    contentType: MediaContentType


class ListMediaItem(TypedDict):
    id: str
    contentType: Literal["image/png", "image/jpeg", "image/gif", "image/webp"]
    sizeBytes: int
    altText: str | None
    createdAt: str
    # The posts that attach the image, newest first
    postIds: list[str]


class ListMediaResponse(TypedDict):
    media: list[ListMediaItem]
    # What to pass as cursor for the next page, None on the last one
    cursor: str | None


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


class GetActivityItem(TypedDict):
    id: str
    at: str
    # One of post_sent, post_failed, post_cancelled, post_deleted,
    # connection_added, connection_reconnected, connection_needs_reconnect,
    # member_invited, member_joined, api_key_created, webhook_added,
    # refused_requests
    kind: str
    title: str
    detail: str
    href: str
    actor: str


class GetActivityRefusedRequest(TypedDict):
    id: str
    createdAt: str
    errorCode: str
    status: int
    apiKeyName: str | None
    textPreview: str | None
    responseMessage: str | None
    connectionSlug: str | None
    resolution: Literal["open", "moved", "deleted"]
    connectionName: str | None
    connectionId: str | None


class GetActivityResponse(TypedDict):
    """A page of the account's activity log, newest first."""

    items: list[GetActivityItem]
    # What to pass as cursor for the next page, None on the last one
    cursor: str | None
    # The post requests refused in the last 30 days. Only the first page
    # carries them.
    refusedRequests: list[GetActivityRefusedRequest]


class GetMeAccount(TypedDict):
    id: str
    # None on an account that was never given a name
    name: str | None


class GetMeProfile(TypedDict):
    id: str
    name: str


class GetMeUsage(TypedDict):
    postsToday: int
    # None is unlimited
    dailyPostCap: int | None
    postsThisMonth: int
    # None is unlimited
    monthlyPostCap: int | None
    messagesThisMonth: int
    # None is unlimited
    monthlyMessageCap: int | None
    smsThisMonth: int
    # None is unlimited
    monthlySmsCap: int | None
    rendersThisMonth: int
    # None is unlimited
    monthlyRenderCap: int | None


class GetMeRateLimits(TypedDict):
    mcpRequestsPerMinute: int


class GetMeResponse(TypedDict):
    """Who the API key is acting as, and what is left of its allowance."""

    account: GetMeAccount
    # "test" for a test key, which reaches sandbox connections only
    mode: Literal["live", "test"]
    # The profile the key is scoped to, None when it reaches the whole account
    profile: GetMeProfile | None
    plan: str
    usage: GetMeUsage
    rateLimits: GetMeRateLimits
    # The connections this key reaches: sandbox ones only for a test key, its
    # own profile's for a scoped key
    connectionCount: int


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


class PreviewSourceItem(TypedDict):
    title: str
    url: str | None
    summary: str
    publishedAt: str | None


class PreviewSourceResponse(TypedDict):
    """What a link would post, before anything is saved."""

    kind: Literal["feed", "json", "sitemap", "page"]
    name: str
    # The feed a page pointed to, None when the address itself is the list
    resolvedUrl: str | None
    itemCount: int
    # The newest few
    items: list[PreviewSourceItem]


class SourceError(TypedDict):
    code: str
    message: str


class SourceItemCounts(TypedDict):
    baseline: int
    new: int
    writing: int
    posted: int
    failed: int
    skipped: int


class Source(TypedDict):
    id: str
    slug: str
    name: str
    # None for a push source
    url: str | None
    kind: Literal["feed", "json", "sitemap", "page", "push"]
    resolvedUrl: str | None
    profileId: str | None
    connectionSlugs: list[str]
    mode: Literal["queue", "draft"]
    instructions: str
    makeCard: bool
    status: Literal["active", "paused", "error"]
    lastCheckedAt: str | None
    nextCheckAt: str | None
    lastError: SourceError | None
    itemCounts: SourceItemCounts
    # Where an app posts items, for a push source only
    pushUrl: str | None
    createdAt: str


class GetSourceResponse(TypedDict):
    source: Source


class CreateSourceResponse(TypedDict):
    source: Source


class GetSourcesResponse(TypedDict):
    sources: list[Source]
    limit: int
    offset: int


class UpdateSourceResponse(TypedDict):
    source: Source


class DeleteSourceResponse(TypedDict):
    id: str
    deleted: Literal[True]


class CheckSourceNewItem(TypedDict):
    id: str
    title: str
    url: str | None


class CheckSourceResponse(TypedDict):
    source: Source
    # The items this check found that had not been seen before
    newItems: list[CheckSourceNewItem]


class SourceItemPost(TypedDict):
    id: str
    connectionSlug: str
    status: Literal[
        "sent",
        "scheduled",
        "processing",
        "draft",
        "failed",
        "cancelled",
        "deleted",
    ]
    scheduledFor: str | None
    url: str | None


class SourceItem(TypedDict):
    id: str
    title: str
    url: str | None
    summary: str
    publishedAt: str | None
    status: Literal[
        "baseline", "new", "writing", "posted", "failed", "skipped"
    ]
    attempts: int
    error: SourceError | None
    posts: list[SourceItemPost]
    createdAt: str


class GetSourceItemsResponse(TypedDict):
    items: list[SourceItem]
    limit: int
    offset: int


class RetrySourceItemResponse(TypedDict):
    id: str
    status: Literal["new"]


class _PushSourceItemOptional(TypedDict, total=False):
    # http or https only
    url: str
    summary: str
    content: str
    # ISO 8601 with an offset
    publishedAt: str


class PushSourceItem(_PushSourceItemOptional):
    """One item an app pushes to a push source."""

    # Your own stable id for the item
    id: str
    title: str


class AddSourceItemsResponse(TypedDict):
    # Items that were new and are now waiting to be posted
    added: int
    # Ids that were already known, which are left as they are
    duplicates: int


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
    #
    # voice and look set the connection's own tone of voice and look for image
    # cards, and clear_voice or clear_look takes them off so the connection
    # falls back to the account's. Setting them is not the owner's call alone:
    # a scoped key may set them on a connection inside its profile. When a voice
    # or look is set or cleared, leaving profile_id out leaves the profile
    # alone; profile_id=None moves the connection out. Passing nothing at all
    # raises a ValueError.
    def update_connection(
        self,
        connection_id: str,
        profile_id: str | None = _UNSET,
        *,
        voice: ConnectionVoice | None = None,
        clear_voice: bool = False,
        look: ConnectionLook | None = None,
        clear_look: bool = False,
    ) -> UpdateConnectionResponse:
        if clear_voice and voice is not None:
            raise ValueError("pass either voice or clear_voice, not both")

        if clear_look and look is not None:
            raise ValueError("pass either look or clear_look, not both")

        has_profile_id = profile_id is not _UNSET

        if (
            not has_profile_id
            and voice is None
            and not clear_voice
            and look is None
            and not clear_look
        ):
            raise ValueError(
                "pass profile_id, voice, clear_voice, look or clear_look"
            )

        json_body: dict[str, Any] = {
            "voice": _NULL if clear_voice else voice,
            "look": _NULL if clear_look else look,
        }

        # None here is the explicit null that moves the connection out, so
        # the key is only left out when profile_id was not passed at all
        if has_profile_id:
            json_body["profileId"] = _NULL if profile_id is None else profile_id

        return self._request(
            "PATCH",
            f"/connections/{urllib.parse.quote(connection_id, safe='')}",
            json_body=json_body,
        )

    # The account's look: how image cards should look for every connection that
    # has no look of its own. None when the account has none. Any key can read
    # it, including a profile-scoped one.
    def get_look(self) -> GetLookResponse:
        return self._request("GET", "/look")

    # Sets the account's look, or clears it with None. The whole look is
    # replaced, so leaving out logoMediaId clears the logo. The account look
    # covers every profile, so a profile-scoped key or a test key raises a 403
    # forbidden: set a connection's look with update_connection instead.
    def update_look(self, look: ConnectionLook | None) -> UpdateLookResponse:
        return self._request(
            "PUT",
            "/look",
            json_body={"look": _NULL if look is None else look},
        )

    # Drafts a look from a brand's website: a description, two example cards,
    # a logo and the facts it read. Nothing is saved unless apply is True, and
    # then connection_id or account says which look it becomes. Show the draft
    # before you apply it. 20 calls a minute per key. An address the API will
    # not fetch raises a 400 invalid_url.
    def draft_look_from_url(
        self,
        url: str,
        *,
        apply: bool | None = None,
        connection_id: str | None = None,
        account: bool | None = None,
    ) -> DraftLookFromUrlResponse:
        return self._request(
            "POST",
            "/look/draft-from-url",
            json_body={
                "url": url,
                "apply": apply,
                "connectionId": connection_id,
                "account": account,
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
    # minutes (7 days without a redirect_url), and the token in it carries the whole authorization: nobody
    # signs in to yeetpost, and the page never shows your key, your email or
    # anything about your other customers. Leave platform out and the page
    # shows a picker. headless=True draws it with no yeetpost header or footer,
    # for a popup with your own branding around it. A test key opens a session
    # that offers the sandbox and nothing else, which is how the whole flow
    # runs in CI.
    def create_connect_url(
        self,
        profile_id: str,
        redirect_url: str | None = None,
        platform: ConnectPlatform | None = None,
        *,
        headless: bool | None = None,
        connection_id: str | None = None,
    ) -> CreateConnectSessionResponse:
        return self._request(
            "POST",
            f"/profiles/{urllib.parse.quote(profile_id, safe='')}/connect",
            json_body={
                "platform": platform,
                "redirectUrl": redirect_url,
                "headless": headless,
                "connectionId": connection_id,
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
    # validate_only runs every check the real call runs and creates nothing: no
    # post, no idempotency reservation, no usage held, nothing in the request
    # log. It answers a ValidatePostsResponse with an item for every
    # connection, each with its own error or None, or raises when the request
    # is refused as a whole.
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
        validate_only: bool | None = None,
    ) -> CreatePostsResponse | ValidatePostsResponse:
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
                "validateOnly": validate_only,
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

    # Renders an HTML card into a jpeg or png and stores it as an image, exactly
    # as if you had uploaded it. Pass the mediaId to create_posts, or a post_id
    # to append it to a scheduled post. Size the card with preset (square,
    # landscape or portrait), or with width and height together (200 to 2000
    # each). html is one document with inline CSS: no JavaScript runs, and your
    # own uploads show as yeetpost-media:<mediaId>. 300 renders a month per
    # account; past that it raises a 429 render_allowance_reached.
    def render_image(
        self,
        html: str,
        *,
        preset: Literal["square", "landscape", "portrait"] | None = None,
        width: int | None = None,
        height: int | None = None,
        format: Literal["jpeg", "png"] | None = None,
        alt_text: str | None = None,
        connection_id: str | None = None,
        post_id: str | None = None,
    ) -> RenderImageResponse:
        return self._request(
            "POST",
            "/images/render",
            json_body={
                "html": html,
                "preset": preset,
                "width": width,
                "height": height,
                "format": format,
                "altText": alt_text,
                "connectionId": connection_id,
                "postId": post_id,
            },
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

    # Your images, newest first, each with the posts that attach it. Pass the
    # cursor of one page as cursor for the next, until it comes back None. The
    # MCP tool list_media answers the same.
    def list_media(
        self,
        *,
        connection_slug: str | None = None,
        post_id: str | None = None,
        created_after: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> ListMediaResponse:
        return self._request(
            "GET",
            "/media",
            query={
                "connectionSlug": connection_slug,
                "postId": post_id,
                "createdAfter": created_after,
                "cursor": cursor,
                "limit": limit,
            },
        )

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
    # nothing for a post that was never scheduled. created_after and
    # created_before are ISO 8601 timestamps, both inclusive, read against
    # createdAt. sort is created_desc (the default), created_asc,
    # scheduled_desc or scheduled_asc; a post that was never scheduled comes
    # last on the scheduled orders.
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
        created_after: str | None = None,
        created_before: str | None = None,
        sort: str | None = None,
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
                "createdAfter": created_after,
                "createdBefore": created_before,
                "sort": sort,
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

    # Draws an image card for a post in its connection's look, from the post's
    # own text. Without attach it is a preview: read the picture with
    # get_media and nothing on the post changes. With attach=True the card is
    # appended to a draft or a scheduled post. html is the card's source, to
    # keep as an example card in the look (put it first: cards follow the
    # first example card). The connection needs a look with an
    # example card, or this raises a 400 look_missing.
    def draw_card(
        self,
        post_id: str,
        instructions: str | None = None,
        attach: bool | None = None,
    ) -> DrawCardResponse:
        return self._request(
            "POST",
            f"/posts/{urllib.parse.quote(post_id, safe='')}/card",
            json_body={"instructions": instructions, "attach": attach},
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

    # Who this key is acting as: the account, live or test mode, the profile the
    # key is scoped to, the plan, how much of today's posts and this month's
    # renders is used, and how many connections the key reaches. The MCP tool
    # get_context answers the same.
    def get_me(self) -> GetMeResponse:
        return self._request("GET", "/me")

    # The account's activity log, newest first, plus on the first page the post
    # requests refused in the last 30 days. It needs a live key not scoped to
    # one profile, else it raises a 403 forbidden. limit is 1 to 100 and the API
    # defaults it to 25. The MCP tool get_activity answers the same.
    def get_activity(
        self, limit: int | None = None, cursor: str | None = None
    ) -> GetActivityResponse:
        return self._request(
            "GET", "/activity", query={"limit": limit, "cursor": cursor}
        )

    # What a link would post, before anything is saved: its kind, name, item
    # count and the newest 5 items. A page with no feed is read by AI. Like
    # every sources call it needs a live key and raises a 403 forbidden for a
    # test key. The MCP tool preview_source answers the same.
    def preview_source(self, url: str) -> PreviewSourceResponse:
        return self._request("POST", "/sources/preview", json_body={"url": url})

    # Watches a link and posts what is new into the connections, each post in
    # that connection's voice and look. Pass url, or kind="push" for a source an
    # app fills with add_source_items. mode "queue" takes each connection's next
    # slot, "draft" saves the post for you to review. Items already there are
    # never posted unless backfill_count asks for the newest few (0 to 20).
    # instructions is plain words about how to write the posts, up to 1000
    # characters. The MCP tool create_source answers the same.
    def create_source(
        self,
        connection_slugs: list[str],
        mode: Literal["queue", "draft"],
        *,
        url: str | None = None,
        kind: Literal["push"] | None = None,
        name: str | None = None,
        instructions: str | None = None,
        make_card: bool | None = None,
        backfill_count: int | None = None,
        profile_id: str | None = None,
    ) -> CreateSourceResponse:
        return self._request(
            "POST",
            "/sources",
            json_body={
                "url": url,
                "kind": kind,
                "name": name,
                "connectionSlugs": connection_slugs,
                "mode": mode,
                "instructions": instructions,
                "makeCard": make_card,
                "backfillCount": backfill_count,
                "profileId": profile_id,
            },
        )

    # Your sources, newest first. A key scoped to a profile lists that
    # profile's sources alone.
    def list_sources(
        self, limit: int | None = None, offset: int | None = None
    ) -> GetSourcesResponse:
        return self._request(
            "GET", "/sources", query={"limit": limit, "offset": offset}
        )

    def get_source(self, source_id: str) -> GetSourceResponse:
        return self._request(
            "GET", f"/sources/{urllib.parse.quote(source_id, safe='')}"
        )

    # Changes the connections, mode, instructions or card of a source, or pauses
    # and resumes it with status. Only what you pass is changed.
    def update_source(
        self,
        source_id: str,
        *,
        connection_slugs: list[str] | None = None,
        mode: Literal["queue", "draft"] | None = None,
        instructions: str | None = None,
        make_card: bool | None = None,
        status: Literal["active", "paused"] | None = None,
    ) -> UpdateSourceResponse:
        return self._request(
            "PATCH",
            f"/sources/{urllib.parse.quote(source_id, safe='')}",
            json_body={
                "connectionSlugs": connection_slugs,
                "mode": mode,
                "instructions": instructions,
                "makeCard": make_card,
                "status": status,
            },
        )

    # Stops watching a link. The posts it already made are not touched.
    def delete_source(self, source_id: str) -> DeleteSourceResponse:
        return self._request(
            "DELETE", f"/sources/{urllib.parse.quote(source_id, safe='')}"
        )

    # Checks a source now instead of waiting for the hourly check, and answers
    # with the new items it found. A paused source is refused, and each source
    # can be checked once a minute.
    def check_source(self, source_id: str) -> CheckSourceResponse:
        return self._request(
            "POST",
            f"/sources/{urllib.parse.quote(source_id, safe='')}/check",
        )

    # The items a source found, newest first, with their status and the posts
    # they made.
    def list_source_items(
        self,
        source_id: str,
        status: Literal[
            "baseline", "new", "writing", "posted", "failed", "skipped"
        ]
        | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> GetSourceItemsResponse:
        return self._request(
            "GET",
            f"/sources/{urllib.parse.quote(source_id, safe='')}/items",
            query={"status": status, "limit": limit, "offset": offset},
        )

    # Pushes 1 to 20 items to a push source, for an app that knows what is new
    # the moment it happens. A source that watches a link refuses them. An id
    # already sent is counted as a duplicate and left as it is.
    def add_source_items(
        self, source_id: str, items: list[PushSourceItem]
    ) -> AddSourceItemsResponse:
        return self._request(
            "POST",
            f"/sources/{urllib.parse.quote(source_id, safe='')}/items",
            json_body={
                "items": [
                    {name: value for name, value in item.items() if value is not None}
                    for item in items
                ]
            },
        )

    # Puts a failed item back to waiting, to be written and posted on the next
    # turn. An item held back by a burst of unseen items can be posted the same
    # way.
    def retry_source_item(
        self, source_id: str, item_id: str
    ) -> RetrySourceItemResponse:
        return self._request(
            "POST",
            f"/sources/{urllib.parse.quote(source_id, safe='')}"
            f"/items/{urllib.parse.quote(item_id, safe='')}/retry",
        )

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
