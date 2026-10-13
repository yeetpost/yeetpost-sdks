<?php

declare(strict_types=1);

namespace Yeetpost;

// Every non-2xx answer from the API.
//
// The API answers a failure with {"error", "message"}, plus "req_id" on
// platform_rejected. The one exception is 429, whose
// body is {"error": "too many requests"} and carries no message and no code
// from the vocabulary, so on a 429 the code is that literal string and the
// thing to branch on is status.
//
// The code is errorCode rather than code, because \Exception already owns code
// as an int and PHP will not let a subclass retype it. The message is the
// exception's own: read it with getMessage().
//
// requestId is the x-request-id header, and the body's req_id when the header
// was not sent. rateLimitLimit, rateLimitRemaining and rateLimitReset are the
// x-ratelimit-* headers: the requests allowed in the current window, the
// requests left in it, and the unix second it has room again. Each is -1 when
// the response did not carry the header, which is the case on 401.
final class YeetpostApiError extends \RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly ?string $requestId = null,
        public readonly int $rateLimitLimit = -1,
        public readonly int $rateLimitRemaining = -1,
        public readonly int $rateLimitReset = -1,
    ) {
        parent::__construct($message);
    }
}
