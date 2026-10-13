package yeetpost

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is production. Point somewhere else with WithBaseURL.
const DefaultBaseURL = "https://api.yeetpost.com/api/v2"

// DefaultTimeout is how long the built-in http client waits for one call.
const DefaultTimeout = 30 * time.Second

// DefaultWebhookTolerance is how far a delivery's timestamp may be from your
// clock before VerifyWebhookSignature refuses it. Five minutes, as the API
// documents.
const DefaultWebhookTolerance = 5 * time.Minute

// The headers every webhook delivery carries.
const (
	HeaderSignature = "x-yeetpost-signature"
	HeaderEvent     = "x-yeetpost-event"
	HeaderEventID   = "x-yeetpost-event-id"
	HeaderDelivery  = "x-yeetpost-delivery"
	HeaderMode      = "x-yeetpost-mode"
)

//
// Errors
//

// APIError is every non-2xx answer from the API.
//
// The API answers a failure with {"error", "message"}, plus "req_id" on
// platform_rejected and internal_server_error. The one exception is 429, whose
// body is {"error": "too many requests"} and carries no message and no code
// from the vocabulary, so on a 429 the code is that literal string and the
// thing to branch on is StatusCode.
type APIError struct {
	StatusCode int
	Code       string
	Message    string
	// RequestID is the x-request-id header, which is the same value the body
	// carries as req_id on platform_rejected and internal_server_error. Empty
	// when the response carried neither. Quote it when you report a problem.
	RequestID string
	// RateLimitLimit, RateLimitRemaining and RateLimitReset are the
	// x-ratelimit-* headers: the requests allowed in the current window, the
	// requests left in it, and the unix second it has room again. Each is -1
	// when the response did not carry the header, which is the case on 401 and
	// on 500.
	RateLimitLimit     int
	RateLimitRemaining int
	RateLimitReset     int64
}

func (apiError *APIError) Error() string {
	return fmt.Sprintf("yeetpost: %d %s: %s", apiError.StatusCode, apiError.Code, apiError.Message)
}

// ErrMalformedSignature is what VerifyWebhookSignature answers with when the
// x-yeetpost-signature header is not "t=<unix seconds>,v1=<hex hmac-sha256>" at
// all. A header that parses but does not match the body is a plain false.
//
// It is a parse failure on a header somebody else wrote, not a fault of yours,
// so answer it the same way you answer a false: reject the delivery. It is
// never a 500.
var ErrMalformedSignature = errors.New("yeetpost: malformed x-yeetpost-signature header")

//
// Responses
//

// PostStatus is where a post is. Scheduled is waiting to be sent, processing is
// being sent right now, draft is stored and has gone nowhere, cancelled was a
// scheduled post you cancelled, and deleted was sent and then taken back down on
// its platform. A result from CreatePosts is only ever sent, scheduled, draft or
// failed.
type PostStatus string

const (
	PostStatusSent       PostStatus = "sent"
	PostStatusScheduled  PostStatus = "scheduled"
	PostStatusProcessing PostStatus = "processing"
	PostStatusDraft      PostStatus = "draft"
	PostStatusFailed     PostStatus = "failed"
	PostStatusCancelled  PostStatus = "cancelled"
	PostStatusDeleted    PostStatus = "deleted"
)

// HealthStatus is what GET /health answers with. Degraded means at least one of
// its checks is not ok.
type HealthStatus string

const (
	HealthStatusOK       HealthStatus = "ok"
	HealthStatusDegraded HealthStatus = "degraded"
)

// DeliveryStatus is where a webhook delivery is. Failed means the webhook was
// deleted under it; dead ran out of attempts and is only sent again by a replay.
type DeliveryStatus string

const (
	DeliveryStatusPending    DeliveryStatus = "pending"
	DeliveryStatusProcessing DeliveryStatus = "processing"
	DeliveryStatusDelivered  DeliveryStatus = "delivered"
	DeliveryStatusFailed     DeliveryStatus = "failed"
	DeliveryStatusDead       DeliveryStatus = "dead"
)

// DeliveryStatusFilter is the subset of DeliveryStatus the delivery log can be
// filtered by. There is no processing filter: a delivery is only in that state
// while a worker holds it, which is too brief a window to page.
type DeliveryStatusFilter string

const (
	DeliveryStatusFilterPending   DeliveryStatusFilter = "pending"
	DeliveryStatusFilterDelivered DeliveryStatusFilter = "delivered"
	DeliveryStatusFilterFailed    DeliveryStatusFilter = "failed"
	DeliveryStatusFilterDead      DeliveryStatusFilter = "dead"
)

// EventName is one of the seven events a webhook can be subscribed to, and
// the value a delivery carries in x-yeetpost-event.
type EventName string

const (
	EventPostSent                    EventName = "post.sent"
	EventPostFailed                  EventName = "post.failed"
	EventPostDeleted                 EventName = "post.deleted"
	EventPostMetrics                 EventName = "post.metrics"
	EventConnectionCreated           EventName = "connection.created"
	EventConnectionRemoved           EventName = "connection.removed"
	EventConnectionReconnectRequired EventName = "connection.reconnect_required"
)

// ConnectionEventName is the subset of EventName a connection delivery can
// carry. A connection event is about an account rather than a post, so only
// these three ever arrive on a ConnectionEvent.
type ConnectionEventName string

const (
	ConnectionEventNameCreated           ConnectionEventName = "connection.created"
	ConnectionEventNameRemoved           ConnectionEventName = "connection.removed"
	ConnectionEventNameReconnectRequired ConnectionEventName = "connection.reconnect_required"
)

// ConnectPlatform is a platform a connect link can be opened for. Leave it
// empty and the end customer picks one on the page. A test key may only name
// ConnectPlatformSandbox, which is how the whole flow runs in CI. Reddit,
// Facebook, Instagram and Threads are listed only once the API has an app for
// them: a platform it cannot connect is a 400 invalid_request.
type ConnectPlatform string

const (
	ConnectPlatformLinkedIn       ConnectPlatform = "linkedin"
	ConnectPlatformX              ConnectPlatform = "x"
	ConnectPlatformBluesky        ConnectPlatform = "bluesky"
	ConnectPlatformMastodon       ConnectPlatform = "mastodon"
	ConnectPlatformDiscord        ConnectPlatform = "discord"
	ConnectPlatformTelegram       ConnectPlatform = "telegram"
	ConnectPlatformSandbox        ConnectPlatform = "sandbox"
	ConnectPlatformReddit         ConnectPlatform = "reddit"
	ConnectPlatformFacebook       ConnectPlatform = "facebook"
	ConnectPlatformInstagram      ConnectPlatform = "instagram"
	ConnectPlatformThreads        ConnectPlatform = "threads"
	ConnectPlatformGoogleBusiness ConnectPlatform = "google_business"
)

// ConnectSessionStatus is where a connect link stands. Pending is a customer
// who still has it open, connected is an account that came in, failed is a
// customer who cancelled or a platform that refused, and expired is fifteen
// minutes gone with nothing happening.
type ConnectSessionStatus string

const (
	ConnectSessionStatusPending   ConnectSessionStatus = "pending"
	ConnectSessionStatusConnected ConnectSessionStatus = "connected"
	ConnectSessionStatusFailed    ConnectSessionStatus = "failed"
	ConnectSessionStatusExpired   ConnectSessionStatus = "expired"
)

// ConnectError is why the customer came back without a connection. Both mean
// the same thing to you: show the button again.
type ConnectError string

const (
	ConnectErrorCancelled     ConnectError = "cancelled"
	ConnectErrorConnectFailed ConnectError = "connect_failed"
)

// MediaContentType is one of the four image types the API takes.
type MediaContentType string

const (
	MediaContentTypePNG  MediaContentType = "image/png"
	MediaContentTypeJPEG MediaContentType = "image/jpeg"
	MediaContentTypeGIF  MediaContentType = "image/gif"
	MediaContentTypeWebP MediaContentType = "image/webp"
)

// APIKeyType is what a key can do. A live key posts for real; a test key
// reaches the sandbox only, and can only ever mint more test keys.
type APIKeyType string

const (
	APIKeyTypeLive APIKeyType = "live"
	APIKeyTypeTest APIKeyType = "test"
)

// QueueSlot is one posting slot on the connection's own clock. Weekday 0 is
// Sunday, and Time is 24 hour "HH:MM".
type QueueSlot struct {
	Weekday int    `json:"weekday"`
	Time    string `json:"time"`
}

// Connection is one account or channel you can post to.
type Connection struct {
	// ID is the connection's id, which the queue endpoints take in their path.
	ID string `json:"id"`
	// Slug is the identifier you post to, for example linkedin or alexdoe_x.
	Slug string `json:"slug"`
	// PlatformID is which platform is behind the slug: linkedin, x, bluesky,
	// discord, telegram, mastodon, reddit, facebook, instagram, threads,
	// google_business, sms, email, slack or sandbox. Branch on this rather than
	// on the wording of Description: sms, email and slack are messaging
	// channels, the rest are places you broadcast to. It is a string rather
	// than a closed set, because the set grows as platforms land.
	PlatformID  string `json:"platformId"`
	Description string `json:"description"`
	// ProfileID is the profile the connection belongs to, and nil when it is one
	// of your own accounts rather than an end customer's.
	ProfileID *string `json:"profileId"`
	// Timezone is the IANA zone the posting slots are read in, for example
	// Europe/Helsinki. UTC until you set one.
	Timezone string `json:"timezone"`
	// QueueSlots are the connection's posting slots, in the order they were set.
	// Empty when the connection has no queue.
	QueueSlots []QueueSlot `json:"queueSlots"`
	// Status is reconnect_required once the stored login has actually failed,
	// expiring while it still works but will stop soon, and active otherwise.
	Status string `json:"status"`
	// LoginExpiresAt is set only while Status is expiring: when the login runs
	// out. Nil the rest of the time, including once it already needs a
	// reconnect.
	LoginExpiresAt *string `json:"loginExpiresAt"`
}

type ConnectionsResponse struct {
	Connections []Connection `json:"connections"`
}

type GetConnectionResponse struct {
	Connection Connection `json:"connection"`
}

// UpdateConnectionResponse is the connection where it now sits, the same shape
// GetConnection answers with.
type UpdateConnectionResponse struct {
	Connection Connection `json:"connection"`
}

