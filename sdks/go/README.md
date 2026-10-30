# yeetpost go sdk

A thin, hand-written client for the [yeetpost API](https://yeetpost.com/docs). One
file, standard library only (`net/http`, `encoding/json`, `crypto/hmac`,
`context`), nothing here that you could not have written yourself in an
afternoon, which is the point.

Go 1.21 or newer.

## Install

```bash
go get github.com/yeetpost/yeetpost-sdks/sdks/go
```

Or just copy `yeetpost.go` into your package. It is one file with no imports
outside the standard library.

```go
import yeetpost "github.com/yeetpost/yeetpost-sdks/sdks/go"
```

## Versioning

The module carries no tags yet, so `go get` takes the latest commit and nothing
here has ever shipped under a version anyone pins.

## Yeet

```go
client := yeetpost.New(os.Getenv("YEETPOST_API_KEY"))

response, err := client.CreatePosts(ctx, yeetpost.CreatePostsParams{
	Text:            "shipped the new api docs today",
	ConnectionSlugs: []string{"linkedin", "x"},
})
```

Every method takes a `context.Context` first, so a call is cancelled with the
request that started it.

Not sure what you can post to?

```go
connections, err := client.ListConnections(ctx, nil)
// [{ID: "3f2a1b4c-...", Slug: "linkedin", PlatformID: "linkedin",
//   Description: "Alex Doe (LinkedIn)", ProfileID: nil,
//   Timezone: "Europe/Helsinki", QueueSlots: [...]}, ...]
```

`nil` is every connection of yours. Pass a `&ListConnectionsParams{ProfileID:
...}` to see one end customer's.

Branch on `PlatformID`, not on the wording of `Description`: `sms`, `email` and
`slack` are messaging channels, the rest are places you broadcast to.

## Read the per-item status, not just the absence of an error

`CreatePosts` fans out over several connections, and one of them failing does not
fail the call. You get a result per connection, and `Results.Failed()` is the
ones that did not go out:

```go
response, err := client.CreatePosts(ctx, yeetpost.CreatePostsParams{
	Text:            "shipped the new api docs today",
	ConnectionSlugs: []string{"linkedin", "x"},
})
if err != nil {
	return err
}

for _, result := range response.Results.Failed() {
	log.Println(result.ConnectionSlug, result.Error.Code, result.Error.Message)
}
```

The call itself only fails (`400 invalid_connection`) when none of the slugs
match a connection of yours.

Fields the API can send as null are pointers: `result.URL`, `result.PostID`,
`result.ScheduledFor` and `result.Error`. On a `failed` item `Error` is always
set; everywhere else, check it.

A `sent` or `scheduled` item can also carry a `Warning`, empty when there is
none: AI polish was asked for and failed, so the post went out under its
original text. Surface it rather than filing it.

## Scheduling

Give it a time and it schedules instead of sending. Must be in the future.

```go
_, err := client.CreatePosts(ctx, yeetpost.CreatePostsParams{
	Text:            "scheduled from a real integration",
	ConnectionSlugs: []string{"linkedin"},
	ScheduledFor:    "2026-09-15T15:00:00Z",
})
```

Timestamps go in and come back as ISO 8601 strings in UTC, exactly as the API
sends them.

A scheduled post sits in status `scheduled` until the worker picks it up. Cancel
it while it is still waiting:

```go
posts, err := client.ListPosts(ctx, yeetpost.ListPostsParams{
	Status: yeetpost.PostStatusScheduled,
	Limit:  10,
})

_, err = client.DeletePost(ctx, posts.Posts[0].ID)

post, err := client.GetPost(ctx, posts.Posts[0].ID)
// post.Post.Status == yeetpost.PostStatusCancelled
```

`ListPostsParams` also takes `CreatedAfter` and `CreatedBefore` (ISO 8601, read
against `createdAt`, both inclusive) and `Sort` (`created_desc`, the default,
`created_asc`, `scheduled_desc` or `scheduled_asc`). The answer carries `Total`,
`HasMore` and `NextOffset`, a `*int` that is nil on the last page.

`DeletePost` is one verb with three meanings, decided by what the post is, and
`DeletePostResponse` folds all three shapes into one struct the way
`LegacyPostResponse` already folds its three. A post still waiting is cancelled
(`Status` `cancelled`), a draft is really deleted (`Deleted` true), and a post
that already went out comes down on its platform, head post and thread replies
both (`Status` `deleted`, with a `DeletedAt`):

```go
response, err := client.DeletePost(ctx, postID)
// response.Status == yeetpost.PostStatusDeleted, response.DeletedAt is when
```

LinkedIn, X, Bluesky, Discord, Telegram, Mastodon, Reddit, Facebook and Google
Business Profile have a delete; Slack, SMS, Email, Instagram and Threads answer
`400 delete_unsupported`.
Nothing is refunded: an X fee is charged when the post goes out and is kept when
it comes down. `CancelPost` is the name this call had before it could do the
other two, and answers the same struct.

## Images

Upload the bytes, attach the id. The body is the raw file, not a multipart form,
and images are free within your storage allowance.

```go
image, err := os.ReadFile("./shot.png")

media, err := client.UploadMedia(ctx, yeetpost.UploadMediaParams{
	Bytes:       image,
	ContentType: yeetpost.MediaContentTypePNG,
	AltText:     "the new docs page",
})

_, err = client.CreatePosts(ctx, yeetpost.CreatePostsParams{
	Text:            "the new docs page is live",
	ConnectionSlugs: []string{"bluesky"},
	MediaIDs:        []string{media.MediaID},
})
```

The same bytes uploaded twice are one image: the second upload answers with the
id of the first and costs nothing against your allowance. Use `Media` instead of
`MediaIDs` to give one image its own alt text on this post, and never send both.

```go
Media: []yeetpost.PostMediaItem{
	{ID: media.MediaID, AltText: "the docs page, on this post"},
},
```

A third way skips the upload entirely: `MediaURLs` hands yeetpost the urls and
it fetches the bytes itself. Send only one of `MediaIDs`, `Media` or
`MediaURLs`.

```go
_, err = client.CreatePosts(ctx, yeetpost.CreatePostsParams{
	Text:            "the new docs page is live",
	ConnectionSlugs: []string{"bluesky"},
	MediaURLs:       []string{"https://example.com/shot.png"},
})
```

`GetMedia` reads the bytes back and `DeleteMedia` frees the storage. Posts that
used a deleted image keep their text and lose the image, so delete one only once
the posts that need it have gone out.

`RenderImage` makes the image for you: send HTML with inline CSS and a `Preset`
(or `Width` and `Height`), and the answer is a `MediaID` to attach like any
upload. 300 renders a month; past that it is a 429 `render_allowance_reached`.

```go
render, err := client.RenderImage(ctx, yeetpost.RenderImageParams{
	HTML:   "<div style=\"font:700 64px sans-serif\">The new docs page</div>",
	Preset: "landscape",
})
```

## Voice and look

`UpdateConnection` sets a connection's own tone of voice and look for image
cards, and `ClearVoice` or `ClearLook` takes them off again so the connection
falls back to the account's. `ProfileID` left nil still moves the connection
back out to your own, unless a voice or look is in the same call, where
`MoveOut: true` asks for the move. The account
look is `GetLook` and `UpdateLook`; a nil `Look` on `UpdateLookParams` clears it.

```go
_, err = client.UpdateConnection(ctx, connectionID, yeetpost.UpdateConnectionParams{
	Voice: &yeetpost.ConnectionVoice{ToneDescription: "dry and short", ExamplePosts: []string{"shipped"}},
})
_, err = client.UpdateLook(ctx, yeetpost.UpdateLookParams{
	Look: &yeetpost.ConnectionLook{Description: "warm and bold", ExampleCards: []string{}},
})
```

## Threads and first comments

`Thread` is a reply chain under the head post, at most 24 entries, in order. X,
Bluesky, Telegram and Mastodon only. `FirstComment` is a comment posted under
the post as its author, LinkedIn and Facebook only. Any other connection refuses
the item with `shape_unsupported`, which is a failed item rather than a failed
call.

```go
response, err := client.CreatePosts(ctx, yeetpost.CreatePostsParams{
	Text:            "the head post",
	ConnectionSlugs: []string{"x", "bluesky"},
	Thread:          []string{"second segment", "third segment"},
})

// response.Results[0].ThreadCount is how many replies actually went out
```

Two platforms have a shape of their own. Instagram publishes images and nothing
else, so a text-only item to it is refused with `shape_unsupported` before
anything is stored: attach an image and send the text as the caption. Reddit
takes the first line as the title and the rest as the body, and a bare URL as a
link post; it takes no thread, no first comment (`shape_unsupported`) and, for
now, no image (`media_unsupported`).

## AI polish and per-platform text

An account can add its own Claude or OpenAI key in the console and have outgoing
posts rewritten a little in its own tone of voice before they go out. It is
decided when the post is created, so a scheduled or queued post already carries
its rewritten text. `Rewrite: &true` or `Rewrite: &false` on `CreatePosts` wins
over everything else for that post; leave it nil and the connection's own mode
decides, falling back to the account's default.

```go
rewrite := true
_, err := client.CreatePosts(ctx, yeetpost.CreatePostsParams{
	Text:            "changelog: fixed a bug where scheduled posts could double post",
	ConnectionSlugs: []string{"linkedin"},
	Rewrite:         &rewrite,
})
```

A post fetched back (`ListPosts`, `GetPost`) carries `OriginalText` (what you
sent) next to `Text` (what actually went out) and `AiRewriteStatus`: `nil`
(never touched), `"rewritten"`, `"failed"` (the model or the account's key
errored, `Text` is the original after all) or `"skipped"` (a thread or other
multi-segment post; only a single post rewrites).

`TextByPlatform` gives one platform its own text in place of the shared `Text`,
for that request only, keyed by platform id and reaching every connection on
that platform in the call:

```go
_, err = client.CreatePosts(ctx, yeetpost.CreatePostsParams{
	Text:            "Shipped the new dashboard today. Read the full write-up on the blog.",
	ConnectionSlugs: []string{"linkedin", "x"},
	TextByPlatform:  map[string]string{"x": "Shipped the new dashboard today 🚀"},
})
```

A platform left out of `TextByPlatform` gets the shared `Text`.

## Queues

Give a connection a list of posting slots and `Queue: true` takes the next free
one instead of you naming a time. Slots are wall times on the connection's own
clock, `Weekday` 0 is Sunday.

```go
connections, err := client.ListConnections(ctx, nil)

_, err = client.UpdateConnectionQueue(ctx, connections.Connections[0].ID, yeetpost.UpdateConnectionQueueParams{
	Timezone: "Europe/Helsinki",
	Slots: &[]yeetpost.QueueSlot{
		{Weekday: 1, Time: "09:00"},
		{Weekday: 4, Time: "17:30"},
	},
})

response, err := client.CreatePosts(ctx, yeetpost.CreatePostsParams{
	Text:            "goes out at the next open slot",
	ConnectionSlugs: []string{connections.Connections[0].Slug},
	Queue:           true,
})
// response.Results[0].Status is scheduled, and ScheduledFor is the slot it took
```

Two queued posts never share a slot. A connection with no slots fails that one
item with `queue_empty`, and one whose slots are all taken inside the next 30
days fails it with `queue_full`.

```go
queue, err := client.ListConnectionQueue(ctx, connections.Connections[0].ID)
// queue.Paused is true while the queue is held
```

`Slots` is a pointer so that an empty list can be sent rather than dropped:
`Slots: &[]yeetpost.QueueSlot{}` takes every slot off the connection, and
leaving `Slots` nil sends only the timezone.

Pause a queue and nothing waiting in it goes out until you resume it. A post
scheduled by hand, rather than taking a slot, still goes out on time regardless.

```go
paused := true
_, err = client.UpdateConnectionQueue(ctx, connections.Connections[0].ID, yeetpost.UpdateConnectionQueueParams{
	Paused: &paused,
})
```

A queued post is a scheduled post: `DeletePost` frees its slot for the next one.
Changing the slots does not move posts that are already queued.

## Drafts and tags

`IsDraft: true` stores the post against every connection you name and publishes
nothing. It is validated the way a real send is, but reserves nothing: no usage,
no X fee, no queue slot, no webhook.

```go
response, err := client.CreatePosts(ctx, yeetpost.CreatePostsParams{
	Text:            "half an idea",
	ConnectionSlugs: []string{"linkedin"},
	IsDraft:         true,
	Tags:            []string{"launch"},
})
// response.Results[0].Status is draft, and PostID is the draft

postID := *response.Results[0].PostID

_, err = client.UpdateDraft(ctx, postID, yeetpost.UpdatePostParams{
	Text: "a whole idea",
	Tags: &[]string{"launch", "q3"},
})

_, err = client.PublishPost(ctx, postID, yeetpost.PublishPostParams{})
// or PublishPostParams{ScheduledFor: ...}, or PublishPostParams{Queue: true}
```

The post keeps the id it had as a draft, and the mode it was created with. A
refusal you can still settle leaves the draft where it was, so you can fix the
problem and publish the same id again: `queue_empty`, `queue_full`,
`payment_method_required`, `spend_cap_reached`, `fair_use_reached`,
`connection_limit_exceeded` and `platform_unavailable`. Every other refusal is
what happened to the post, so the draft becomes a failed post. Publishing
twice is a `404 not_found`, and `DeletePost` throws a draft away.

Every field of `UpdatePostParams` is optional and only what you send is written.
The lists are pointers so that an empty list can be sent rather than dropped:
`Thread: &[]string{}` clears the thread, `MediaIDs: &[]string{}` takes every
image off. `FirstComment` on its own sets the comment, and
`ClearFirstComment: true` sends the explicit null that takes it off.

`UpdateDraft` also edits a pending scheduled post, not only a draft: text,
images and tags the same way, plus `ScheduledFor` (with an optional
`Timezone`) or `Queue: true` to move its time, the same two ways
`PublishPostParams` reads them. A draft refuses all three with
`400 invalid_request`, since it has nowhere to be sent at yet; publish it
first. A text edit on a scheduled post is stored as final, your own words
from here on, so any AI polish it already carried is cleared rather than run
again. Naming a new time fires `post.rescheduled` with reason `edited`, but
only once the time actually changes; `Queue: true` on a post already queued
is a no-op. The worker may have already claimed the post, which is a
`409 post_not_editable`.

```go
_, err = client.UpdateDraft(ctx, scheduledPostID, yeetpost.UpdatePostParams{
	Text:         "a better idea",
	ScheduledFor: "2026-09-20T15:00:00Z",
})
```

`Tags` are your own labels, at most 10, each 1 to 40 characters of lowercase
letters, digits, dashes, underscores, colons, dots and slashes (`cms:launch`
works; input is lowercased before it is stored). They come back on every post
and on every webhook, and `ListPostsParams.Tag` narrows by all of them at once:

```go
// posts tagged both launch and q3, not either
posts, err := client.ListPosts(ctx, yeetpost.ListPostsParams{
	Tag: []string{"launch", "q3"},
})
```

## Sources

Paste a link and yeetpost posts what is new on it. A source watches a page that
lists things (courses, a blog, a changelog), an RSS, Atom or JSON feed, or a
sitemap, checks it every hour, and turns each new item into a post per
connection, written in that connection's voice with a card in its look. Sources
post for real, so every call needs a live key (a test key gets `403 forbidden`).

```go
// What would it find? Nothing is saved.
preview, err := client.PreviewSource(ctx, yeetpost.PreviewSourceParams{
	URL: "https://herizon.io/courses",
})
// preview.Kind is "feed", "json", "sitemap" or "page"; preview.Items the newest 5

created, err := client.CreateSource(ctx, yeetpost.CreateSourceParams{
	URL:             "https://herizon.io/courses",
	ConnectionSlugs: []string{"herizon_linkedin"},
	Mode:            "queue", // or "draft" to review every post first
	Instructions:    "one post per course, say it is free for members",
	BackfillCount:   0, // post none of what is already there
})

sourceID := created.Source.ID

_, err = client.CheckSource(ctx, sourceID) // now, instead of in the next hour
items, err := client.ListSourceItems(ctx, sourceID, &yeetpost.ListSourceItemsParams{Status: "failed"})
_, err = client.RetrySourceItem(ctx, sourceID, items.Items[0].ID)
_, err = client.UpdateSource(ctx, sourceID, yeetpost.UpdateSourceParams{Status: "paused"})
_, err = client.DeleteSource(ctx, sourceID) // the posts it made are not touched
```

An app that knows what is new the moment it happens makes a push source with
`Kind: "push"` instead of `URL`, and sends items to it:

```go
result, err := client.AddSourceItems(ctx, sourceID, yeetpost.AddSourceItemsParams{
	Items: []yeetpost.PushSourceItem{
		{ID: "course-4", Title: "Pricing your work", URL: "https://herizon.io/courses/pricing-your-work"},
	},
})
// result.Added is 1; an id sent twice counts as a duplicate and is never posted twice
```

## Idempotency

Network calls fail halfway. Pass a key and a retry cannot double-post: same key
and same body replays the stored response verbatim, without posting again.

```go
_, err := client.CreatePosts(ctx, yeetpost.CreatePostsParams{
	Text:            "v2.4.0 is out",
	ConnectionSlugs: []string{"linkedin"},
	IdempotencyKey:  "release-v2.4.0-announcement",
})
```

Same key with a different body is a `409 idempotency_key_conflict`. Keys expire
after 24 hours.

## Build a platform

Everything above assumes the accounts you post to are your own. If you are
building a product on yeetpost and posting on behalf of your own customers,
profiles are how you keep them apart. Five steps:

**1. One profile per end customer.**

```go
response, err := client.CreateProfile(ctx, yeetpost.CreateProfileParams{
	Name:       "Acme Coffee",
	ExternalID: "cus_4821",
})
profileID := response.Profile.ID
```

`ExternalID` is your own id for the same customer, so their row in your database
and their profile here agree without a second lookup table. It is optional and
unique across your live profiles: a second profile with the same one is a
`409 profile_external_id_conflict`. An account can have 1000 profiles at once,
and over that `CreateProfile` is a `403 limit_exceeded`.

**2. Send them a connect URL.** `CreateConnectURL` answers with a page yeetpost
hosts. Send your customer there and they connect one of their own accounts into
that profile.

```go
session, err := client.CreateConnectURL(ctx, profileID, yeetpost.CreateConnectURLParams{
	Platform:    yeetpost.ConnectPlatformLinkedIn,
	RedirectURL: "https://acme.example.com/settings/social",
})
// session.URL is where you send them, session.ConnectSessionID is what the
// redirect and the webhook come back with
```

Leave `Platform` empty and the page shows a picker instead. The token in the url
is the whole authorization: it stands for your account, that one profile and
that one redirect, it works once, and it lasts fifteen minutes. Only its hash is
stored, so the url above is the only time it exists, and the page never shows
your API key, your email or anything about your other customers. `Headless: true`
takes the yeetpost header and footer off the page so it can sit inside a popup
with your own branding around it: a popup rather than an iframe, because the
platforms' own consent screens refuse to be framed.

`RedirectURL` is optional: without it the customer finishes on a yeetpost "connected, you can close this tab" page and the link lasts 7 days instead of 15 minutes. `ConnectionID` reconnects an existing connection instead of adding one: the connection keeps its id and slug if the customer signs in to the same account, and a different account becomes a new connection. When given, `RedirectURL` must be an https URL on a public host with no fragment; plain http
is accepted for `localhost` and `127.0.0.1`. It is bound to the session here and
used exactly as stored, so nothing your customer's browser sends can change
where they land.

The customer lands on it either way, and `ParseConnectRedirect` reads what the
page put on the query:

```go
redirect := yeetpost.ParseConnectRedirect(request.URL.Query())

if redirect.Error != "" {
	// cancelled when they backed out, connect_failed when the platform
	// refused. Both mean the same thing to you: show the button again.
}

// redirect.ConnectionID, redirect.ProfileID, redirect.Slug and
// redirect.Platform are set when an account came in.
```

That is a browser coming back, so it is a hint rather than proof. The two
authorities are `GetConnectSession(ctx, connectSessionID)`, which says the same
thing from the API, and the `connection.created` webhook, whose
`Connection.ConnectSessionID` files the account against the customer you made
the link for without waiting for a browser at all.

```go
session, err := client.GetConnectSession(ctx, connectSessionID)
// session.ConnectSession.Status is pending, connected, failed or expired
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

```go
_, err = client.CreatePosts(ctx, yeetpost.CreatePostsParams{
	Text:            "our new roast is out",
	ConnectionSlugs: []string{"acme_linkedin"},
	ProfileID:       profileID,
})
```

A slug that belongs to another profile, or to you, fails that one item with
`invalid_connection` while the rest of the request goes out. `ProfileID` is part
of the idempotency hash, so the same text to the same slug is a different
request inside a profile from outside one.

**4. Read one customer back.**

```go
connections, err := client.ListConnections(ctx, &yeetpost.ListConnectionsParams{
	ProfileID: profileID,
})

posts, err := client.ListPosts(ctx, yeetpost.ListPostsParams{ProfileID: profileID})
```

Every connection and every post carries a `ProfileID` of its own, nil when it is
one of your own accounts. `ListProfiles(ctx, params)` pages your profiles newest
first and takes nil for the API's own paging, `GetProfile(ctx, profileID)` reads
one, and `UpdateProfile(ctx, profileID, params)` renames one or moves its
external id. `ExternalID` is a `*string` so that leaving it nil keeps the one the
profile had; `ClearExternalID: true` sends the explicit null that takes it off,
and the two cannot be combined.

**5. Move an account that is already connected.**

```go
_, err = client.UpdateConnection(ctx, connectionID, yeetpost.UpdateConnectionParams{
	ProfileID: &profileID,
})

// and back out to your own
_, err = client.UpdateConnection(ctx, connectionID, yeetpost.UpdateConnectionParams{})
```

The slug, the queue and every post already written stay where they are, and so
does the billed connection count: only the routing changes. A post keeps the
profile it was written under, so one customer's history never follows the
connection to another, and a post still waiting to go out fires the webhooks of
the customer it was written for.

The move fires `connection.removed` for the profile the connection left and
`connection.created` for the one it arrived at, so both tenants hear their own
half. LinkedIn pages move with the personal account that administers them.

A profile that already holds the same account is a `409 connection_conflict`
naming the connection in the way, and SMS and email are exempt because their
connect flows do not deduplicate either. A profile-scoped key is a
`403 forbidden`, and so does the connection you sign in with, because the move
is yours to make.

**6. Offboard them.**

```go
deleted, err := client.DeleteProfile(ctx, profileID)
// deleted.RemovedConnections is how many accounts went with it
```

That disconnects every account in the profile: the credentials are deleted, the
posts that already went out stay readable, anything still waiting to be sent is
cancelled, the drafts written in it are deleted, and your bill drops to the
connections you have left. The profile itself is kept out of sight rather than
erased, so `ListPosts` with its `ProfileID` still lists the history of a customer
you have offboarded.

A profile is a routing rail, not an authorization boundary. It decides which
connections a call reaches, and that is all it decides: an account key still
reaches any object of the account by id, so `GetPost` answers for one customer's
post whatever profile the caller had in mind. Keep the key on your server and
give each customer nothing but the profile id they belong to. When something
other than your own server holds a key, scope the key instead: see "Scoped keys"
below.

A profile id that is not one of yours is a `400 invalid_request` everywhere it
is taken, rather than an empty list. `PostToConnection` has nowhere to name a
profile, so it reaches your own accounts and nothing else. Profiles are not
scoped by key type either: a test key manages the same profiles a live key does,
and a sandbox connection can sit in a profile, which is how you test a
customer's flow without publishing anything.

### Scoped keys

A `ProfileID` on a call is a promise your own code makes. A key scoped to a
profile is a promise the API keeps: it can only ever reach that one end
customer, whatever the call says.

Scope is a property of the key, not of the call, and there is nothing to set
here: pick the customer under "Scope" when you create the key in the console.
The key still reads `yp_secret_` or `yp_test_`, so nothing that already stores
one has to change shape.

| Call                                                                   | Key scoped to profile P                                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ListConnections`, `ListPosts`                                         | P's objects only; a `ProfileID` other than P is `400`                       |
| `GetConnection`, `GetPost`, `UpdateDraft`, `PublishPost`, `DeletePost` | `404` outside P                                                             |
| `CreatePosts`                                                          | `ProfileID` defaults to P; a different one is `400`; slugs resolve inside P |
| `PostToConnection`                                                     | P's accounts, where an unscoped key reaches your own                        |
| `UploadMedia`, `GetMedia`, `DeleteMedia`                               | the image belongs to P; another profile's is `invalid_media` on a post      |
| `CreateWebhook` and the rest of the webhook calls                      | P's webhooks, hearing P's events only; `404` for the rest                   |
| `GetProfile`, `CreateConnectURL`                                       | P only; any other id is `403 forbidden`                                     |
| `CreateProfile`, `ListProfiles`, `UpdateProfile`, `DeleteProfile`      | `403 forbidden`                                                             |
| `CreateProfileKey` and the rest of the key calls                       | `403 forbidden`                                                             |
| `GetConnectSession`                                                    | P's sessions only; `404` for the rest                                       |

The `404`s are deliberate: an object outside the key's profile does not exist as
far as the key is concerned, so an id cannot be probed for whether it is there.
The `403`s are deliberate too: managing profiles is a real capability the key
does not have, and saying so saves you debugging a profile that is not missing.

`ProfileID` can be left empty everywhere it is optional. `CreatePosts` fills in
the key's own profile, and `ListConnections` and `ListPosts` are filtered
already, so the same code reads right whether it names the profile or not.

An idempotency key is reserved inside the key's scope, so two of your customers
sending `order-123` on the same day get their own posts and their own replays.

A connect URL from a scoped key is bound twice over. It is bound to P, because
`CreateConnectURL` takes no other profile, and to the key's redirect allowlist,
which is a list of origins set on the key in the console: with one set, a
`RedirectURL` whose scheme, host and port are not on it is a
`400 invalid_request` naming the allowed origins. Leave it empty and any https
URL on a public host is accepted, which is the rule for every key that has none.

Deleting a profile revokes the keys scoped to it, in the same transaction that
disconnects the accounts, so a key you handed to a customer's integration stops
working when they leave rather than quietly widening to the whole account.

### Minting a key from code

Onboarding a customer is code, so minting their key is too. `CreateProfileKey`
mints a key scoped to that profile, and the `Secret` on the answer is the raw
key, shown exactly once: no API endpoint reads the secret back, though the
account owner can reveal any key in the console. Store it where the customer's
integration will read it, or show it to them once and mint another if it goes
missing.

```go
minted, err := client.CreateProfileKey(ctx, profileID, yeetpost.CreateProfileKeyParams{
	Name:              "Acme integration",
	Type:              yeetpost.APIKeyTypeLive,
	RedirectAllowlist: []string{"https://acme.example.com"},
})

includeRevoked := true

keys, err := client.ListProfileKeys(ctx, profileID, yeetpost.ListAPIKeysParams{
	IncludeRevoked: &includeRevoked,
	Limit:          100,
})

revoked, err := client.RevokeProfileKey(ctx, profileID, minted.Key.ID)
```

Only an unscoped key of yours may call these five, and a key scoped to a profile
is a `403 forbidden` on all of them. A test key mints test keys only, so asking
it for a live one is a `403 forbidden` too, and a profile holds at most 50 live
and 50 test keys, over which minting is a `403 limit_exceeded`; a revoked key
does not count. `RedirectAllowlist` is bare origins such as
`https://acme.example.com`, no path, query or fragment, at most 20, normalized
and deduped, and an empty list means no allowlist at all. `ListKeys` and
`RevokeKey` do the same across the whole account, the unscoped keys and every
profile's, and a revocation takes effect on the next request everywhere at once,
including for the key that asked for it: only a connect url the key already
issued outlives it, for the rest of its fifteen minutes.

A test key manages test keys and nothing else on all five: both listings show it
the test keys, and a live key of yours answers `404 not_found` to it, the same
answer a key that is not yours gets. Both listings page like `ListProfiles`, with
`Limit` 1 to 100 defaulting to 25 and `Offset` defaulting to 0, and the answer
carries both back.

## Errors

Every non-2xx comes back as an `*APIError` carrying the status, the code and the
message. Nothing is swallowed.

```go
_, err := client.PostToConnection(ctx, "linkedn", "hello", yeetpost.PostToConnectionParams{})

var apiError *yeetpost.APIError

if errors.As(err, &apiError) {
	log.Println(apiError.StatusCode, apiError.Code, apiError.Message, apiError.RequestID)
	// 400 invalid_connection Connection 'linkedn' not found. ...
}
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
show up in a stored post's own error (`ListPosts`, a webhook).
`platform_unavailable` means the platform answered 429 or 5xx so nothing was
sent, safe to send again. `platform_timeout` means a Discord image upload got no answer in time: the message may still have posted, so check the channel before sending it again. When Discord is slow to answer a text-only post, it counts as sent, without a message id.

`RequestID` is the `x-request-id` header, the same value the body carries as
`req_id` on `platform_rejected`, `internal_server_error`,
`platform_unavailable` and `platform_timeout`. Quote it if you report the
problem.

Rate limiting is the one odd one out. The API's `429` body is
`{"error": "too many requests"}`, with no code from the vocabulary and no
message, so `Code` is that literal string. Branch on the status, and the
`x-ratelimit-*` headers are on the error:

```go
if errors.As(err, &apiError) && apiError.StatusCode == 429 {
	// 60 requests per minute per API key, per endpoint group.
	// apiError.RateLimitReset is the unix second the window has room again.
}
```

`RateLimitLimit`, `RateLimitRemaining` and `RateLimitReset` are `-1` when the
response did not carry the header, which is the case on `401` and on `500`.

## Webhooks

Register an https endpoint and yeetpost POSTs `post.sent`, `post.failed`,
`post.deleted`, `post.metrics`, `connection.created`, `connection.removed` and
`connection.reconnect_required` events to it as posts go out and come down and
accounts are connected, disconnected or need a reconnect, including scheduled
posts, which is the whole point, since nobody is waiting on an HTTP response by
then.

```go
response, err := client.CreateWebhook(ctx, yeetpost.CreateWebhookParams{
	URL: "https://example.com/hooks/yeetpost",
})
// response.Webhook.Secret is shown exactly once. Store it now.
```

Verify every delivery against the **raw** body, before any JSON parsing, since
re-serialising it changes the bytes that were signed:

```go
func handleWebhook(writer http.ResponseWriter, request *http.Request) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		http.Error(writer, "could not read the body", http.StatusBadRequest)
		return
	}

	isValid, err := yeetpost.VerifyWebhookSignature(
		os.Getenv("YEETPOST_WEBHOOK_SECRET"),
		request.Header.Get(yeetpost.HeaderSignature),
		body,
		yeetpost.DefaultWebhookTolerance,
	)
	if err != nil || !isValid {
		http.Error(writer, "bad signature", http.StatusBadRequest)
		return
	}

	event, err := yeetpost.ParseWebhookEvent(body)
	if err != nil {
		http.Error(writer, "bad body", http.StatusBadRequest)
		return
	}

	log.Println(event.Event, event.Post.ID)
	writer.WriteHeader(http.StatusOK)
}
```

It checks the HMAC in constant time and rejects anything more than the tolerance
(`DefaultWebhookTolerance` is 5 minutes) away from your clock, so a captured
delivery cannot be replayed at you later. A header that is not
`t=<unix seconds>,v1=<hex hmac-sha256>` at all comes back as
`ErrMalformedSignature`; a signature that simply does not match is a plain
`false`.

A `post.deleted` delivery is a shape of its own: a deleted post is no longer a
post, so the body says which one is gone and where it stood rather than
repeating its text one last time. Branch on `HeaderEvent` and read it with
`ParsePostDeletedWebhookEvent`:

```go
if request.Header.Get(yeetpost.HeaderEvent) == string(yeetpost.EventPostDeleted) {
	event, err := yeetpost.ParsePostDeletedWebhookEvent(body)
	log.Println(event.Post.ID, event.Post.PlatformID, event.Post.DeletedAt)
	return
}
```

Cancelling a scheduled post fires nothing: it was never published.

The two connection deliveries are a third shape, read with
`ParseConnectionWebhookEvent`. They fire when an account is connected or
disconnected, whether it went into one of your profiles or into your own
account, and the two ids in the body are the mapping to persist: the profile is
your customer, the connection is what you post to.

```go
if request.Header.Get(yeetpost.HeaderEvent) == string(yeetpost.EventConnectionCreated) {
	event, err := yeetpost.ParseConnectionWebhookEvent(body)
	log.Println(event.Connection.ProfileID, event.Connection.ID, event.Connection.Slug)
	return
}
```

`Connection.ConnectSessionID` is the connect link the account came in through,
nil when the connection was made in the console, so a receiver can file the
account against the customer you made the link for without waiting for a browser
to come back. `ConnectionEvent.Event` is a `ConnectionEventName`, which is only
ever `ConnectionEventNameCreated` or `ConnectionEventNameRemoved`.

Reconnecting an account that is already there replaces its credentials rather
than making a new connection, so it fires nothing, and deleting a profile fires
one `connection.removed` per account inside it.

`HeaderMode` (`x-yeetpost-mode`) is `test` on sandbox traffic, which is a post
made with a test key or an event about a sandbox connection, and `live`
otherwise. Key your receiver off it to keep sandbox traffic out of its real
handling.

## Dedupe on the event id

Every delivery carries an `x-yeetpost-event-id` header (`HeaderEventID`) and an
`EventID` at the top of its body. It is the same value on every retry and every
replay, so a receiver that has already handled it can say so and stop:

```go
if seen(event.EventID) {
	writer.WriteHeader(http.StatusOK)
	return
}

