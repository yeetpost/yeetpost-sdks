import crypto from "crypto";

// The yeetpost API client. Everything here is hand-written against
// yeetpost-api/src/lib/openapi.json. The response interfaces are copies of the
// schemas in that spec, so they stay portable and self-contained.

export const DEFAULT_BASE_URL = "https://api.yeetpost.com/api/v2";

//
// Errors
//

// The API answers every failure with { error, message }, plus req_id on
// platform_rejected and internal_server_error. The one exception is 429, whose
// body is { error: "too many requests" } and carries no message and no code
// from the vocabulary, so on a 429 the code is that literal string and the
// thing to branch on is status.
export class YeetpostApiError extends Error {
  readonly status: number;
  readonly code: string;
  // The x-request-id header, or the req_id the body carries on
  // platform_rejected and internal_server_error when the header was missing.
  // Null when the response carried neither. Quote it when you report a problem.
  readonly requestId: string | null;
  // The x-ratelimit-* headers: the requests allowed in the current window, the
  // requests left in it, and the unix second it has room again. Each is -1 when
  // the response did not carry the header, which is the case on 401 and on 500.
  readonly rateLimitLimit: number;
  readonly rateLimitRemaining: number;
  readonly rateLimitReset: number;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null,
    rateLimit: { limit: number; remaining: number; reset: number } = {
      limit: -1,
      remaining: -1,
      reset: -1,
    },
  ) {
    super(message);
    this.name = "YeetpostApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.rateLimitLimit = rateLimit.limit;
    this.rateLimitRemaining = rateLimit.remaining;
    this.rateLimitReset = rateLimit.reset;
  }
}

//
// Responses
//

// A posting slot on the connection's own clock. weekday 0 is Sunday, and time
// is 24 hour "HH:MM".
export interface QueueSlot {
  weekday: number;
  time: string;
}

export interface ConnectionsResponse {
  connections: {
    id: string;
    slug: string;
    // Which platform is behind the slug, such as "linkedin" or "x". A string
    // rather than a closed set, because the set grows as platforms land.
    platformId: string;
    description: string;
    // The profile the connection belongs to, null when it is one of your own
    // accounts rather than an end customer's.
    profileId: string | null;
    timezone: string;
    queueSlots: {
      weekday: number;
      time: string;
    }[];
    // "reconnect_required" once the stored login has actually failed,
    // "expiring" while it still works but will stop soon, "active" otherwise
    status: "active" | "reconnect_required" | "expiring";
    // Set only while status is "expiring": when the login runs out. Null the
    // rest of the time, including once it already needs a reconnect.
    loginExpiresAt: string | null;
  }[];
}

export interface GetConnectionResponse {
  connection: {
    id: string;
    slug: string;
    // Which platform is behind the slug, such as "linkedin" or "x". A string
    // rather than a closed set, because the set grows as platforms land.
    platformId: string;
    description: string;
    // The profile the connection belongs to, null when it is one of your own
    // accounts rather than an end customer's.
    profileId: string | null;
    timezone: string;
    queueSlots: {
      weekday: number;
      time: string;
    }[];
    // "reconnect_required" once the stored login has actually failed,
    // "expiring" while it still works but will stop soon, "active" otherwise
    status: "active" | "reconnect_required" | "expiring";
    // Set only while status is "expiring": when the login runs out. Null the
    // rest of the time, including once it already needs a reconnect.
    loginExpiresAt: string | null;
  };
}

export interface UpdateConnectionResponse {
  connection: {
    id: string;
    slug: string;
    // Which platform is behind the slug, such as "linkedin" or "x". A string
    // rather than a closed set, because the set grows as platforms land.
    platformId: string;
    description: string;
    // The profile the connection belongs to, null when it is one of your own
    // accounts rather than an end customer's.
    profileId: string | null;
    timezone: string;
    queueSlots: {
      weekday: number;
      time: string;
    }[];
  };
}

export interface DeleteConnectionResponse {
  id: string;
  deleted: true;
}

export interface GetConnectionQueueResponse {
  queue: {
    id: string;
    text: string;
    scheduledFor: string;
    mediaCount: number;
  }[];
  // True while the queue is paused: nothing waiting here goes out until it
  // is resumed. A post scheduled by hand, rather than taking one of these
  // slots, still goes out on time regardless.
  paused: boolean;
}

export interface UpdateConnectionQueueResponse {
  connection: {
    id: string;
    slug: string;
    timezone: string;
    queueSlots: {
      weekday: number;
      time: string;
    }[];
    paused: boolean;
  };
}

export interface CreateProfileResponse {
  profile: {
    id: string;
    // What you call this end customer. Shown in the console, never sent to a
    // platform.
    name: string;
    // Your own id for the same end customer, unique across your account. Null
    // when you did not give one.
    externalId: string | null;
    createdAt: string;
  };
}

export interface GetProfilesResponse {
  profiles: {
    id: string;
    name: string;
    externalId: string | null;
    createdAt: string;
  }[];
  limit: number;
  offset: number;
}

export interface GetProfileResponse {
  profile: {
    id: string;
    name: string;
    externalId: string | null;
    createdAt: string;
  };
}

export interface UpdateProfileResponse {
  profile: {
    id: string;
    name: string;
    externalId: string | null;
    createdAt: string;
  };
}

export interface DeleteProfileResponse {
  id: string;
  deleted: true;
  // How many connections went with the profile
  removedConnections: number;
}

export interface CreateApiKeyResponse {
  key: {
    id: string;
    // What you call this key. Shown in the console, never sent to a platform.
    name: string;
    // A live key posts for real, a test key reaches the sandbox only.
    type: "live" | "test";
    // The readable head of the key, which is what the console lists it by.
    prefix: string;
    // The profile the key is scoped to, null on an account key.
    profileId: string | null;
    // The origins a connect redirect from this key may land on, null when the
    // key has none and any https url on a public host is accepted.
    redirectAllowlist: string[] | null;
    createdAt: string;
    // When the key last made a request, null while it never has.
    lastUsedAt: string | null;
    // When the key was revoked, null while it still works.
    revokedAt: string | null;
  };
  // The raw key. It is answered here and nowhere else: no API endpoint reads
  // the secret back, though the account owner can reveal any key in the
  // console. Store it now.
  secret: string;
}

export interface GetApiKeysResponse {
  keys: {
    id: string;
    name: string;
    type: "live" | "test";
    prefix: string;
    profileId: string | null;
    redirectAllowlist: string[] | null;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }[];
  limit: number;
  offset: number;
}

export interface RevokeApiKeyResponse {
  id: string;
  revoked: true;
}

// The platforms a connect link can be opened for. A test key may only name
// "sandbox", which is how the whole flow runs in CI. Reddit, Facebook,
// Instagram and Threads are listed only once the API has an app for them: a
// platform it cannot connect is a 400 invalid_request.
export type ConnectPlatform =
  | "linkedin"
  | "x"
  | "bluesky"
  | "mastodon"
  | "discord"
  | "telegram"
  | "sandbox"
  | "reddit"
  | "facebook"
  | "instagram"
  | "threads"
  | "google_business";

export interface CreateConnectSessionResponse {
  // The page to send your end customer to. It carries a single use token, and
  // this is the only time it is shown: only its hash is stored, so it cannot
  // be read back.
  url: string;
  // When the link stops working. Fifteen minutes out.
  expiresAt: string;
  // Comes back on the redirect and on the connection.created event, and is
  // what getConnectSession answers for.
  connectSessionId: string;
}