// DeleteConnectionResponse is what DELETE /connections/{connectionId}
// answers with.
type DeleteConnectionResponse struct {
	ID      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

// Profile is one of your end customers, and the connections you made for them.
type Profile struct {
	ID string `json:"id"`
	// Name is what you call this end customer. It is shown in the console and
	// never sent to a platform.
	Name string `json:"name"`
	// ExternalID is your own id for the same end customer, unique across your
	// account. It is nil when you did not give one.
	ExternalID *string `json:"externalId"`
	CreatedAt  string  `json:"createdAt"`
}

type CreateProfileResponse struct {
	Profile Profile `json:"profile"`
}

type GetProfilesResponse struct {
	Profiles []Profile `json:"profiles"`
	Limit    int       `json:"limit"`
	Offset   int       `json:"offset"`
}

type GetProfileResponse struct {
	Profile Profile `json:"profile"`
}

type UpdateProfileResponse struct {
	Profile Profile `json:"profile"`
}

type DeleteProfileResponse struct {
	ID      string `json:"id"`
	Deleted bool   `json:"deleted"`
	// RemovedConnections is how many connections went with the profile.
	RemovedConnections int `json:"removedConnections"`
}

// APIKey is one key of your account, without its secret. The secret is
// answered once, by CreateProfileKey. No API endpoint reads the secret back,
// though the account owner can reveal any key in the console.
type APIKey struct {
	ID string `json:"id"`
	// Name is what you call this key. It is shown in the console and never sent
	// to a platform.
	Name string     `json:"name"`
	Type APIKeyType `json:"type"`
	// Prefix is the readable head of the key, which is what the console lists it
	// by.
	Prefix string `json:"prefix"`
	// ProfileID is the profile the key is scoped to, and nil on an account key.
	ProfileID *string `json:"profileId"`
	// RedirectAllowlist is the origins a connect redirect from this key may land
	// on, and nil when the key has none and any https url on a public host is
	// accepted.
	RedirectAllowlist []string `json:"redirectAllowlist"`
	CreatedAt         string   `json:"createdAt"`
	// LastUsedAt is when the key last made a request, and nil while it never
	// has.
	LastUsedAt *string `json:"lastUsedAt"`
	// RevokedAt is when the key was revoked, and nil while it still works.
	RevokedAt *string `json:"revokedAt"`
}

// CreateAPIKeyResponse is a freshly minted key. The secret is in this one
// response and nowhere else: no API endpoint reads the secret back, though the
// account owner can reveal any key in the console.
type CreateAPIKeyResponse struct {
	Key APIKey `json:"key"`
	// Secret is the raw key. Store it now.
	Secret string `json:"secret"`
}

type GetAPIKeysResponse struct {
	Keys   []APIKey `json:"keys"`
	Limit  int      `json:"limit"`
	Offset int      `json:"offset"`
}

type RevokeAPIKeyResponse struct {
	ID      string `json:"id"`
	Revoked bool   `json:"revoked"`
}

// CreateConnectSessionResponse is the hosted url, its expiry and the session id.
type CreateConnectSessionResponse struct {
	// URL is the page to send your end customer to. It carries a single use
	// token, and this is the only time it is shown: only its hash is stored, so
	// it cannot be read back.
	URL string `json:"url"`
	// ExpiresAt is when the link stops working, fifteen minutes out.
	ExpiresAt string `json:"expiresAt"`
	// ConnectSessionID comes back on the redirect and on the connection.created
	// event, and is what GetConnectSession answers for.
	ConnectSessionID string `json:"connectSessionId"`
}

// ConnectSession is how one connect link ended.
type ConnectSession struct {
	ID        string `json:"id"`
	ProfileID string `json:"profileId"`
	// Platform is the platform the link was opened for, and nil when the end
	// customer picks one on the page.
	Platform *ConnectPlatform     `json:"platform"`
	Status   ConnectSessionStatus `json:"status"`
	// ConnectionID is the connection that was made, and nil until one is.
	ConnectionID *string `json:"connectionId"`
	// Error is why the customer came back without a connection, and nil
	// otherwise.
	Error       *ConnectError `json:"error"`
	RedirectURL string        `json:"redirectUrl"`
	Headless    bool          `json:"headless"`
	ExpiresAt   string        `json:"expiresAt"`
	CreatedAt   string        `json:"createdAt"`
}

type GetConnectSessionResponse struct {
	ConnectSession ConnectSession `json:"connectSession"`
}

// QueuedPost is one post waiting in a connection's queue.
type QueuedPost struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	// ScheduledFor is the slot this post took, in ISO 8601 UTC.
	ScheduledFor string `json:"scheduledFor"`
	// MediaCount is how many images the post carries.
	MediaCount int `json:"mediaCount"`
}

type GetConnectionQueueResponse struct {
	// Queue is the posts waiting in this connection's queue, earliest slot
	// first.
	Queue []QueuedPost `json:"queue"`
	// Paused is true while the queue is held: nothing waiting here goes out
	// until it is resumed. A post scheduled by hand, rather than taking one
	// of these slots, still goes out on time regardless.
	Paused bool `json:"paused"`
}

// UpdateConnectionQueueResponse is the narrower connection shape the queue
// update answers with: the id, the slug, and what the queue now runs on.
type UpdateConnectionQueueResponse struct {
	Connection struct {
		ID         string      `json:"id"`
		Slug       string      `json:"slug"`
		Timezone   string      `json:"timezone"`
		QueueSlots []QueueSlot `json:"queueSlots"`
		Paused     bool        `json:"paused"`
	} `json:"connection"`
}

// LegacyPostResponse is what POST /post/{connectionSlug} answers with. It is
// one of three shapes, and which one you get depends on the platform and on
// whether the post was scheduled: Platform and Link for a published post,
// Platform and Sent for a messaging channel, Scheduled and ScheduledFor for a
// post that goes out later.
type LegacyPostResponse struct {
	Platform     string `json:"platform"`
	Link         string `json:"link"`
	Sent         bool   `json:"sent"`
	Scheduled    bool   `json:"scheduled"`
	ScheduledFor string `json:"scheduled_for"`
}

// PostError is why a post did not make it. The code comes from the same
// vocabulary as the top-level error code.
type PostError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// PostResult is what happened on one connection. Timestamps are ISO 8601 in
// UTC, and a field the API can send as null is a pointer.
type PostResult struct {
	ConnectionSlug string     `json:"connectionSlug"`
	Status         PostStatus `json:"status"`
	// PostID is nil when nothing was stored, for example when the slug did not
	// match a connection.
	PostID *string `json:"postId"`
	// URL is the permalink, for platforms that return one. It is nil for SMS,
	// email, Slack and for scheduled posts.
	URL          *string `json:"url"`
	ScheduledFor *string `json:"scheduledFor"`
	// ThreadCount is how many replies actually went out under the head post.
	ThreadCount int `json:"threadCount"`
	// HasFirstComment is false when none was asked for, and false when the
	// platform refused it, which does not fail the post.
	HasFirstComment bool `json:"hasFirstComment"`
	// Warning is set only when AI polish was asked for and failed: the post
	// went out under its original text. Empty on every other result.
	Warning string     `json:"warning,omitempty"`
	Error   *PostError `json:"error"`
}

// Results is one entry per connection, in the order the slugs were given.
type Results []PostResult

// Failed is the results that did not go out. A connection failing comes back
// here rather than as an error, so this is what a caller checks after every
// CreatePosts.
func (results Results) Failed() Results {
	failed := Results{}

	for _, result := range results {
		if result.Status == PostStatusFailed {
			failed = append(failed, result)
		}
	}

	return failed
}

type CreatePostsResponse struct {
	Results Results `json:"results"`
}

// Post is one post, on one connection. Timestamps are ISO 8601 in UTC.
type Post struct {
	ID             string `json:"id"`
	ConnectionSlug string `json:"connectionSlug"`
	// ProfileID is the profile the post's connection belongs to, and nil when it
	// is one of your own accounts.
	ProfileID *string `json:"profileId"`
	Text      string  `json:"text"`
	// OriginalText is what the caller actually sent, equal to Text unless AI
	// polish rewrote this post.
	OriginalText string `json:"originalText"`
	// AiRewriteStatus is nil when AI polish never touched this post,
	// "rewritten" when Text is the model's own words, "failed" when AI polish
	// tried and failed (Text is the original after all), and "skipped" when
	// the post's shape does not support a rewrite.
	AiRewriteStatus *string    `json:"aiRewriteStatus"`
	Status          PostStatus `json:"status"`
	URL             *string    `json:"url"`
	ScheduledFor    *string    `json:"scheduledFor"`
	CreatedAt       string     `json:"createdAt"`
	// Tags are your own labels for the post, lowercase and deduped.
	Tags []string `json:"tags"`
	// PlatformPostID is the platform's own id for the head post: a tweet id, an
	// at-uri, a status id, a message id or a LinkedIn urn. It is what a delete
	// works from, and it is nil on a post that never reached a platform and on
	// one sent before yeetpost recorded these.
	PlatformPostID *string `json:"platformPostId"`
	// DeletedAt is when the post was deleted on its platform, and nil while it is
	// still up.
	DeletedAt *string    `json:"deletedAt"`
	Error     *PostError `json:"error"`
	// Media are the images attached to the post, in posting order.
	Media []PostMedia `json:"media"`
	// Thread is the reply chain under the head post, as it was given. Empty for
	// a single post, which is every post made before shapes shipped.
	Thread []string `json:"thread"`
	// FirstComment is the author's own comment under the share, and nil when
	// there is none.
	FirstComment *string `json:"firstComment"`
	// PublishedAt is when the post actually went out, and nil while it is still
	// a draft, still pending, or never sent at all.
	PublishedAt *string `json:"publishedAt"`
}

// PostMedia is one image attached to a post.
type PostMedia struct {
	ID string `json:"id"`
	// AltText is nil when none was given.
	AltText *string `json:"altText"`
}

type GetPostsResponse struct {
	Posts  []Post `json:"posts"`
	Limit  int    `json:"limit"`
	Offset int    `json:"offset"`
}

type GetPostResponse struct {
	Post Post `json:"post"`
}

// MetricsRead is one read of a post's numbers. Every counter is a running
// total, so the newest read is the post's numbers now.
//
// A nil field means the platform does not report that number, which is not the
// same as zero: Bluesky and Mastodon give likes, reposts and replies; LinkedIn
// gives likes and comments on any share, and impressions and clicks only on a
// page; X gives impressions, likes, reposts and replies, and only when X
// analytics is on for the account, because X charges for the read.
type MetricsRead struct {
	FetchedAt   string `json:"fetchedAt"`
	Impressions *int   `json:"impressions"`
	Likes       *int   `json:"likes"`
	Reposts     *int   `json:"reposts"`
	Replies     *int   `json:"replies"`
	Clicks      *int   `json:"clicks"`
}

// GetPostMetricsResponse is one post's numbers: the newest read, and every read
// before it.
type GetPostMetricsResponse struct {
	// Latest is nil until the first read, which is an hour after the post goes
	// out.
	Latest *MetricsRead `json:"latest"`
	// History is every read, oldest first. A post is read hourly for 48 hours
	// and then daily until it is 30 days old.
	History []MetricsRead `json:"history"`
}

// AnalyticsTotals is a window summed up.
type AnalyticsTotals struct {
	Posts       int `json:"posts"`
	Impressions int `json:"impressions"`
	Likes       int `json:"likes"`
	Reposts     int `json:"reposts"`
	Replies     int `json:"replies"`
	Clicks      int `json:"clicks"`
}

// AnalyticsDay is one UTC day of a window. A post counts on the day it went
// out, and its numbers count with it.
type AnalyticsDay struct {
	Day         string `json:"day"`
	Posts       int    `json:"posts"`
	Impressions int    `json:"impressions"`
	Likes       int    `json:"likes"`
	Reposts     int    `json:"reposts"`
	Replies     int    `json:"replies"`
}

// AnalyticsPlatform is one platform's share of a window.
type AnalyticsPlatform struct {
	PlatformID  string `json:"platformId"`
	Posts       int    `json:"posts"`
	Impressions int    `json:"impressions"`
	Likes       int    `json:"likes"`
	Reposts     int    `json:"reposts"`
	Replies     int    `json:"replies"`
	Clicks      int    `json:"clicks"`
}

