# yeetpost node sdk

A thin, hand-written client for the [yeetpost API](https://yeetpost.com/docs). One
file, no runtime dependencies, built on the global `fetch`. Nothing here that you
could not have written yourself in an afternoon, which is the point.

Node 18 or newer.

## Install

```bash
npm install yeetpost
```

> The `yeetpost` package already on npm is the older one from
> [`yeetpost/yeetpost-node`](https://github.com/yeetpost/yeetpost-node): a single
> `yeetpost({ connection, text })` over `POST /post/{slug}`, plus a CLI. It predates the
> JSON endpoint, so it has no `createPosts`, scheduling, idempotency, post listing or
> webhooks. This client is the whole v2 surface.

## Versioning

`2.6.0`, matching the python client. No 2.x has ever been published, so nothing
here is a break for anyone.

## CLI

The same package installs a `yeetpost` command. Ten commands, no generated
catalogue.

```bash
npx yeetpost login
npx yeetpost post "shipped the new api docs today" --to all
```

`login` asks for an API key with the typing hidden, checks it against
`GET /connections`, and stores it in `~/.config/yeetpost/config.json` with mode
`0600`. `YEETPOST_API_KEY` overrides the file, `YEETPOST_BASE_URL` and
`--base-url` point at a self-hosted API or the sandbox, and `XDG_CONFIG_HOME`
moves the config file. What `login` writes as the base url is what `--base-url`
said, or the default: `YEETPOST_BASE_URL` steers one shell and never lands on
disk.

| Command                             | What it does                                                        |
| ----------------------------------- | ------------------------------------------------------------------- |
| `yeetpost login`                    | Store an API key, after checking it against the API                 |
| `yeetpost logout`                   | Forget the stored API key                                           |
| `yeetpost whoami`                   | Key prefix, mode, base url, connection count                        |
| `yeetpost connections`              | Slug, platform, description, mode and profile per connection        |
| `yeetpost post "text" --to <slugs>` | Post now, at `--schedule`, into the `--queue`, or as a `--draft`     |
| `yeetpost posts`                    | Your posts, newest first                                            |
| `yeetpost post:get <id>`            | One post by id                                                      |
| `yeetpost post:cancel <id>`         | Cancel, delete a draft, or take one down                            |
| `yeetpost media:upload <file>`      | Upload an image, print the id                                       |
| `yeetpost webhooks`                 | Your webhook endpoints                                              |
| `yeetpost sources`                  | The links yeetpost watches to post what is new                      |
| `yeetpost sources:preview <url>`    | What yeetpost finds at a link, before anything is saved             |
| `yeetpost sources:create <url>`     | Watch a link: `--to <slugs> --mode queue\|draft`                    |
| `yeetpost sources:get <id>`         | One source with its status and item counts                          |
| `yeetpost sources:update <id>`      | Change connections, mode, instructions or card, or `--status paused` |
| `yeetpost sources:delete <id>`      | Stop watching a link                                                |
| `yeetpost sources:check <id>`       | Check now and print the new items                                   |
| `yeetpost sources:items <id>`       | A source's items and the posts they made                            |
| `yeetpost sources:push <id>`        | Push items from `--items <file\|->` to a push source                |
| `yeetpost sources:retry <id> <item>` | Try a failed item again                                            |

Commands that act on one record use a colon, so `post` (the verb) and
`post:get` (a record) never collide. `yeetpost media upload` and `yeetpost sources preview <url>` are accepted as the
spelling the docs use.

`--profile <id>` is on the three commands that can read one end customer:
`connections --profile`, `post --profile` and `posts --profile`. There is no
`yeetpost profiles`, and no profile CRUD: making, renaming and deleting one is a
platform-builder job, done from the server that holds the API key, so it stays
in the API and in the clients below. 

### Output is json, because agents read it

Every command prints one JSON object or array on stdout, so an agent or a pipe
gets a parseable answer without a `--format` flag:

```bash
yeetpost posts --status scheduled | jq -r '.posts[].id'
```

`--pretty` swaps that for a table when a person is reading, and `--quiet` prints
ids only, one per line:

```bash
yeetpost connections --pretty
# slug      platform  description          mode  profile
# --------  --------  -------------------  ----  -------
# linkedin  linkedin  Alex Doe (LinkedIn)  live
# x         x         @alexdoe (X)         live

yeetpost post "v2.4.0 is out" --to all --quiet | wc -l
```

The `profile` column is empty for your own accounts and carries the profile id
for an end customer's.

Exit codes: `0` on success, `1` on an API error with the error body on stderr as
JSON, `2` when the command line is wrong. `post` also exits `1` when every
connection failed. A partial failure is still `0`, so a script that cares reads
the per-item `status`.

### Posting

`--to` takes slugs, or `all`:

```bash
yeetpost post "shipped the new api docs today" --to linkedin,x
echo "piped in from a script" | yeetpost post --to all
```

`--to all` means every social connection: every connection whose `platformId` is
not `sms`, `email` or `slack`. Those three are messaging channels rather than
places you broadcast to, so they are left out: a copy-and-run command must never
text a real person. Name their slugs when you do mean them.

`--to all` also stops at the accounts the post can actually reach: your own when
there is no `--profile`, and that one customer's when there is. Sweeping a
customer's accounts into a post that names no profile would fail every one of
those items, so the CLI does not do it.

```bash
yeetpost post "our new roast is out" --to all --profile b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b
```

The rest of `POST /posts` is there as flags:

```bash
yeetpost post "the head post" \
  --to x,bluesky \
  --schedule 2026-09-15T15:00:00Z \
  --media "$(yeetpost media:upload ./shot.png --alt 'the new docs page' --quiet)" \
  --thread "second segment" \
  --thread "third segment" \
  --first-comment "and the link, in the comments" \
  --tag launch \
  --idempotency-key release-v2.4.0-announcement
```

`--thread` is repeatable and goes out as a reply chain under the head post, X,
Bluesky, Telegram and Mastodon only. `--first-comment` is the comment posted
under the post as its author, LinkedIn and Facebook only. Any other connection
refuses that item with `shape_unsupported`, which is a failed item rather than a
failed command.

`--queue` takes each connection's next free posting slot instead of a time, and
`--timezone` names the clock a `--schedule` with no offset is read on. What the
API would refuse is an exit `2` before the request goes out: `--queue` with
`--schedule`, either of them with `--draft`, `--timezone` with no `--schedule`
to read, and `--timezone` with a `--schedule` that already carries an offset:

```bash
yeetpost post "goes out at the next open slot" --to linkedin --queue
yeetpost post "nine in the morning" --to linkedin \
  --schedule 2026-09-15T09:00:00 --timezone Europe/Helsinki
```

A `sent` or `scheduled` item can carry a `warning`, which `--pretty` prints as
its own column: AI polish was asked for and failed, so the post went out under
its original text.

There is no `--rewrite` or `--textByPlatform` flag: AI polish follows the
connection's own mode (and the account's default when the connection has
none), and a per-platform text override is an SDK or API-only field for now.

One connection failing is a failed item, not a failed command, exactly as in the
API. Read the per-item `status`:

```bash
yeetpost post "v2.4.0 is out" --to all | jq '.results[] | select(.status == "failed")'
```

`yeetpost posts --connection <slug>` narrows the page the API answered, since
`GET /posts` has no connection filter of its own.

### Drafts, from the shell

`--draft` stores the post and publishes nothing, and `--tag` labels it. Both
take the same values the API does, and a tag the API would refuse is an exit `2`
before the request goes out:

```bash
draft=$(yeetpost post "half an idea" --to linkedin --draft --tag launch --quiet)
yeetpost posts --status draft --tag launch --pretty
yeetpost posts --created-after 2026-09-01T00:00:00Z --sort created_asc --offset 25
yeetpost post:cancel "$draft"   # throws the draft away
```

Publishing is the other thing the CLI leaves to the API.
`POST /posts/{postId}/publish` takes an empty body, so it is a one-line `curl`,
and the ten-command rule is worth more than an eleventh command that would save
that line:

```bash
curl -X POST "https://api.yeetpost.com/api/v2/posts/$draft/publish" \
  -H "x-api-key: $YEETPOST_API_KEY"
```

The client has it as `publishPost(postId, { scheduledFor, queue })` when you are
already in JavaScript.

`yeetpost --help` lists the ten, and `yeetpost <command> --help` gives one
example each.

## Yeet

```ts
import { Yeetpost } from "yeetpost";

const yeetpost = new Yeetpost({ apiKey: process.env.YEETPOST_API_KEY! });

await yeetpost.createPosts({
  text: "shipped the new api docs today",
  connectionSlugs: ["linkedin", "x"],
});
```

Not sure what you can post to?

```ts
const { connections } = await yeetpost.listConnections();
// [{ id: "3f2a1b4c-...", slug: "linkedin", platformId: "linkedin",
//    description: "Alex Doe (LinkedIn)", profileId: null,
//    timezone: "UTC", queueSlots: [] }, ...]
```

Branch on `platformId`, not on the wording of `description`: `sms`, `email` and
`slack` are messaging channels, the rest are places you broadcast to.

## Images

Upload the bytes, attach the id. The body is the raw file, not a multipart form,
and images are free within your storage allowance.

```ts
const media = await yeetpost.uploadMedia({
  bytes: await fs.promises.readFile("./shot.png"),
  contentType: "image/png",
  altText: "the new docs page",
});

await yeetpost.createPosts({
  text: "the new docs page is live",
  connectionSlugs: ["bluesky"],
  mediaIds: [media.mediaId],
});
```

The same bytes uploaded twice are one image: the second upload answers with the
id of the first and costs nothing against your allowance. Use `media` instead of
`mediaIds` to give one image its own alt text on this post, and never send both:

```ts
media: [{ id: media.mediaId, altText: "the docs page, on this post" }],
```

`getMedia(mediaId)` reads the bytes back with the content type they were
uploaded as, and `deleteMedia(mediaId)` frees the storage. Posts that used a
deleted image keep their text and lose the image, so delete one only once the
posts that need it have gone out.

Already have the image hosted somewhere else? Send `mediaUrls` instead and
skip the upload step; yeetpost fetches each url itself. Send only one of
`mediaIds`, `media` or `mediaUrls`:

```ts
await yeetpost.createPosts({
  text: "the new docs page is live",
  connectionSlugs: ["bluesky"],
  mediaUrls: ["https://example.com/shot.png"],
});
```

## Threads and first comments

`thread` is a reply chain posted under the head post, at most 24 entries, in
order. X, Bluesky, Telegram and Mastodon only. `firstComment` is a comment
posted under the post as its author, LinkedIn and Facebook only. Any other
connection refuses the item with `shape_unsupported`, which is a failed item
rather than a failed call.

```ts
const { results } = await yeetpost.createPosts({
  text: "the head post",
  connectionSlugs: ["x", "bluesky"],
  thread: ["second segment", "third segment"],
  firstComment: "and the link, in the comments",
});

// results[0].threadCount is how many replies actually went out
```

Images stay on the head post. `hasFirstComment` is false when none was asked
for, and false when the platform refused it, which does not fail the post.

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
its rewritten text. `rewrite: true` or `rewrite: false` on `createPosts` (and
`create_post` over MCP) wins over everything else for that post; leave it out
and the connection's own mode decides, falling back to the account's default.

```ts
const { results } = await yeetpost.createPosts({
  text: "changelog: fixed a bug where scheduled posts could double post",
  connectionSlugs: ["linkedin"],
  rewrite: true,
});
```

A post fetched back (`listPosts`, `getPost`) carries `originalText` (what you
sent) next to `text` (what actually went out) and `aiRewriteStatus`: `null`
(never touched), `"rewritten"`, `"failed"` (the model or the account's key
errored, `text` is the original after all) or `"skipped"` (a thread or other
multi-segment post; only a single post rewrites).

`textByPlatform` gives one platform its own text in place of the shared `text`,
for that request only, keyed by platform id and reaching every connection on
that platform in the call:

```ts
await yeetpost.createPosts({
  text: "Shipped the new dashboard today. Read the full write-up on the blog.",
  connectionSlugs: ["linkedin", "x"],
  textByPlatform: {
    x: "Shipped the new dashboard today 🚀",
  },
});
```

A platform left out of `textByPlatform` gets the shared `text`.

## Read the per-item status, not just the absence of an error

`createPosts` fans out over several connections, and one of them failing does not
fail the call. You get a result per connection:

```ts
const { results } = await yeetpost.createPosts({
  text: "shipped the new api docs today",
  connectionSlugs: ["linkedin", "x"],
});

for (const result of results) {
  if (result.status === "failed") {
    console.error(
      result.connectionSlug,
      result.error?.code,
      result.error?.message,
    );
  }
}
```

The whole call only throws (`400 invalid_connection`) when none of the slugs match
a connection of yours.

A `sent` or `scheduled` item can also carry a `warning`: AI polish was asked
for and failed, so the post went out under its original text. Surface it
rather than filing it.

## Scheduling

Give it a time and it schedules instead of sending. Must be in the future.

```ts
await yeetpost.createPosts({
  text: "scheduled from a real integration",
  connectionSlugs: ["linkedin"],
  scheduledFor: "2026-09-15T15:00:00Z",
});
```

A scheduled post sits in status `scheduled` until the worker picks it up. Cancel
it while it is still waiting:

```ts
const { posts } = await yeetpost.listPosts({ status: "scheduled", limit: 10 });
await yeetpost.deletePost(posts[0].id);

const { post } = await yeetpost.getPost(posts[0].id);
// post.status === "cancelled"
```

The same call on a post that already went out deletes it on its platform, head
post and thread replies both, and answers `{ id, status: "deleted", deletedAt }`.
LinkedIn, X, Bluesky, Discord, Telegram, Mastodon, Reddit, Facebook and Google
Business Profile have a delete; Slack, SMS, Email, Instagram and Threads answer
`400 delete_unsupported`.
Nothing is refunded: an X fee is charged when the post goes out and is kept when
it comes down.

One endpoint, three shapes, so `deletePost` answers a union: a cancelled or a
taken-down post carries a `status`, and a deleted draft carries `deleted: true`
and no status at all. Narrow it before you read either. `deleteDraft(postId)` is
the same call under the name you reach for when the post is a draft, and it
answers the same union, since the endpoint answers whatever the post really is.

A `scheduledFor` with an offset is already an instant. For a local time without
one, say which clock to read it on:

```ts
await yeetpost.createPosts({
  text: "nine in the morning, wherever the office is",
  connectionSlugs: ["linkedin"],
  scheduledFor: "2026-09-15T09:00:00",
  timezone: "Europe/Helsinki",
});
```

## Queues

Give a connection a list of posting slots and `queue: true` takes the next free
one instead of you naming a time. Slots are wall times on the connection's own
clock, `weekday` 0 is Sunday.

```ts
const { connections } = await yeetpost.listConnections();

await yeetpost.updateConnectionQueue(connections[0].id, {
  timezone: "Europe/Helsinki",
  slots: [
    { weekday: 1, time: "09:00" },
    { weekday: 4, time: "17:30" },
  ],
});

const { results } = await yeetpost.createPosts({
  text: "goes out at the next open slot",
  connectionSlugs: [connections[0].slug],
  queue: true,
});
// results[0].status === "scheduled", results[0].scheduledFor is the slot it took
```

Two queued posts never share a slot. A connection with no slots fails that one
item with `queue_empty`, and one whose slots are all taken inside the next 30
days fails it with `queue_full`.

```ts
const { queue } = await yeetpost.listConnectionQueue(connections[0].id);
// queue.paused is true while the queue is held
```

Pause a queue and nothing waiting in it goes out until you resume it. A post
scheduled by hand, rather than taking a slot, still goes out on time regardless.

```ts
await yeetpost.updateConnectionQueue(connections[0].id, { paused: true });
// later
await yeetpost.updateConnectionQueue(connections[0].id, { paused: false });
```

A queued post is a scheduled post: `deletePost` frees its slot for the next one.
Changing the slots does not move posts that are already queued.

## Drafts and tags

`isDraft: true` stores the post against every connection you name and publishes
nothing. It is validated the way a real send is, but reserves nothing: no usage,
no X fee, no queue slot, no webhook.

```ts
const { results } = await yeetpost.createPosts({
  text: "half an idea",
  connectionSlugs: ["linkedin"],
  isDraft: true,
  tags: ["launch"],
});
// results[0].status === "draft", results[0].postId is the draft

await yeetpost.updateDraft(results[0].postId!, {
  text: "a whole idea",
  tags: ["launch", "q3"],
});

await yeetpost.publishPost(results[0].postId!);
// or publishPost(postId, { scheduledFor }) or publishPost(postId, { queue: true })
```

The post keeps the id it had as a draft, and the mode it was created with. A
refusal you can still settle leaves the draft where it was, so you can fix the
problem and publish the same id again: `queue_empty`, `queue_full`,
`payment_method_required`, `spend_cap_reached`, `fair_use_reached`,
`connection_limit_exceeded` and `platform_unavailable`. Every other refusal is
what happened to the post, so the draft becomes a failed post. Publishing
twice is a `404 not_found`, and `deleteDraft(postId)` throws it away.

Every field of `updateDraft` is optional and only what you send is written, so a
field you leave out keeps what the draft had. `thread` and `firstComment`
describe one shape between them, so sending either replaces both. Taking
something off is sending it empty: `thread: []` clears the reply chain,
`mediaIds: []` takes every image off, `tags: []` drops the labels, and
`firstComment: null` removes the comment.

`updateDraft` also edits a pending scheduled post, not only a draft: text,
images and tags the same way, plus `scheduledFor` (with an optional
`timezone`) or `queue: true` to move its time, the same two ways
`publishPost` reads them. A draft refuses all three with
`400 invalid_request`, since it has nowhere to be sent at yet; publish it
first. A text edit on a scheduled post is stored as final, your own words
from here on, so any AI polish it already carried is cleared rather than run
again. Naming a new time fires `post.rescheduled` with reason `edited`, but
only once the time actually changes; `queue: true` on a post already queued
is a no-op. The worker may have already claimed the post, which is a
`409 post_not_editable`.

```ts
await yeetpost.updateDraft(scheduledPostId, {
  text: "a better idea",
  scheduledFor: "2026-09-20T15:00:00Z",
});
```

`tags` are your own labels, at most 10, each 1 to 40 characters of lowercase
letters, digits, dashes, underscores, colons, dots and slashes (`cms:launch`
works; input is lowercased before it is stored). They come back on every post
and on every webhook,
and `listPosts({ tag })` narrows by all of them at once:

```ts
// posts tagged both launch and q3, not either
const { posts } = await yeetpost.listPosts({ tag: ["launch", "q3"] });
```

## Sources

Paste a link and yeetpost posts what is new on it. A source watches a page that
lists things (courses, a blog, a changelog), an RSS, Atom or JSON feed, or a
sitemap, checks it every hour, and turns each new item into a post per
connection, written in that connection's voice with a card in its look. Sources
post for real, so every call needs a live key (a test key gets `403 forbidden`).

```ts
// What would it find? Nothing is saved.
const preview = await yeetpost.previewSource({
  url: "https://herizon.io/courses",
});
// preview.kind is "feed", "json", "sitemap" or "page"; preview.items the newest 5

const { source } = await yeetpost.createSource({
  url: "https://herizon.io/courses",
  connectionSlugs: ["herizon_linkedin"],
  mode: "queue", // or "draft" to review every post first
  instructions: "one post per course, say it is free for members",
  backfillCount: 0, // post none of what is already there
});

await yeetpost.checkSource(source.id); // now, instead of in the next hour
const { items } = await yeetpost.listSourceItems(source.id, { status: "failed" });
await yeetpost.retrySourceItem(source.id, items[0].id);
await yeetpost.updateSource(source.id, { status: "paused" });
await yeetpost.deleteSource(source.id); // the posts it made are not touched
```

An app that knows what is new the moment it happens makes a push source with
`createSource({ kind: "push", ... })` and sends items to it:

```ts
await yeetpost.addSourceItems(source.id, {
  items: [{ id: "course-4", title: "Pricing your work", url: "https://herizon.io/courses/pricing-your-work" }],
});
// { added: 1, duplicates: 0 }: an id sent twice is never posted twice
```

## Idempotency

Network calls fail halfway. Pass a key and a retry cannot double-post: same key
and same body replays the stored response verbatim, without posting again.

```ts
await yeetpost.createPosts({
  text: "v2.4.0 is out",
  connectionSlugs: ["linkedin"],
  idempotencyKey: "release-v2.4.0-announcement",
});
```

Same key with a different body is a `409 idempotency_key_conflict`. Keys expire
after 24 hours.

## Build a platform

Everything above assumes the accounts you post to are your own. If you are
building a product on yeetpost and posting on behalf of your own customers,
profiles are how you keep them apart. Five steps:

**1. One profile per end customer.**

```ts
const { profile } = await yeetpost.createProfile({
  name: "Acme Coffee",
  externalId: "cus_4821",
});
```

`externalId` is your own id for the same customer, so their row in your database
and their profile here agree without a second lookup table. It is optional and
unique across your live profiles: a second profile with the same one is refused
with `409 profile_external_id_conflict`. An account can have 1000 profiles at
once, and over that `createProfile` is a `403 limit_exceeded`.

**2. Send them a connect URL.** `createConnectUrl` answers with a page yeetpost
hosts. Send your customer there and they connect one of their own accounts into
that profile.

```ts
const { url, connectSessionId } = await yeetpost.createConnectUrl(profile.id, {
  platform: "linkedin",
  redirectUrl: "https://acme.example.com/settings/social",
});
// url is where you send them, connectSessionId is what the redirect and the
// webhook come back with
```

Leave `platform` out and the page shows a picker instead. Leave `redirectUrl`
out and the customer finishes on a yeetpost page that says they are connected
and can close the tab; that link lasts 7 days. Pass `connectionId` to reconnect
an existing connection: the connection keeps its id and slug if the customer
signs in to the same account; a different account becomes a new connection. The token in the url
is the whole authorization: it stands for your account, that one profile and
that one redirect, it works once, and it lasts fifteen minutes. Only its hash is
stored, so the url above is the only time it exists, and the page never shows
your API key, your email or anything about your other customers. `headless: true`
takes the yeetpost header and footer off the page so it can sit inside a popup
with your own branding around it: a popup rather than an iframe, because the
platforms' own consent screens refuse to be framed.

`redirectUrl` must be an https URL on a public host with no fragment; plain
http is accepted for `localhost` and `127.0.0.1`. It is bound to the session
here and used exactly as stored, so nothing your customer's browser sends can
change where they land.

The customer lands on your `redirectUrl` either way, and `parseConnectRedirect`
reads what the page put on the query:

```ts
import { parseConnectRedirect } from "yeetpost";

const redirect = parseConnectRedirect(new URL(request.url).searchParams);

if (redirect.error) {
  // "cancelled" when they backed out, "connect_failed" when the platform
  // refused. Both mean the same thing to you: show the button again.
}

// redirect.connectionId, redirect.profileId, redirect.slug and
// redirect.platform are there when an account came in.
```

That is a browser coming back, so it is a hint rather than proof. The two
authorities are `getConnectSession(connectSessionId)`, which says the same thing
from the API, and the `connection.created` webhook, whose
`connection.connectSessionId` files the account against the customer you made
the link for without waiting for a browser at all.

```ts
const { connectSession } = await yeetpost.getConnectSession(connectSessionId);
// connectSession.status is "pending", "connected", "failed" or "expired"
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

```ts
await yeetpost.createPosts({
  text: "our new roast is out",
  connectionSlugs: ["acme_linkedin"],
  profileId: profile.id,
});
```

A slug that belongs to another profile, or to you, fails that one item with
`invalid_connection` while the rest of the request goes out. `profileId` is part
of the idempotency hash, so the same text to the same slug is a different
request inside a profile from outside one.

**4. Read one customer back.**

```ts
const { connections } = await yeetpost.listConnections({
  profileId: profile.id,
});
const { posts } = await yeetpost.listPosts({ profileId: profile.id });
```

Every connection and every post carries a `profileId` of its own, `null` when it
is one of your own accounts. `listProfiles({ limit, offset })` pages your
profiles newest first, `getProfile(profileId)` reads one, and
`updateProfile(profileId, { name, externalId })` renames one or moves its
external id. Sending `externalId: null` takes the external id off, which is
different from leaving the field out, and that leaves it alone.

**5. Move an account that is already connected.**

```ts
await yeetpost.updateConnection(connection.id, { profileId: profile.id });

// and back out to your own
await yeetpost.updateConnection(connection.id, { profileId: null });
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

```ts
const { removedConnections } = await yeetpost.deleteProfile(profile.id);
```

That disconnects every account in the profile: the credentials are deleted, the
posts that already went out stay readable, anything still waiting to be sent is
cancelled, the drafts written in it are deleted, and your bill drops to the
connections you have left. The profile itself is kept out of sight rather than
erased, so `listPosts({ profileId })` still lists the history of a customer you
have offboarded.

A profile is a routing rail, not an authorization boundary. It decides which
connections a call reaches, and that is all it decides: an account key still
reaches any object of the account by id, so `getPost(postId)` answers for one
customer's post whatever profile the caller had in mind. Keep the key on your
server and give each customer nothing but the `profileId` they belong to. When
something other than your own server holds a key, scope the key instead: see
"Scoped keys" below.

A `profileId` that is not one of yours is a `400 invalid_request` everywhere it
is taken, rather than an empty list. `postToConnection` has nowhere to name a
profile, so it reaches your own accounts and nothing else. Profiles are not
scoped by key type either: a test key manages the same profiles a live key does,
and a sandbox connection can sit in a profile, which is how you test a
customer's flow without publishing anything.

### Scoped keys

`profileId` on a call is a promise your own code makes. A key scoped to a
profile is a promise the API keeps: it can only ever reach that one end
customer, whatever the call says.

Scope is a property of the key, not of the call, and there is nothing to set
here: pick the customer under "Scope" when you create the key in the console.
The key still reads `yp_secret_` or `yp_test_`, so nothing that already stores
one has to change shape.

| Call                                                                   | Key scoped to profile P                                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `listConnections()`, `listPosts()`                                     | P's objects only; a `profileId` other than P is `400`                       |
| `getConnection`, `getPost`, `updateDraft`, `publishPost`, `deletePost` | `404` outside P                                                             |
| `createPosts({ ... })`                                                 | `profileId` defaults to P; a different one is `400`; slugs resolve inside P |
| `postToConnection(slug, text)`                                         | P's accounts, where an unscoped key reaches your own                        |
| `uploadMedia(...)`, `getMedia`, `deleteMedia`                          | the image belongs to P; another profile's is `invalid_media` on a post      |
| `createWebhook(...)` and the rest of the webhook calls                 | P's webhooks, hearing P's events only; `404` for the rest                   |
| `getProfile(profileId)`, `createConnectUrl(profileId, ...)`            | P only; any other id is `403 forbidden`                                     |
| `createProfile`, `listProfiles`, `updateProfile`, `deleteProfile`      | `403 forbidden`                                                             |
| `createProfileKey` and the rest of the key calls                       | `403 forbidden`                                                             |
| `getConnectSession(connectSessionId)`                                  | P's sessions only; `404` for the rest                                       |

The `404`s are deliberate: an object outside the key's profile does not exist as
far as the key is concerned, so an id cannot be probed for whether it is there.
The `403`s are deliberate too: managing profiles is a real capability the key
does not have, and saying so saves you debugging a profile that is not missing.

`profileId` can be left out everywhere it is optional. `createPosts` fills in
the key's own profile, and `listConnections()` and `listPosts()` are filtered
already, so the same code reads right whether it names the profile or not.

An idempotency key is reserved inside the key's scope, so two of your customers
sending `order-123` on the same day get their own posts and their own replays.

A connect URL from a scoped key is bound twice over. It is bound to P, because
`createConnectUrl` takes no other profile, and to the key's redirect allowlist,
which is a list of origins set on the key in the console: with one set, a
`redirectUrl` whose scheme, host and port are not on it is a
`400 invalid_request` naming the allowed origins. Leave it empty and any https
URL on a public host is accepted, which is the rule for every key that has none.

Deleting a profile revokes the keys scoped to it, in the same transaction that
disconnects the accounts, so a key you handed to a customer's integration stops
working when they leave rather than quietly widening to the whole account.

### Minting a key from code

Onboarding a customer is code, so minting their key is too. `createProfileKey`
mints a key scoped to that profile, and the `secret` in the answer is the raw
key, shown exactly once: no API endpoint reads the secret back, though the
account owner can reveal any key in the console. Store it where the customer's
integration will read it, or show it to them once and mint another if it goes
missing.

```ts
const { key, secret } = await yeetpost.createProfileKey(profile.id, {
  name: "Acme integration",
  type: "live",
  redirectAllowlist: ["https://acme.example.com"],
});

const { keys } = await yeetpost.listProfileKeys(profile.id, {
  includeRevoked: true,
  limit: 100,
});

await yeetpost.revokeProfileKey(profile.id, key.id);
```

Only an unscoped key of yours may call these five, and a key scoped to a profile
is a `403 forbidden` on all of them. A test key mints test keys only, so asking
it for a live one is a `403 forbidden` too, and a profile holds at most 50 live
and 50 test keys, over which minting is a `403 limit_exceeded`; a revoked key
does not count. `redirectAllowlist` is bare origins such as
`https://acme.example.com`, no path, query or fragment, at most 20, normalized
and deduped, and an empty list means no allowlist at all. `listKeys()` and
`revokeKey(keyId)` do the same across the whole account, the unscoped keys and
every profile's, and a revocation takes effect on the next request everywhere at
once, including for the key that asked for it: only a connect URL the key
already issued outlives it, for the rest of its fifteen minutes.

A test key manages test keys and nothing else on all five: both listings show it
the test keys, and a live key of yours is a `404 not_found` to it, the same
answer a key that is not yours gets. Both listings page like `listProfiles()`,
with `limit` 1 to 100 defaulting to 25 and `offset` defaulting to 0, and the
answer carries both back.

## Errors

Every non-2xx throws a `YeetpostApiError` carrying the status, the code and the
message. Nothing is swallowed.

```ts
import { Yeetpost, YeetpostApiError } from "yeetpost";

try {
  await yeetpost.postToConnection("linkedn", "hello");
} catch (error) {
  if (error instanceof YeetpostApiError) {
    console.error(error.status, error.code, error.message, error.requestId);
    // 400 invalid_connection Connection 'linkedn' not found. ... null
  }
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
show up in a stored post's own `error` (`GET /posts`, a webhook).
`platform_unavailable` means the platform answered 429 or 5xx so nothing was
sent, safe to send again. `platform_timeout` is no longer returned: when Discord is slow to answer the message POST the post counts as sent, without a message id. It stays in the vocabulary for older stored posts.

`requestId` is the `x-request-id` header, and the `req_id` the body carries on
`platform_rejected`, `internal_server_error`, `platform_unavailable` and
`platform_timeout` when the header was not sent. Quote it if you report the
problem.

Rate limiting is the one odd one out. The API's `429` body is
`{ "error": "too many requests" }`, with no code from the vocabulary and no
message, so `code` is that literal string. Branch on the status, and the
`x-ratelimit-*` headers are on the error:

```ts
if (error instanceof YeetpostApiError && error.status === 429) {
  // 60 requests per minute per API key, per endpoint group.
  // error.rateLimitReset is the unix second the window has room again.
}
```

`rateLimitLimit`, `rateLimitRemaining` and `rateLimitReset` are `-1` when the
response did not carry the header, which is the case on `401` and on `500`.

## Webhooks

Register an https endpoint and yeetpost POSTs `post.sent`, `post.failed`,
`post.deleted`, `post.metrics`, `post.rescheduled`, `connection.created`,
`connection.removed` and `connection.reconnect_required` events to it as posts
go out and come down, get moved to a new time, and accounts are connected,
disconnected or start needing a reconnect, including scheduled posts, which is
the whole point, since nobody is waiting on an HTTP response by then.

```ts
const { webhook } = await yeetpost.createWebhook({
  url: "https://example.com/hooks/yeetpost",
});
// webhook.secret is shown exactly once. Store it now.
```

Verify every delivery against the **raw** body, before any JSON parsing,
since re-serialising it changes the bytes that were signed:

```ts
import express from "express";
import { verifyWebhookSignature, WebhookEvent } from "yeetpost";

app.post(
  "/hooks/yeetpost",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const isValid = verifyWebhookSignature({
      body: req.body,
      signatureHeader: String(req.headers["x-yeetpost-signature"]),
      secret: process.env.YEETPOST_WEBHOOK_SECRET!,
    });

    if (!isValid) {
      res.status(400).send("bad signature");
      return;
    }

    const event: WebhookEvent = JSON.parse(req.body.toString("utf8"));

    if (event.event === "connection.created") {
      console.log(event.connection.profileId, event.connection.id);
    }

    if (event.event === "post.sent" || event.event === "post.failed") {
      console.log(event.event, event.post.id);
    }

    res.sendStatus(200);
  },
);
```

It checks the HMAC in constant time and rejects anything more than
`toleranceSeconds` (default 300) away from your clock, so a captured delivery
cannot be replayed at you later.

`WebhookEvent` is a union discriminated on `event`, so narrow on it, or on the
`x-yeetpost-event` header, before you read `post` or `connection`. The members
include `PostWebhookEvent` (`post.sent`, `post.failed`),
`PostDeletedWebhookEvent`, `PostRescheduledWebhookEvent` and
`ConnectionWebhookEvent`.

A `post.deleted` delivery is a shape of its own: a deleted post is no longer a
post, so the body says which one is gone and where it stood rather than
repeating its text one last time. Cancelling a scheduled post fires nothing: it
was never published.

`post.rescheduled` fires whenever a pending post's own time changes:
`reason` is `"missed_slot"` for a queued post moved to its next free slot,
`"fair_use"` for a fair-use deferral, `"requeued"` for a failed post moved back
into the queue by hand, `"catch_up"` for a hand-scheduled post spaced out
behind a backlog draining on its connection, and `"edited"` for you moving it
yourself with `updateDraft`.

`connection.created`, `connection.removed` and `connection.reconnect_required`
fire when an account is connected, disconnected, or starts needing a
reconnect, whether it went into one of your profiles or into your own account.
The two ids in the body are the mapping to persist: the profile is your
customer, the connection is what you post to. `connection.connectSessionId` is
the connect link the account came in through, `null` when the connection was
made in the console, so a receiver can file the account against the customer you
made the link for without waiting for a browser to come back. Reconnecting an
account that is already there replaces its credentials rather than making a new
connection, so it fires nothing, and deleting a profile fires one
`connection.removed` per account inside it.

## Dedupe on the event id

Every delivery carries an `x-yeetpost-event-id` header and an `eventId` at the
top of its body. It is the same value on every retry and every replay, so a
receiver that has already handled it can say so and stop:

```js
if (await seen(event.eventId)) return res.sendStatus(200);
await handle(event);
await remember(event.eventId);
```

## Retries, dead letters and replays

A delivery is attempted up to 7 times, waiting 1m, 5m, 30m, 2h, 6h and 12h
between attempts. After the last one it becomes a dead letter (`status: "dead"`)
and is never retried on its own.

When a receiver is not getting events, read the log instead of guessing:

```ts
const { deliveries, hasMore } = await yeetpost.listWebhookDeliveries(
  webhook.id,
  { status: "dead", limit: 10 },
);
```

`hasMore` says whether there is another page. New deliveries land at the top of
the log while you page it, so the next page starts after the last id you saw
rather than at an offset:

```ts
const nextPage = await yeetpost.listWebhookDeliveries(webhook.id, {
  status: "dead",
  limit: 10,
  startingAfter: deliveries[deliveries.length - 1].id,
});
```

Fix the receiver, then throw the delivery at it again. The replay keeps the same
event id and the same body, so a receiver deduping on `eventId` sees the
delivery it missed, not a new one:

```ts
await yeetpost.replayDelivery(webhook.id, deliveries[0].id);
```

Replay works on `failed`, `dead` and `delivered`. A delivery already queued for
another attempt is a `400 invalid_request`.

Building the receiver in the first place? Send it a test event and nothing gets
posted anywhere. The body is a normal, signed `post.sent` event with
`"test": true` on it:

```ts
const { delivery } = await yeetpost.sendTestEvent(webhook.id);
```

## Health

`getHealth()` is whether the database answers and whether each background loop
has finished one recently. The endpoint needs no API key, and the status code is
`200` whether the API is ok or degraded, so read `status` rather than catching
an error.

```ts
const health = await yeetpost.getHealth();
// health.status === "degraded" when any check is not ok
// health.checks.scheduledPosts.lastOkAt is when that loop last finished
```

`getHealthHistory({ days })` is the same health aggregated per UTC day, oldest
first. `uptimePercent` is `null` for a day that was over before sampling began:
nobody was watching it, so it is unmeasured rather than down.

```ts
const { days } = await yeetpost.getHealthHistory({ days: 30 });
```

The answers are cached for 10 and 60 seconds, and both endpoints share one limit
of 60 requests a minute per IP.

`getStats()` is the public counts the marketing site draws: posts that reached a
platform this week and ever, the connections that can be posted to right now,
and the platform ids a post can go out to today. Nothing in it is about one
account, so it needs no key either, and its answer is cached for 60 seconds.

```ts
const { postsThisWeek, platformsLive } = await yeetpost.getStats();
```

## The whole surface

| Method                                                     | Endpoint                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `listConnections({ profileId })`                           | `GET /connections`                                          |
| `getConnection(connectionId)`                              | `GET /connections/{connectionId}`                           |
| `updateConnection(connectionId, { profileId })`            | `PATCH /connections/{connectionId}`                         |
| `deleteConnection(connectionId)`                           | `DELETE /connections/{connectionId}`                        |
| `listConnectionQueue(connectionId)`                        | `GET /connections/{connectionId}/queue`                     |
| `updateConnectionQueue(connectionId, { slots, timezone, paused })` | `PATCH /connections/{connectionId}/queue`             |
| `createProfile({ name, externalId })`                      | `POST /profiles`                                            |
| `listProfiles({ limit, offset })`                          | `GET /profiles`                                             |
| `getProfile(profileId)`                                    | `GET /profiles/{profileId}`                                 |
| `updateProfile(profileId, { name, externalId })`           | `PATCH /profiles/{profileId}`                               |
| `deleteProfile(profileId)`                                 | `DELETE /profiles/{profileId}`                              |
| `createProfileKey(profileId, { name, type })`              | `POST /profiles/{profileId}/keys`                           |
| `listProfileKeys(profileId, { includeRevoked, ... })`      | `GET /profiles/{profileId}/keys`                            |
| `revokeProfileKey(profileId, keyId)`                       | `DELETE /profiles/{profileId}/keys/{keyId}`                 |
| `listKeys({ includeRevoked, ... })`                        | `GET /keys`                                                 |
| `revokeKey(keyId)`                                         | `DELETE /keys/{keyId}`                                      |
| `createConnectUrl(profileId, { platform, redirectUrl, connectionId })` | `POST /profiles/{profileId}/connect`                        |
| `getConnectSession(connectSessionId)`                      | `GET /connect-sessions/{connectSessionId}`                  |
| `postToConnection(slug, text, { scheduledFor })`           | `POST /post/{connectionSlug}`                               |
| `createPosts({ text, connectionSlugs, ... })`              | `POST /posts`                                               |
| `listPosts({ status, tag, profileId, scheduledAfter, scheduledBefore, connectionSlug, platform, sendGroupId, createdAfter, createdBefore, sort, limit, offset })` | `GET /posts`                     |
| `getPost(postId)`                                          | `GET /posts/{postId}`                                       |
| `updateDraft(postId, { text, ... })`                       | `PATCH /posts/{postId}`                                     |
| `publishPost(postId, { scheduledFor, queue })`             | `POST /posts/{postId}/publish`                              |
| `deletePost(postId)`                                       | `DELETE /posts/{postId}`                                    |
| `cancelPost(postId)`                                       | `DELETE /posts/{postId}`                                    |
| `deleteDraft(postId)`                                      | `DELETE /posts/{postId}`                                    |
| `retryPost(postId)`                                        | `POST /posts/{postId}/retry`                                |
| `drawCard(postId, { instructions, attach })`               | `POST /posts/{postId}/card`                                 |
| `getPostMetrics(postId)`                                   | `GET /posts/{postId}/metrics`                               |
| `getAnalytics({ from, to, profileId, platform })`          | `GET /analytics`                                            |
| `uploadMedia({ bytes, contentType, altText })`             | `POST /media`                                               |
| `getMedia(mediaId)`                                        | `GET /media/{mediaId}`                                      |
| n/a (fetch the signed url directly)                        | `GET /media/{mediaId}/raw`                                  |
| `deleteMedia(mediaId)`                                     | `DELETE /media/{mediaId}`                                   |
| `createWebhook({ url, events })`                           | `POST /webhooks`                                            |
| `listWebhooks()`                                           | `GET /webhooks`                                             |
| `deleteWebhook(webhookId)`                                 | `DELETE /webhooks/{webhookId}`                              |
| `listWebhookDeliveries(webhookId, { status, limit, ... })` | `GET /webhooks/{webhookId}/deliveries`                      |
| `replayDelivery(webhookId, deliveryId)`                    | `POST /webhooks/{webhookId}/deliveries/{deliveryId}/replay` |
| `sendTestEvent(webhookId)`                                 | `POST /webhooks/{webhookId}/test`                           |
| `getHealth()`                                              | `GET /health`                                               |
| `getHealthHistory({ days })`                               | `GET /health/history`                                       |
| `getStats()`                                               | `GET /stats`                                                |
| `getMe()`                                                  | `GET /me`                                                   |
| `getActivity({ limit, cursor })`                           | `GET /activity`                                             |
| `previewSource({ url })`                                   | `POST /sources/preview`                                     |
| `createSource({ url, connectionSlugs, mode, ... })`        | `POST /sources`                                             |
| `listSources({ limit, offset })`                           | `GET /sources`                                              |
| `getSource(sourceId)`                                      | `GET /sources/{sourceId}`                                   |
| `updateSource(sourceId, { mode, status, ... })`            | `PATCH /sources/{sourceId}`                                 |
| `deleteSource(sourceId)`                                   | `DELETE /sources/{sourceId}`                                |
| `checkSource(sourceId)`                                    | `POST /sources/{sourceId}/check`                            |
| `listSourceItems(sourceId, { status, limit, offset })`     | `GET /sources/{sourceId}/items`                             |
| `addSourceItems(sourceId, { items })`                      | `POST /sources/{sourceId}/items`                            |
| `retrySourceItem(sourceId, itemId)`                        | `POST /sources/{sourceId}/items/{itemId}/retry`             |
| `getOpenapiSpec()`                                         | `GET /openapi.json`                                         |
| `parseConnectRedirect(query)`                              | n/a                                                         |
| `verifyWebhookSignature({ body, ... })`                    | n/a                                                         |

`postToConnection` is the original one-liner endpoint: `text/plain` in, one
connection, no idempotency key, no post id. Prefer `createPosts` for anything
that is not a shell script.

`getHealth`, `getHealthHistory`, `getStats` and `getOpenapiSpec` need no API
key, so `new Yeetpost({ apiKey: "" })` can still call those four. Every other
call with an empty key throws `apiKey is required for this call` before the
request goes out.

Not covered: the MCP endpoint (`POST /mcp`), which you point an MCP client at
directly, and `GET /media/{mediaId}/raw`, the signed link Instagram and Threads
fetch an image through. You never build one and never receive one, so there is
nothing for a client to call.

Pass `baseUrl` to point at something other than production:

```ts
const yeetpost = new Yeetpost({
  apiKey,
  baseUrl: "http://localhost:3901/api/v2",
});
```

## Tests

`node:test` and `node:assert` from the standard library, against a stub http
server on a random port. No network, no test-runner dependency.

```bash
yarn test
yarn typecheck
```