export interface GetConnectSessionResponse {
  connectSession: {
    id: string;
    profileId: string;
    // The platform the link was opened for, null when the end customer picks
    // one on the page.
    platform: ConnectPlatform | null;
    // "pending" while the customer still has the link open, "connected" once
    // an account came in, "failed" when they cancelled or the platform
    // refused, "expired" when the fifteen minutes ran out with nothing
    // happening.
    status: "pending" | "connected" | "failed" | "expired";
    // The connection that was made, null until one is.
    connectionId: string | null;
    // Why the customer came back without a connection: "cancelled" when they
    // backed out, "connect_failed" when the platform refused. Null otherwise.
    error: "cancelled" | "connect_failed" | null;
    redirectUrl: string;
    headless: boolean;
    expiresAt: string;
    createdAt: string;
  };
}

// POST /post/{connectionSlug} answers with one of three shapes, depending on
// the platform and on whether the post was scheduled.
export type LegacyPostResponse =
  | {
      platform:
        | "linkedin"
        | "x"
        | "bluesky"
        | "discord"
        | "telegram"
        | "mastodon"
        | "reddit"
        | "facebook"
        | "instagram"
        | "threads"
        | "google_business";
      link: string;
    }
  | { platform: "sms" | "email" | "slack"; sent: true }
  | { scheduled: true; scheduled_for: string };

export interface CreatePostsResponse {
  results: {
    connectionSlug: string;
    status: "sent" | "scheduled" | "draft" | "failed";
    postId: string | null;
    url: string | null;
    scheduledFor: string | null;
    threadCount: number;
    hasFirstComment: boolean;
    // Present only when AI polish was asked for and failed: the post went out
    // under its original text. Absent on every other result.
    warning?: string;
    error: {
      code: string;
      message: string;
    } | null;
  }[];
}

// One draft turned into a real send. The item is the one createPosts answers
// with for that connection, so both surfaces read the same.
export interface PublishPostResponse {
  result: {
    connectionSlug: string;
    status: "sent" | "scheduled" | "draft" | "failed";
    postId: string | null;
    url: string | null;
    scheduledFor: string | null;
    threadCount: number;
    hasFirstComment: boolean;
    // Present only when AI polish was asked for and failed: the post went out
    // under its original text. Absent on every other result.
    warning?: string;
    error: {
      code: string;
      message: string;
    } | null;
  };
}

export interface CreateMediaResponse {
  mediaId: string;
  contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  sizeBytes: number;
}