// GetAnalyticsResponse is every post that went out in a window, with the newest
// numbers read for each of them.
type GetAnalyticsResponse struct {
	Totals AnalyticsTotals `json:"totals"`
	// Days is one entry per UTC day of the window, gaps included, so it charts
	// as it comes.
	Days []AnalyticsDay `json:"days"`
	// ByPlatform is the same window split by platform. A platform with no posts
	// in it is not listed.
	ByPlatform []AnalyticsPlatform `json:"byPlatform"`
	// From and To are the window, as whole UTC days, both ends included.
	From string `json:"from"`
	To   string `json:"to"`
}

// GetAnalyticsParams narrows a window. Leave From and To empty for the last 30
// days, which is exactly as long as a post's numbers are refreshed for. The
// longest window is 365 days.
type GetAnalyticsParams struct {
	// From and To are whole UTC days, "YYYY-MM-DD", both ends included.
	From           string
	To             string
	ProfileID      string
	Platform       string
	ConnectionSlug string
}

// UpdatePostResponse is the draft as it stands after the edit.
type UpdatePostResponse struct {
	Post Post `json:"post"`
}

// PublishPostResponse is the same per-connection item CreatePosts answers with,
// for the connection the draft was stored against.
type PublishPostResponse struct {
	Result PostResult `json:"result"`
}

// DeletePostResponse is what DELETE /posts/{postId} answers with. One endpoint,
// three shapes, decided by what the post was, and folded into one struct the way
// LegacyPostResponse folds its three: a scheduled post is cancelled and comes
// back with Status cancelled, a draft is really deleted and comes back with
// Deleted true, and a post that already went out comes down on its platform and
// comes back with Status deleted and a DeletedAt. Read Status and Deleted to
// tell which happened.
type DeletePostResponse struct {
	ID      string     `json:"id"`
	Status  PostStatus `json:"status"`
	Deleted bool       `json:"deleted"`
	// DeletedAt is when the post came down on its platform, and nil on a
	// cancelled post and on a deleted draft.
	DeletedAt *string `json:"deletedAt"`
}

// CancelPostResponse is the name DeletePostResponse had while this call could
// only cancel. It is an alias rather than a struct of its own, so code written
// against the old name keeps compiling and reads the same answer.
type CancelPostResponse = DeletePostResponse

// RetryPostResponse is what POST /posts/{postId}/retry answers with on
// success.
type RetryPostResponse struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	// Warning is set only when AI polish was asked for and failed: the post
	// went out under its original text. Empty on every other result.
	Warning string `json:"warning,omitempty"`
}

type CreateMediaResponse struct {
	// MediaID is the id you attach to a post. Uploading the same bytes again
	// answers with this same id.
	MediaID     string           `json:"mediaId"`
	ContentType MediaContentType `json:"contentType"`
	SizeBytes   int              `json:"sizeBytes"`
}

// GetMediaResponse is the image itself. The API answers this one with the bytes
// rather than with JSON, so the client builds it from the response.
type GetMediaResponse struct {
	Bytes       []byte
	ContentType MediaContentType
}

type DeleteMediaResponse struct {
	ID      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

// HealthDatabaseCheck is a real query against the database, and how long it took.
type HealthDatabaseCheck struct {
	OK        bool `json:"ok"`
	LatencyMs int  `json:"latencyMs"`
}

// HealthWorkerCheck is one background worker loop. OK is false when the loop has
// not finished an iteration within three of its own intervals, and when it has
// never finished one at all.
type HealthWorkerCheck struct {
	OK bool `json:"ok"`
	// LastRunAt is when the loop last ran, whether or not that iteration
	// finished.
	LastRunAt *string `json:"lastRunAt"`
	// LastOkAt is when the loop last finished an iteration.
	LastOkAt *string `json:"lastOkAt"`
}

// GetHealthResponse is whether the API answers and whether each of its
// background loops has finished one recently. The status code is 200 whether the
// API is ok or degraded, so read Status rather than the code.
type GetHealthResponse struct {
	Status HealthStatus `json:"status"`
	Checks struct {
		Database          HealthDatabaseCheck `json:"database"`
		ScheduledPosts    HealthWorkerCheck   `json:"scheduledPosts"`
		WebhookDeliveries HealthWorkerCheck   `json:"webhookDeliveries"`
		XUsageSweep       HealthWorkerCheck   `json:"xUsageSweep"`
		PostMetrics       HealthWorkerCheck   `json:"postMetrics"`
	} `json:"checks"`
	// Version is the API version that answered.
	Version string `json:"version"`
	// Time is when the health was measured, ISO 8601 UTC. The answer is cached
	// for 10 seconds, so it can be that much behind.
	Time string `json:"time"`
}

// HealthDay is one UTC day of uptime. What is measured is minutes, not samples:
// a day owes 1440 of them, today owes the ones already behind it, and a minute
// with no sample counts as degraded exactly like a sample that came back
// degraded.
type HealthDay struct {
	// Day is the UTC day, YYYY-MM-DD.
	Day string `json:"day"`
	// UptimePercent is the ok minutes over the minutes the day owed, to two
	// decimals. It is nil when the day was over before the first sample was ever
	// taken: nobody was watching it, so it is unmeasured rather than down.
	UptimePercent *float64 `json:"uptimePercent"`
	// Samples is how many of that day's minutes got a sample. A full day is 1440,
	// and anything less is a stretch the API did not report in.
	Samples int `json:"samples"`
	// DegradedMinutes is the minutes of that day that were not ok, the ones with
	// no sample included. It is zero for an unmeasured day.
	DegradedMinutes int `json:"degradedMinutes"`
}

// GetHealthHistoryResponse is one aggregate per UTC day, oldest first. Every day
// of the window is in it, so a day that was sampled and came back with nothing
// is 0 percent rather than missing.
type GetHealthHistoryResponse struct {
	Days []HealthDay `json:"days"`
}

// GetStatsResponse is public numbers about yeetpost as a whole, which is what
// the marketing site's proof pill draws. Nothing here is about one account.
type GetStatsResponse struct {
	// PostsThisWeek and PostsAllTime are posts that reached a platform in the
	// last 7 days, and ever: no error, not a draft, not taken down, not still
	// waiting in a queue. Sandbox connections and test-key traffic are left
	// out. Whole numbers exactly as counted, so round them yourself.
	PostsThisWeek int `json:"postsThisWeek"`
	PostsAllTime  int `json:"postsAllTime"`
	// LiveConnections is the connections that can be posted to right now,
	// sandbox ones left out.
	LiveConnections int `json:"liveConnections"`
	// PlatformsLive is the platform ids a post can go out to today, such as
	// linkedin or x.
	PlatformsLive []string `json:"platformsLive"`
	// Time is when the counts were taken, ISO 8601 UTC. The answer is cached
	// for 60 seconds, so it can be that much behind.
	Time string `json:"time"`
}

// GetOpenapiSpecResponse is the OpenAPI 3.1 document itself. It is the spec's
// own shape rather than one of ours, so it comes back as the decoded document
// rather than as a struct.
type GetOpenapiSpecResponse map[string]any

type Webhook struct {
	ID        string      `json:"id"`
	URL       string      `json:"url"`
	Events    []EventName `json:"events"`
	CreatedAt string      `json:"createdAt"`
}

// WebhookWithSecret is a freshly registered webhook. The secret is in this one
// response and nowhere else, ever.
type WebhookWithSecret struct {
	ID        string      `json:"id"`
	URL       string      `json:"url"`
	Events    []EventName `json:"events"`
	Secret    string      `json:"secret"`
	CreatedAt string      `json:"createdAt"`
}

type CreateWebhookResponse struct {
	Webhook WebhookWithSecret `json:"webhook"`
}

type GetWebhooksResponse struct {
	Webhooks []Webhook `json:"webhooks"`
}

type DeleteWebhookResponse struct {
	ID      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

// WebhookDelivery is one attempt series at delivering one event to one webhook.
type WebhookDelivery struct {
	ID string `json:"id"`
	// EventID is what the delivery carries in x-yeetpost-event-id and in the
	// eventId field of its body. It is the delivery id: one event, one id,
	// every attempt and every replay of it. Deduplicate on it.
	EventID string         `json:"eventId"`
	Event   EventName      `json:"event"`
	Status  DeliveryStatus `json:"status"`
	// Attempts is how many times it has been sent. Up to 7, and back to 0 after
	// a replay.
	Attempts      int     `json:"attempts"`
	CreatedAt     string  `json:"createdAt"`
	NextAttemptAt string  `json:"nextAttemptAt"`
	DeliveredAt   *string `json:"deliveredAt"`
	DeadAt        *string `json:"deadAt"`
	// LastStatusCode is what your receiver answered the last attempt with, or
	// nil when the request never got a response.
	LastStatusCode *int `json:"lastStatusCode"`
	// LastError is our own one-line summary of why the last attempt did not
	// land, never your receiver's response body.
	LastError *string `json:"lastError"`
}

type GetWebhookDeliveriesResponse struct {
	Deliveries []WebhookDelivery `json:"deliveries"`
	Limit      int               `json:"limit"`
	// HasMore is whether there is another page. Ask for it with StartingAfter
	// set to the id of the last delivery here.
	HasMore bool `json:"hasMore"`
}

type ReplayWebhookDeliveryResponse struct {
	Delivery WebhookDelivery `json:"delivery"`
}

type SendWebhookTestEventResponse struct {
	Delivery WebhookDelivery `json:"delivery"`
}

// EventPost is the post a webhook event is about. The media ids are left out on
// purpose: read the bytes back with GetMedia if you need them.
type EventPost struct {
	ID             string `json:"id"`
	ConnectionSlug string `json:"connectionSlug"`
	// ProfileID is the profile the post's connection belongs to, and nil when it
	// is one of your own accounts.
	ProfileID       *string    `json:"profileId"`
	Text            string     `json:"text"`
	Status          PostStatus `json:"status"`
	URL             *string    `json:"url"`
	ScheduledFor    *string    `json:"scheduledFor"`
	CreatedAt       string     `json:"createdAt"`
	Tags            []string   `json:"tags"`
	MediaCount      int        `json:"mediaCount"`
	ThreadCount     int        `json:"threadCount"`
	HasFirstComment bool       `json:"hasFirstComment"`
	Error           *PostError `json:"error"`
}

// Event is the body of a webhook delivery, for the receiver that verified it.
// EventID leads the body and matches the x-yeetpost-event-id header: it is the
// same value on every attempt and every replay, so it is what you dedupe on.
// Test is set only on the event SendTestEvent enqueues.
type Event struct {
	EventID   string    `json:"eventId"`
	Event     EventName `json:"event"`
	Timestamp string    `json:"timestamp"`
	Test      bool      `json:"test,omitempty"`
	Post      EventPost `json:"post"`
}

// DeletedEventPost is the post a post.deleted event is about: which one is gone
// and where it stood.
type DeletedEventPost struct {
	ID             string `json:"id"`
	ConnectionSlug string `json:"connectionSlug"`
	// ProfileID is the profile the post's connection belongs to, and nil when it
	// is one of your own accounts.
	ProfileID *string `json:"profileId"`
	// PlatformID is the platform the post came down on, such as x or mastodon.
	PlatformID string `json:"platformId"`
	DeletedAt  string `json:"deletedAt"`
}

// PostDeletedEvent is the body of a post.deleted delivery. A deleted post is no
// longer a post, so the event says which one is gone rather than repeating its
// text one last time, which is why it is a shape of its own rather than an Event.
type PostDeletedEvent struct {
	EventID   string           `json:"eventId"`
	Event     EventName        `json:"event"`
	Timestamp string           `json:"timestamp"`
	Post      DeletedEventPost `json:"post"`
}

// MetricsEventPost is the post a post.metrics event is about.
type MetricsEventPost struct {
	ID             string `json:"id"`
	ConnectionSlug string `json:"connectionSlug"`
	// ProfileID is the profile the post's connection belongs to, and nil when it
	// is one of your own accounts.
	ProfileID *string `json:"profileId"`
	// PlatformID is the platform the numbers came from, such as x or mastodon.
	PlatformID string  `json:"platformId"`
	URL        *string `json:"url"`
}

// PostMetricsEvent is the body of a post.metrics delivery: a day's reading of a
// post's numbers, which is a shape of its own rather than an Event.
type PostMetricsEvent struct {
	EventID   string           `json:"eventId"`
	Event     EventName        `json:"event"`
	Timestamp string           `json:"timestamp"`
	Post      MetricsEventPost `json:"post"`
	Metrics   MetricsRead      `json:"metrics"`
}

// EventConnection is the account a connection event is about. The two ids
// together are the mapping to persist: the profile is your customer, the
// connection is what you post to.
type EventConnection struct {
	ID string `json:"id"`
	// ProfileID is the profile the connection belongs to, and nil when it is one
	// of your own accounts.
	ProfileID *string `json:"profileId"`
	// ConnectSessionID is the connect session the account came in through, and
	// nil when the connection was made in the console. It lets you file the
	// connection against the customer you made the link for without waiting for
	// their browser to come back.
	ConnectSessionID *string `json:"connectSessionId"`
	PlatformID       string  `json:"platformId"`
	Slug             string  `json:"slug"`
}

// ConnectionEvent is the body of a connection.created, connection.removed or
// connection.reconnect_required delivery. They fire when an account is
// connected, disconnected, or needs reconnecting, whether it went into one of
// your profiles or into your own account, and they carry a connection rather
// than a post, which is why they are a shape of their own rather than an
// Event.
type ConnectionEvent struct {
	EventID    string              `json:"eventId"`
	Event      ConnectionEventName `json:"event"`
	Timestamp  string              `json:"timestamp"`
	Connection EventConnection     `json:"connection"`
}

//
// Client
//

// Client is the yeetpost API client. One per API key, safe to share between
// goroutines.
type Client struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
}

// Option changes a client at construction. See WithBaseURL and WithHTTPClient.
type Option func(*Client)

// WithBaseURL points the client at something other than production, such as a
// local API on http://localhost:3901/api/v2.
func WithBaseURL(baseURL string) Option {
	return func(client *Client) {
		client.baseURL = strings.TrimRight(baseURL, "/")
	}
}

// WithHTTPClient hands the client your own http client, for your own timeout,
// transport or proxy.
func WithHTTPClient(httpClient *http.Client) Option {
	return func(client *Client) {
		client.httpClient = httpClient
	}
}

// New builds a client for one API key. An empty key is not refused here, and
// the x-api-key header is left off entirely when it is empty, so GetHealth,
// GetHealthHistory, GetStats and GetOpenapiSpec still work. Every other call
// answers 401 unauthorized.
func New(apiKey string, options ...Option) *Client {
	client := &Client{
		apiKey:     apiKey,
		baseURL:    DefaultBaseURL,
		httpClient: &http.Client{Timeout: DefaultTimeout},
	}

	for _, option := range options {
		option(client)
	}

	return client
}

// requestOptions is what varies between calls. A jsonBody is marshalled and
// sent as application/json; a rawBody goes out as it is, under contentType.
type requestOptions struct {
	query          url.Values
	jsonBody       any
	rawBody        []byte
	contentType    string
	idempotencyKey string
}

// do sets auth, sends the body, and turns any non-2xx into an *APIError before
// the caller sees it. The response body is read and closed here, so the
// response comes back only for its status and its headers.
func (client *Client) do(ctx context.Context, method string, path string, options requestOptions) (*http.Response, []byte, error) {
	requestURL := client.baseURL + path

	if len(options.query) > 0 {
		requestURL = requestURL + "?" + options.query.Encode()
	}

	var body []byte

	if options.jsonBody != nil {
		encoded, err := json.Marshal(options.jsonBody)
		if err != nil {
			return nil, nil, fmt.Errorf("yeetpost: could not encode the request body: %w", err)
		}

		body = encoded
	}

	if options.rawBody != nil {
		body = options.rawBody
	}

	request, err := http.NewRequestWithContext(ctx, method, requestURL, bytes.NewReader(body))
	if err != nil {
		return nil, nil, fmt.Errorf("yeetpost: could not build the request: %w", err)
	}

	// An empty key goes out as no header at all: the endpoints that need no key
	// take the request as it is, and the rest answer 401 unauthorized either
	// way.
	if client.apiKey != "" {
		request.Header.Set("x-api-key", client.apiKey)
	}

	if options.jsonBody != nil {
		request.Header.Set("content-type", "application/json")
	}

	if options.contentType != "" {
		request.Header.Set("content-type", options.contentType)
	}

	if options.idempotencyKey != "" {
		request.Header.Set("idempotency-key", options.idempotencyKey)
	}

	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, nil, fmt.Errorf("yeetpost: the request failed: %w", err)
	}

	defer response.Body.Close()

	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("yeetpost: could not read the response: %w", err)
	}

	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, nil, newAPIError(response, responseBody)
	}

	return response, responseBody, nil
}