handle(event)
remember(event.EventID)
```

## Retries, dead letters and replays

A delivery is attempted up to 7 times, waiting 1m, 5m, 30m, 2h, 6h and 12h
between attempts. After the last one it becomes a dead letter
(`DeliveryStatusDead`) and is never retried on its own.

When a receiver is not getting events, read the log instead of guessing:

```go
page, err := client.ListWebhookDeliveries(ctx, webhookID, yeetpost.ListWebhookDeliveriesParams{
	Status: yeetpost.DeliveryStatusFilterDead,
	Limit:  10,
})
```

`HasMore` says whether there is another page. New deliveries land at the top of
the log while you page it, so the next page starts after the last id you saw
rather than at an offset:

```go
nextPage, err := client.ListWebhookDeliveries(ctx, webhookID, yeetpost.ListWebhookDeliveriesParams{
	Status:        yeetpost.DeliveryStatusFilterDead,
	Limit:         10,
	StartingAfter: page.Deliveries[len(page.Deliveries)-1].ID,
})
```

Fix the receiver, then throw the delivery at it again. The replay keeps the same
event id and the same body, so a receiver deduping on `EventID` sees the
delivery it missed, not a new one:

```go
_, err := client.ReplayDelivery(ctx, webhookID, page.Deliveries[0].ID)
```

Replay works on `failed`, `dead` and `delivered`. A delivery already queued for
another attempt is a `400 invalid_request`.

Building the receiver in the first place? Send it a test event and nothing gets
posted anywhere. The body is a normal, signed `post.sent` event with
`"test": true` on it:

```go
delivery, err := client.SendTestEvent(ctx, webhookID)
```

## Health

`GetHealth` is whether the database answers and whether each background loop has
finished one recently. It needs no API key, so a client built with an empty one
can still call it, and the status code is `200` whether the API is ok or
degraded: read `Status`.

```go
health, err := yeetpost.New("").GetHealth(ctx)
// health.Status == yeetpost.HealthStatusDegraded when any check is not ok
// health.Checks.ScheduledPosts.LastOkAt is when that loop last finished
```

`GetHealthHistory` is the same health aggregated per UTC day, oldest first.
`UptimePercent` is nil for a day that was over before sampling began: nobody was
watching it, so it is unmeasured rather than down.

```go
history, err := client.GetHealthHistory(ctx, yeetpost.GetHealthHistoryParams{Days: 30})
```

The answers are cached for 10 and 60 seconds, and both endpoints share one limit
of 60 requests a minute per IP.

`GetStats` is the public counts the marketing site draws: posts that reached a
platform this week and ever, the connections that can be posted to right now,
and the platform ids a post can go out to today. Nothing in it is about one
account, so it needs no key either, and its answer is cached for 60 seconds.

```go
stats, err := yeetpost.New("").GetStats(ctx)
// stats.PostsThisWeek, stats.PlatformsLive
```

## The whole surface

| Method                                              | Endpoint                                                    |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `ListConnections(ctx, params)`                      | `GET /connections`                                          |
| `GetConnection(ctx, connectionID)`                  | `GET /connections/{connectionId}`                           |
| `UpdateConnection(ctx, connectionID, params)`       | `PATCH /connections/{connectionId}`                         |
| `GetLook(ctx)`                                      | `GET /look`                                                 |
| `UpdateLook(ctx, params)`                           | `PUT /look`                                                 |
| `DraftLookFromURL(ctx, params)`                     | `POST /look/draft-from-url`                                 |
| `DeleteConnection(ctx, connectionID)`               | `DELETE /connections/{connectionId}`                        |
| `ListConnectionQueue(ctx, connectionID)`            | `GET /connections/{connectionId}/queue`                     |
| `UpdateConnectionQueue(ctx, connectionID, params)`  | `PATCH /connections/{connectionId}/queue`                   |
| `CreateProfile(ctx, params)`                        | `POST /profiles`                                            |
| `ListProfiles(ctx, params)`                         | `GET /profiles`                                             |
| `GetProfile(ctx, profileID)`                        | `GET /profiles/{profileId}`                                 |
| `UpdateProfile(ctx, profileID, params)`             | `PATCH /profiles/{profileId}`                               |
| `DeleteProfile(ctx, profileID)`                     | `DELETE /profiles/{profileId}`                              |
| `CreateProfileKey(ctx, profileID, params)`          | `POST /profiles/{profileId}/keys`                           |
| `ListProfileKeys(ctx, profileID, params)`           | `GET /profiles/{profileId}/keys`                            |
| `RevokeProfileKey(ctx, profileID, keyID)`           | `DELETE /profiles/{profileId}/keys/{keyId}`                 |
| `ListKeys(ctx, params)`                             | `GET /keys`                                                 |
| `RevokeKey(ctx, keyID)`                             | `DELETE /keys/{keyId}`                                      |
| `CreateConnectURL(ctx, profileID, params)`          | `POST /profiles/{profileId}/connect`                        |
| `GetConnectSession(ctx, connectSessionID)`          | `GET /connect-sessions/{connectSessionId}`                  |
| `PostToConnection(ctx, slug, text, params)`         | `POST /post/{connectionSlug}`                               |
| `CreatePosts(ctx, params)`                          | `POST /posts`                                               |
| `ListPosts(ctx, params)`                            | `GET /posts`                                                |
| `GetPost(ctx, postID)`                              | `GET /posts/{postId}`                                       |
| `UpdateDraft(ctx, postID, params)`                  | `PATCH /posts/{postId}`                                     |
| `PublishPost(ctx, postID, params)`                  | `POST /posts/{postId}/publish`                              |
| `DeletePost(ctx, postID)`                           | `DELETE /posts/{postId}`                                    |
| `CancelPost(ctx, postID)`                           | `DELETE /posts/{postId}`                                    |
| `RetryPost(ctx, postID)`                            | `POST /posts/{postId}/retry`                                |
| `DrawCard(ctx, postID, params)`                     | `POST /posts/{postId}/card`                                 |
| `GetPostMetrics(ctx, postID)`                       | `GET /posts/{postId}/metrics`                               |
| `GetAnalytics(ctx, params)`                         | `GET /analytics`                                            |
| `UploadMedia(ctx, params)`                          | `POST /media`                                               |
| `RenderImage(ctx, params)`                          | `POST /images/render`                                       |
| `GetMedia(ctx, mediaID)`                            | `GET /media/{mediaId}`                                      |
| `DeleteMedia(ctx, mediaID)`                         | `DELETE /media/{mediaId}`                                   |
| n/a (fetch the signed url directly)                 | `GET /media/{mediaId}/raw`                                  |
| `CreateWebhook(ctx, params)`                        | `POST /webhooks`                                            |
| `ListWebhooks(ctx)`                                 | `GET /webhooks`                                             |
| `DeleteWebhook(ctx, webhookID)`                     | `DELETE /webhooks/{webhookId}`                              |
| `ListWebhookDeliveries(ctx, webhookID, params)`     | `GET /webhooks/{webhookId}/deliveries`                      |
| `ReplayDelivery(ctx, webhookID, deliveryID)`        | `POST /webhooks/{webhookId}/deliveries/{deliveryId}/replay` |
| `SendTestEvent(ctx, webhookID)`                     | `POST /webhooks/{webhookId}/test`                           |
| `GetHealth(ctx)`                                    | `GET /health`                                               |
| `GetHealthHistory(ctx, params)`                     | `GET /health/history`                                       |
| `GetStats(ctx)`                                     | `GET /stats`                                                |
| `GetMe(ctx)`                                        | `GET /me`                                                   |
| `GetActivity(ctx, params)`                          | `GET /activity`                                             |
| `PreviewSource(ctx, params)`                        | `POST /sources/preview`                                     |
| `CreateSource(ctx, params)`                         | `POST /sources`                                             |
| `ListSources(ctx, params)`                          | `GET /sources`                                              |
| `GetSource(ctx, sourceID)`                          | `GET /sources/{sourceId}`                                   |
| `UpdateSource(ctx, sourceID, params)`               | `PATCH /sources/{sourceId}`                                 |
| `DeleteSource(ctx, sourceID)`                       | `DELETE /sources/{sourceId}`                                |
| `CheckSource(ctx, sourceID)`                        | `POST /sources/{sourceId}/check`                            |
| `ListSourceItems(ctx, sourceID, params)`            | `GET /sources/{sourceId}/items`                             |
| `AddSourceItems(ctx, sourceID, params)`             | `POST /sources/{sourceId}/items`                            |
| `RetrySourceItem(ctx, sourceID, itemID)`            | `POST /sources/{sourceId}/items/{itemId}/retry`             |
| `GetOpenapiSpec(ctx)`                               | `GET /openapi.json`                                         |
| `VerifyWebhookSignature(secret, header, body, ...)` | n/a                                                         |
| `ParseWebhookEvent(body)`                           | n/a                                                         |
| `ParsePostDeletedWebhookEvent(body)`                | n/a                                                         |
| `ParseConnectionWebhookEvent(body)`                 | n/a                                                         |
| `ParseConnectRedirect(query)`                       | n/a                                                         |

`PostToConnection` is the original one-liner endpoint: `text/plain` in, one
connection, no idempotency key, no post id. Prefer `CreatePosts` for anything
that is not a shell script.

`GetOpenapiSpec` is the document this client was written against. It needs no
API key, so a client built with an empty one can read it, and it comes back as
the decoded document rather than as a struct.

Not covered: the MCP endpoint (`POST /mcp`), which you point an MCP client at
directly, and `GET /media/{mediaId}/raw`, the signed link Instagram and Threads
fetch an image through. You never build one and never receive one, so there is
nothing for a client to call.

Point the client somewhere other than production, or give it your own transport
and timeout:

```go
client := yeetpost.New(apiKey,
	yeetpost.WithBaseURL("http://localhost:3901/api/v2"),
	yeetpost.WithHTTPClient(&http.Client{Timeout: 10 * time.Second}),
)
```

## Tests

`testing` and `net/http/httptest` from the standard library, against a stub http
server on a random port. No network, no test dependencies.

```bash
cd sdks/go
go test ./... -count=1
go vet ./...
gofmt -l .
```