// The image itself. The API answers this one with the bytes rather than with
// JSON, so the client builds it from the response.
export interface GetMediaResponse {
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export interface DeleteMediaResponse {
  id: string;
  deleted: true;
}

export interface GetPostsResponse {
  posts: {
    id: string;
    connectionSlug: string;
    // The profile the post's connection belongs to, null when it is one of
    // your own accounts.
    profileId: string | null;
    text: string;
    // What the caller actually sent, equal to text unless AI polish rewrote
    // this post
    originalText: string;
    // null: AI polish never touched this post. "rewritten": text above is the
    // model's own words. "failed": AI polish tried and failed, and text is
    // the original after all. "skipped": the post's shape does not support a
    // rewrite.
    aiRewriteStatus: "rewritten" | "failed" | "skipped" | null;
    status:
      | "sent"
      | "scheduled"
      | "processing"
      | "draft"
      | "failed"
      | "cancelled"
      | "deleted";
    url: string | null;
    scheduledFor: string | null;
    createdAt: string;
    tags: string[];
    // The platform's own id for the head post, which is what a delete works
    // from. Null on a post that never reached a platform.
    platformPostId: string | null;
    // When the post was deleted on its platform, null while it is still up
    deletedAt: string | null;
    error: {
      code: string;
      message: string;
    } | null;
    // The images attached to the post, in posting order
    media: {
      id: string;
      altText: string | null;
    }[];
    // The reply chain under the head post, as it was given. Empty for a
    // single post, which is every post made before shapes shipped.
    thread: string[];
    // The author's own comment under the share, null when there is none
    firstComment: string | null;
    // When the post actually went out, null while it is still a draft, still
    // pending, or never sent at all
    publishedAt: string | null;
  }[];
  limit: number;
  offset: number;
}

export interface GetPostResponse {
  post: {
    id: string;
    connectionSlug: string;
    // The profile the post's connection belongs to, null when it is one of
    // your own accounts.
    profileId: string | null;
    text: string;
    // What the caller actually sent, equal to text unless AI polish rewrote
    // this post
    originalText: string;
    // null: AI polish never touched this post. "rewritten": text above is the
    // model's own words. "failed": AI polish tried and failed, and text is
    // the original after all. "skipped": the post's shape does not support a
    // rewrite.
    aiRewriteStatus: "rewritten" | "failed" | "skipped" | null;
    status:
      | "sent"
      | "scheduled"
      | "processing"
      | "draft"
      | "failed"
      | "cancelled"
      | "deleted";
    url: string | null;
    scheduledFor: string | null;
    createdAt: string;
    tags: string[];
    // The platform's own id for the head post, which is what a delete works
    // from. Null on a post that never reached a platform.
    platformPostId: string | null;
    // When the post was deleted on its platform, null while it is still up
    deletedAt: string | null;
    error: {
      code: string;
      message: string;
    } | null;
    // The images attached to the post, in posting order
    media: {
      id: string;
      altText: string | null;
    }[];
    // The reply chain under the head post, as it was given. Empty for a
    // single post, which is every post made before shapes shipped.
    thread: string[];
    // The author's own comment under the share, null when there is none
    firstComment: string | null;
    // When the post actually went out, null while it is still a draft, still
    // pending, or never sent at all
    publishedAt: string | null;
  };
}

export interface UpdatePostResponse {
  post: {
    id: string;
    connectionSlug: string;
    // The profile the post's connection belongs to, null when it is one of
    // your own accounts.
    profileId: string | null;
    text: string;
    status:
      | "sent"
      | "scheduled"
      | "processing"
      | "draft"
      | "failed"
      | "cancelled"
      | "deleted";
    url: string | null;
    scheduledFor: string | null;
    createdAt: string;
    tags: string[];
    platformPostId: string | null;
    deletedAt: string | null;
    error: {
      code: string;
      message: string;
    } | null;
  };
}

export interface CancelPostResponse {
  id: string;
  status: "cancelled";
}

export interface DeleteDraftResponse {
  id: string;
  deleted: true;
}

// deletePost answers with this when the post had already been sent: it comes
// down on its platform rather than being cancelled
export interface DeletePostResponse {
  id: string;
  status: "deleted";
  deletedAt: string;
}

export interface RetryPostResponse {
  id: string;
  status: "sent";
  // Set only on a retry sent inside the connection-limit grace window
  warning?: string;
}

// One read of a post's numbers. Every counter is a running total, so the newest
// read is the post's numbers now.
//
// Null is "this platform does not report this number", which is not zero.
// Bluesky and Mastodon give likes, reposts and replies. LinkedIn gives likes
// and comments on any share, and impressions and clicks only on a page. X gives
// impressions, likes, reposts and replies, and only when X analytics is on for
// the account, because X charges for the read.
export interface PostMetricsRead {
  fetchedAt: string;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  clicks: number | null;
}

export interface GetPostMetricsResponse {
  // Null until the first read, which happens an hour after the post goes out
  latest: PostMetricsRead | null;
  // Every read, oldest first. A post is read hourly for 48 hours and then daily
  // until it is 30 days old.
  history: PostMetricsRead[];
}

export interface GetAnalyticsResponse {
  totals: {
    posts: number;
    impressions: number;
    likes: number;
    reposts: number;
    replies: number;
    clicks: number;
  };
  // One entry per UTC day of the window, gaps included, so it charts as it
  // comes. A post counts on the day it went out.
  days: {
    day: string;
    posts: number;
    impressions: number;
    likes: number;
    reposts: number;
    replies: number;
  }[];
  // The same window split by platform. A platform with no posts in it is not
  // listed.
  byPlatform: {
    platformId: string;
    posts: number;
    impressions: number;
    likes: number;
    reposts: number;
    replies: number;
    clicks: number;
  }[];
  // The window, as whole UTC days, both ends included
  from: string;
  to: string;
}

// The events a webhook can be subscribed to, and the values the deliveries
// carry in x-yeetpost-event.
export type WebhookEventName =
  | "post.sent"
  | "post.failed"
  | "post.deleted"
  | "post.metrics"
  | "post.rescheduled"
  | "connection.created"
  | "connection.removed"
  | "connection.reconnect_required";

export interface CreateWebhookResponse {
  webhook: {
    id: string;
    url: string;
    events: WebhookEventName[];
    secret: string;
    createdAt: string;
  };
}

export interface GetWebhooksResponse {
  webhooks: {
    id: string;
    url: string;
    events: WebhookEventName[];
    createdAt: string;
  }[];
}

export interface DeleteWebhookResponse {
  id: string;
  deleted: true;
}

export interface GetWebhookDeliveriesResponse {
  deliveries: {
    id: string;
    // What the delivery carries in x-yeetpost-event-id and in the eventId field
    // of its body. It is the delivery id: one event, one id, every attempt and
    // every replay of it.
    eventId: string;
    event: WebhookEventName;
    status: "pending" | "processing" | "delivered" | "failed" | "dead";
    attempts: number;
    createdAt: string;
    nextAttemptAt: string;
    deliveredAt: string | null;
    deadAt: string | null;
    lastStatusCode: number | null;
    lastError: string | null;
  }[];
  limit: number;
  hasMore: boolean;
}

export interface ReplayWebhookDeliveryResponse {
  delivery: {
    id: string;
    eventId: string;
    event: WebhookEventName;
    status: "pending" | "processing" | "delivered" | "failed" | "dead";
    attempts: number;
    createdAt: string;
    nextAttemptAt: string;
    deliveredAt: string | null;
    deadAt: string | null;
    lastStatusCode: number | null;
    lastError: string | null;
  };
}

export interface SendWebhookTestEventResponse {
  delivery: {
    id: string;
    eventId: string;
    event: WebhookEventName;
    status: "pending" | "processing" | "delivered" | "failed" | "dead";
    attempts: number;
    createdAt: string;
    nextAttemptAt: string;
    deliveredAt: string | null;
    deadAt: string | null;
    lastStatusCode: number | null;
    lastError: string | null;
  };
}

// The body of a post.sent or post.failed delivery, for the receiver that
// verified it. eventId leads the body, and matches the x-yeetpost-event-id
// header: it is the same value on every attempt and every replay, so it is what
// you dedupe on. test is set only on the event that
// POST /webhooks/{webhookId}/test enqueues.
export interface PostWebhookEvent {
  eventId: string;
  event: "post.sent" | "post.failed";
  timestamp: string;
  test?: true;
  post: {
    id: string;
    connectionSlug: string;
    // The profile the post's connection belongs to, null when it is one of
    // your own accounts.
    profileId: string | null;
    text: string;
    status: "sent" | "failed";
    url: string | null;
    scheduledFor: string | null;
    createdAt: string;
    tags: string[];
    // How many images the post carried. The ids are left out on purpose: read
    // the bytes back with getMedia if you need them.
    mediaCount: number;
    // How many replies went out under the head post
    threadCount: number;
    // Whether the first comment landed
    hasFirstComment: boolean;
    error: {
      code: string;
      message: string;
    } | null;
  };
}

// The body of a post.deleted delivery. A deleted post is no longer a post, so
// the event says which one is gone and where it stood rather than repeating its
// text one last time.
export interface PostDeletedWebhookEvent {
  eventId: string;
  event: "post.deleted";
  timestamp: string;
  post: {
    id: string;
    connectionSlug: string;
    // The profile the post's connection belongs to, null when it is one of
    // your own accounts.
    profileId: string | null;
    platformId: string;
    deletedAt: string;
  };
}

// The body of a connection.created, connection.removed or
// connection.reconnect_required delivery: an account was connected,
// disconnected, or started needing a reconnect, whether it went into one of
// your profiles or into your own account. The two ids together are the mapping
// to persist: the profile is your customer, the connection is what you post to.
export interface ConnectionWebhookEvent {
  eventId: string;
  event:
    | "connection.created"
    | "connection.removed"
    | "connection.reconnect_required";
  timestamp: string;
  connection: {
    id: string;
    // The profile the connection belongs to, null when it is one of your own
    // accounts.
    profileId: string | null;
    // The connect session the account came in through, null when the
    // connection was made in the console. It lets you file the connection
    // against the customer you made the link for without waiting for their
    // browser to come back.
    connectSessionId: string | null;
    platformId: string;
    slug: string;
  };
}

// The body of a post.metrics delivery: a day's reading of a post's numbers. It
// fires on the first read of each UTC day, for as long as the post is being
// refreshed, so it is one delivery per post per day rather than one per hourly
// read.
export interface PostMetricsWebhookEvent {
  eventId: string;
  event: "post.metrics";
  timestamp: string;
  post: {
    id: string;
    connectionSlug: string;
    // The profile the post's connection belongs to, null when it is one of
    // your own accounts.
    profileId: string | null;
    platformId: string;
    url: string | null;
  };
  metrics: PostMetricsRead;
}

// The body of a post.rescheduled delivery: a pending post's own time
// changed. reason is "missed_slot" for a queued post moved to its next free
// slot, "fair_use" for a fair-use deferral, "requeued" for a failed post moved
// back into the queue by hand, "catch_up" for a hand-scheduled post spaced
// out behind a backlog draining on its connection, and "edited" for you
// moving it yourself with updateDraft.
export interface PostRescheduledWebhookEvent {
  eventId: string;
  event: "post.rescheduled";
  timestamp: string;
  post: {
    id: string;
    connectionSlug: string;
    // The profile the post's connection belongs to, null when it is one of
    // your own accounts.
    profileId: string | null;
    scheduledFor: string;
    reason: "missed_slot" | "fair_use" | "requeued" | "catch_up" | "edited";
  };
}

// Any delivery body, discriminated on event. Narrow on it, or on the
// x-yeetpost-event header, before reading post or connection: a post.deleted
// event says which post is gone rather than repeating its text, and a
// connection event carries no post at all.
export type WebhookEvent =
  | PostWebhookEvent
  | PostDeletedWebhookEvent
  | PostMetricsWebhookEvent
  | PostRescheduledWebhookEvent
  | ConnectionWebhookEvent;

// Whether the database answers and whether each background worker has finished
// a loop recently. The status code is 200 whether the API is ok or degraded, so
// read status rather than the code.
export interface GetHealthResponse {
  status: "ok" | "degraded";
  checks: {
    database: {
      ok: boolean;
      latencyMs: number;
    };
    scheduledPosts: {
      ok: boolean;
      lastRunAt: string | null;
      lastOkAt: string | null;
    };
    webhookDeliveries: {
      ok: boolean;
      lastRunAt: string | null;
      lastOkAt: string | null;
    };
    xUsageSweep: {
      ok: boolean;
      lastRunAt: string | null;
      lastOkAt: string | null;
    };
    postMetrics: {
      ok: boolean;
      lastRunAt: string | null;
      lastOkAt: string | null;
    };
  };
  // The API version that answered
  version: string;
  // When the health was measured. The answer is cached for 10 seconds, so this
  // can be that much behind.
  time: string;
}

// One aggregate per UTC day, oldest first. What is measured is minutes, not
// samples: a day owes 1440 of them, today owes the ones already behind it, and
// a minute with no sample counts as degraded exactly like a sample that came
// back degraded.
export interface GetHealthHistoryResponse {
  days: {
    // The UTC day, YYYY-MM-DD
    day: string;
    // Ok minutes over the minutes the day owed, to two decimals. Null when the
    // day was over before the first sample was ever taken: nobody was watching
    // it, so it is unmeasured rather than down.
    uptimePercent: number | null;
    // How many of that day's minutes got a sample. A full day is 1440.
    samples: number;
    // Minutes of that day that were not ok, the ones with no sample included
    degradedMinutes: number;
  }[];
}

// Public numbers about yeetpost as a whole, which is what the marketing site's
// proof pill draws. Nothing here is about one account.
export interface GetStatsResponse {
  // Posts that reached a platform in the last 7 days, and ever: no error, not
  // a draft, not taken down, not still waiting in a queue. Sandbox connections
  // and test-key traffic are left out. Whole numbers exactly as counted, so
  // round them yourself.
  postsThisWeek: number;
  postsAllTime: number;
  // Connections that can be posted to right now, sandbox ones left out
  liveConnections: number;
  // The platform ids a post can go out to today, such as "linkedin" or "x"
  platformsLive: string[];
  // When the counts were taken. The answer is cached for 60 seconds, so this
  // can be that much behind.
  time: string;
}

// The OpenAPI 3.1 document itself. It is the spec's own shape rather than one
// of ours, so it comes back as the decoded document.
export type GetOpenapiSpecResponse = Record<string, unknown>;

//
// Client
//

export interface YeetpostOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface PostToConnectionOptions {
  scheduledFor?: string;
}

export interface ListConnectionsParams {
  // Only the connections in this profile. Leave it out for every connection of
  // yours, your own accounts and your customers' both.
  profileId?: string;
}

export interface CreateProfileParams {
  // What you call this end customer, 1 to 100 characters
  name: string;
  // Your own id for the same end customer, 1 to 200 characters. Unique across
  // your account: a second profile with the same one is refused with
  // 409 profile_external_id_conflict.
  externalId?: string;
}

export interface ListProfilesParams {
  limit?: number;
  offset?: number;
}

// Send a name, an externalId, or both. Only what you send is written, so a
// field you leave out keeps what the profile had.
export interface UpdateProfileParams {
  name?: string;
  // An explicit null takes the external id off the profile, which is different
  // from leaving the field out.
  externalId?: string | null;
}

export interface CreateProfileKeyParams {
  // What you call this key, 1 to 80 characters
  name: string;
  // A live key posts for real, a test key reaches the sandbox only. A test key
  // can only mint test keys: asking it for a live one is a 403 forbidden.
  type: "live" | "test";
  // The origins a connect redirect from this key may land on, at most 20. Each
  // is a bare origin such as "https://acme.example.com", with no path, query or
  // fragment; they are normalized and deduped. An empty list means no
  // allowlist, which is the same as leaving the field out.
  redirectAllowlist?: string[];
}

export interface ListApiKeysParams {
  // List the revoked keys as well. Left out, only the keys that still work are
  // listed.
  includeRevoked?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateConnectUrlParams {
  // The platform to connect. Leave it out and the end customer picks one on
  // the page. A test key may only name "sandbox".
  platform?: ConnectPlatform;
  // Where the end customer goes when the flow ends, either way. An https URL
  // on a public host with no fragment; plain http is accepted for localhost
  // only. It is bound to the session here and used exactly as stored, so
  // nothing in the hosted page's own query can change where they land.
  redirectUrl: string;
  // Draw the hosted page with no yeetpost header or footer, for a popup with
  // your own branding around it.
  headless?: boolean;
}

// One image on a post, with the alt text it gets there. altText overrides the
// alt text given at upload, and is passed to X, Bluesky, Mastodon and LinkedIn;
// Telegram has no field for it, so it is dropped there.
export interface PostMediaItem {
  id: string;
  altText?: string;
}

export interface CreatePostsParams {
  text: string;
  connectionSlugs: string[];
  // The end customer this post is going out for. Every slug in connectionSlugs
  // has to belong to that profile, and one that does not fails that item with
  // invalid_connection. Leave it out and every slug has to be one of your own
  // connections, so a post can never reach a profile by accident.
  profileId?: string;
  scheduledFor?: string;
  // The IANA zone to read a scheduledFor that carries no UTC offset in
  timezone?: string;
  // Take each connection's next free posting slot instead of naming a time.
  // Cannot be combined with scheduledFor.
  queue?: boolean;
  mediaIds?: string[];
  // The same images with their own alt text. Send either this or mediaIds,
  // never both.
  media?: PostMediaItem[];
  // Fetch and attach these https image URLs yourself instead of uploading
  // first. Send only one of mediaIds, media or mediaUrls.
  mediaUrls?: string[];
  thread?: string[];
  firstComment?: string;
  // Store the post against every connection and publish nothing. Each item
  // comes back as "draft" with a postId; publish it with publishPost. Cannot
  // be combined with scheduledFor or queue.
  isDraft?: boolean;
  // Your own labels, at most 10, each 1 to 40 characters of lowercase
  // letters, digits, dashes, underscores, colons, dots and slashes
  tags?: string[];
  // AI polish for this post: true or false always wins over the connection's
  // own mode and the account's default. Left out, the connection's mode
  // decides. No effect on a thread, which AI polish never touches.
  rewrite?: boolean;
  // A platform's own text, keyed by platform id (linkedin, x, bluesky, and so
  // on), used in place of the shared text for every connection on that
  // platform. A platform left out gets the shared text.
  textByPlatform?: Record<string, string>;
  idempotencyKey?: string;
}

// How a draft goes out. All three are optional, and an empty object sends it
// now; queue and scheduledFor cannot be combined.
export interface PublishPostParams {
  scheduledFor?: string;
  timezone?: string;
  queue?: boolean;
  idempotencyKey?: string;
}

// Every field is optional, and only what you send is written. thread and
// firstComment describe one shape between them, so sending either replaces
// both, and mediaIds replaces the whole image list. This also edits a
// pending scheduled post, not only a draft: scheduledFor (with an optional
// timezone) or queue moves its time, the same two ways publishPost reads
// them. A draft refuses all three, since it has nowhere to be sent at yet.
export interface UpdateDraftParams {
  text?: string;
  thread?: string[];
  firstComment?: string | null;
  mediaIds?: string[];
  // The same replacement, with alt text per image. Send either this or
  // mediaIds, never both.
  media?: PostMediaItem[];
  tags?: string[];
  // A pending scheduled post's new send time. Cannot be combined with queue.
  scheduledFor?: string;
  // IANA zone to read scheduledFor in when it carries no UTC offset.
  timezone?: string;
  // Take the connection's next free posting slot instead of naming a time.
  // Already queued, this is a no-op. Cannot be combined with scheduledFor.
  queue?: boolean;
}

export interface UpdateConnectionParams {
  // The profile to move the connection into. Null moves it back out to your
  // own connections.
  profileId: string | null;
}

// Send slots, timezone, paused, or a combination. At least one is required.
export interface UpdateConnectionQueueParams {
  slots?: QueueSlot[];
  timezone?: string;
  paused?: boolean;
}

export interface UploadMediaParams {
  // The raw file, not a multipart form.
  bytes: Uint8Array;
  contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  altText?: string;
}

export interface ListPostsParams {
  status?:
    | "sent"
    | "scheduled"
    | "processing"
    | "draft"
    | "failed"
    | "cancelled"
    | "deleted";
  // Only posts carrying every one of these tags, not any of them
  tag?: string[];
  // Only the posts that went out for this end customer. A deleted profile
  // still answers here, so an offboarded customer keeps its history.
  profileId?: string;
  // Matched against the post's own scheduledFor, both inclusive. Answers
  // nothing for a post that was never scheduled: an immediate post has no
  // scheduledFor to compare.
  scheduledAfter?: string;
  scheduledBefore?: string;
  connectionSlug?: string;
  platform?: string;
  // Every post created by one request shares this id, so this groups the
  // targets of one send the way the console does.
  sendGroupId?: string;
  limit?: number;
  offset?: number;
}

export interface GetAnalyticsParams {
  // Whole UTC days, "YYYY-MM-DD", both ends included. Left out, the window is
  // the last 30 days, which is exactly as long as a post's numbers are
  // refreshed for. The longest window is 365 days.
  from?: string;
  to?: string;
  profileId?: string;
  platform?: string;
  connectionSlug?: string;
}

export interface CreateWebhookParams {
  url: string;
  events?: WebhookEventName[];
}

export interface GetHealthHistoryParams {
  // How many days back to aggregate, 1 to 90. The API defaults it to 90.
  days?: number;
}

export interface ListWebhookDeliveriesParams {
  status?: "pending" | "delivered" | "failed" | "dead";
  limit?: number;
  // A delivery id. The page continues from the delivery after that one, which
  // is steadier than an offset while new deliveries land at the top of the log.
  startingAfter?: string;
}

// One of the numeric headers, or -1 when the response did not carry it.
const getHeaderNumber = (headers: Headers, name: string): number => {
  const header = headers.get(name);

  if (header === null || header === "") {
    return -1;
  }

  const value = Number(header);

  if (!Number.isInteger(value)) {
    return -1;
  }

  return value;
};

const getRateLimit = (
  headers: Headers,
): { limit: number; remaining: number; reset: number } => ({
  limit: getHeaderNumber(headers, "x-ratelimit-limit"),
  remaining: getHeaderNumber(headers, "x-ratelimit-remaining"),
  reset: getHeaderNumber(headers, "x-ratelimit-reset"),
});

const getApiError = (
  status: number,
  headers: Headers,
  responseBody: unknown,
): YeetpostApiError => {
  const headerRequestId = headers.get("x-request-id");
  const rateLimit = getRateLimit(headers);

  if (typeof responseBody !== "object" || responseBody === null) {
    return new YeetpostApiError(
      status,
      "internal_server_error",
      "the yeetpost api returned an error that was not json",
      headerRequestId,
      rateLimit,
    );
  }

  const errorBody = responseBody as {
    error?: unknown;
    message?: unknown;
    req_id?: unknown;
  };

  if (typeof errorBody.error !== "string") {
    return new YeetpostApiError(
      status,
      "internal_server_error",
      "the yeetpost api returned an error without a code",
      headerRequestId,
      rateLimit,
    );
  }

  // The 429 body has no message field, so the code stands in for it there.
  const message =
    typeof errorBody.message === "string" ? errorBody.message : errorBody.error;
  // The header leads, and the body's req_id stands in when it was not sent.
  const bodyRequestId =
    typeof errorBody.req_id === "string" ? errorBody.req_id : null;
  const requestId = headerRequestId ?? bodyRequestId;

  return new YeetpostApiError(
    status,
    errorBody.error,
    message,
    requestId,
    rateLimit,
  );
};

// What varies between calls. A jsonBody is serialised and sent as
// application/json, a textBody as text/plain, and a bytesBody goes out as it is
// under its own content type.
interface SendOptions {
  query?: Record<string, string | number | boolean | string[] | undefined>;
  jsonBody?: unknown;
  textBody?: string;
  bytesBody?: { bytes: Uint8Array; contentType: string };
  idempotencyKey?: string;
  // Set by the endpoints that need no API key: health, health history, stats
  // and the spec. Everywhere else an empty key is refused before the request
  // goes out.
  isPublicEndpoint?: boolean;
}

// The response body as JSON, or null when it was not JSON at all. A body that
// is literally "null" reads the same way, which is what the callers want:
// neither is a response they can hand back.
const getJsonBody = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

export class Yeetpost {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  // An empty apiKey is allowed: getHealth, getHealthHistory, getStats and
  // getOpenapiSpec need no key. Every other call is refused here before the
  // request goes out, rather than coming back as a 401 from the API.
  constructor(options: YeetpostOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  // Every method funnels through here: it sets auth, sends the body, and turns
  // any non-2xx into a YeetpostApiError before the caller sees it. The response
  // body comes back as bytes, since getMedia answers with an image rather than
  // with JSON.
  private async send(
    method: string,
    path: string,
    options: SendOptions = {},
  ): Promise<{ response: Response; bytes: Uint8Array }> {
    if (!this.apiKey && !options.isPublicEndpoint) {
      throw new Error("apiKey is required for this call");
    }

    const url = new URL(`${this.baseUrl}${path}`);

    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) {
        continue;
      }

      // A repeatable parameter, such as tag, goes on once per value: the API
      // reads the repeats as a list to narrow by, not as one comma string
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(name, item);
        }
        continue;
      }