// requestJSON is do plus decoding, which is every endpoint but GetMedia.
func (client *Client) requestJSON(ctx context.Context, method string, path string, options requestOptions, out any) error {
	response, responseBody, err := client.do(ctx, method, path, options)
	if err != nil {
		return err
	}

	if err := json.Unmarshal(responseBody, out); err != nil {
		return &APIError{
			StatusCode:         response.StatusCode,
			Code:               "internal_server_error",
			Message:            "the yeetpost api returned a response that was not json",
			RequestID:          response.Header.Get("x-request-id"),
			RateLimitLimit:     int(headerNumber(response.Header, "x-ratelimit-limit")),
			RateLimitRemaining: int(headerNumber(response.Header, "x-ratelimit-remaining")),
			RateLimitReset:     headerNumber(response.Header, "x-ratelimit-reset"),
		}
	}

	return nil
}

// headerNumber reads one of the numeric headers, or -1 when the response did
// not carry it.
func headerNumber(header http.Header, name string) int64 {
	value, err := strconv.ParseInt(header.Get(name), 10, 64)
	if err != nil {
		return -1
	}

	return value
}

func newAPIError(response *http.Response, responseBody []byte) *APIError {
	apiError := &APIError{
		StatusCode:         response.StatusCode,
		Code:               "internal_server_error",
		Message:            "the yeetpost api returned an error that was not json",
		RequestID:          response.Header.Get("x-request-id"),
		RateLimitLimit:     int(headerNumber(response.Header, "x-ratelimit-limit")),
		RateLimitRemaining: int(headerNumber(response.Header, "x-ratelimit-remaining")),
		RateLimitReset:     headerNumber(response.Header, "x-ratelimit-reset"),
	}

	var decoded any

	if err := json.Unmarshal(responseBody, &decoded); err != nil {
		return apiError
	}

	// A null, a string or a number is not an error body at all. An array is one
	// that carries no code, which is how the other sdks read it.
	fields, isObject := decoded.(map[string]any)
	_, isArray := decoded.([]any)

	if !isObject && !isArray {
		return apiError
	}

	code, hasCode := fields["error"].(string)

	if !hasCode {
		apiError.Message = "the yeetpost api returned an error without a code"
		return apiError
	}

	apiError.Code = code

	// The 429 body has no message field, so the code stands in for it there.
	apiError.Message = code

	message, hasMessage := fields["message"].(string)

	if hasMessage {
		apiError.Message = message
	}

	requestID, hasRequestID := fields["req_id"].(string)

	if apiError.RequestID == "" && hasRequestID {
		apiError.RequestID = requestID
	}

	return apiError
}

// PostToConnectionParams is the query of the one-liner endpoint.
type PostToConnectionParams struct {
	// ScheduledFor is an ISO 8601 timestamp to send at. It must be in the
	// future. Leave it empty to post immediately.
	ScheduledFor string
}

// ListConnectionsParams filters GET /connections. Pass nil for every
// connection of yours, your own accounts and your customers' both.
type ListConnectionsParams struct {
	// ProfileID narrows the list to the connections inside one profile. A
	// profile that is not one of yours is a 400 invalid_request rather than an
	// empty list.
	ProfileID string
}

// CreateProfileParams is the body of POST /profiles.
type CreateProfileParams struct {
	// Name is what you call this end customer, 1 to 100 characters.
	Name string `json:"name"`
	// ExternalID is your own id for the same end customer, 1 to 200 characters.
	// It is unique across your account: a second profile with the same one is
	// refused with 409 profile_external_id_conflict.
	ExternalID string `json:"externalId,omitempty"`
}

// ListProfilesParams pages GET /profiles. A zero Limit or Offset is left out,
// and the API defaults them to 25 and 0.
type ListProfilesParams struct {
	Limit  int
	Offset int
}

// UpdateProfileParams is the body of PATCH /profiles/{profileId}. Send a name,
// an external id, or both: only what you send is written, so a field left at
// its zero value keeps what the profile had.
type UpdateProfileParams struct {
	// Name is the new name.
	Name string
	// ExternalID is the new external id. It is a pointer so that leaving it nil
	// keeps the one the profile had, and set ClearExternalID to take it off.
	ExternalID *string
	// ClearExternalID sends the explicit null the API reads as "no external id
	// any more". It cannot be combined with ExternalID.
	ClearExternalID bool
}

// updateProfileBody is what UpdateProfile puts on the wire. ExternalID is raw
// JSON because the API reads three things in that one key: the key left out
// (keep what the profile had), a string (the new external id) and an explicit
// null (take it off).
type updateProfileBody struct {
	Name       string          `json:"name,omitempty"`
	ExternalID json.RawMessage `json:"externalId,omitempty"`
}

// CreateProfileKeyParams is the body of POST /profiles/{profileId}/keys.
type CreateProfileKeyParams struct {
	// Name is what you call this key, 1 to 80 characters.
	Name string `json:"name"`
	// Type is live or test. A test key can only mint test keys: asking it for a
	// live one is a 403 forbidden.
	Type APIKeyType `json:"type"`
	// RedirectAllowlist is the origins a connect redirect from this key may land
	// on, at most 20. Each is a bare origin such as https://acme.example.com,
	// with no path, query or fragment; they are normalized and deduped. It is
	// left out of the request when it is empty, which means no allowlist.
	RedirectAllowlist []string `json:"redirectAllowlist,omitempty"`
}

// ListAPIKeysParams filters and pages a key listing. A zero Limit or Offset is
// left out, and the API defaults them to 25 and 0.
type ListAPIKeysParams struct {
	// IncludeRevoked lists the revoked keys as well. It is a pointer so that
	// leaving it nil sends nothing and lets the API default it, while an
	// explicit false can still be sent: that is the default either way, and a
	// caller reading a flag off its own config should be able to send what it
	// read rather than translate it.
	IncludeRevoked *bool
	Limit          int
	Offset         int
}

