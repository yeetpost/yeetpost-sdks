<?php

declare(strict_types=1);

namespace Yeetpost;

// The yeetpost API client. Everything here is hand-written against
// yeetpost-api/src/lib/openapi.json, on ext-curl and ext-json and nothing else.
//
// Responses come back as plain arrays, decoded from exactly what the API sends,
// with the keys the spec names: $response["results"][0]["connectionSlug"] reads
// the same here as it does in curl. A field the API sends as null is null. The
// one exception is getMedia, which answers with the image bytes rather than
// with JSON, so it builds its own two-key array.
//
// One instance per API key. Every non-2xx is thrown as a YeetpostApiError, and
// a call refused here before the request goes out is an
// \InvalidArgumentException: an argument pair that cannot be combined, a call
// that needs a key on a client built without one, or a body that cannot be
// encoded as JSON, such as text that is not valid UTF-8. A request that never
// got an answer, such as a timeout, is a \RuntimeException with curl's own
// message.
final class Yeetpost
{
    public const DEFAULT_BASE_URL = "https://api.yeetpost.com/api/v2";

    // How long the built-in curl handle waits for one call.
    public const DEFAULT_TIMEOUT_SECONDS = 30;

    // How far a delivery's timestamp may be from your clock before
    // verifyWebhookSignature refuses it. Five minutes, as the API documents.
    public const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

    // The headers every webhook delivery carries.
    public const HEADER_SIGNATURE = "x-yeetpost-signature";
    public const HEADER_EVENT = "x-yeetpost-event";
    public const HEADER_EVENT_ID = "x-yeetpost-event-id";
    public const HEADER_DELIVERY = "x-yeetpost-delivery";
    public const HEADER_MODE = "x-yeetpost-mode";

    // D pins $ to the very end: without it PHP lets a trailing newline through,
    // which Node and Go do not.
    private const SIGNATURE_HEADER_PATTERN = '/^t=(\d+),v1=([0-9a-f]{64})$/D';

    private string $apiKey;

    private string $baseUrl;

    private int $timeoutSeconds;

    // An empty apiKey is allowed: getHealth, getHealthHistory, getStats and
    // getOpenapiSpec need no key. Every other call is refused before the
    // request goes out, rather than coming back as a 401 from the API.
    public function __construct(
        string $apiKey,
        string $baseUrl = self::DEFAULT_BASE_URL,
        int $timeoutSeconds = self::DEFAULT_TIMEOUT_SECONDS,
    ) {
        $this->apiKey = $apiKey;
        $this->baseUrl = rtrim($baseUrl, "/");
        $this->timeoutSeconds = $timeoutSeconds;
    }

    //
    // Transport
    //

    // Every method funnels through here: it sets auth, sends the body, and
    // turns any non-2xx into a YeetpostApiError before the caller sees it. The
    // answer comes back as [status, media type, raw bytes, headers], since
    // getMedia answers with an image rather than with JSON, and a 2xx that is
    // not JSON still needs the headers to build its error from.
    //
    // A null in $query is left out. $jsonBody goes out exactly as given, so a
    // method that has to send an explicit null puts one there itself, after
    // dropping the arguments nobody passed with withoutNulls. $bytesBody is the
    // raw file and the type the API checks it against, as one pair.
    private function send(
        string $method,
        string $path,
        array $query = [],
        ?array $jsonBody = null,
        ?string $textBody = null,
        ?array $bytesBody = null,
        ?string $idempotencyKey = null,
        bool $isPublicEndpoint = false,
    ): array {
        if ($this->apiKey === "" && !$isPublicEndpoint) {
            throw new \InvalidArgumentException("apiKey is required for this call");
        }

        $url = $this->baseUrl . $path;
        $queryString = self::buildQuery($query);

        if ($queryString !== "") {
            $url = $url . "?" . $queryString;
        }

        // An empty key goes out as no header at all, which is what the
        // endpoints that need no key expect to see.
        $headers = [];

        if ($this->apiKey !== "") {
            $headers["x-api-key"] = $this->apiKey;
        }

        $body = null;

        if ($jsonBody !== null) {
            $headers["content-type"] = "application/json";
            // The cast keeps an empty body as {} rather than []: the API reads
            // the request as an object, and PHP has no other way to say so.
            try {
                $body = json_encode(
                    (object) $jsonBody,
                    JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
                );
            } catch (\JsonException $error) {
                throw new \InvalidArgumentException(
                    "the request body could not be encoded as json: " . $error->getMessage(),
                );
            }
        }

        if ($textBody !== null) {
            $headers["content-type"] = "text/plain";
            $body = $textBody;
        }

        if ($bytesBody !== null) {
            [$body, $headers["content-type"]] = $bytesBody;
        }

        if ($idempotencyKey !== null) {
            $headers["idempotency-key"] = $idempotencyKey;
        }

        $headerLines = [];

        foreach ($headers as $name => $value) {
            $headerLines[] = $name . ": " . $value;
        }

        // curl adds "Expect: 100-continue" to a body over a kilobyte and waits
        // on it, which an image upload would trip. An empty value takes the
        // header off.
        $headerLines[] = "expect:";

        $responseHeaders = [];

        $handle = curl_init($url);

        curl_setopt_array($handle, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headerLines,
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_HEADERFUNCTION => function ($handle, string $line) use (&$responseHeaders): int {
                $separator = strpos($line, ":");

                if ($separator !== false) {
                    $name = strtolower(trim(substr($line, 0, $separator)));
                    $responseHeaders[$name] = trim(substr($line, $separator + 1));
                }

                return strlen($line);
            },
        ]);

