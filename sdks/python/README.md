# yeetpost python sdk

A thin, hand-written client for the [yeetpost API](https://yeetpost.com/docs). One
module, standard library only (`urllib.request`, `hmac`, `hashlib`, `json`),
nothing here that you could not have written yourself in an afternoon, which is
the point.

Python 3.10 or newer.

## Install

Not published yet. From this repo:

```bash
pip install ./sdks/python
```

Or just copy `yeetpost.py` into your project. It is one file with no imports
outside the standard library.

## Versioning

`2.6.0`, matching the node client. Nothing has been published to PyPI yet, so
nothing here is a break for anyone.

## Yeet

```python
import os
from yeetpost import Yeetpost

yeetpost = Yeetpost(os.environ["YEETPOST_API_KEY"])

yeetpost.create_posts(
    text="shipped the new api docs today",
    connection_slugs=["linkedin", "x"],
)
```

Not sure what you can post to?

```python
connections = yeetpost.list_connections()["connections"]
# [{"id": "3f2a1b4c-...", "slug": "linkedin", "platformId": "linkedin",
#   "description": "Alex Doe (LinkedIn)", "profileId": None,
#   "timezone": "UTC", "queueSlots": [], "status": "active",
#   "loginExpiresAt": None}, ...]
```

Branch on `platformId`, not on the wording of `description`: `sms`, `email` and
`slack` are messaging channels, the rest are places you broadcast to.

## Images

Upload the bytes, attach the id. The body is the raw file, not a multipart form,
and images are free within your storage allowance.

```python
with open("./shot.png", "rb") as image:
    media = yeetpost.upload_media(
        image.read(), "image/png", alt_text="the new docs page"
    )

yeetpost.create_posts(
    text="the new docs page is live",
    connection_slugs=["bluesky"],
    media_ids=[media["mediaId"]],
)
```

The same bytes uploaded twice are one image: the second upload answers with the
id of the first and costs nothing against your allowance. Use `media` instead of
`media_ids` to give one image its own alt text on this post, and never send
both:

```python
media=[{"id": media["mediaId"], "altText": "the docs page, on this post"}],
```

A third way skips the upload call entirely: `media_urls` has yeetpost fetch the
bytes itself. Send only one of `media_ids`, `media` or `media_urls`.

```python
yeetpost.create_posts(
    text="the new docs page is live",
    connection_slugs=["bluesky"],
    media_urls=["https://example.com/shot.png"],
)
```

`get_media(media_id)` reads the bytes back with the content type they were
uploaded as, and `delete_media(media_id)` frees the storage. Posts that used a
deleted image keep their text and lose the image, so delete one only once the
posts that need it have gone out.

## Threads and first comments

`thread` is a reply chain under the head post, at most 24 entries, in order. X,
Bluesky, Telegram and Mastodon only. `first_comment` is a comment posted under
the post as its author, LinkedIn and Facebook only. Any other connection refuses
the item with `shape_unsupported`, which is a failed item rather than a failed
call.

```python
response = yeetpost.create_posts(
    text="the head post",
    connection_slugs=["x", "bluesky"],
    thread=["second segment", "third segment"],
)
# response["results"][0]["threadCount"] is how many replies actually went out
```

Two platforms have a shape of their own. Instagram publishes images and nothing
else, so a text-only item to it is refused with `shape_unsupported` before
anything is stored: attach an image and send the text as the caption. Reddit
takes the first line as the title and the rest as the body, and a bare URL as a
link post; it takes no thread, no first comment (`shape_unsupported`) and, for
now, no image (`media_unsupported`).

## Read the per-item status, not just the absence of an exception

`create_posts` fans out over several connections, and one of them failing does not
fail the call. You get a result per connection:

```python
response = yeetpost.create_posts(
    text="shipped the new api docs today",
    connection_slugs=["linkedin", "x"],
)

for result in response["results"]:
    if result["status"] == "failed":
        print(result["connectionSlug"], result["error"]["code"], result["error"]["message"])
```

The whole call only raises (`400 invalid_connection`) when none of the slugs match
a connection of yours.

A `sent` or `scheduled` item can also carry a `"warning"`: AI polish was asked
for and failed, so the post went out under its original text. Surface it
rather than filing it. The key is there only when there is one, so read it
with `result.get("warning")`.

## AI polish and per-platform text

An account can add its own Claude or OpenAI key in the console and have outgoing
posts rewritten a little in its own tone of voice before they go out. It is
decided when the post is created, so a scheduled or queued post already carries
its rewritten text. `rewrite=True` or `rewrite=False` on `create_posts` wins
over everything else for that post; leave it out and the connection's own mode
decides, falling back to the account's default.

```python
yeetpost.create_posts(
    text="changelog: fixed a bug where scheduled posts could double post",
    connection_slugs=["linkedin"],
    rewrite=True,
)
```

A post fetched back (`list_posts`, `get_post`) carries `"originalText"` (what
you sent) next to `"text"` (what actually went out) and `"aiRewriteStatus"`:
`None` (never touched), `"rewritten"`, `"failed"` (the model or the account's
key errored, `"text"` is the original after all) or `"skipped"` (a thread or
other multi-segment post; only a single post rewrites).

`text_by_platform` gives one platform its own text in place of the shared
`text`, for that request only, keyed by platform id and reaching every
connection on that platform in the call:

```python
yeetpost.create_posts(
    text="Shipped the new dashboard today. Read the full write-up on the blog.",
    connection_slugs=["linkedin", "x"],
    text_by_platform={"x": "Shipped the new dashboard today 🚀"},
)
```

A platform left out of `text_by_platform` gets the shared `text`.

## Scheduling

Give it a time and it schedules instead of sending. Must be in the future.

```python
yeetpost.create_posts(
    text="scheduled from a real integration",
    connection_slugs=["linkedin"],
    scheduled_for="2026-09-15T15:00:00Z",
)
```

A scheduled post sits in status `scheduled` until the worker picks it up. Cancel
it while it is still waiting:

```python
posts = yeetpost.list_posts(status="scheduled", limit=10)["posts"]
yeetpost.delete_post(posts[0]["id"])

post = yeetpost.get_post(posts[0]["id"])["post"]
# post["status"] == "cancelled"
```

The same call on a post that already went out deletes it on its platform, head
post and thread replies both, and answers `{"id", "status": "deleted",
"deletedAt"}`. LinkedIn, X, Bluesky, Discord, Telegram, Mastodon, Reddit,
Facebook and Google Business Profile have a delete; Slack, SMS, Email, Instagram
and Threads answer `400 delete_unsupported`. Nothing is refunded: an X fee is charged when the post
goes out and is kept when it comes down.

One endpoint, three shapes, so `delete_post` answers a union: a cancelled or a
taken-down post carries a `"status"`, and a deleted draft carries
`"deleted": True` and no status at all. Read whichever key is there.
`delete_draft(post_id)` is the same call under the name you reach for when the
post is a draft, and it answers the same union, since the endpoint answers
whatever the post really is.

A `scheduled_for` with an offset is already an instant. For a local time without
one, say which clock to read it on:

```python
yeetpost.create_posts(
    text="nine in the morning, wherever the office is",
    connection_slugs=["linkedin"],
    scheduled_for="2026-09-15T09:00:00",
    timezone="Europe/Helsinki",
)
```

A post that failed can be sent again without rebuilding it:

```python
failed = yeetpost.list_posts(status="failed", limit=10)["posts"]
response = yeetpost.retry_post(failed[0]["id"])
# response == {"id": ..., "status": "sent"}
```

`list_posts` also narrows by `scheduled_after` and `scheduled_before` (ISO 8601
timestamps, read against `scheduledFor`, both inclusive), `connection_slug`,
`platform` and `send_group_id`, the id every post made by one `create_posts`
call shares:

```python
yeetpost.list_posts(
    scheduled_after="2026-09-01T00:00:00Z",
    scheduled_before="2026-09-30T00:00:00Z",
    platform="linkedin",
)
```

## Queues

Give a connection a list of posting slots and `queue=True` takes the next free
one instead of you naming a time. Slots are wall times on the connection's own
clock, `weekday` 0 is Sunday.

```python
connections = yeetpost.list_connections()["connections"]

yeetpost.update_connection_queue(
    connections[0]["id"],
    timezone="Europe/Helsinki",
    slots=[
        {"weekday": 1, "time": "09:00"},
        {"weekday": 4, "time": "17:30"},
    ],
)

results = yeetpost.create_posts(
    text="goes out at the next open slot",
    connection_slugs=[connections[0]["slug"]],
    queue=True,
)["results"]
# results[0]["status"] == "scheduled", results[0]["scheduledFor"] is the slot
```

Two queued posts never share a slot. A connection with no slots fails that one
item with `queue_empty`, and one whose slots are all taken inside the next 30
days fails it with `queue_full`.

```python
queue = yeetpost.list_connection_queue(connections[0]["id"])
# queue["paused"] is True while the queue is held
```

Pause a queue and nothing waiting in it goes out until you resume it. A post
scheduled by hand, rather than taking a slot, still goes out on time regardless.

```python
yeetpost.update_connection_queue(connections[0]["id"], paused=True)
# later
yeetpost.update_connection_queue(connections[0]["id"], paused=False)
```

A queued post is a scheduled post: `delete_post` frees its slot for the next one.
Changing the slots does not move posts that are already queued.

## Drafts and tags

`is_draft=True` stores the post against every connection you name and publishes
nothing. It is validated the way a real send is, but reserves nothing: no usage,
no X fee, no queue slot, no webhook.

```python
results = yeetpost.create_posts(
    text="half an idea",
    connection_slugs=["linkedin"],
    is_draft=True,
    tags=["launch"],
)["results"]
# results[0]["status"] == "draft", results[0]["postId"] is the draft

post_id = results[0]["postId"]

yeetpost.update_draft(post_id, "a whole idea", tags=["launch", "q3"])

yeetpost.publish_post(post_id)
# or publish_post(post_id, "2026-09-15T15:00:00Z"), or publish_post(post_id, queue=True)
```

The post keeps the id it had as a draft, and the mode it was created with. A
refusal you can still settle leaves the draft where it was, so you can fix the
problem and publish the same id again: `queue_empty`, `queue_full`,
`payment_method_required`, `spend_cap_reached`, `fair_use_reached`,
`connection_limit_exceeded` and `platform_unavailable`. Every other refusal is
what happened to the post, so the draft becomes a failed post. Publishing
twice raises a `404 not_found`, and `delete_draft(post_id)` throws it away.

Every argument to `update_draft` is optional and only what you pass is written,
so `first_comment=None` leaves the comment alone. Take one off with
`update_draft(post_id, clear_first_comment=True)`. `media_ids` or `media`
replaces the whole image list, and `thread=[]` clears the reply chain.

`update_draft` also edits a pending scheduled post, not only a draft: text,
images and tags the same way, plus `scheduled_for` (with an optional
`timezone`) or `queue=True` to move its time, the same two ways
`publish_post` reads them. A draft raises a `400 invalid_request` on all
three, since it has nowhere to be sent at yet; publish it first. A text edit
on a scheduled post is stored as final, your own words from here on, so any
AI polish it already carried is cleared rather than run again. Naming a new
time fires `post.rescheduled` with reason `edited`, but only once the time
actually changes; `queue=True` on a post already queued is a no-op. The
worker may have already claimed the post, which raises a
`409 post_not_editable`.

```python
yeetpost.update_draft(
    scheduled_post_id, "a better idea", scheduled_for="2026-09-20T15:00:00Z"
)
```

`tags` are your own labels, at most 10, each 1 to 40 characters of lowercase
letters, digits, dashes, underscores, colons, dots and slashes (`cms:launch`
works; input is lowercased before it is stored). They come back on every post
and on every webhook, and `list_posts(tag=[...])` narrows by all of them at
once:

```python
# posts tagged both launch and q3, not either
posts = yeetpost.list_posts(tag=["launch", "q3"])["posts"]
```

## Idempotency

Network calls fail halfway. Pass a key and a retry cannot double-post: same key
and same body replays the stored response verbatim, without posting again.

```python
yeetpost.create_posts(
    text="v2.4.0 is out",
    connection_slugs=["linkedin"],
    idempotency_key="release-v2.4.0-announcement",
)
```

Same key with a different body is a `409 idempotency_key_conflict`. Keys expire
after 24 hours.

## Build a platform

Everything above assumes the accounts you post to are your own. If you are
building a product on yeetpost and posting on behalf of your own customers,
profiles are how you keep them apart. Five steps:

**1. One profile per end customer.**

```python
profile = yeetpost.create_profile("Acme Coffee", "cus_4821")["profile"]
```

The second argument is `external_id`, your own id for the same customer, so
their row in your database and their profile here agree without a second lookup
table. It is optional and unique across your live profiles: a second profile
with the same one raises a `409 profile_external_id_conflict`. An account can
have 1000 profiles at once, and over that `create_profile` raises a
`403 limit_exceeded`.

**2. Send them a connect URL.** `create_connect_url` answers with a page
yeetpost hosts. Send your customer there and they connect one of their own
accounts into that profile.

```python
session = yeetpost.create_connect_url(
    profile["id"],
    "https://acme.example.com/settings/social",
    "linkedin",
)
# session["url"] is where you send them, session["connectSessionId"] is what
# the redirect and the webhook come back with
```

Leave the platform out and the page shows a picker instead. The token in the url
is the whole authorization: it stands for your account, that one profile and
that one redirect, it works once, and it lasts fifteen minutes. Only its hash is
stored, so the url above is the only time it exists, and the page never shows
your API key, your email or anything about your other customers.
`headless=True` takes the yeetpost header and footer off the page so it can sit
inside a popup with your own branding around it: a popup rather than an iframe,
because the platforms' own consent screens refuse to be framed.

The redirect url must be an https URL on a public host with no fragment; plain
http is accepted for `localhost` and `127.0.0.1`. It is bound to the session
here and used exactly as stored, so nothing your customer's browser sends can
change where they land.

The customer lands on it either way, and `parse_connect_redirect` reads what the
page put on the query:

```python
from yeetpost import parse_connect_redirect

redirect = parse_connect_redirect(request.args)

if "error" in redirect:
    # "cancelled" when they backed out, "connect_failed" when the platform
    # refused. Both mean the same thing to you: show the button again.
    ...

# redirect["connectionId"], redirect["profileId"], redirect["slug"] and
# redirect["platform"] are there when an account came in.
```

That is a browser coming back, so it is a hint rather than proof. The two
authorities are `get_connect_session(connect_session_id)`, which says the same
thing from the API, and the `connection.created` webhook, whose
`connection["connectSessionId"]` files the account against the customer you made
the link for without waiting for a browser at all.

```python
session = yeetpost.get_connect_session(connect_session_id)["connectSession"]
# session["status"] is "pending", "connected", "failed" or "expired"
```

A link that has been used or has run out shows a plain "this link has expired"
page and sends nobody anywhere, which is why polling exists: there is no
redirect left to carry the news.

A test key opens a session that offers the sandbox and nothing else, which is
how you exercise the whole flow, redirect and webhook included, in CI without
connecting anybody's real account. The console does the same job by hand: pick
the customer in "Connect for" on the connections screen and connect as usual.

The same account connected into two profiles is two connections, with their own
slugs, history and queue, and it counts twice on your bill, because you are
billing two of your own customers for it.

**3. Post with the profile.** A post that names one can only reach that
profile's connections, and a post that names none can only reach the accounts
outside every profile, which are your own. That is what stops a bug in your code
from posting one customer's message to another customer's account.

```python
yeetpost.create_posts(
    text="our new roast is out",
    connection_slugs=["acme_linkedin"],
    profile_id=profile["id"],
)
```

A slug that belongs to another profile, or to you, fails that one item with
`invalid_connection` while the rest of the request goes out. `profile_id` is
part of the idempotency hash, so the same text to the same slug is a different
request inside a profile from outside one.

**4. Read one customer back.**

```python
connections = yeetpost.list_connections(profile_id=profile["id"])["connections"]
posts = yeetpost.list_posts(profile_id=profile["id"])["posts"]
```

Every connection and every post carries a `profileId` of its own, `None` when it
is one of your own accounts. `list_profiles(limit, offset)` pages your profiles
newest first, `get_profile(profile_id)` reads one, and
`update_profile(profile_id, name, external_id=...)` renames one or moves its
external id. `external_id=None` is "leave it alone" like every other argument,
so taking an external id off is
`update_profile(profile_id, clear_external_id=True)`, which sends the explicit
null the API reads as "no external id any more".

**5. Move an account that is already connected.**

```python
yeetpost.update_connection(connection["id"], profile["id"])

# and back out to your own
yeetpost.update_connection(connection["id"], None)
```

The slug, the queue and every post already written stay where they are, and so
does the billed connection count: only the routing changes. A post keeps the
profile it was written under, so one customer's history never follows the
connection to another, and a post still waiting to go out fires the webhooks of
the customer it was written for.

The move fires `connection.removed` for the profile the connection left and
`connection.created` for the one it arrived at, so both tenants hear their own
half. LinkedIn pages move with the personal account that administers them.

A profile that already holds the same account raises a `409 connection_conflict`
naming the connection in the way, and SMS and email are exempt because their
connect flows do not deduplicate either. A profile-scoped key raises a
`403 forbidden`, and so does the connection you sign in with, because the move
is yours to make.

**6. Offboard them.**

```python
removed = yeetpost.delete_profile(profile["id"])["removedConnections"]
```

That disconnects every account in the profile: the credentials are deleted, the
posts that already went out stay readable, anything still waiting to be sent is
cancelled, the drafts written in it are deleted, and your bill drops to the
connections you have left. The profile itself is kept out of sight rather than
erased, so `list_posts(profile_id=...)` still lists the history of a customer
you have offboarded.

A profile is a routing rail, not an authorization boundary. It decides which
connections a call reaches, and that is all it decides: an account key still
reaches any object of the account by id, so `get_post(post_id)` answers for one
customer's post whatever profile the caller had in mind. Keep the key on your
server and give each customer nothing but the `profileId` they belong to. When
something other than your own server holds a key, scope the key instead: see
"Scoped keys" below.

A `profile_id` that is not one of yours raises a `400 invalid_request`
everywhere it is taken, rather than answering with an empty list.
`post_to_connection` has nowhere to name a profile, so it reaches your own
accounts and nothing else. Profiles are not scoped by key type either: a test
key manages the same profiles a live key does, and a sandbox connection can sit
in a profile, which is how you test a customer's flow without publishing
anything.

### Scoped keys

`profile_id` on a call is a promise your own code makes. A key scoped to a
profile is a promise the API keeps: it can only ever reach that one end
customer, whatever the call says.

Scope is a property of the key, not of the call, and there is nothing to set
here: pick the customer under "Scope" when you create the key in the console.
The key still reads `yp_secret_` or `yp_test_`, so nothing that already stores
one has to change shape.

| Call                                                                        | Key scoped to profile P                                                      |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `list_connections()`, `list_posts()`                                        | P's objects only; a `profile_id` other than P is `400`                       |
| `get_connection`, `get_post`, `update_draft`, `publish_post`, `delete_post` | `404` outside P                                                              |
| `create_posts(...)`                                                         | `profile_id` defaults to P; a different one is `400`; slugs resolve inside P |
| `post_to_connection(slug, text)`                                            | P's accounts, where an unscoped key reaches your own                         |
| `upload_media(...)`, `get_media`, `delete_media`                            | the image belongs to P; another profile's is `invalid_media` on a post       |
| `create_webhook(...)` and the rest of the webhook calls                     | P's webhooks, hearing P's events only; `404` for the rest                    |
| `get_profile(profile_id)`, `create_connect_url(profile_id, ...)`            | P only; any other id is `403 forbidden`                                      |
| `create_profile`, `list_profiles`, `update_profile`, `delete_profile`       | `403 forbidden`                                                              |
| `create_profile_key` and the rest of the key calls                          | `403 forbidden`                                                              |
| `get_connect_session(connect_session_id)`                                   | P's sessions only; `404` for the rest                                        |

The `404`s are deliberate: an object outside the key's profile does not exist as
far as the key is concerned, so an id cannot be probed for whether it is there.
The `403`s are deliberate too: managing profiles is a real capability the key
does not have, and saying so saves you debugging a profile that is not missing.

`profile_id` can be left out everywhere it is optional. `create_posts` fills in
the key's own profile, and `list_connections()` and `list_posts()` are filtered
already, so the same code reads right whether it names the profile or not.

An idempotency key is reserved inside the key's scope, so two of your customers
sending `order-123` on the same day get their own posts and their own replays.

A connect URL from a scoped key is bound twice over. It is bound to P, because
`create_connect_url` takes no other profile, and to the key's redirect
allowlist, which is a list of origins set on the key in the console: with one
set, a `redirect_url` whose scheme, host and port are not on it raises a
`400 invalid_request` naming the allowed origins. Leave it empty and any https
URL on a public host is accepted, which is the rule for every key that has none.

Deleting a profile revokes the keys scoped to it, in the same transaction that
disconnects the accounts, so a key you handed to a customer's integration stops
working when they leave rather than quietly widening to the whole account.

### Minting a key from code

Onboarding a customer is code, so minting their key is too.
`create_profile_key` mints a key scoped to that profile, and the `"secret"` in
the answer is the raw key, shown exactly once: no API endpoint reads the secret
back, though the account owner can reveal any key in the console. Store it where
the customer's integration will read it, or show it to them once and mint
another if it goes missing.

```python
minted = yeetpost.create_profile_key(
    profile["id"],
    "Acme integration",
    "live",
    ["https://acme.example.com"],
)

keys = yeetpost.list_profile_keys(
    profile["id"], include_revoked=True, limit=100
)["keys"]

yeetpost.revoke_profile_key(profile["id"], minted["key"]["id"])
```

Only an unscoped key of yours may call these five, and a key scoped to a profile
raises a `403 forbidden` on all of them. A test key mints test keys only, so
asking it for a live one raises a `403 forbidden` too, and a profile holds at
most 50 live and 50 test keys, over which minting raises a `403 limit_exceeded`;
a revoked key does not count. `redirect_allowlist` is bare origins such as
`https://acme.example.com`, no path, query or fragment, at most 20, normalized
and deduped, and an empty list means no allowlist at all. `list_keys()` and
`revoke_key(key_id)` do the same across the whole account, the unscoped keys and
every profile's, and a revocation takes effect on the next request everywhere at
once, including for the key that asked for it: only a connect url the key
already issued outlives it, for the rest of its fifteen minutes.

A test key manages test keys and nothing else on all five: both listings show it
the test keys, and a live key of yours raises a `404 not_found` to it, the same
answer a key that is not yours gets. Both listings page like `list_profiles()`,
with `limit` 1 to 100 defaulting to 25 and `offset` defaulting to 0, and the
answer carries both back.

## Errors

Every non-2xx raises a `YeetpostApiError` carrying the status, the code and the
message. Nothing is swallowed.

```python
from yeetpost import YeetpostApiError

try:
    yeetpost.post_to_connection("linkedn", "hello")
except YeetpostApiError as error:
    print(error.status, error.code, error.message, error.request_id)
    # 400 invalid_connection Connection 'linkedn' not found. ... None
```

Codes are the API's own vocabulary: `invalid_request`, `invalid_connection`,
`invalid_media`, `invalid_media_type`, `media_unsupported`, `shape_unsupported`,
`queue_empty`, `unauthorized`, `payment_method_required`, `spend_cap_reached`,
`connection_limit_exceeded`, `limit_exceeded`, `fair_use_reached`,
`reconnect_required`, `queue_full`, `forbidden`, `not_found`,
`idempotency_key_conflict`, `profile_external_id_conflict`,
`connection_conflict`, `post_not_cancellable`, `post_not_editable`,
`delete_unsupported`, `unsupported_content_type`, `media_too_large`,
`media_storage_full`, `platform_rejected`, `internal_server_error`,
`send_interrupted`, `platform_unavailable`, `platform_timeout`, `missed_slot`,
`missed_schedule`. That is the whole vocabulary, all 33 codes, exactly as
`openapi.json` lists them. `send_interrupted`, `missed_slot` and
`missed_schedule` never come back from a call you made directly: they only
show up in a stored post's own error (`list_posts`, a webhook).
`platform_unavailable` means the platform answered 429 or 5xx so nothing was
sent, safe to send again. `platform_timeout` is Discord only: its own message
POST timed out, so the message may already have posted and the fix is to
check the channel before sending it again.

`request_id` is the `x-request-id` header, and the `req_id` the body carries on
`platform_rejected`, `internal_server_error`, `platform_unavailable` and
`platform_timeout` when the header was not sent. Quote it if you report the
problem.

Rate limiting is the one odd one out. The API's `429` body is
`{"error": "too many requests"}`, with no code from the vocabulary and no
message, so `code` is that literal string. Branch on the status, and the
`x-ratelimit-*` headers are on the error:

```python
except YeetpostApiError as error:
    if error.status == 429:
        # 60 requests per minute per API key, per endpoint group.
        # error.rate_limit_reset is the unix second the window has room again.
        ...
```

`rate_limit_limit`, `rate_limit_remaining` and `rate_limit_reset` are `-1` when
the response did not carry the header, which is the case on `401` and on `500`.

## Webhooks

Register an https endpoint and yeetpost POSTs `post.sent`, `post.failed`,
`post.deleted`, `post.metrics`, `connection.created`, `connection.removed` and
`connection.reconnect_required` events to it as posts go out and come down,
accounts are connected, and a stored login stops working, including scheduled
posts, which is the whole point, since nobody is waiting on an HTTP response by
then.

```python
webhook = yeetpost.create_webhook(url="https://example.com/hooks/yeetpost")["webhook"]
# webhook["secret"] is shown exactly once. Store it now.
```

Verify every delivery against the **raw** body, before any JSON parsing,
since re-serialising it changes the bytes that were signed:

```python
import json
import os
from flask import Flask, request
from yeetpost import verify_webhook_signature

app = Flask(__name__)


@app.post("/hooks/yeetpost")
def hooks_yeetpost():
    is_valid = verify_webhook_signature(
        request.get_data(),
        request.headers.get("x-yeetpost-signature", ""),
        os.environ["YEETPOST_WEBHOOK_SECRET"],
    )

    if not is_valid:
        return "bad signature", 400

    event = json.loads(request.get_data())

    if event["event"].startswith("connection."):
        print(event["connection"]["profileId"], event["connection"]["id"])
    else:
        print(event["event"], event["post"]["id"])

    return "", 200
```

It checks the HMAC in constant time and rejects anything more than
`tolerance_seconds` (default 300) away from your clock, so a captured delivery
cannot be replayed at you later.

Branch on the `x-yeetpost-event` header, or on `event`, before you read `post`
or `connection`. The bodies are `WebhookEvent` (`post.sent`, `post.failed`),
`PostDeletedWebhookEvent` and `ConnectionWebhookEvent`, and `AnyWebhookEvent` is
the union of the three, for a receiver that takes a delivery before it knows
which one it is.

A `post.deleted` delivery is a shape of its own: a deleted post is no longer a
post, so the body says which one is gone and where it stood rather than
repeating its text one last time. Cancelling a scheduled post fires nothing: it
was never published.

`connection.created` and `connection.removed` fire when an account is connected
or disconnected, whether it went into one of your profiles or into your own
account. The two ids in the body are the mapping to persist: the profile is your
customer, the connection is what you post to. `connection["connectSessionId"]`
is the connect link the account came in through, `None` when the connection was
made in the console, so a receiver can file the account against the customer you
made the link for without waiting for a browser to come back. Reconnecting an
account that is already there replaces its credentials rather than making a new
connection, so it fires nothing, and deleting a profile fires one
`connection.removed` per account inside it.

`connection.reconnect_required` fires once, the moment a stored login actually
fails rather than on every post that runs into it, so `status` on
`list_connections()` and `get_connection()` is the one to poll if you would
rather not wait on a webhook.

## Dedupe on the event id

Every delivery carries an `x-yeetpost-event-id` header and an `eventId` at the
top of its body. It is the same value on every retry and every replay, so a
receiver that has already handled it can say so and stop:

```python
if seen(event["eventId"]):
    return "", 200
handle(event)
remember(event["eventId"])
```

## Retries, dead letters and replays

A delivery is attempted up to 7 times, waiting 1m, 5m, 30m, 2h, 6h and 12h
between attempts. After the last one it becomes a dead letter
(`status == "dead"`) and is never retried on its own.

When a receiver is not getting events, read the log instead of guessing:

```python
response = yeetpost.list_webhook_deliveries(webhook["id"], status="dead", limit=10)
deliveries = response["deliveries"]
```

`hasMore` says whether there is another page. New deliveries land at the top of
the log while you page it, so the next page starts after the last id you saw
rather than at an offset:

```python
next_page = yeetpost.list_webhook_deliveries(
    webhook["id"],
    status="dead",
    limit=10,
    starting_after=deliveries[-1]["id"],
)
```

Fix the receiver, then throw the delivery at it again. The replay keeps the same
event id and the same body, so a receiver deduping on `eventId` sees the
delivery it missed, not a new one:

```python
yeetpost.replay_delivery(webhook["id"], deliveries[0]["id"])
```

Replay works on `failed`, `dead` and `delivered`. A delivery already queued for
another attempt is a `400 invalid_request`.

Building the receiver in the first place? Send it a test event and nothing gets
posted anywhere. The body is a normal, signed `post.sent` event with
`"test": True` on it:

```python
delivery = yeetpost.send_test_event(webhook["id"])["delivery"]
```

## Health

`get_health()` is whether the database answers and whether each background loop
has finished one recently. The endpoint needs no API key, and the status code is
`200` whether the API is ok or degraded, so read `"status"` rather than catching
an exception.

```python
health = yeetpost.get_health()
# health["status"] == "degraded" when any check is not ok
# health["checks"]["scheduledPosts"]["lastOkAt"] is when that loop last finished
```

`get_health_history(days)` is the same health aggregated per UTC day, oldest
first. `uptimePercent` is `None` for a day that was over before sampling began:
nobody was watching it, so it is unmeasured rather than down.

```python
days = yeetpost.get_health_history(days=30)["days"]
```

The answers are cached for 10 and 60 seconds, and both endpoints share one limit
of 60 requests a minute per IP.

`get_stats()` is the public counts the marketing site draws: posts that reached
a platform this week and ever, the connections that can be posted to right now,
and the platform ids a post can go out to today. Nothing in it is about one
account, so it needs no key either, and its answer is cached for 60 seconds.

```python
stats = yeetpost.get_stats()
# stats["postsThisWeek"], stats["platformsLive"]
```

## The whole surface

| Method                                                               | Endpoint                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `list_connections(profile_id)`                                       | `GET /connections`                                          |
| `get_connection(connection_id)`                                      | `GET /connections/{connectionId}`                           |
| `update_connection(connection_id, profile_id)`                       | `PATCH /connections/{connectionId}`                         |
| `delete_connection(connection_id)`                                   | `DELETE /connections/{connectionId}`                        |
| `list_connection_queue(connection_id)`                               | `GET /connections/{connectionId}/queue`                     |
| `update_connection_queue(connection_id, slots, timezone, paused)`    | `PATCH /connections/{connectionId}/queue`                   |
| `create_profile(name, external_id)`                                  | `POST /profiles`                                            |
| `list_profiles(limit, offset)`                                       | `GET /profiles`                                             |
| `get_profile(profile_id)`                                            | `GET /profiles/{profileId}`                                 |
| `update_profile(profile_id, name, external_id, ...)`                 | `PATCH /profiles/{profileId}`                               |
| `delete_profile(profile_id)`                                         | `DELETE /profiles/{profileId}`                              |
| `create_profile_key(profile_id, name, key_type, ...)`                | `POST /profiles/{profileId}/keys`                           |
| `list_profile_keys(profile_id, include_revoked, ...)`                | `GET /profiles/{profileId}/keys`                            |
| `revoke_profile_key(profile_id, key_id)`                             | `DELETE /profiles/{profileId}/keys/{keyId}`                 |
| `list_keys(include_revoked, limit, offset)`                          | `GET /keys`                                                 |
| `revoke_key(key_id)`                                                 | `DELETE /keys/{keyId}`                                      |
| `create_connect_url(profile_id, redirect_url, platform, ...)`        | `POST /profiles/{profileId}/connect`                        |
| `get_connect_session(connect_session_id)`                            | `GET /connect-sessions/{connectSessionId}`                  |
| `post_to_connection(slug, text, scheduled_for)`                      | `POST /post/{connectionSlug}`                               |
| `create_posts(text, connection_slugs, ...)`                          | `POST /posts`                                               |
| `list_posts(status, limit, offset, tag, profile_id, ...)`            | `GET /posts`                                                |
| `get_post(post_id)`                                                  | `GET /posts/{postId}`                                       |
| `update_draft(post_id, text, ...)`                                   | `PATCH /posts/{postId}`                                     |
| `publish_post(post_id, scheduled_for, ...)`                          | `POST /posts/{postId}/publish`                              |
| `retry_post(post_id)`                                                | `POST /posts/{postId}/retry`                                |
| `delete_post(post_id)`                                               | `DELETE /posts/{postId}`                                    |
| `cancel_post(post_id)`                                               | `DELETE /posts/{postId}`                                    |
| `delete_draft(post_id)`                                              | `DELETE /posts/{postId}`                                    |
| `get_post_metrics(post_id)`                                          | `GET /posts/{postId}/metrics`                               |
| `get_analytics(from_, to, profile_id, platform)`                     | `GET /analytics`                                            |
| `upload_media(image_bytes, content_type, alt_text)`                  | `POST /media`                                               |
| `get_media(media_id)`                                                | `GET /media/{mediaId}`                                      |
| `delete_media(media_id)`                                             | `DELETE /media/{mediaId}`                                   |
| n/a (fetch the signed url directly)                                  | `GET /media/{mediaId}/raw`                                  |
| `create_webhook(url, events)`                                        | `POST /webhooks`                                            |
| `list_webhooks()`                                                    | `GET /webhooks`                                             |
| `delete_webhook(webhook_id)`                                         | `DELETE /webhooks/{webhookId}`                              |
| `list_webhook_deliveries(webhook_id, limit, status, starting_after)` | `GET /webhooks/{webhookId}/deliveries`                      |
| `replay_delivery(webhook_id, delivery_id)`                           | `POST /webhooks/{webhookId}/deliveries/{deliveryId}/replay` |
| `send_test_event(webhook_id)`                                        | `POST /webhooks/{webhookId}/test`                           |
| `get_health()`                                                       | `GET /health`                                               |
| `get_health_history(days)`                                           | `GET /health/history`                                       |
| `get_stats()`                                                        | `GET /stats`                                                |
| `get_openapi_spec()`                                                 | `GET /openapi.json`                                         |
| `parse_connect_redirect(query)`                                      | n/a                                                         |
| `verify_webhook_signature(body, signature_header, ...)`              | n/a                                                         |

`post_to_connection` is the original one-liner endpoint: `text/plain` in, one
connection, no idempotency key, no post id. Prefer `create_posts` for anything
that is not a shell script.

`get_health()`, `get_health_history()`, `get_stats()` and `get_openapi_spec()`
need no API key, so `Yeetpost("")` can still call those four. Every other call
with an empty key raises `ValueError("api_key is required for this call")`
before the request goes out.

Not covered: the MCP endpoint (`POST /mcp`), which you point an MCP client at
directly, and `GET /media/{mediaId}/raw`, the signed link Instagram and Threads
fetch an image through. You never build one and never receive one, so there is
nothing for a client to call.

Responses come back as plain dicts, exactly as the API sends them, with
`TypedDict` shapes (`CreatePostsResponse`, `GetPostsResponse`, `WebhookEvent`, …)
copied from the spec so a type checker can see them. `post_to_connection`
answers `LegacyPostResponse`, the union of the three shapes that endpoint sends.

Pass `base_url` to point at something other than production:

```python
yeetpost = Yeetpost(api_key, base_url="http://localhost:3901/api/v2")
```

## Tests

`unittest` from the standard library, against a stub http server on a random port.
No network, no test dependencies.

```bash
cd sdks/python && python3 -m unittest -v
```