// CreateConnectURLParams is the body of POST /profiles/{profileId}/connect.
type CreateConnectURLParams struct {
	// Platform is the platform to connect. Leave it empty and the end customer
	// picks one on the page. A test key may only name ConnectPlatformSandbox.
	Platform ConnectPlatform `json:"platform,omitempty"`
	// RedirectURL is where the end customer goes when the flow ends, either way.
	// It must be an https URL on a public host with no fragment; plain http is
	// accepted for localhost only. It is bound to the session here and used
	// exactly as stored, so nothing in the hosted page's own query can change
	// where they land.
	RedirectURL string `json:"redirectUrl"`
	// Headless draws the hosted page with no yeetpost header or footer, for a
	// popup with your own branding around it.
	Headless bool `json:"headless,omitempty"`
}

// CreatePostsParams is the body of POST /posts. Everything but Text and
// ConnectionSlugs is left out of the request when it is empty.
type CreatePostsParams struct {
	Text            string   `json:"text"`
	ConnectionSlugs []string `json:"connectionSlugs"`
	// ProfileID is the end customer this post is going out for. Every slug in
	// ConnectionSlugs has to belong to that profile, and one that does not fails
	// that item with invalid_connection. Leave it empty and every slug has to be
	// one of your own connections, so a post can never reach a profile by
	// accident.
	ProfileID string `json:"profileId,omitempty"`
	// ScheduledFor is an ISO 8601 timestamp to send at. It must be in the
	// future.
	ScheduledFor string `json:"scheduledFor,omitempty"`
	// Timezone is the IANA zone to read ScheduledFor in when it carries no UTC
	// offset, for example Europe/Helsinki. Refused with invalid_request when
	// ScheduledFor already has an offset, or when there is no ScheduledFor to
	// read.
	Timezone string `json:"timezone,omitempty"`
	// Queue takes each connection's next free posting slot instead of naming a
	// time. The per-connection result comes back as scheduled with the slot it
	// took in ScheduledFor. Cannot be combined with ScheduledFor. A connection
	// with no slots fails that one item with queue_empty, and one whose slots
	// are all taken inside the next 30 days fails it with queue_full.
	Queue bool `json:"queue,omitempty"`
	// MediaIDs are ids from UploadMedia, at most 5. It is shorthand for Media
	// when no alt text is needed. Send either this or Media, never both.
	MediaIDs []string `json:"mediaIds,omitempty"`
	// Media are the same images with their own alt text.
	Media []PostMediaItem `json:"media,omitempty"`
	// MediaURLs are urls to fetch the images from instead of uploading them
	// first, at most 5. Send this, MediaIDs or Media, never more than one.
	MediaURLs []string `json:"mediaUrls,omitempty"`
	// Thread is a reply chain posted under the head post, at most 24 entries,
	// in order. X, Bluesky, Telegram and Mastodon only: any other connection
	// refuses the item with shape_unsupported. Images stay on the head post.
	Thread []string `json:"thread,omitempty"`
	// FirstComment is a comment posted under the post as its author. LinkedIn
	// and Facebook only: any other connection refuses the item with
	// shape_unsupported.
	FirstComment string `json:"firstComment,omitempty"`
	// IsDraft stores the post against every connection in ConnectionSlugs and
	// publishes nothing. Each item comes back as draft with a PostID. A draft is
	// validated against its connection the way a real send is, but reserves
	// nothing: no usage, no X fee, no queue slot and no webhook. Publish it with
	// PublishPost. Cannot be combined with ScheduledFor or Queue.
	IsDraft bool `json:"isDraft,omitempty"`
	// Tags are your own labels for the post, at most 10, each 1 to 40 characters
	// of lowercase letters, digits, dashes, underscores, colons, dots and
	// slashes. Whitespace is trimmed, the tag is lowercased, and repeats are
	// dropped. Filter by them with ListPostsParams.Tag.
	Tags []string `json:"tags,omitempty"`
	// Rewrite is AI polish for this post: true or false always wins over the
	// connection's own mode and the account's default. Left nil, the
	// connection's mode decides. No effect on a thread, which AI polish never
	// touches.
	Rewrite *bool `json:"rewrite,omitempty"`
	// TextByPlatform gives one platform its own text, keyed by platform id
	// (linkedin, x, bluesky, and so on), used in place of Text for every
	// connection in ConnectionSlugs on that platform. A platform left out
	// gets Text.
	TextByPlatform map[string]string `json:"textByPlatform,omitempty"`
	// IdempotencyKey makes a retry safe: the same key with the same body
	// replays the stored response verbatim, without posting again. It goes in
	// the Idempotency-Key header rather than in the body.
	IdempotencyKey string `json:"-"`
}

// PublishPostParams is how a draft goes out. An empty struct sends it now.
type PublishPostParams struct {
	// ScheduledFor is an ISO 8601 timestamp to send at instead of now. It must be
	// in the future.
	ScheduledFor string `json:"scheduledFor,omitempty"`
	// Timezone is the IANA zone to read ScheduledFor in when it carries no UTC
	// offset, for example Europe/Helsinki.
	Timezone string `json:"timezone,omitempty"`
	// Queue takes the connection's next free posting slot instead of naming a
	// time. Cannot be combined with ScheduledFor. A queue with no free slot
	// answers queue_empty or queue_full in Result.Error and leaves the draft
	// where it was.
	Queue bool `json:"queue,omitempty"`
	// IdempotencyKey goes in the Idempotency-Key header rather than in the body.
	IdempotencyKey string `json:"-"`
}

// UpdatePostParams is the body of PATCH /posts/{postId}. Every field is
// optional and only what you send is written, so a field left at its zero value
// keeps what the post had. The lists are pointers so that an empty list can be
// sent rather than dropped: that is what clears a thread, takes every image off,
// or drops every tag. Thread and FirstComment describe one shape between them,
// so sending either replaces both.
//
// This also edits a pending scheduled post, not only a draft: ScheduledFor
// (with an optional Timezone) or Queue moves its time, the same two ways
// PublishPostParams reads them. A draft refuses all three with
// invalid_request, since it has nowhere to be sent at yet.
type UpdatePostParams struct {
	// Text is the new text. Leading and trailing whitespace is trimmed. On a
	// scheduled post this is stored as final: any AI polish it already carried
	// is cleared rather than run again.
	Text string
	// Thread is the new reply chain under the head post, at most 24 entries.
	Thread *[]string
	// FirstComment is the new comment under the share, LinkedIn and Facebook
	// only. Leave it empty to keep what the draft had, and set ClearFirstComment
	// to take it off.
	FirstComment string
	// ClearFirstComment sends the explicit null the API reads as "no comment any
	// more". It cannot be combined with FirstComment.
	ClearFirstComment bool
	// MediaIDs are the images the post should carry from now on. The list
	// replaces what it had, so an id you leave out is taken off it. Send either
	// this or Media, never both.
	MediaIDs *[]string
	// Media is the same replacement, with alt text per image.
	Media *[]PostMediaItem
	// Tags replace the post's labels.
	Tags *[]string
	// ScheduledFor is a pending scheduled post's new send time. It must be in
	// the future. Cannot be combined with Queue.
	ScheduledFor string
	// Timezone is the IANA zone to read ScheduledFor in when it carries no UTC
	// offset, for example Europe/Helsinki.
	Timezone string
	// Queue takes the connection's next free posting slot instead of naming a
	// time. Already queued, this is a no-op: the slot it holds is left alone.
	// Cannot be combined with ScheduledFor.
	Queue bool
}

// updatePostBody is what UpdateDraft puts on the wire. FirstComment is raw JSON
// because the API reads three things in that one key: the key left out (keep
// what the draft had), a string (the new comment) and an explicit null (take it
// off).
type updatePostBody struct {
	Text         string           `json:"text,omitempty"`
	Thread       *[]string        `json:"thread,omitempty"`
	FirstComment json.RawMessage  `json:"firstComment,omitempty"`
	MediaIDs     *[]string        `json:"mediaIds,omitempty"`
	Media        *[]PostMediaItem `json:"media,omitempty"`
	Tags         *[]string        `json:"tags,omitempty"`
	ScheduledFor string           `json:"scheduledFor,omitempty"`
	Timezone     string           `json:"timezone,omitempty"`
	Queue        bool             `json:"queue,omitempty"`
}

// PostMediaItem is one image on a post, with the alt text it gets there.
type PostMediaItem struct {
	ID string `json:"id"`
	// AltText overrides the alt text given at upload. It is passed to X,
	// Bluesky, Mastodon and LinkedIn; Telegram has no field for it.
	AltText string `json:"altText,omitempty"`
}

// UpdateConnectionParams is the body of PATCH /connections/{connectionId}.
type UpdateConnectionParams struct {
	// ProfileID is the profile to move the connection into. It is a pointer so
	// that nil goes on the wire as the explicit null the API reads as "back out
	// to your own connections", rather than being dropped.
	ProfileID *string `json:"profileId"`
}

// UpdateConnectionQueueParams is the body of PATCH
// /connections/{connectionId}/queue. Send Slots, Timezone, Paused, or a
// combination: at least one of them is required.
type UpdateConnectionQueueParams struct {
	// Slots is the complete slot list, replacing whatever was there. At most 50,
	// and no two the same. Posts already queued keep the times they were given.
	// It is a pointer so that an empty list can be sent rather than dropped, the
	// way the lists on UpdatePostParams are: &[]QueueSlot{} takes every slot off
	// the connection.
	Slots *[]QueueSlot `json:"slots,omitempty"`
	// Timezone is the IANA zone the slots are read in, for example
	// Europe/Helsinki.
	Timezone string `json:"timezone,omitempty"`
	// Paused pauses or resumes the queue. It is a pointer so that Paused:
	// false can be sent explicitly rather than dropped as the zero value.
	Paused *bool `json:"paused,omitempty"`
}

// UploadMediaParams is one image. The body is the raw file, not a multipart
// form.
type UploadMediaParams struct {
	Bytes       []byte
	ContentType MediaContentType
	// AltText is kept with the upload and used by every post that attaches it
	// unless the post gives its own.
	AltText string
}

// ListPostsParams filters GET /posts. A zero Limit or Offset is left out, and
// the API defaults them to 25 and 0.
type ListPostsParams struct {
	Status PostStatus
	// Tag narrows to the posts carrying every one of these tags, not any of
	// them. It goes on the query string once per tag.
	Tag []string
	// ProfileID narrows to the posts that went out for one end customer. A
	// deleted profile still answers here, so an offboarded customer keeps its
	// history.
	ProfileID string
	// ScheduledAfter and ScheduledBefore narrow on scheduledFor, both
	// inclusive, as ISO 8601 timestamps. They answer nothing for a post that
	// was never scheduled: an immediate post has no scheduledFor to compare.
	ScheduledAfter  string
	ScheduledBefore string
	// ConnectionSlug narrows to the posts that went out on one connection.
	ConnectionSlug string
	// Platform narrows to the posts that went out on one platform, such as
	// linkedin or x.
	Platform string
	// SendGroupID narrows to the posts made by one CreatePosts call.
	SendGroupID string
	Limit       int
	Offset      int
}

// GetHealthHistoryParams is the window GET /health/history aggregates. A zero
// Days is left out, and the API defaults it to 90.
type GetHealthHistoryParams struct {
	// Days is how many days back to aggregate, 1 to 90.
	Days int
}