      url.searchParams.set(name, String(value));
    }

    // An empty key goes out as no header at all, which is what the endpoints
    // that need no key expect to see.
    const headers: Record<string, string> = {};

    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    if (options.jsonBody !== undefined) {
      headers["content-type"] = "application/json";
    }

    if (options.textBody !== undefined) {
      headers["content-type"] = "text/plain";
    }

    if (options.bytesBody !== undefined) {
      headers["content-type"] = options.bytesBody.contentType;
    }

    if (options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey;
    }

    let body: string | Uint8Array | undefined = options.textBody;

    if (options.jsonBody !== undefined) {
      body = JSON.stringify(options.jsonBody);
    }

    if (options.bytesBody !== undefined) {
      body = options.bytesBody.bytes;
    }

    const response = await fetch(url, { method, headers, body });
    const responseBytes = new Uint8Array(await response.arrayBuffer());

    if (!response.ok) {
      throw getApiError(
        response.status,
        response.headers,
        getJsonBody(responseBytes),
      );
    }

    return { response, bytes: responseBytes };
  }

  // send plus decoding, which is every endpoint but getMedia.
  private async request<TResponse>(
    method: string,
    path: string,
    options: SendOptions = {},
  ): Promise<TResponse> {
    const { response, bytes } = await this.send(method, path, options);
    const responseBody = getJsonBody(bytes);

    if (responseBody === null) {
      throw new YeetpostApiError(
        response.status,
        "internal_server_error",
        "the yeetpost api returned a response that was not json",
        response.headers.get("x-request-id"),
        getRateLimit(response.headers),
      );
    }

    // The API is the authority on its own response shapes; the interfaces here
    // are copies of its spec, so this is the one place a cast is needed.
    return responseBody as TResponse;
  }

  // Every connection of yours, or only the ones inside one profile. A
  // profileId that is not one of yours is a 400 invalid_request rather than an
  // empty list.
  async listConnections(
    params: ListConnectionsParams = {},
  ): Promise<ConnectionsResponse> {
    const { profileId } = params;

    return this.request<ConnectionsResponse>("GET", "/connections", {
      query: { profileId },
    });
  }

  async getConnection(connectionId: string): Promise<GetConnectionResponse> {
    return this.request<GetConnectionResponse>(
      "GET",
      `/connections/${encodeURIComponent(connectionId)}`,
    );
  }

  // Moves a connection into one of your profiles, or back out to your own with
  // a null profileId. The slug, the queue and every post already written stay
  // where they are, and so does the billed connection count: only the routing
  // changes. It fires connection.removed for the profile it left and
  // connection.created for the one it arrived at, and LinkedIn pages move with
  // the personal account that administers them.
  //
  // A profile that already holds the same account is a 409 connection_conflict
  // naming the connection in the way (SMS and email are exempt, because their
  // connect flows do not deduplicate either). A profile-scoped key is a 403
  // forbidden, and so is the connection you sign in with: the move is the
  // account owner's call.
  async updateConnection(
    connectionId: string,
    params: UpdateConnectionParams,
  ): Promise<UpdateConnectionResponse> {
    const { profileId } = params;

    return this.request<UpdateConnectionResponse>(
      "PATCH",
      `/connections/${encodeURIComponent(connectionId)}`,
      { jsonBody: { profileId } },
    );
  }

  // Disconnects one account: the credentials are deleted, and anything still
  // waiting to be sent to it is cancelled. The connection you sign in with
  // cannot be disconnected, which is a 403 forbidden.
  async deleteConnection(
    connectionId: string,
  ): Promise<DeleteConnectionResponse> {
    return this.request<DeleteConnectionResponse>(
      "DELETE",
      `/connections/${encodeURIComponent(connectionId)}`,
    );
  }

  // The posts waiting in the connection's queue, earliest slot first.
  async listConnectionQueue(
    connectionId: string,
  ): Promise<GetConnectionQueueResponse> {
    return this.request<GetConnectionQueueResponse>(
      "GET",
      `/connections/${encodeURIComponent(connectionId)}/queue`,
    );
  }

  // Replaces the slot list, the timezone, pauses or resumes the queue, or a
  // combination. Posts already queued keep the times they were given.
  async updateConnectionQueue(
    connectionId: string,
    params: UpdateConnectionQueueParams,
  ): Promise<UpdateConnectionQueueResponse> {
    const { slots, timezone, paused } = params;

    return this.request<UpdateConnectionQueueResponse>(
      "PATCH",
      `/connections/${encodeURIComponent(connectionId)}/queue`,
      { jsonBody: { slots, timezone, paused } },
    );
  }

  // One profile is one of your end customers. Connect their accounts into it
  // and post with its id, and a post of theirs can never reach another
  // customer's account. An account can have 1000 profiles at once; over that,
  // this is a 403 limit_exceeded.
  async createProfile(
    params: CreateProfileParams,
  ): Promise<CreateProfileResponse> {
    const { name, externalId } = params;

    return this.request<CreateProfileResponse>("POST", "/profiles", {
      jsonBody: { name, externalId },
    });
  }

  // Your profiles, newest first. A deleted profile is not in the list.
  async listProfiles(
    params: ListProfilesParams = {},
  ): Promise<GetProfilesResponse> {
    const { limit, offset } = params;

    return this.request<GetProfilesResponse>("GET", "/profiles", {
      query: { limit, offset },
    });
  }

  async getProfile(profileId: string): Promise<GetProfileResponse> {
    return this.request<GetProfileResponse>(
      "GET",
      `/profiles/${encodeURIComponent(profileId)}`,
    );
  }

  // Renames a profile, sets its external id, or takes the external id off with
  // an explicit null. Only what you send is written, so leaving externalId out
  // keeps the one the profile had. An external id another live profile of
  // yours already carries is a 409 profile_external_id_conflict. A call that
  // names neither field is refused here, before the request goes out: the API
  // needs at least one of them.
  async updateProfile(
    profileId: string,
    params: UpdateProfileParams,
  ): Promise<UpdateProfileResponse> {
    const { name, externalId } = params;

    if (name === undefined && externalId === undefined) {
      throw new Error("send a name, an externalId, or both");
    }

    return this.request<UpdateProfileResponse>(
      "PATCH",
      `/profiles/${encodeURIComponent(profileId)}`,
      { jsonBody: { name, externalId } },
    );
  }

  // Disconnects every account in the profile: the credentials are deleted,
  // anything still waiting to be sent is cancelled, the drafts written in it
  // are deleted, and the posts that already went out stay readable. The answer
  // says how many connections went with it. The profile itself is kept out of
  // sight rather than erased, so listPosts({ profileId }) still lists the
  // history of a customer you have offboarded.
  async deleteProfile(profileId: string): Promise<DeleteProfileResponse> {
    return this.request<DeleteProfileResponse>(
      "DELETE",
      `/profiles/${encodeURIComponent(profileId)}`,
    );
  }

  // Mints a key for one end customer. A key made here is always scoped to the
  // profile in the path, so it reaches that customer and nothing else, whatever
  // a call made with it says. Only an unscoped key of yours may call this: a
  // key that is itself scoped to a profile is a 403 forbidden. A test key can
  // only mint test keys, and asking it for a live one is a 403 forbidden too. A
  // profile holds at most 50 live and 50 test keys, and over that this is a 403
  // limit_exceeded; a revoked key does not count against either. The secret is
  // answered exactly once, in this response.
  async createProfileKey(
    profileId: string,
    params: CreateProfileKeyParams,
  ): Promise<CreateApiKeyResponse> {
    const { name, type, redirectAllowlist } = params;

    return this.request<CreateApiKeyResponse>(
      "POST",
      `/profiles/${encodeURIComponent(profileId)}/keys`,
      { jsonBody: { name, type, redirectAllowlist } },
    );
  }

  // The keys scoped to one profile, oldest first, without their secrets. Only
  // an unscoped key of yours may call this, and a test key sees the test keys
  // and no live ones. Paged like listProfiles: limit is 1 to 100 and defaults
  // to 25.
  async listProfileKeys(
    profileId: string,
    params: ListApiKeysParams = {},
  ): Promise<GetApiKeysResponse> {
    const { includeRevoked, limit, offset } = params;

    return this.request<GetApiKeysResponse>(
      "GET",
      `/profiles/${encodeURIComponent(profileId)}/keys`,
      { query: { includeRevoked, limit, offset } },
    );
  }

  // Revokes one of the profile's keys. It stops working everywhere at once, on
  // the next request, except that a connect url it already issued keeps working
  // for the rest of its fifteen minutes. Revoking a key that is already revoked
  // is the same 200, so a retry is safe. Only an unscoped key of yours may call
  // this, and a test key may only revoke test keys: a live key answers 404 to
  // one.
  async revokeProfileKey(
    profileId: string,
    keyId: string,
  ): Promise<RevokeApiKeyResponse> {
    return this.request<RevokeApiKeyResponse>(
      "DELETE",
      `/profiles/${encodeURIComponent(profileId)}/keys/${encodeURIComponent(keyId)}`,
    );
  }

  // Every key of your account, oldest first: the unscoped ones and every
  // profile's, with no secrets. Only an unscoped key of yours may call this,
  // and a test key sees the test keys and no live ones. Paged like
  // listProfiles: limit is 1 to 100 and defaults to 25.
  async listKeys(params: ListApiKeysParams = {}): Promise<GetApiKeysResponse> {
    const { includeRevoked, limit, offset } = params;

    return this.request<GetApiKeysResponse>("GET", "/keys", {
      query: { includeRevoked, limit, offset },
    });
  }

  // Revokes any key of your account, scoped or not, including the key making
  // the call: that one answers 200 and the next request with it is a 401. Only
  // an unscoped key of yours may call this, and a test key may only revoke test
  // keys: a live key answers 404 to one, the same answer a key that is not
  // yours gets.
  async revokeKey(keyId: string): Promise<RevokeApiKeyResponse> {
    return this.request<RevokeApiKeyResponse>(
      "DELETE",
      `/keys/${encodeURIComponent(keyId)}`,
    );
  }

  // A page yeetpost hosts, where your end customer connects one of their own
  // accounts into this profile. The link works once and lasts fifteen
  // minutes, and the token in it carries the whole authorization: nobody
  // signs in to yeetpost, and the page never shows your key, your email or
  // anything about your other customers. A test key opens a session that
  // offers the sandbox and nothing else, which is how the whole flow runs in
  // CI.
  async createConnectUrl(
    profileId: string,
    params: CreateConnectUrlParams,
  ): Promise<CreateConnectSessionResponse> {
    const { platform, redirectUrl, headless } = params;

    return this.request<CreateConnectSessionResponse>(
      "POST",
      `/profiles/${encodeURIComponent(profileId)}/connect`,
      { jsonBody: { platform, redirectUrl, headless } },
    );
  }

  // How a connect link ended, for when you would rather poll than read the
  // query your customer came back on. Both say the same thing, and a link that
  // has been used or has run out sends nobody anywhere, which is why polling
  // exists: there is no redirect left to carry the news.
  async getConnectSession(
    connectSessionId: string,
  ): Promise<GetConnectSessionResponse> {
    return this.request<GetConnectSessionResponse>(
      "GET",
      `/connect-sessions/${encodeURIComponent(connectSessionId)}`,
    );
  }

  // The one-liner endpoint: the body is the post. It has nowhere to name a
  // profile, so it reaches your own accounts and nothing else. Prefer
  // createPosts for anything that is not a shell script.
  async postToConnection(
    connectionSlug: string,
    text: string,
    options: PostToConnectionOptions = {},
  ): Promise<LegacyPostResponse> {
    return this.request<LegacyPostResponse>(
      "POST",
      `/post/${encodeURIComponent(connectionSlug)}`,
      {
        query: { scheduled_for: options.scheduledFor },
        textBody: text,
      },
    );
  }

  // A connection that fails comes back as a failed item in results, not as a
  // thrown error. Read the per-item status.
  async createPosts(params: CreatePostsParams): Promise<CreatePostsResponse> {
    const {
      text,
      connectionSlugs,
      profileId,
      scheduledFor,
      timezone,
      queue,
      mediaIds,
      media,
      mediaUrls,
      thread,
      firstComment,
      isDraft,
      tags,
      rewrite,
      textByPlatform,
      idempotencyKey,
    } = params;

    return this.request<CreatePostsResponse>("POST", "/posts", {
      jsonBody: {
        text,
        connectionSlugs,
        profileId,
        scheduledFor,
        timezone,
        queue,
        mediaIds,
        media,
        mediaUrls,
        thread,
        firstComment,
        isDraft,
        tags,
        rewrite,
        textByPlatform,
      },
      idempotencyKey,
    });
  }

  // Turns a draft into a real send: now, at a time, or into the connection's
  // next free slot. The post keeps the id it had as a draft, and the mode it
  // was created with. A refusal comes back in result.error, and the ones you
  // can still settle leave the draft where it was to be published again:
  // queue_empty, queue_full, payment_method_required, spend_cap_reached,
  // fair_use_reached and connection_limit_exceeded. Every other refusal is the
  // post's outcome, so the draft becomes a failed post. A post that is not a
  // draft any more is a 404 not_found.
  async publishPost(
    postId: string,
    params: PublishPostParams = {},
  ): Promise<PublishPostResponse> {
    const { scheduledFor, timezone, queue, idempotencyKey } = params;

    return this.request<PublishPostResponse>(
      "POST",
      `/posts/${encodeURIComponent(postId)}/publish`,
      {
        jsonBody: { scheduledFor, timezone, queue },
        idempotencyKey,
      },
    );
  }

  // Edits a draft, or a pending scheduled post, in place. Anything else is a
  // record of what already happened, so editing it is a 400 invalid_request,
  // and a post the worker has already claimed is a 409 post_not_editable.
  async updateDraft(
    postId: string,
    params: UpdateDraftParams,
  ): Promise<UpdatePostResponse> {
    const {
      text,
      thread,
      firstComment,
      mediaIds,
      media,
      tags,
      scheduledFor,
      timezone,
      queue,
    } = params;

    return this.request<UpdatePostResponse>(
      "PATCH",
      `/posts/${encodeURIComponent(postId)}`,
      {
        jsonBody: {
          text,
          thread,
          firstComment,
          mediaIds,
          media,
          tags,
          scheduledFor,
          timezone,
          queue,
        },
      },
    );
  }

  // The same bytes uploaded twice are one image: the second upload answers
  // with the id of the first and costs nothing against your allowance.
  async uploadMedia(params: UploadMediaParams): Promise<CreateMediaResponse> {
    const { bytes, contentType, altText } = params;

    return this.request<CreateMediaResponse>("POST", "/media", {
      query: { alt_text: altText },
      bytesBody: { bytes, contentType },
    });
  }

  // Reads an image back, with the content type it was uploaded as. Any
  // parameters the header carries, such as a charset, are dropped: the media
  // type on its own is what the API answers with.
  async getMedia(mediaId: string): Promise<GetMediaResponse> {
    const { response, bytes } = await this.send(
      "GET",
      `/media/${encodeURIComponent(mediaId)}`,
    );

    const mediaType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim();

    // The API only ever answers this one with one of the four image types, and
    // it is the authority on what it sent.
    return {
      bytes,
      contentType: mediaType as GetMediaResponse["contentType"],
    };
  }

  // Deletes an image and frees the storage. Posts that used it keep their text
  // and lose the image, so delete one only once the posts that need it have
  // gone out.
  async deleteMedia(mediaId: string): Promise<DeleteMediaResponse> {
    return this.request<DeleteMediaResponse>(
      "DELETE",
      `/media/${encodeURIComponent(mediaId)}`,
    );
  }

  async listPosts(params: ListPostsParams = {}): Promise<GetPostsResponse> {
    const {
      status,
      tag,
      profileId,
      scheduledAfter,
      scheduledBefore,
      connectionSlug,
      platform,
      sendGroupId,
      limit,
      offset,
    } = params;

    return this.request<GetPostsResponse>("GET", "/posts", {
      query: {
        status,
        tag,
        profileId,
        scheduledAfter,
        scheduledBefore,
        connectionSlug,
        platform,
        sendGroupId,
        limit,
        offset,
      },
    });
  }

  async getPost(postId: string): Promise<GetPostResponse> {
    return this.request<GetPostResponse>(
      "GET",
      `/posts/${encodeURIComponent(postId)}`,
    );
  }

  // The numbers yeetpost has read back off the platform for one post: the
  // newest read, and every read before it. `latest` is null until the first
  // read, an hour after the post goes out.
  async getPostMetrics(postId: string): Promise<GetPostMetricsResponse> {
    return this.request<GetPostMetricsResponse>(
      "GET",
      `/posts/${encodeURIComponent(postId)}/metrics`,
    );
  }

  // Every post that went out in a window, with the newest numbers read for each
  // of them: totals, a per-day series and a per-platform split. Counters are
  // running totals, so a post counts once, at whatever its newest read said.
  async getAnalytics(
    params: GetAnalyticsParams = {},
  ): Promise<GetAnalyticsResponse> {
    const { from, to, profileId, platform, connectionSlug } = params;

    return this.request<GetAnalyticsResponse>("GET", "/analytics", {
      query: { from, to, profileId, platform, connectionSlug },
    });
  }

  // One verb, three meanings, decided by what the post is: a post still
  // waiting to be sent is cancelled, a draft is really deleted (it never went
  // out, so there is no record to keep), and one that already went out comes
  // down on its platform. The answer says which happened: a cancelled or a
  // taken-down post carries a status, a deleted draft carries deleted.
  async deletePost(
    postId: string,
  ): Promise<CancelPostResponse | DeleteDraftResponse | DeletePostResponse> {
    return this.request<
      CancelPostResponse | DeleteDraftResponse | DeletePostResponse
    >("DELETE", `/posts/${encodeURIComponent(postId)}`);
  }

  // The same call under the name a caller reaches for when the post is a
  // draft. It is the same endpoint, so the answer is the same union: a post
  // that stopped being a draft between your read and this call comes back
  // cancelled or deleted, and the type says so.
  async deleteDraft(
    postId: string,
  ): Promise<CancelPostResponse | DeleteDraftResponse | DeletePostResponse> {
    return this.request<
      CancelPostResponse | DeleteDraftResponse | DeletePostResponse
    >("DELETE", `/posts/${encodeURIComponent(postId)}`);
  }

  // The name this call had before it could delete a draft and a published post
  // too
  async cancelPost(
    postId: string,
  ): Promise<CancelPostResponse | DeleteDraftResponse | DeletePostResponse> {
    return this.deletePost(postId);
  }

  // Resends a post that failed. Only a post whose last attempt failed can be
  // retried, which is a 400 invalid_request otherwise. warning is set only
  // when the retry goes out inside the connection-limit grace window.
  async retryPost(postId: string): Promise<RetryPostResponse> {
    return this.request<RetryPostResponse>(
      "POST",
      `/posts/${encodeURIComponent(postId)}/retry`,
    );
  }

  // The secret in the response is shown exactly once. Store it now.
  async createWebhook(
    params: CreateWebhookParams,
  ): Promise<CreateWebhookResponse> {
    const { url, events } = params;

    return this.request<CreateWebhookResponse>("POST", "/webhooks", {
      jsonBody: { url, events },
    });
  }

  async listWebhooks(): Promise<GetWebhooksResponse> {
    return this.request<GetWebhooksResponse>("GET", "/webhooks");
  }

  async deleteWebhook(webhookId: string): Promise<DeleteWebhookResponse> {
    return this.request<DeleteWebhookResponse>(
      "DELETE",
      `/webhooks/${encodeURIComponent(webhookId)}`,
    );
  }

  async listWebhookDeliveries(
    webhookId: string,
    params: ListWebhookDeliveriesParams = {},
  ): Promise<GetWebhookDeliveriesResponse> {
    const { status, limit, startingAfter } = params;

    return this.request<GetWebhookDeliveriesResponse>(
      "GET",
      `/webhooks/${encodeURIComponent(webhookId)}/deliveries`,
      { query: { status, limit, startingAfter } },
    );
  }

  // Queues the delivery again as a fresh attempt chain, keeping its event id
  // and its body. Allowed on failed, dead and delivered; a delivery already
  // waiting for an attempt is a 400 invalid_request.
  async replayDelivery(
    webhookId: string,
    deliveryId: string,
  ): Promise<ReplayWebhookDeliveryResponse> {
    return this.request<ReplayWebhookDeliveryResponse>(
      "POST",
      `/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
    );
  }

  // Enqueues a synthetic post.sent delivery, so a receiver can be checked
  // without posting. Its body carries "test": true and nothing was posted.
  async sendTestEvent(
    webhookId: string,
  ): Promise<SendWebhookTestEventResponse> {
    return this.request<SendWebhookTestEventResponse>(
      "POST",
      `/webhooks/${encodeURIComponent(webhookId)}/test`,
    );
  }

  // Whether the database answers and whether each background worker has
  // finished a loop recently. The endpoint needs no API key, and the status
  // code is 200 whether the API is ok or degraded, so read status rather than
  // catching an error. The answer is cached for 10 seconds, so polling faster
  // than that buys nothing.
  async getHealth(): Promise<GetHealthResponse> {
    return this.request<GetHealthResponse>("GET", "/health", {
      isPublicEndpoint: true,
    });
  }

  // The same health aggregated per UTC day, oldest first, from a sample taken
  // once a minute and kept for 90 days. This one needs no API key either, and
  // its answer is cached for 60 seconds.
  async getHealthHistory(
    params: GetHealthHistoryParams = {},
  ): Promise<GetHealthHistoryResponse> {
    const { days } = params;

    return this.request<GetHealthHistoryResponse>("GET", "/health/history", {
      query: { days },
      isPublicEndpoint: true,
    });
  }

  // Public counts about yeetpost as a whole, and the platforms a post can go
  // out to today. Nothing here is about one account, so it needs no API key
  // either. The answer is cached for 60 seconds, and the endpoint has its own
  // limit of 60 requests a minute per IP.
  async getStats(): Promise<GetStatsResponse> {
    return this.request<GetStatsResponse>("GET", "/stats", {
      isPublicEndpoint: true,
    });
  }

  // The OpenAPI document this client was written against. It needs no API key
  // either, so a client built with an empty one can read it.
  async getOpenapiSpec(): Promise<GetOpenapiSpecResponse> {
    return this.request<GetOpenapiSpecResponse>("GET", "/openapi.json", {
      isPublicEndpoint: true,
    });
  }
}

//
// Connect redirects
//

// What the hosted page adds to your redirectUrl when the end customer comes
// back. connectionId, profileId, slug and platform are there when an account
// was connected, and error instead when it was not, so a redirect never
// carries both.
export interface ConnectRedirect {
  // Empty when the query carried none, which means it did not come from a
  // connect link.
  connectSessionId: string;
  connectionId?: string;
  profileId?: string;
  slug?: string;
  platform?: string;
  // "cancelled" when the customer backed out, "connect_failed" when the
  // platform refused. Both mean the same thing to you: show the button again.
  error?: string;
}

// The query, however the caller got hold of it.
const getSearchParams = (
  query:
    | URLSearchParams
    | string
    | Record<string, string | string[] | undefined>,
): URLSearchParams => {
  if (query instanceof URLSearchParams) {
    return query;
  }

  if (typeof query === "string") {
    return new URLSearchParams(query);
  }

  const parameters = new URLSearchParams();

  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }

    // A repeated parameter arrives as an array, and the first value is the one
    // the page put there
    parameters.set(name, Array.isArray(value) ? (value[0] ?? "") : value);
  }

  return parameters;
};

// Reads what the hosted page put on the query your end customer landed back
// on. It takes a URLSearchParams, a query string, or the parsed object a
// framework such as Express hands you.
//
// This is a browser coming back, so nothing here is proof of anything: read
// the connection off getConnectSession or off the connection.created webhook
// before you store it against a customer.
export const parseConnectRedirect = (
  query:
    | URLSearchParams
    | string
    | Record<string, string | string[] | undefined>,
): ConnectRedirect => {
  const parameters = getSearchParams(query);

  const redirect: ConnectRedirect = {
    connectSessionId: parameters.get("connectSessionId") ?? "",
  };

  const connectionId = parameters.get("connectionId");
  const profileId = parameters.get("profileId");
  const slug = parameters.get("slug");
  const platform = parameters.get("platform");
  const error = parameters.get("error");

  if (connectionId !== null) {
    redirect.connectionId = connectionId;
  }

  if (profileId !== null) {
    redirect.profileId = profileId;
  }

  if (slug !== null) {
    redirect.slug = slug;
  }

  if (platform !== null) {
    redirect.platform = platform;
  }

  if (error !== null) {
    redirect.error = error;
  }

  return redirect;
};

//
// Webhooks
//

export interface VerifyWebhookSignatureParams {
  // The raw request body, before any JSON parsing. Re-serialising it changes
  // the bytes that were signed.
  body: string | Buffer;
  // The x-yeetpost-signature header, "t=<unix seconds>,v1=<hex hmac-sha256>".
  signatureHeader: string;
  // The secret from the create-webhook response, "yp_whsec_…".
  secret: string;
  // How far the delivery's timestamp may be from your clock, in seconds.
  toleranceSeconds?: number;
}

// Verifies a delivery: the signature matches the body, and the delivery is
// recent enough that a captured one cannot be replayed at you later.
export const verifyWebhookSignature = (
  params: VerifyWebhookSignatureParams,
): boolean => {
  const { body, signatureHeader, secret, toleranceSeconds = 300 } = params;

  const match = signatureHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);

  if (!match) {
    return false;
  }

  const timestampSeconds = Number(match[1]);
  const signature = match[2];

  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);

  if (ageSeconds > toleranceSeconds) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestampSeconds}.`)
    .update(body)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expected, "hex"),
  );
};