        if ($body !== null) {
            curl_setopt($handle, CURLOPT_POSTFIELDS, $body);
        }

        $responseBody = curl_exec($handle);

        // The handle is freed when it goes out of scope: curl_close has done
        // nothing since PHP 8.0.
        if ($responseBody === false) {
            throw new \RuntimeException("the request failed: " . curl_error($handle));
        }

        $status = curl_getinfo($handle, CURLINFO_RESPONSE_CODE);

        if ($status < 200 || $status > 299) {
            throw self::apiError($status, $responseHeaders, $responseBody);
        }

        // Any parameters the header carries, such as a charset, are dropped:
        // the media type on its own is what getMedia wants.
        $contentType = $responseHeaders["content-type"] ?? "";
        $mediaType = strtolower(trim(explode(";", $contentType)[0]));

        return [$status, $mediaType, $responseBody, $responseHeaders];
    }

    // send plus decoding, which is every endpoint but getMedia.
    private function request(
        string $method,
        string $path,
        array $query = [],
        ?array $jsonBody = null,
        ?string $textBody = null,
        ?array $bytesBody = null,
        ?string $idempotencyKey = null,
        bool $isPublicEndpoint = false,
    ): array {
        [$status, , $responseBody, $responseHeaders] = $this->send(
            $method,
            $path,
            query: $query,
            jsonBody: $jsonBody,
            textBody: $textBody,
            bytesBody: $bytesBody,
            idempotencyKey: $idempotencyKey,
            isPublicEndpoint: $isPublicEndpoint,
        );

        try {
            $decoded = json_decode($responseBody, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            $decoded = null;
        }

        if (!is_array($decoded)) {
            throw self::errorWithHeaders(
                $status,
                $responseHeaders,
                "internal_server_error",
                "the yeetpost api returned a response that was not json",
            );
        }

        return $decoded;
    }

    // A query string in the form the API reads. A null is left out, a bool
    // goes out as the literal "true" or "false", and a list, such as tag, goes
    // on once per value: the API reads the repeats as a list to narrow by, not
    // as one comma string.
    private static function buildQuery(array $query): string
    {
        $pairs = [];

        foreach ($query as $name => $value) {
            if ($value === null) {
                continue;
            }

            if (is_array($value)) {
                foreach ($value as $item) {
                    $pairs[] = urlencode($name) . "=" . urlencode((string) $item);
                }

                continue;
            }

            if (is_bool($value)) {
                $value = $value ? "true" : "false";
            }

            $pairs[] = urlencode($name) . "=" . urlencode((string) $value);
        }

        return implode("&", $pairs);
    }

    // The request body without the arguments nobody passed, which is what an
    // optional argument left at null means: the key is left out, and the API
    // keeps what it had.
    private static function withoutNulls(array $body): array
    {
        $given = [];

        foreach ($body as $name => $value) {
            if ($value !== null) {
                $given[$name] = $value;
            }
        }

        return $given;
    }

    // A list argument as a JSON array. A PHP array that has been filtered or
    // had an item unset keeps its old keys, and json_encode writes one of those
    // as an object, which the API refuses. Renumbering the keys is what makes
    // it a list again. A null stays null, so it is left out like any other.
    private static function asList(?array $list): ?array
    {
        if ($list === null) {
            return null;
        }

        return array_values($list);
    }

    // One path segment, escaped so that an id with a slash in it cannot open
    // a path of its own.
    private static function segment(string $value): string
    {
        return rawurlencode($value);
    }

    // One of the numeric headers, or -1 when the response did not carry it.
    // Only a whole number counts: a fraction or padding is read as not carried,
    // the way the other sdks read it, rather than rounded by the cast.
    private static function headerNumber(array $headers, string $name): int
    {
        $value = $headers[$name] ?? null;

        if ($value === null || preg_match('/^[+-]?\d+$/D', $value) !== 1) {
            return -1;
        }

        return (int) $value;
    }

    // An error built from the response headers: the request id and the
    // x-ratelimit-* trio come off them. The header leads, and the body's
    // req_id stands in when it was not sent.
    private static function errorWithHeaders(
        int $status,
        array $headers,
        string $code,
        string $message,
        ?string $bodyRequestId = null,
    ): YeetpostApiError {
        $headerRequestId = $headers["x-request-id"] ?? null;

        return new YeetpostApiError(
            $status,
            $code,
            $message,
            $headerRequestId ?? $bodyRequestId,
            self::headerNumber($headers, "x-ratelimit-limit"),
            self::headerNumber($headers, "x-ratelimit-remaining"),
            self::headerNumber($headers, "x-ratelimit-reset"),
        );
    }

    private static function apiError(int $status, array $headers, string $responseBody): YeetpostApiError
    {
        try {
            $body = json_decode($responseBody, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            $body = null;
        }

        // A null, a string or a number is not an error body at all. An array
        // is one that carries no code, which is how the other sdks read it.
        if (!is_array($body)) {
            return self::errorWithHeaders(
                $status,
                $headers,
                "internal_server_error",
                "the yeetpost api returned an error that was not json",
            );
        }

        if (!is_string($body["error"] ?? null)) {
            return self::errorWithHeaders(
                $status,
                $headers,
                "internal_server_error",
                "the yeetpost api returned an error without a code",
            );
        }

        $code = $body["error"];

        // The 429 body has no message field, so the code stands in for it there.
        $message = is_string($body["message"] ?? null) ? $body["message"] : $code;
        $bodyRequestId = is_string($body["req_id"] ?? null) ? $body["req_id"] : null;

        return self::errorWithHeaders($status, $headers, $code, $message, $bodyRequestId);
    }

    //
    // Connections
    //

    // Every connection of yours, or only the ones inside one profile. A
    // profileId that is not one of yours is a 400 invalid_request rather than
    // an empty list.
    public function listConnections(?string $profileId = null): array
    {
        return $this->request("GET", "/connections", query: ["profileId" => $profileId]);
    }

    // One connection of yours, with the timezone and posting slots its queue
    // runs on. Somebody else's connection is a 404, same as one that does not
    // exist.
    public function getConnection(string $connectionId): array
    {
        return $this->request("GET", "/connections/" . self::segment($connectionId));
    }

    // Moves a connection into one of your profiles, or back out to your own
    // with profileId null. The slug, the queue and every post already written
    // stay where they are, and so does the billed connection count: only the
    // routing changes. It fires connection.removed for the profile it left and
    // connection.created for the one it arrived at, and LinkedIn pages move
    // with the personal account that administers them.
    //
    // A profile that already holds the same account throws a
    // 409 connection_conflict naming the connection in the way (SMS and email
    // are exempt, because their connect flows do not deduplicate either). A
    // profile-scoped key throws a 403 forbidden, and so does the connection you
    // sign in with: the move is the account owner's call.
    public function updateConnection(string $connectionId, ?string $profileId): array
    {
        // An explicit null rather than a dropped key: null is what moves the
        // connection back out to your own.
        return $this->request(
            "PATCH",
            "/connections/" . self::segment($connectionId),
            jsonBody: ["profileId" => $profileId],
        );
    }

    // Disconnects an account: its credentials are deleted, anything still
    // waiting to be sent on it is cancelled, and the posts that already went
    // out stay readable. The connection you sign in with cannot be
    // disconnected this way, which is a 403 forbidden, the same refusal
    // moving it into a profile gives.
    public function deleteConnection(string $connectionId): array
    {
        return $this->request("DELETE", "/connections/" . self::segment($connectionId));
    }

    // The posts waiting in the connection's queue, earliest slot first.
    public function listConnectionQueue(string $connectionId): array
    {
        return $this->request("GET", "/connections/" . self::segment($connectionId) . "/queue");
    }

    // Replaces the slot list, the timezone, pauses or resumes the queue, or a
    // combination. Posts already queued keep the times they were given.
    // slots is a list of ["weekday" => 0-6, "time" => "HH:MM"], weekday 0
    // being Sunday, and an empty list takes every slot off the connection.
    public function updateConnectionQueue(
        string $connectionId,
        ?array $slots = null,
        ?string $timezone = null,
        ?bool $paused = null,
    ): array {
        return $this->request(
            "PATCH",
            "/connections/" . self::segment($connectionId) . "/queue",
            jsonBody: self::withoutNulls([
                "slots" => self::asList($slots),
                "timezone" => $timezone,
                "paused" => $paused,
            ]),
        );
    }

    //
    // Profiles
    //

    // One profile is one of your end customers. Connect their accounts into it
    // and post with its id, and a post of theirs can never reach another
    // customer's account. An account can have 1000 profiles at once; over
    // that, this is a 403 limit_exceeded.
    public function createProfile(string $name, ?string $externalId = null): array
    {
        return $this->request(
            "POST",
            "/profiles",
            jsonBody: self::withoutNulls(["name" => $name, "externalId" => $externalId]),
        );
    }

    // Your profiles, newest first. A deleted profile is not in the list. The
    // API defaults limit to 25 and offset to 0.
    public function listProfiles(?int $limit = null, ?int $offset = null): array
    {
        return $this->request("GET", "/profiles", query: ["limit" => $limit, "offset" => $offset]);
    }

    public function getProfile(string $profileId): array
    {
        return $this->request("GET", "/profiles/" . self::segment($profileId));
    }

    // Renames a profile, sets its external id, or both. Only what you pass is
    // written, so an argument left out keeps what the profile had. externalId
    // null is "leave it alone" like every other argument, so taking an
    // external id off is clearExternalId: true, which sends the explicit null
    // the API reads as "no external id any more". An external id another live
    // profile of yours already carries is a 409 profile_external_id_conflict.
    // A call that names no field is refused here, before the request goes
    // out: the API needs at least one of them.
    public function updateProfile(
        string $profileId,
        ?string $name = null,
        ?string $externalId = null,
        bool $clearExternalId = false,
    ): array {
        if ($clearExternalId && $externalId !== null) {
            throw new \InvalidArgumentException("pass either externalId or clearExternalId, not both");
        }

        if ($name === null && $externalId === null && !$clearExternalId) {
            throw new \InvalidArgumentException("pass a name, an externalId, or both");
        }

        $body = self::withoutNulls(["name" => $name]);

        // externalId is the one key the API reads three ways: left out keeps
        // what the profile had, a string is the new id, and an explicit null
        // takes it off. It goes on after the nulls are dropped, so the null
        // survives: clearExternalId means externalId is null here.
        if ($externalId !== null || $clearExternalId) {
            $body["externalId"] = $externalId;
        }

        return $this->request("PATCH", "/profiles/" . self::segment($profileId), jsonBody: $body);
    }

    // Disconnects every account in the profile: the credentials are deleted,
    // anything still waiting to be sent is cancelled, the drafts written in it
    // are deleted, and the posts that already went out stay readable. The
    // answer says how many connections went with it. The profile itself is
    // kept out of sight rather than erased, so listPosts with its profileId
    // still lists the history of a customer you have offboarded.
    public function deleteProfile(string $profileId): array
    {
        return $this->request("DELETE", "/profiles/" . self::segment($profileId));
    }

    //
    // Keys
    //

    // Mints a key for one end customer. A key made here is always scoped to
    // the profile in the path, so it reaches that customer and nothing else,
    // whatever a call made with it says. type is "live" or "test".
    // redirectAllowlist is the origins a connect redirect from this key may
    // land on, at most 20, each a bare origin such as
    // "https://acme.example.com" with no path, query or fragment; they are
    // normalized and deduped, and an empty list means no allowlist at all.
    //
    // Only an unscoped key of yours may call this: a key that is itself scoped
    // to a profile is a 403 forbidden. A test key can only mint test keys, and
    // asking it for a live one is a 403 forbidden too. A profile holds at most
    // 50 live and 50 test keys, and over that this is a 403 limit_exceeded; a
    // revoked key does not count against either. The secret is answered
    // exactly once, in this response.
    public function createProfileKey(
        string $profileId,
        string $name,
        string $type,
        ?array $redirectAllowlist = null,
    ): array {
        return $this->request(
            "POST",
            "/profiles/" . self::segment($profileId) . "/keys",
            jsonBody: self::withoutNulls([
                "name" => $name,
                "type" => $type,
                "redirectAllowlist" => self::asList($redirectAllowlist),
            ]),
        );
    }

    // The keys scoped to one profile, oldest first, without their secrets.
    // Only an unscoped key of yours may call this, and a test key sees the
    // test keys and no live ones. Paged like listProfiles: limit is 1 to 100
    // and the API defaults it to 25.
    public function listProfileKeys(
        string $profileId,
        ?bool $includeRevoked = null,
        ?int $limit = null,
        ?int $offset = null,
    ): array {
        return $this->request(
            "GET",
            "/profiles/" . self::segment($profileId) . "/keys",
            query: ["includeRevoked" => $includeRevoked, "limit" => $limit, "offset" => $offset],
        );
    }

    // Revokes one of the profile's keys. It stops working everywhere at once,
    // on the next request, except that a connect url it already issued keeps
    // working for the rest of its fifteen minutes. Revoking a key that is
    // already revoked is the same 200, so a retry is safe. Only an unscoped
    // key of yours may call this, and a test key may only revoke test keys: a
    // live key answers 404 to one.
    public function revokeProfileKey(string $profileId, string $keyId): array
    {
        return $this->request(
            "DELETE",
            "/profiles/" . self::segment($profileId) . "/keys/" . self::segment($keyId),
        );
    }

    // Every key of your account, oldest first: the unscoped ones and every
    // profile's, with no secrets. Only an unscoped key of yours may call this,
    // and a test key sees the test keys and no live ones. Paged like
    // listProfiles: limit is 1 to 100 and the API defaults it to 25.
    public function listKeys(?bool $includeRevoked = null, ?int $limit = null, ?int $offset = null): array
    {
        return $this->request(
            "GET",
            "/keys",
            query: ["includeRevoked" => $includeRevoked, "limit" => $limit, "offset" => $offset],
        );
    }

    // Revokes any key of your account, scoped or not, including the key making
    // the call: that one answers 200 and the next request with it is a 401.
    // Only an unscoped key of yours may call this, and a test key may only
    // revoke test keys: a live key answers 404 to one, the same answer a key
    // that is not yours gets.
    public function revokeKey(string $keyId): array
    {
        return $this->request("DELETE", "/keys/" . self::segment($keyId));
    }

    //
    // Connect sessions
    //

    // A page yeetpost hosts, where your end customer connects one of their own
    // accounts into this profile. The link works once and lasts fifteen
    // minutes, and the token in it carries the whole authorization: nobody
    // signs in to yeetpost, and the page never shows your key, your email or
    // anything about your other customers. Leave platform out and the page
    // shows a picker. headless: true draws it with no yeetpost header or
    // footer, for a popup with your own branding around it. A test key opens a
    // session that offers the sandbox and nothing else, which is how the whole
    // flow runs in CI.
    public function createConnectUrl(
        string $profileId,
        string $redirectUrl,
        ?string $platform = null,
        ?bool $headless = null,
    ): array {
        return $this->request(
            "POST",
            "/profiles/" . self::segment($profileId) . "/connect",
            jsonBody: self::withoutNulls([
                "platform" => $platform,
                "redirectUrl" => $redirectUrl,
                "headless" => $headless,
            ]),
        );
    }

    // How a connect link ended, for when you would rather poll than read the
    // query your customer came back on. Both say the same thing, and a link
    // that has been used or has run out sends nobody anywhere, which is why
    // polling exists: there is no redirect left to carry the news.
    public function getConnectSession(string $connectSessionId): array
    {
        return $this->request("GET", "/connect-sessions/" . self::segment($connectSessionId));
    }

    //
    // Posts
    //

    // The one-liner endpoint: the body is the post. It has nowhere to name a
    // profile, so it reaches your own accounts and nothing else. Prefer
    // createPosts for anything that is not a shell script.
    public function postToConnection(string $connectionSlug, string $text, ?string $scheduledFor = null): array
    {
        return $this->request(
            "POST",
            "/post/" . self::segment($connectionSlug),
            query: ["scheduled_for" => $scheduledFor],
            textBody: $text,
        );
    }

    // A connection that fails comes back as a failed item in results, not as
    // a thrown error. Read the per-item status.
    //
    // rewrite is AI polish for this post: true or false always wins over the
    // connection's own mode and the account's default; leave it null and the
    // connection's mode decides. textByPlatform gives one platform its own
    // text, keyed by platform id, in place of the shared text for every
    // connection on that platform.
    //
    // profileId is the end customer this post is going out for. Every slug in
    // connectionSlugs has to belong to that profile, and one that does not
    // fails that item with invalid_connection. Leave it out and every slug has
    // to be one of your own connections, so a post can never reach a profile
    // by accident. media is a list of ["id" => ..., "altText" => ...], and
    // mediaIds the same images without alt text; mediaUrls is a third way,
    // letting yeetpost fetch the bytes itself instead of uploading first.
    // Send only one of the three.
    public function createPosts(
        string $text,
        array $connectionSlugs,
        ?string $scheduledFor = null,
        ?string $idempotencyKey = null,
        ?string $timezone = null,
        ?bool $queue = null,
        ?array $mediaIds = null,
        ?array $media = null,
        ?array $mediaUrls = null,
        ?array $thread = null,
        ?string $firstComment = null,
        ?bool $isDraft = null,
        ?array $tags = null,
        ?string $profileId = null,
        ?bool $rewrite = null,
        ?array $textByPlatform = null,
    ): array {
        return $this->request(
            "POST",
            "/posts",
            jsonBody: self::withoutNulls([
                "text" => $text,
                "connectionSlugs" => array_values($connectionSlugs),
                "profileId" => $profileId,
                "scheduledFor" => $scheduledFor,
                "timezone" => $timezone,
                "queue" => $queue,
                "mediaIds" => self::asList($mediaIds),
                "media" => self::asList($media),
                "mediaUrls" => self::asList($mediaUrls),
                "thread" => self::asList($thread),
                "firstComment" => $firstComment,
                "isDraft" => $isDraft,
                "tags" => self::asList($tags),
                "rewrite" => $rewrite,
                "textByPlatform" => $textByPlatform,
            ]),
            idempotencyKey: $idempotencyKey,
        );
    }

    // Turns a draft into a real send: now, at a time, or into the connection's
    // next free slot. The post keeps the id it had as a draft, and the mode it
    // was created with. A refusal comes back in $response["result"]["error"],
    // and the ones you can still settle leave the draft where it was to be
    // published again: queue_empty, queue_full, payment_method_required,
    // spend_cap_reached, fair_use_reached, connection_limit_exceeded and
    // platform_unavailable. Every other refusal is the post's outcome, so the
    // draft becomes a failed post. A post that is not a draft any more is a
    // 404 not_found.
    public function publishPost(
        string $postId,
        ?string $scheduledFor = null,
        ?string $idempotencyKey = null,
        ?string $timezone = null,
        ?bool $queue = null,
    ): array {
        return $this->request(
            "POST",
            "/posts/" . self::segment($postId) . "/publish",
            jsonBody: self::withoutNulls([
                "scheduledFor" => $scheduledFor,
                "timezone" => $timezone,
                "queue" => $queue,
            ]),
            idempotencyKey: $idempotencyKey,
        );
    }

    // Edits a draft, or a pending scheduled post, in place. Only what you pass
    // is written, so an argument left out keeps what it had. thread and
    // firstComment describe one shape between them, so passing either
    // replaces both, and thread: [] clears it. firstComment null is "leave it
    // alone" like every other argument, so taking a comment off a draft is
    // clearFirstComment: true, which sends the explicit null the API reads as
    // "no comment any more". mediaIds or media replaces the whole image list,
    // so an id you leave out is taken off it.
    //
    // scheduledFor (with an optional timezone) or queue moves a pending
    // scheduled post's own time, the same two ways publishPost reads them. A
    // draft is a 400 invalid_request on all three, since it has nowhere to be
    // sent at yet. A text edit on a scheduled post is stored as final: any AI
    // polish it already carried is cleared rather than run again.
    //
    // Anything else is a record of what already happened, so editing it is a
    // 400 invalid_request, and a post the worker has already claimed is a
    // 409 post_not_editable.
    public function updateDraft(
        string $postId,
        ?string $text = null,
        ?array $thread = null,
        ?string $firstComment = null,
        bool $clearFirstComment = false,
        ?array $mediaIds = null,
        ?array $media = null,
        ?array $tags = null,
        ?string $scheduledFor = null,
        ?string $timezone = null,
        ?bool $queue = null,
    ): array {
        if ($clearFirstComment && $firstComment !== null) {
            throw new \InvalidArgumentException("pass either firstComment or clearFirstComment, not both");
        }

        $body = self::withoutNulls([
            "text" => $text,
            "thread" => self::asList($thread),
            "mediaIds" => self::asList($mediaIds),
            "media" => self::asList($media),
            "tags" => self::asList($tags),
            "scheduledFor" => $scheduledFor,
            "timezone" => $timezone,
            "queue" => $queue,
        ]);

        // firstComment is the one key the API reads three ways: left out keeps
        // what the draft had, a string is the new comment, and an explicit null
        // takes it off. It goes on after the nulls are dropped, so the null
        // survives: clearFirstComment means firstComment is null here.
        if ($firstComment !== null || $clearFirstComment) {
            $body["firstComment"] = $firstComment;
        }

        return $this->request("PATCH", "/posts/" . self::segment($postId), jsonBody: $body);
    }

    // Your posts, newest first, one row per connection they went to. tag is
    // repeatable: a post has to carry every tag you name, not any of them.
    // profileId narrows to the posts that went out for one end customer, and
    // answers for a deleted profile too, so an offboarded customer keeps its
    // history. scheduledAfter and scheduledBefore are both inclusive, on
    // scheduled_for, and answer nothing for a post that was never scheduled.
    // connectionSlug, platform and sendGroupId narrow to one connection, one
    // platform, or the one bulk send a post went out as part of.
    public function listPosts(
        ?string $status = null,
        ?int $limit = null,
        ?int $offset = null,
        ?array $tag = null,
        ?string $profileId = null,
        ?string $scheduledAfter = null,
        ?string $scheduledBefore = null,
        ?string $connectionSlug = null,
        ?string $platform = null,
        ?string $sendGroupId = null,
    ): array {
        return $this->request(
            "GET",
            "/posts",
            query: [
                "status" => $status,
                "tag" => $tag,
                "profileId" => $profileId,
                "scheduledAfter" => $scheduledAfter,
                "scheduledBefore" => $scheduledBefore,
                "connectionSlug" => $connectionSlug,
                "platform" => $platform,
                "sendGroupId" => $sendGroupId,
                "limit" => $limit,
                "offset" => $offset,
            ],
        );
    }

    public function getPost(string $postId): array
    {
        return $this->request("GET", "/posts/" . self::segment($postId));
    }

    // The numbers yeetpost has read back off the platform for one post: the
    // newest read, and every read before it. "latest" is null until the first
    // read, an hour after the post goes out.
    public function getPostMetrics(string $postId): array
    {
        return $this->request("GET", "/posts/" . self::segment($postId) . "/metrics");
    }

    // Every post that went out in a window, with the newest numbers read for
    // each of them: totals, a per-day series and a per-platform split.
    // Counters are running totals, so a post counts once, at whatever its
    // newest read said. The window is whole UTC days, "YYYY-MM-DD", both ends
    // included; left out, it is the last 30 days, which is exactly as long as
    // a post is refreshed for.
    public function getAnalytics(
        ?string $from = null,
        ?string $to = null,
        ?string $profileId = null,
        ?string $platform = null,
        ?string $connectionSlug = null,
    ): array {
        return $this->request(
            "GET",
            "/analytics",
            query: [
                "from" => $from,
                "to" => $to,
                "profileId" => $profileId,
                "platform" => $platform,
                "connectionSlug" => $connectionSlug,
            ],
        );
    }

    // One verb, three meanings, decided by what the post is: a post still
    // waiting to be sent is cancelled, a draft is really deleted (it never
    // went out, so there is no record to keep), and one that already went out
    // comes down on its platform. The answer says which happened: a cancelled
    // or a taken-down post carries a "status", a deleted draft carries
    // "deleted".
    public function deletePost(string $postId): array
    {
        return $this->request("DELETE", "/posts/" . self::segment($postId));
    }

    // The same call under the name a caller reaches for when the post is a
    // draft. It is the same endpoint, so the answer is the same three shapes:
    // a post that stopped being a draft between your read and this call comes
    // back cancelled or deleted.
    public function deleteDraft(string $postId): array
    {
        return $this->deletePost($postId);
    }

    // The name this call had before it could delete a draft and a published
    // post too.
    public function cancelPost(string $postId): array
    {
        return $this->deletePost($postId);
    }

    // Sends a failed post again, keeping its id. Only a post whose last
    // attempt failed can be retried: everything else, and a retry already
    // in flight for this post, is a thrown YeetpostApiError rather than a
    // new attempt.
    public function retryPost(string $postId): array
    {
        return $this->request("POST", "/posts/" . self::segment($postId) . "/retry");
    }

    //
    // Media
    //

    // The same bytes uploaded twice are one image: the second upload answers
    // with the id of the first and costs nothing against your allowance. The
    // body is the raw file, not a multipart form. contentType is one of
    // image/png, image/jpeg, image/gif and image/webp.
    public function uploadMedia(string $imageBytes, string $contentType, ?string $altText = null): array
    {
        if ($contentType === "") {
            throw new \InvalidArgumentException("contentType is required");
        }

        return $this->request(
            "POST",
            "/media",
            query: ["alt_text" => $altText],
            bytesBody: [$imageBytes, $contentType],
        );
    }

    // Reads an image back, as ["bytes" => the file, "contentType" => the type
    // it was uploaded as].
    public function getMedia(string $mediaId): array
    {
        [, $mediaType, $responseBody] = $this->send("GET", "/media/" . self::segment($mediaId));

        return ["bytes" => $responseBody, "contentType" => $mediaType];
    }

    // Deletes an image and frees the storage. Posts that used it keep their
    // text and lose the image, so delete one only once the posts that need it
    // have gone out.
    public function deleteMedia(string $mediaId): array
    {
        return $this->request("DELETE", "/media/" . self::segment($mediaId));
    }

    //
    // Webhooks
    //

    // Registers an https endpoint of yours for post.sent, post.failed,
    // post.deleted, post.metrics, connection.created, connection.removed and
    // connection.reconnect_required events. events defaults to all of them.
    // The secret in the response is shown exactly once. Store it now.
    public function createWebhook(string $url, ?array $events = null): array
    {
        return $this->request(
            "POST",
            "/webhooks",
            jsonBody: self::withoutNulls(["url" => $url, "events" => self::asList($events)]),
        );
    }

    // Your webhooks, newest first. Secrets are never included.
    public function listWebhooks(): array
    {
        return $this->request("GET", "/webhooks");
    }

    // Stops delivering events to this webhook. Deliveries still queued for it
    // are marked failed.
    public function deleteWebhook(string $webhookId): array
    {
        return $this->request("DELETE", "/webhooks/" . self::segment($webhookId));
    }

    // The delivery log for one webhook of yours, newest first: what was sent,
    // how it went, and the last error when it did not. status is one of
    // pending, delivered, failed and dead. startingAfter is a delivery id: the
    // page continues from the delivery after that one, which is steadier than
    // an offset while new deliveries land at the top of the log.
    public function listWebhookDeliveries(
        string $webhookId,
        ?int $limit = null,
        ?string $status = null,
        ?string $startingAfter = null,
    ): array {
        return $this->request(
            "GET",
            "/webhooks/" . self::segment($webhookId) . "/deliveries",
            query: ["status" => $status, "limit" => $limit, "startingAfter" => $startingAfter],
        );
    }

    // Queues the delivery again as a fresh attempt chain, keeping its event id
    // and its body. Allowed on failed, dead and delivered; a delivery already
    // waiting for an attempt is a 400 invalid_request.
    public function replayDelivery(string $webhookId, string $deliveryId): array
    {
        return $this->request(
            "POST",
            "/webhooks/" . self::segment($webhookId) . "/deliveries/" . self::segment($deliveryId) . "/replay",
        );
    }

    // Enqueues a synthetic post.sent delivery, so a receiver can be checked
    // without posting. Its body carries "test": true and nothing was posted.
    public function sendTestEvent(string $webhookId): array
    {
        return $this->request("POST", "/webhooks/" . self::segment($webhookId) . "/test");
    }

    //
    // Health, stats and the spec
    //

    // Whether the database answers and whether each background worker has
    // finished a loop recently. The endpoint needs no API key, and the status
    // code is 200 whether the API is ok or degraded, so read "status" rather
    // than catching an exception. The one exception is a database that does
    // not answer at all: the endpoint's own rate limit is a database query and
    // runs first, so that is a 500 and a thrown YeetpostApiError. The answer
    // is cached for 10 seconds, so polling faster than that buys nothing.
    public function getHealth(): array
    {
        return $this->request("GET", "/health", isPublicEndpoint: true);
    }

    // The same health aggregated per UTC day, oldest first, from a sample
    // taken once a minute and kept for 90 days. days is 1 to 90 and defaults
    // to 90. This one needs no API key either, and its answer is cached for 60
    // seconds.
    public function getHealthHistory(?int $days = null): array
    {
        return $this->request("GET", "/health/history", query: ["days" => $days], isPublicEndpoint: true);
    }

    // Public numbers about yeetpost as a whole, nothing about one account:
    // posts that reached a platform this week and ever, the connections that
    // can be posted to right now, and the platforms a post can go out to
    // today. It needs no API key, and its answer is cached for 60 seconds.
    public function getStats(): array
    {
        return $this->request("GET", "/stats", isPublicEndpoint: true);
    }

    // The OpenAPI document this client was written against. It needs no API
    // key either, so a client built with an empty one can read it.
    public function getOpenapiSpec(): array
    {
        return $this->request("GET", "/openapi.json", isPublicEndpoint: true);
    }

    //
    // Connect redirects
    //

    // One query parameter, empty when the query did not carry it. PHP keeps
    // the last of a repeated parameter on its own, and hands a name[]= over as
    // an array, which is nothing the hosted page would send, so anything but a
    // string is read as not there.
    private static function queryValue(array $query, string $name): string
    {
        $value = $query[$name] ?? "";

        if (!is_string($value)) {
            return "";
        }

        return $value;
    }

    // Reads what the hosted page put on the query your customer landed on,
    // which is $_GET in plain PHP and the query array of any framework.
    //
    // The answer always carries "connectSessionId", empty when the query did
    // not come from a connect link. "connectionId", "profileId", "slug" and
    // "platform" are there when an account was connected, and "error" instead
    // when it was not ("cancelled" when the customer backed out,
    // "connect_failed" when the platform refused), so a redirect never carries
    // both.
    //
    // This is a browser coming back, so nothing here is proof of anything:
    // read the connection off getConnectSession or off the connection.created
    // webhook before you store it against a customer.
    public static function parseConnectRedirect(array $query): array
    {
        $redirect = ["connectSessionId" => self::queryValue($query, "connectSessionId")];

        $connectionId = self::queryValue($query, "connectionId");
        $profileId = self::queryValue($query, "profileId");
        $slug = self::queryValue($query, "slug");
        $platform = self::queryValue($query, "platform");
        $error = self::queryValue($query, "error");

        if ($connectionId !== "") {
            $redirect["connectionId"] = $connectionId;
        }

        if ($profileId !== "") {
            $redirect["profileId"] = $profileId;
        }

        if ($slug !== "") {
            $redirect["slug"] = $slug;
        }

        if ($platform !== "") {
            $redirect["platform"] = $platform;
        }

        if ($error !== "") {
            $redirect["error"] = $error;
        }

        return $redirect;
    }

    //
    // Webhook signatures
    //

    // Verifies a webhook delivery: the signature must match the body, and the
    // delivery must be recent enough that a captured one cannot be replayed at
    // you later.
    //
    // body is the raw request body, before any JSON parsing, which is
    // file_get_contents("php://input") in plain PHP. Re-serialising it changes
    // the bytes that were signed. signatureHeader is the x-yeetpost-signature
    // header, "t=<unix seconds>,v1=<hex hmac-sha256>". secret is the
    // "yp_whsec_…" value from the createWebhook response. A header that does
    // not parse, a signature that does not match and a timestamp outside the
    // tolerance are all a plain false: reject the delivery, and never answer
    // it with a 500.
    public static function verifyWebhookSignature(
        string $body,
        string $signatureHeader,
        string $secret,
        int $toleranceSeconds = self::DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
    ): bool {
        $isMatch = preg_match(self::SIGNATURE_HEADER_PATTERN, $signatureHeader, $match);

        if ($isMatch !== 1) {
            return false;
        }

        $timestampSeconds = (int) $match[1];
        $signature = $match[2];

        $ageSeconds = abs(time() - $timestampSeconds);

        if ($ageSeconds > $toleranceSeconds) {
            return false;
        }

        $signedPayload = $timestampSeconds . "." . $body;
        $expected = hash_hmac("sha256", $signedPayload, $secret);

        return hash_equals($expected, $signature);
    }
}