// CreateWebhookParams is the body of POST /webhooks. Events defaults to all of
// them.
type CreateWebhookParams struct {
	URL    string      `json:"url"`
	Events []EventName `json:"events,omitempty"`
}

// ListWebhookDeliveriesParams filters one webhook's delivery log.
type ListWebhookDeliveriesParams struct {
	Status DeliveryStatusFilter
	Limit  int
	// StartingAfter is a delivery id. The page continues from the delivery
	// after that one, which is steadier than an offset while new deliveries
	// land at the top of the log.
	StartingAfter string
}

// ListConnections lists every connection of yours that has not been deleted,
// with the slug you use to post to it and the timezone and posting slots its
// queue runs on. Pass nil for all of them, or a ProfileID to see one end
// customer's.
func (client *Client) ListConnections(ctx context.Context, params *ListConnectionsParams) (ConnectionsResponse, error) {
	query := url.Values{}

	if params != nil && params.ProfileID != "" {
		query.Set("profileId", params.ProfileID)
	}

	var response ConnectionsResponse
	err := client.requestJSON(ctx, http.MethodGet, "/connections", requestOptions{query: query}, &response)

	return response, err
}

// GetConnection is one connection of yours, with the timezone and posting slots
// its queue runs on. Somebody else's connection is a 404, same as one that does
// not exist.
func (client *Client) GetConnection(ctx context.Context, connectionID string) (GetConnectionResponse, error) {
	var response GetConnectionResponse
	err := client.requestJSON(ctx, http.MethodGet, "/connections/"+url.PathEscape(connectionID), requestOptions{}, &response)

	return response, err
}

// UpdateConnection moves a connection into one of your profiles, or back out to
// your own with a nil ProfileID. The slug, the queue and every post already
// written stay where they are, and so does the billed connection count: only
// the routing changes. It fires connection.removed for the profile it left and
// connection.created for the one it arrived at, and LinkedIn pages move with
// the personal account that administers them.
//
// A profile that already holds the same account is a 409 connection_conflict
// naming the connection in the way (SMS and email are exempt, because their
// connect flows do not deduplicate either). A profile-scoped key is a 403
// forbidden, and so is the connection you sign in with: the move is the account
// owner's call.
func (client *Client) UpdateConnection(ctx context.Context, connectionID string, params UpdateConnectionParams) (UpdateConnectionResponse, error) {
	var response UpdateConnectionResponse
	err := client.requestJSON(ctx, http.MethodPatch, "/connections/"+url.PathEscape(connectionID), requestOptions{jsonBody: params}, &response)

	return response, err
}

// DeleteConnection disconnects an account. The row is soft deleted, so posts
// it already published stay readable; its secrets are deleted outright; any
// post still waiting to go out on it is cancelled; and a platform token
// nothing else uses is revoked. The connection you sign in with is not an end
// customer's to disconnect, and is a 403 forbidden.
func (client *Client) DeleteConnection(ctx context.Context, connectionID string) (DeleteConnectionResponse, error) {
	var response DeleteConnectionResponse
	err := client.requestJSON(ctx, http.MethodDelete, "/connections/"+url.PathEscape(connectionID), requestOptions{}, &response)

	return response, err
}

// ListConnectionQueue is the posts this connection has queued and not sent yet,
// earliest slot first. A post leaves the queue when it goes out, fails, or is
// cancelled with CancelPost, and cancelling hands its slot back to the next
// post queued.
func (client *Client) ListConnectionQueue(ctx context.Context, connectionID string) (GetConnectionQueueResponse, error) {
	var response GetConnectionQueueResponse
	err := client.requestJSON(ctx, http.MethodGet, "/connections/"+url.PathEscape(connectionID)+"/queue", requestOptions{}, &response)

	return response, err
}

// UpdateConnectionQueue replaces the connection's slot list, its timezone,
// pauses or resumes the queue, or a combination. Changing the slots does not
// move posts that are already queued: a queued post keeps the time it was
// given, and the new slots decide where the next queued post lands.
func (client *Client) UpdateConnectionQueue(ctx context.Context, connectionID string, params UpdateConnectionQueueParams) (UpdateConnectionQueueResponse, error) {
	var response UpdateConnectionQueueResponse
	err := client.requestJSON(ctx, http.MethodPatch, "/connections/"+url.PathEscape(connectionID)+"/queue", requestOptions{jsonBody: params}, &response)

	return response, err
}

// CreateProfile makes one profile, which is one of your end customers. Connect
// their accounts into it and post with its id, and a post of theirs can never
// reach another customer's account. An account can have 1000 profiles at once;
// over that, this is a 403 limit_exceeded.
func (client *Client) CreateProfile(ctx context.Context, params CreateProfileParams) (CreateProfileResponse, error) {
	var response CreateProfileResponse
	err := client.requestJSON(ctx, http.MethodPost, "/profiles", requestOptions{jsonBody: params}, &response)

	return response, err
}

// ListProfiles is your profiles, newest first. A deleted profile is not in the
// list. Pass nil to take the API's own paging.
func (client *Client) ListProfiles(ctx context.Context, params *ListProfilesParams) (GetProfilesResponse, error) {
	query := url.Values{}

	if params != nil && params.Limit != 0 {
		query.Set("limit", strconv.Itoa(params.Limit))
	}

	if params != nil && params.Offset != 0 {
		query.Set("offset", strconv.Itoa(params.Offset))
	}

	var response GetProfilesResponse
	err := client.requestJSON(ctx, http.MethodGet, "/profiles", requestOptions{query: query}, &response)

	return response, err
}

// GetProfile is one profile of yours. A deleted profile is a 404, same as one
// that never existed.
func (client *Client) GetProfile(ctx context.Context, profileID string) (GetProfileResponse, error) {
	var response GetProfileResponse
	err := client.requestJSON(ctx, http.MethodGet, "/profiles/"+url.PathEscape(profileID), requestOptions{}, &response)

	return response, err
}

// UpdateProfile renames a profile, sets its external id, or takes the external
// id off with ClearExternalID. Only what you send is written. An external id
// another live profile of yours already carries is a 409
// profile_external_id_conflict. A call that names no field is refused here,
// before the request goes out: the API needs at least one of them.
func (client *Client) UpdateProfile(ctx context.Context, profileID string, params UpdateProfileParams) (UpdateProfileResponse, error) {
	if params.ClearExternalID && params.ExternalID != nil {
		return UpdateProfileResponse{}, errors.New("yeetpost: set either ExternalID or ClearExternalID, not both")
	}

	if params.Name == "" && params.ExternalID == nil && !params.ClearExternalID {
		return UpdateProfileResponse{}, errors.New("yeetpost: set a Name, an ExternalID, or both")
	}

	body := updateProfileBody{Name: params.Name}

	if params.ClearExternalID {
		body.ExternalID = json.RawMessage("null")
	}

	if params.ExternalID != nil {
		encoded, err := json.Marshal(*params.ExternalID)
		if err != nil {
			return UpdateProfileResponse{}, fmt.Errorf("yeetpost: could not encode the external id: %w", err)
		}

		body.ExternalID = encoded
	}

	var response UpdateProfileResponse
	err := client.requestJSON(ctx, http.MethodPatch, "/profiles/"+url.PathEscape(profileID), requestOptions{jsonBody: body}, &response)

	return response, err
}

// DeleteProfile disconnects every account in the profile: the credentials are
// deleted, anything still waiting to be sent is cancelled, the drafts written
// in it are deleted, and the posts that already went out stay readable. The
// answer says how many connections went with it. The profile itself is kept out
// of sight rather than erased, so ListPosts with its ProfileID still lists the
// history of a customer you have offboarded.
func (client *Client) DeleteProfile(ctx context.Context, profileID string) (DeleteProfileResponse, error) {
	var response DeleteProfileResponse
	err := client.requestJSON(ctx, http.MethodDelete, "/profiles/"+url.PathEscape(profileID), requestOptions{}, &response)

	return response, err
}

// CreateProfileKey mints a key for one end customer. A key made here is always
// scoped to the profile in the path, so it reaches that customer and nothing
// else, whatever a call made with it says.
//
// Only an unscoped key of yours may call this: a key that is itself scoped to a
// profile is a 403 forbidden. A test key can only mint test keys, and asking it
// for a live one is a 403 forbidden too. A profile holds at most 50 live and 50
// test keys, and over that this is a 403 limit_exceeded; a revoked key does not
// count against either. The secret is answered exactly once, in this response.
func (client *Client) CreateProfileKey(ctx context.Context, profileID string, params CreateProfileKeyParams) (CreateAPIKeyResponse, error) {
	var response CreateAPIKeyResponse
	err := client.requestJSON(ctx, http.MethodPost, "/profiles/"+url.PathEscape(profileID)+"/keys", requestOptions{jsonBody: params}, &response)

	return response, err
}

// The query both key listings put on the wire. IncludeRevoked goes out as the
// literal "true" or "false" the API takes, and only when it was set.
func listAPIKeysQuery(params ListAPIKeysParams) url.Values {
	query := url.Values{}

	if params.IncludeRevoked != nil {
		query.Set("includeRevoked", strconv.FormatBool(*params.IncludeRevoked))
	}

	if params.Limit != 0 {
		query.Set("limit", strconv.Itoa(params.Limit))
	}

	if params.Offset != 0 {
		query.Set("offset", strconv.Itoa(params.Offset))
	}

	return query
}

// ListProfileKeys is the keys scoped to one profile, oldest first, without
// their secrets. Only an unscoped key of yours may call this, and a test key
// sees the test keys and no live ones. It is paged like ListProfiles: Limit is
// 1 to 100 and the API defaults it to 25.
func (client *Client) ListProfileKeys(ctx context.Context, profileID string, params ListAPIKeysParams) (GetAPIKeysResponse, error) {
	query := listAPIKeysQuery(params)

	var response GetAPIKeysResponse
	err := client.requestJSON(ctx, http.MethodGet, "/profiles/"+url.PathEscape(profileID)+"/keys", requestOptions{query: query}, &response)

	return response, err
}

// RevokeProfileKey revokes one of the profile's keys. It stops working
// everywhere at once, on the next request, except that a connect url it already
// issued keeps working for the rest of its fifteen minutes. Revoking a key that
// is already revoked is the same 200, so a retry is safe. Only an unscoped key
// of yours may call this, and a test key may only revoke test keys: a live key
// answers 404 to one.
func (client *Client) RevokeProfileKey(ctx context.Context, profileID string, keyID string) (RevokeAPIKeyResponse, error) {
	path := "/profiles/" + url.PathEscape(profileID) + "/keys/" + url.PathEscape(keyID)

	var response RevokeAPIKeyResponse
	err := client.requestJSON(ctx, http.MethodDelete, path, requestOptions{}, &response)

	return response, err
}

// ListKeys is every key of your account, oldest first: the unscoped ones and
// every profile's, with no secrets. Only an unscoped key of yours may call
// this, and a test key sees the test keys and no live ones. It is paged like
// ListProfiles: Limit is 1 to 100 and the API defaults it to 25.
func (client *Client) ListKeys(ctx context.Context, params ListAPIKeysParams) (GetAPIKeysResponse, error) {
	query := listAPIKeysQuery(params)

	var response GetAPIKeysResponse
	err := client.requestJSON(ctx, http.MethodGet, "/keys", requestOptions{query: query}, &response)

	return response, err
}

