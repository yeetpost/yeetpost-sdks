<?php

declare(strict_types=1);

namespace Yeetpost\Tests;

use PHPUnit\Framework\TestCase;
use Yeetpost\Yeetpost;

final class ParseConnectRedirectTest extends TestCase
{
    private const CONNECTION_ID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

    private const PROFILE_ID = "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b";

    private const CONNECT_SESSION_ID = "7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f";

    // The array PHP builds as $_GET from a query string, which is what a
    // handler hands over
    private static function parsedQuery(string $queryString): array
    {
        parse_str($queryString, $query);

        return $query;
    }

    public function testItReadsTheQueryAConnectedCustomerCameBackOn(): void
    {
        $query = self::parsedQuery(
            "connectSessionId=" . self::CONNECT_SESSION_ID
            . "&connectionId=" . self::CONNECTION_ID
            . "&profileId=" . self::PROFILE_ID
            . "&slug=acme_linkedin&platform=linkedin",
        );

        $this->assertSame(
            [
                "connectSessionId" => self::CONNECT_SESSION_ID,
                "connectionId" => self::CONNECTION_ID,
                "profileId" => self::PROFILE_ID,
                "slug" => "acme_linkedin",
                "platform" => "linkedin",
            ],
            Yeetpost::parseConnectRedirect($query),
        );
    }

    public function testItReadsACancelledRedirect(): void
    {
        $query = self::parsedQuery("connectSessionId=" . self::CONNECT_SESSION_ID . "&error=cancelled");

        // No connection was made, so the connection keys are not there at all
        $this->assertSame(
            ["connectSessionId" => self::CONNECT_SESSION_ID, "error" => "cancelled"],
            Yeetpost::parseConnectRedirect($query),
        );
    }

    public function testItReadsAnArrayValueAsNotThere(): void
    {
        // PHP parses ?error[]=a&error[]=b into a list, which is nothing the
        // hosted page would send, so it is read the way a missing key is
        $query = [
            "connectSessionId" => self::CONNECT_SESSION_ID,
            "error" => ["connect_failed", "cancelled"],
        ];

        $this->assertSame(
            ["connectSessionId" => self::CONNECT_SESSION_ID],
            Yeetpost::parseConnectRedirect($query),
        );
    }

    public function testItLeavesTheSessionIdEmptyOnAQueryThatIsNotOurs(): void
    {
        $query = self::parsedQuery("utm_source=newsletter");

        $this->assertSame(["connectSessionId" => ""], Yeetpost::parseConnectRedirect($query));
    }
}