// RevokeKey revokes any key of your account, scoped or not, including the key
// making the call: that one answers 200 and the next request with it is a 401.
// Only an unscoped key of yours may call this, and a test key may only revoke
// test keys: a live key answers 404 to one, the same answer a key that is not
// yours gets.
func (client *Client) RevokeKey(ctx context.Context, keyID string) (RevokeAPIKeyResponse, error) {
	var response RevokeAPIKeyResponse
	err := client.requestJSON(ctx, http.MethodDelete, "/keys/"+url.PathEscape(keyID), requestOptions{}, &response)

	return response, err
}

// CreateConnectURL answers with a page yeetpost hosts, where your end customer
// connects one of their own accounts into this profile. The link works once and
// lasts fifteen minutes, and the token in it carries the whole authorization:
// nobody signs in to yeetpost, and the page never shows your key, your email or
// anything about your other customers. A test key opens a session that offers
// the sandbox and nothing else, which is how the whole flow runs in CI.
func (client *Client) CreateConnectURL(ctx context.Context, profileID string, params CreateConnectURLParams) (CreateConnectSessionResponse, error) {
	var response CreateConnectSessionResponse
	err := client.requestJSON(ctx, http.MethodPost, "/profiles/"+url.PathEscape(profileID)+"/connect", requestOptions{jsonBody: params}, &response)

	return response, err
}

// GetConnectSession is how a connect link ended, for when you would rather poll
// than read the query your customer came back on. Both say the same thing, and a
// link that has been used or has run out sends nobody anywhere, which is why
// polling exists: there is no redirect left to carry the news.
func (client *Client) GetConnectSession(ctx context.Context, connectSessionID string) (GetConnectSessionResponse, error) {
	var response GetConnectSessionResponse
	err := client.requestJSON(ctx, http.MethodGet, "/connect-sessions/"+url.PathEscape(connectSessionID), requestOptions{}, &response)

	return response, err
}

// PostToConnection is the one-liner endpoint: the body is the post. It has
// nowhere to name a profile, so it reaches your own accounts and nothing else.
// Prefer CreatePosts for anything that is not a shell script.
func (client *Client) PostToConnection(ctx context.Context, connectionSlug string, text string, params PostToConnectionParams) (LegacyPostResponse, error) {
	query := url.Values{}

	if params.ScheduledFor != "" {
		query.Set("scheduled_for", params.ScheduledFor)
	}

	var response LegacyPostResponse
	err := client.requestJSON(ctx, http.MethodPost, "/post/"+url.PathEscape(connectionSlug), requestOptions{
		query:       query,
		rawBody:     []byte(text),
		contentType: "text/plain",
	}, &response)

	return response, err
}

// CreatePosts posts the same text to every connection in ConnectionSlugs. A
// connection that fails comes back as a failed item in Results, not as an
// error, so read the per-item status. The call itself only fails (400
// invalid_connection) when none of the slugs match a connection of yours.
func (client *Client) CreatePosts(ctx context.Context, params CreatePostsParams) (CreatePostsResponse, error) {
	var response CreatePostsResponse
	err := client.requestJSON(ctx, http.MethodPost, "/posts", requestOptions{
		jsonBody:       params,
		idempotencyKey: params.IdempotencyKey,
	}, &response)

	return response, err
}

// PublishPost turns a draft into a real send: now, at a time, or into the
// connection's next free slot. The post keeps the id it had as a draft, and the
// mode it was created with. A refusal comes back in Result.Error, and the ones
// you can still settle leave the draft where it was to be published again:
// queue_empty, queue_full, payment_method_required, spend_cap_reached,
// fair_use_reached, connection_limit_exceeded and platform_unavailable. Every
// other refusal is the post's outcome, so the draft becomes a failed post. A
// post that is not a draft any more is a 404 not_found.
func (client *Client) PublishPost(ctx context.Context, postID string, params PublishPostParams) (PublishPostResponse, error) {
	var response PublishPostResponse
	err := client.requestJSON(ctx, http.MethodPost, "/posts/"+url.PathEscape(postID)+"/publish", requestOptions{
		jsonBody:       params,
		idempotencyKey: params.IdempotencyKey,
	}, &response)

	return response, err
}

// UpdateDraft edits a draft, or a pending scheduled post, in place. Anything
// else is a record of what already happened, so editing it is a 400
// invalid_request, and a post the worker has already claimed is a 409
// post_not_editable. The result is validated against the connection again, so
// an edit cannot leave a post in a shape the connection could never publish.
func (client *Client) UpdateDraft(ctx context.Context, postID string, params UpdatePostParams) (UpdatePostResponse, error) {
	if params.ClearFirstComment && params.FirstComment != "" {
		return UpdatePostResponse{}, errors.New("yeetpost: set either FirstComment or ClearFirstComment, not both")
	}

	body := updatePostBody{
		Text:         params.Text,
		Thread:       params.Thread,
		MediaIDs:     params.MediaIDs,
		Media:        params.Media,
		Tags:         params.Tags,
		ScheduledFor: params.ScheduledFor,
		Timezone:     params.Timezone,
		Queue:        params.Queue,
	}

	if params.ClearFirstComment {
		body.FirstComment = json.RawMessage("null")
	}

	if params.FirstComment != "" {
		encoded, err := json.Marshal(params.FirstComment)
		if err != nil {
			return UpdatePostResponse{}, fmt.Errorf("yeetpost: could not encode the first comment: %w", err)
		}

		body.FirstComment = encoded
	}

	var response UpdatePostResponse
	err := client.requestJSON(ctx, http.MethodPatch, "/posts/"+url.PathEscape(postID), requestOptions{jsonBody: body}, &response)

	return response, err
}

// UploadMedia stores one image and answers with the id you attach to a post.
// The same bytes uploaded twice are one image: the second upload answers with
// the id of the first and costs nothing against your allowance.
func (client *Client) UploadMedia(ctx context.Context, params UploadMediaParams) (CreateMediaResponse, error) {
	if params.ContentType == "" {
		return CreateMediaResponse{}, errors.New("yeetpost: contentType is required")
	}

	query := url.Values{}

	if params.AltText != "" {
		query.Set("alt_text", params.AltText)
	}

	var response CreateMediaResponse
	err := client.requestJSON(ctx, http.MethodPost, "/media", requestOptions{
		query:       query,
		rawBody:     params.Bytes,
		contentType: string(params.ContentType),
	}, &response)

	return response, err
}

// GetMedia reads an image back, with the content type it was uploaded as. Any
// parameters the header carries, such as a charset, are dropped: the media type
// on its own is what matches a MediaContentType constant.
func (client *Client) GetMedia(ctx context.Context, mediaID string) (GetMediaResponse, error) {
	response, responseBody, err := client.do(ctx, http.MethodGet, "/media/"+url.PathEscape(mediaID), requestOptions{})
	if err != nil {
		return GetMediaResponse{}, err
	}

	mediaType, _, err := mime.ParseMediaType(response.Header.Get("content-type"))
	if err != nil {
		return GetMediaResponse{}, fmt.Errorf("yeetpost: could not read the content type of the image: %w", err)
	}

	return GetMediaResponse{
		Bytes:       responseBody,
		ContentType: MediaContentType(mediaType),
	}, nil
}

// DeleteMedia deletes an image and frees the storage. Posts that used it keep
// their text and lose the image, so delete one only once the posts that need it
// have gone out.
func (client *Client) DeleteMedia(ctx context.Context, mediaID string) (DeleteMediaResponse, error) {
	var response DeleteMediaResponse
	err := client.requestJSON(ctx, http.MethodDelete, "/media/"+url.PathEscape(mediaID), requestOptions{}, &response)

	return response, err
}

// ListPosts is your posts, newest first, one row per connection they went to.
func (client *Client) ListPosts(ctx context.Context, params ListPostsParams) (GetPostsResponse, error) {
	query := url.Values{}

	if params.Status != "" {
		query.Set("status", string(params.Status))
	}

	// tag goes on once per value: the API reads the repeats as a list to narrow
	// by, not as one comma string.
	for _, tag := range params.Tag {
		query.Add("tag", tag)
	}

	if params.ProfileID != "" {
		query.Set("profileId", params.ProfileID)
	}

	if params.ScheduledAfter != "" {
		query.Set("scheduledAfter", params.ScheduledAfter)
	}

	if params.ScheduledBefore != "" {
		query.Set("scheduledBefore", params.ScheduledBefore)
	}

	if params.ConnectionSlug != "" {
		query.Set("connectionSlug", params.ConnectionSlug)
	}

	if params.Platform != "" {
		query.Set("platform", params.Platform)
	}

	if params.SendGroupID != "" {
		query.Set("sendGroupId", params.SendGroupID)
	}

	if params.Limit != 0 {
		query.Set("limit", strconv.Itoa(params.Limit))
	}

	if params.Offset != 0 {
		query.Set("offset", strconv.Itoa(params.Offset))
	}

	var response GetPostsResponse
	err := client.requestJSON(ctx, http.MethodGet, "/posts", requestOptions{query: query}, &response)

	return response, err
}

// GetPost is one post of yours. Somebody else's post is a 404, same as one that
// does not exist.
func (client *Client) GetPost(ctx context.Context, postID string) (GetPostResponse, error) {
	var response GetPostResponse
	err := client.requestJSON(ctx, http.MethodGet, "/posts/"+url.PathEscape(postID), requestOptions{}, &response)

	return response, err
}

// GetPostMetrics is the numbers yeetpost has read back off the platform for one
// post: the newest read, and every read before it. Latest is nil until the
// first read, an hour after the post goes out.
func (client *Client) GetPostMetrics(ctx context.Context, postID string) (GetPostMetricsResponse, error) {
	var response GetPostMetricsResponse
	err := client.requestJSON(ctx, http.MethodGet, "/posts/"+url.PathEscape(postID)+"/metrics", requestOptions{}, &response)

	return response, err
}

// GetAnalytics is every post that went out in a window, with the newest numbers
// read for each of them: totals, a per-day series and a per-platform split.
// Counters are running totals, so a post counts once, at whatever its newest
// read said.
func (client *Client) GetAnalytics(ctx context.Context, params GetAnalyticsParams) (GetAnalyticsResponse, error) {
	query := url.Values{}

	if params.From != "" {
		query.Set("from", params.From)
	}

	if params.To != "" {
		query.Set("to", params.To)
	}

	if params.ProfileID != "" {
		query.Set("profileId", params.ProfileID)
	}

	if params.Platform != "" {
		query.Set("platform", params.Platform)
	}

	if params.ConnectionSlug != "" {
		query.Set("connectionSlug", params.ConnectionSlug)
	}

	var response GetAnalyticsResponse
	err := client.requestJSON(ctx, http.MethodGet, "/analytics", requestOptions{query: query}, &response)

	return response, err
}

// DeletePost is one verb with three meanings, decided by what the post is. A
// post still waiting to be sent is cancelled and its row is kept. A draft is
// really deleted, because there is nothing to keep a record of. A post that
// already went out comes down on its platform, head post and thread replies
// both, and its row is kept with its text and its permalink. Read Status and
// Deleted on the answer to tell which happened.
func (client *Client) DeletePost(ctx context.Context, postID string) (DeletePostResponse, error) {
	var response DeletePostResponse
	err := client.requestJSON(ctx, http.MethodDelete, "/posts/"+url.PathEscape(postID), requestOptions{}, &response)

	return response, err
}

// CancelPost is the name this call had before it could delete a draft and a
// published post too.
func (client *Client) CancelPost(ctx context.Context, postID string) (DeletePostResponse, error) {
	return client.DeletePost(ctx, postID)
}

// RetryPost sends a failed post again. Only a post that actually failed can
// be retried; the API answers everything else with an error.
func (client *Client) RetryPost(ctx context.Context, postID string) (RetryPostResponse, error) {
	var response RetryPostResponse
	err := client.requestJSON(ctx, http.MethodPost, "/posts/"+url.PathEscape(postID)+"/retry", requestOptions{}, &response)

	return response, err
}

// CreateWebhook registers an https endpoint of yours for post.sent,
// post.failed, post.deleted, post.metrics, connection.created,
// connection.removed and connection.reconnect_required events.
// The secret in the response is shown exactly once. Store it now.
func (client *Client) CreateWebhook(ctx context.Context, params CreateWebhookParams) (CreateWebhookResponse, error) {
	var response CreateWebhookResponse
	err := client.requestJSON(ctx, http.MethodPost, "/webhooks", requestOptions{jsonBody: params}, &response)

	return response, err
}

// ListWebhooks is your webhooks, newest first. Secrets are never included.
func (client *Client) ListWebhooks(ctx context.Context) (GetWebhooksResponse, error) {
	var response GetWebhooksResponse
	err := client.requestJSON(ctx, http.MethodGet, "/webhooks", requestOptions{}, &response)

	return response, err
}

// DeleteWebhook stops delivering events to this webhook. Deliveries still
// queued for it are marked failed.
func (client *Client) DeleteWebhook(ctx context.Context, webhookID string) (DeleteWebhookResponse, error) {
	var response DeleteWebhookResponse
	err := client.requestJSON(ctx, http.MethodDelete, "/webhooks/"+url.PathEscape(webhookID), requestOptions{}, &response)

	return response, err
}

// ListWebhookDeliveries is the delivery log for one webhook of yours, newest
// first: what was sent, how it went, and the last error when it did not.
func (client *Client) ListWebhookDeliveries(ctx context.Context, webhookID string, params ListWebhookDeliveriesParams) (GetWebhookDeliveriesResponse, error) {
	query := url.Values{}

	if params.Status != "" {
		query.Set("status", string(params.Status))
	}

	if params.Limit != 0 {
		query.Set("limit", strconv.Itoa(params.Limit))
	}

	if params.StartingAfter != "" {
		query.Set("startingAfter", params.StartingAfter)
	}

	var response GetWebhookDeliveriesResponse
	err := client.requestJSON(ctx, http.MethodGet, "/webhooks/"+url.PathEscape(webhookID)+"/deliveries", requestOptions{query: query}, &response)

	return response, err
}

// ReplayDelivery queues the delivery again as a fresh attempt chain, keeping
// its event id and its body. Allowed on failed, dead and delivered; a delivery
// already waiting for an attempt is a 400 invalid_request.
func (client *Client) ReplayDelivery(ctx context.Context, webhookID string, deliveryID string) (ReplayWebhookDeliveryResponse, error) {
	path := "/webhooks/" + url.PathEscape(webhookID) + "/deliveries/" + url.PathEscape(deliveryID) + "/replay"

	var response ReplayWebhookDeliveryResponse
	err := client.requestJSON(ctx, http.MethodPost, path, requestOptions{}, &response)

	return response, err
}

// SendTestEvent enqueues a synthetic post.sent delivery, so a receiver can be
// checked without posting. Its body carries "test": true and nothing was
// posted.
func (client *Client) SendTestEvent(ctx context.Context, webhookID string) (SendWebhookTestEventResponse, error) {
	var response SendWebhookTestEventResponse
	err := client.requestJSON(ctx, http.MethodPost, "/webhooks/"+url.PathEscape(webhookID)+"/test", requestOptions{}, &response)

	return response, err
}

// GetHealth is whether the database answers and whether each background worker
// has finished a loop recently. It needs no API key, so a client built with an
// empty one can still call it, and the status code is 200 whether the API is ok
// or degraded: read Status. The answer is cached for 10 seconds, so polling
// faster than that buys nothing. Both health endpoints share one limit of 60
// requests a minute per IP.
func (client *Client) GetHealth(ctx context.Context) (GetHealthResponse, error) {
	var response GetHealthResponse
	err := client.requestJSON(ctx, http.MethodGet, "/health", requestOptions{}, &response)

	return response, err
}

// GetHealthHistory is the same health aggregated per UTC day, oldest first, from
// a sample taken once a minute and kept for 90 days. It needs no API key either,
// and its answer is cached for 60 seconds.
func (client *Client) GetHealthHistory(ctx context.Context, params GetHealthHistoryParams) (GetHealthHistoryResponse, error) {
	query := url.Values{}

	if params.Days != 0 {
		query.Set("days", strconv.Itoa(params.Days))
	}

	var response GetHealthHistoryResponse
	err := client.requestJSON(ctx, http.MethodGet, "/health/history", requestOptions{query: query}, &response)

	return response, err
}

// GetStats is public counts about yeetpost as a whole, and the platforms a post
// can go out to today. Nothing here is about one account, so it needs no API
// key either. The answer is cached for 60 seconds, and the endpoint has its
// own limit of 60 requests a minute per IP.
func (client *Client) GetStats(ctx context.Context) (GetStatsResponse, error) {
	var response GetStatsResponse
	err := client.requestJSON(ctx, http.MethodGet, "/stats", requestOptions{}, &response)

	return response, err
}

// GetOpenapiSpec is the OpenAPI 3.1 document this client was written against.
// It needs no API key either, so a client built with an empty one can read it.
func (client *Client) GetOpenapiSpec(ctx context.Context) (GetOpenapiSpecResponse, error) {
	var response GetOpenapiSpecResponse
	err := client.requestJSON(ctx, http.MethodGet, "/openapi.json", requestOptions{}, &response)

	return response, err
}

//
// Connect redirects
//

// ConnectRedirect is what the hosted page adds to your RedirectURL when the end
// customer comes back. ConnectionID, ProfileID, Slug and Platform are set when
// an account was connected, and Error instead when it was not, so a redirect
// never carries both.
type ConnectRedirect struct {
	// ConnectSessionID is empty when the query carried none, which means it did
	// not come from a connect link.
	ConnectSessionID string
	ConnectionID     string
	ProfileID        string
	Slug             string
	Platform         string
	// Error is cancelled when the customer backed out and connect_failed when
	// the platform refused. Both mean the same thing to you: show the button
	// again.
	Error string
}

// ParseConnectRedirect reads what the hosted page put on the query your end
// customer landed back on, which is request.URL.Query() in a net/http handler.
//
// This is a browser coming back, so nothing here is proof of anything: read the
// connection off GetConnectSession or off the connection.created webhook before
// you store it against a customer.
func ParseConnectRedirect(query url.Values) ConnectRedirect {
	return ConnectRedirect{
		ConnectSessionID: query.Get("connectSessionId"),
		ConnectionID:     query.Get("connectionId"),
		ProfileID:        query.Get("profileId"),
		Slug:             query.Get("slug"),
		Platform:         query.Get("platform"),
		Error:            query.Get("error"),
	}
}

//
// Webhooks
//

var signatureHeaderPattern = regexp.MustCompile(`^t=(\d+),v1=([0-9a-f]{64})$`)

// VerifyWebhookSignature verifies a delivery: the signature matches the body,
// and the delivery is recent enough that a captured one cannot be replayed at
// you later.
//
// secret is the "yp_whsec_…" value from CreateWebhook. header is the
// x-yeetpost-signature header, "t=<unix seconds>,v1=<hex hmac-sha256>". body is
// the raw request body, before any JSON parsing: re-serialising it changes the
// bytes that were signed. tolerance is how far the delivery's timestamp may be
// from your clock, and a tolerance of zero or less means
// DefaultWebhookTolerance.
//
// A header that cannot be parsed at all comes back as ErrMalformedSignature. A
// signature that does not match, or a timestamp outside the tolerance, is a
// plain false with no error. Both are a rejected delivery rather than a server
// error: the error only says the header was unreadable, which is the sender's
// problem, so answer it the way you answer a false.
func VerifyWebhookSignature(secret string, header string, body []byte, tolerance time.Duration) (bool, error) {
	match := signatureHeaderPattern.FindStringSubmatch(header)

	if match == nil {
		return false, ErrMalformedSignature
	}

	timestampSeconds, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil {
		return false, ErrMalformedSignature
	}

	if tolerance <= 0 {
		tolerance = DefaultWebhookTolerance
	}

	age := time.Since(time.Unix(timestampSeconds, 0))

	if age < 0 {
		age = -age
	}

	if age > tolerance {
		return false, nil
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(timestampSeconds, 10) + "."))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))

	return hmac.Equal([]byte(match[2]), []byte(expected)), nil
}

// ParseWebhookEvent reads the body of a verified post.sent or post.failed
// delivery. Verify it first: anything can POST to your endpoint. A post.deleted
// delivery and the two connection deliveries are different shapes, so read
// those with ParsePostDeletedWebhookEvent and ParseConnectionWebhookEvent,
// branching on the x-yeetpost-event header (HeaderEvent).
func ParseWebhookEvent(body []byte) (Event, error) {
	var event Event

	if err := json.Unmarshal(body, &event); err != nil {
		return Event{}, fmt.Errorf("yeetpost: the webhook body was not json: %w", err)
	}

	return event, nil
}

// ParsePostDeletedWebhookEvent reads the body of a verified post.deleted
// delivery, which fires when a published post is taken back down on its
// platform. Cancelling a scheduled post fires nothing: it was never published.
func ParsePostDeletedWebhookEvent(body []byte) (PostDeletedEvent, error) {
	var event PostDeletedEvent

	if err := json.Unmarshal(body, &event); err != nil {
		return PostDeletedEvent{}, fmt.Errorf("yeetpost: the webhook body was not json: %w", err)
	}

	return event, nil
}

// ParsePostMetricsWebhookEvent reads the body of a verified post.metrics
// delivery, which is a day's reading of a post's numbers. It fires on the first
// read of each UTC day for as long as the post is being refreshed, so it is one
// delivery per post per day rather than one per hourly read.
func ParsePostMetricsWebhookEvent(body []byte) (PostMetricsEvent, error) {
	var event PostMetricsEvent

	if err := json.Unmarshal(body, &event); err != nil {
		return PostMetricsEvent{}, fmt.Errorf("yeetpost: the webhook body was not json: %w", err)
	}

	return event, nil
}

// ParseConnectionWebhookEvent reads the body of a verified connection.created,
// connection.removed or connection.reconnect_required delivery, which fires
// when an account is connected, disconnected, or needs reconnecting, whether
// it went into one of your profiles or into your own account. Reconnecting an
// account that is already there replaces its credentials rather than making a
// new connection, so it fires nothing, and deleting a profile fires one
// connection.removed per account inside it.
func ParseConnectionWebhookEvent(body []byte) (ConnectionEvent, error) {
	var event ConnectionEvent

	if err := json.Unmarshal(body, &event); err != nil {
		return ConnectionEvent{}, fmt.Errorf("yeetpost: the webhook body was not json: %w", err)
	}

	return event, nil
}
