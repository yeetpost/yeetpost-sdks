<?php

declare(strict_types=1);

namespace Yeetpost\Tests;

use PHPUnit\Framework\TestCase;
use Yeetpost\Yeetpost;
use Yeetpost\YeetpostApiError;

// The client is exercised against a real http server on a random port, PHP's
// own `php -S` running tests/stub_server.php, so the request it actually puts
// on the wire (method, path, query, headers, body) is what gets asserted.
// Nothing here reaches the network.
final class YeetpostTest extends TestCase
{
    private const CONNECTION_ID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

    private const LINKEDIN_CONNECTION = [
        "id" => self::CONNECTION_ID,
        "slug" => "linkedin",
        "platformId" => "linkedin",
        "description" => "Alex Doe (LinkedIn)",
        "profileId" => null,
        "timezone" => "Europe/Helsinki",
        "queueSlots" => [["weekday" => 1, "time" => "09:00"]],
    ];

    private const MEDIA_ID = "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d";

    private const POST_ID = "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10";

    private const PROFILE_ID = "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b";

    private const ACME_PROFILE = [
        "id" => self::PROFILE_ID,
        "name" => "Acme Coffee",
        "externalId" => "cus_4821",
        "createdAt" => "2026-08-29T09:24:11.412Z",
    ];

    private const SOURCE_ID = "7d1f0c52-3a8e-4d6b-9c41-0b2e5a9f1c33";

    private const SOURCE_ITEM_ID = "2c9e4b1a-6d3f-4e58-b7a0-5f1d8c3e9a42";

    private const HERIZON_SOURCE = [
        "id" => self::SOURCE_ID,
        "slug" => "herizon-io",
        "name" => "Herizon courses",
        "url" => "https://herizon.io/courses.xml",
        "kind" => "feed",
        "resolvedUrl" => null,
        "profileId" => null,
        "connectionSlugs" => ["herizon_linkedin"],
        "mode" => "queue",
        "instructions" => "",
        "makeCard" => true,
        "status" => "active",
        "lastCheckedAt" => null,
        "nextCheckAt" => "2026-10-27T10:00:00.000Z",
        "lastError" => null,
        "itemCounts" => ["baseline" => 3, "new" => 0, "writing" => 0, "posted" => 0, "failed" => 0, "skipped" => 0],
        "pushUrl" => null,
        "createdAt" => "2026-10-27T09:00:00.000Z",
    ];

    private const KEY_ID = "9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31";

    // Word for word what the API answers a scoped key that tries to manage
    // keys, so the stub is the real refusal rather than an approximation of one
    private const SCOPED_KEY_MESSAGE = "This API key is scoped to profile " . self::PROFILE_ID
        . ", which cannot manage API keys. Use an unscoped key for that.";

    private const ACME_KEY = [
        "id" => self::KEY_ID,
        "name" => "Acme integration",
        "type" => "live",
        "prefix" => "yp_secret_4f9a2c",
        "profileId" => self::PROFILE_ID,
        "redirectAllowlist" => ["https://acme.example.com"],
        "createdAt" => "2026-08-30T09:24:11.412Z",
        "lastUsedAt" => null,
        "revokedAt" => null,
    ];

    private const CONNECT_SESSION_ID = "7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f";

    private const CONNECT_SESSION = [
        "url" => "https://yeetpost.com/connect/8Qm2rXk9vT1sB4nE6yPzL0aJdHcWfUgR",
        "expiresAt" => "2026-08-29T09:39:11.412Z",
        "connectSessionId" => self::CONNECT_SESSION_ID,
    ];

    private const WEBHOOK_ID = "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90";

    private const DELIVERY_ID = "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68";

    private const PENDING_DELIVERY = [
        "id" => self::DELIVERY_ID,
        "eventId" => self::DELIVERY_ID,
        "event" => "post.sent",
        "status" => "pending",
        "attempts" => 0,
        "createdAt" => "2026-08-26T09:24:12.004Z",
        "nextAttemptAt" => "2026-08-26T11:02:41.880Z",
        "deliveredAt" => null,
        "deadAt" => null,
        "lastStatusCode" => null,
        "lastError" => null,
    ];

    // The stub server process, and the directory it reads its answer from and
    // records requests into
    private static mixed $serverProcess = null;

    private static string $stubDirectory = "";

    private static string $baseUrl = "";

    private Yeetpost $client;

    public static function setUpBeforeClass(): void
    {
        self::$stubDirectory = sys_get_temp_dir() . "/yeetpost-php-stub-" . bin2hex(random_bytes(6));
        mkdir(self::$stubDirectory);

        // Bind port 0 to have the kernel pick a free one, then hand it to the
        // server. The window between the two is too small to matter.
        $socket = stream_socket_server("tcp://127.0.0.1:0");
        $name = stream_socket_get_name($socket, false);
        $port = (int) substr($name, strrpos($name, ":") + 1);
        fclose($socket);

        // The first answer carries a marker header, so readiness is the stub
        // itself answering rather than anything else that happens to listen
        self::setStubResponse(200, "ready", "text/plain", ["x-yeetpost-stub" => "ready"]);

        self::$serverProcess = proc_open(
            [PHP_BINARY, "-S", "127.0.0.1:" . $port, __DIR__ . "/stub_server.php"],
            [["pipe", "r"], ["file", "/dev/null", "w"], ["file", "/dev/null", "w"]],
            $pipes,
            null,
            array_merge(getenv(), ["YEETPOST_STUB_DIRECTORY" => self::$stubDirectory]),
        );

        self::$baseUrl = "http://127.0.0.1:" . $port . "/api/v2";

        // PHPUnit skips tearDownAfterClass when this throws, so the server
        // and the directory are cleaned up here before the throw
        try {
            self::waitForStubServer($port);
        } catch (\Throwable $error) {
            self::stopStubServer();

            throw $error;
        }
    }

    // Polls the stub until it answers with its marker header, up to five
    // seconds.
    private static function waitForStubServer(int $port): void
    {
        $context = stream_context_create(["http" => ["timeout" => 0.5, "ignore_errors" => true]]);

        for ($attempt = 0; $attempt < 100; $attempt++) {
            $headers = @get_headers("http://127.0.0.1:" . $port . "/ready", true, $context);

            if ($headers !== false && ($headers["x-yeetpost-stub"] ?? null) === "ready") {
                return;
            }

            usleep(50_000);
        }

        throw new \RuntimeException("the stub server did not come up on port " . $port);
    }

    private static function stopStubServer(): void
    {
        if (self::$serverProcess !== null) {
            proc_terminate(self::$serverProcess);
            proc_close(self::$serverProcess);
            self::$serverProcess = null;
        }

        foreach (glob(self::$stubDirectory . "/*") as $file) {
            unlink($file);
        }

        rmdir(self::$stubDirectory);
    }

    public static function tearDownAfterClass(): void
    {
        self::stopStubServer();
    }

    protected function setUp(): void
    {
        file_put_contents(self::$stubDirectory . "/requests.jsonl", "");
        self::setStubResponse(200, []);
        $this->client = new Yeetpost("yp_secret_test", self::$baseUrl);
    }

    // What the stub server answers the next request with. A string body goes
    // out as it is; anything else is encoded the way the API encodes it,
    // without escaped slashes, which is what the node sdk's JSON.stringify
    // writes and what the shared webhook vector is signed over.
    private static function setStubResponse(
        int $status,
        mixed $body,
        string $contentType = "application/json",
        array $extraHeaders = [],
    ): void {
        if (!is_string($body)) {
            $body = json_encode((object) $body, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        }

        file_put_contents(
            self::$stubDirectory . "/response.json",
            json_encode([
                "status" => $status,
                "contentType" => $contentType,
                "extraHeaders" => (object) $extraHeaders,
                "body" => $body,
            ], JSON_THROW_ON_ERROR),
        );
    }

    // Every request the stub has seen since setUp, oldest first, each as
    // ["method", "path", "headers", "body"] with the body as bytes again.
    private function recordedRequests(): array
    {
        $lines = file(self::$stubDirectory . "/requests.jsonl", FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        $requests = [];

        foreach ($lines as $line) {
            $request = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
            $request["body"] = base64_decode($request["body"]);
            $requests[] = $request;
        }

        return $requests;
    }

    // The single request a call is expected to have made.
    private function onlyRequest(): array
    {
        $requests = $this->recordedRequests();

        $this->assertCount(1, $requests);

        return $requests[0];
    }

    private function decodedBody(array $request): array
    {
        return json_decode($request["body"], true, 512, JSON_THROW_ON_ERROR);
    }

    //
    // Connections
    //

    public function testSendsTheApiKeyAsTheXApiKeyHeader(): void
    {
        self::setStubResponse(200, ["connections" => [self::LINKEDIN_CONNECTION]]);

        $response = $this->client->listConnections();

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/connections", $request["path"]);
        $this->assertSame("yp_secret_test", $request["headers"]["x-api-key"]);
        $this->assertSame(["connections" => [self::LINKEDIN_CONNECTION]], $response);
    }

    public function testGetConnectionReadsOneConnection(): void
    {
        self::setStubResponse(200, ["connection" => self::LINKEDIN_CONNECTION]);

        $response = $this->client->getConnection(self::CONNECTION_ID);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/connections/" . self::CONNECTION_ID, $request["path"]);
        $this->assertSame(["connection" => self::LINKEDIN_CONNECTION], $response);
    }

    public function testUpdateConnectionMovesItIntoAProfile(): void
    {
        $moved = [
            "connection" => array_merge(self::LINKEDIN_CONNECTION, ["profileId" => self::PROFILE_ID]),
        ];
        self::setStubResponse(200, $moved);

        $response = $this->client->updateConnection(self::CONNECTION_ID, self::PROFILE_ID);

        $request = $this->onlyRequest();
        $this->assertSame("PATCH", $request["method"]);
        $this->assertSame("/api/v2/connections/" . self::CONNECTION_ID, $request["path"]);
        $this->assertSame("application/json", $request["headers"]["content-type"]);
        $this->assertSame('{"profileId":"' . self::PROFILE_ID . '"}', $request["body"]);
        $this->assertSame($moved, $response);
    }

    public function testUpdateConnectionSendsAnExplicitNullToMoveItBackOut(): void
    {
        self::setStubResponse(200, ["connection" => self::LINKEDIN_CONNECTION]);

        $this->client->updateConnection(self::CONNECTION_ID, null);

        // An explicit null, not an omitted field: null is what moves the
        // connection back out to your own
        $this->assertSame('{"profileId":null}', $this->onlyRequest()["body"]);
    }

    public function testUpdateConnectionSetsTheVoiceAndLeavesTheProfileAlone(): void
    {
        $voice = ["toneDescription" => "dry and short", "examplePosts" => ["shipped"]];
        $updated = [
            "connection" => array_merge(self::LINKEDIN_CONNECTION, ["voice" => $voice, "look" => null]),
        ];
        self::setStubResponse(200, $updated);

        $response = $this->client->updateConnection(self::CONNECTION_ID, voice: $voice);

        $request = $this->onlyRequest();
        $this->assertSame("PATCH", $request["method"]);
        $this->assertSame("/api/v2/connections/" . self::CONNECTION_ID, $request["path"]);
        $this->assertSame('{"voice":{"toneDescription":"dry and short","examplePosts":["shipped"]}}', $request["body"]);
        $this->assertSame($updated, $response);
    }

    public function testUpdateConnectionSetsTheLookAndClearsTheVoice(): void
    {
        $look = ["description" => "warm and bold", "exampleCards" => [], "logoMediaId" => null];
        self::setStubResponse(200, ["connection" => self::LINKEDIN_CONNECTION]);

        $this->client->updateConnection(self::CONNECTION_ID, look: $look, clearVoice: true);

        $this->assertSame(
            '{"look":{"description":"warm and bold","exampleCards":[],"logoMediaId":null},"voice":null}',
            $this->onlyRequest()["body"],
        );
    }

    public function testUpdateConnectionSendsAnExplicitNullToClearTheLook(): void
    {
        self::setStubResponse(200, ["connection" => self::LINKEDIN_CONNECTION]);

        $this->client->updateConnection(self::CONNECTION_ID, clearLook: true);

        $this->assertSame('{"look":null}', $this->onlyRequest()["body"]);
    }

    public function testUpdateConnectionRefusesAVoiceAndClearVoiceTogether(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        $this->client->updateConnection(
            self::CONNECTION_ID,
            voice: ["toneDescription" => "dry", "examplePosts" => []],
            clearVoice: true,
        );
    }

    public function testGetLookReadsTheAccountLook(): void
    {
        $look = [
            "look" => [
                "description" => "warm and bold",
                "exampleCards" => ["<div>card</div>"],
                "logoMediaId" => self::MEDIA_ID,
            ],
        ];
        self::setStubResponse(200, $look);

        $response = $this->client->getLook();

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/look", $request["path"]);
        $this->assertSame($look, $response);
    }

    public function testGetLookAnswersNullWhenTheAccountHasNone(): void
    {
        self::setStubResponse(200, ["look" => null]);

        $this->assertSame(["look" => null], $this->client->getLook());
    }

    public function testUpdateLookPutsTheWholeLook(): void
    {
        $look = ["description" => "warm and bold", "exampleCards" => [], "logoMediaId" => null];
        self::setStubResponse(200, ["look" => $look]);

        $response = $this->client->updateLook($look);

        $request = $this->onlyRequest();
        $this->assertSame("PUT", $request["method"]);
        $this->assertSame("/api/v2/look", $request["path"]);
        $this->assertSame(
            '{"look":{"description":"warm and bold","exampleCards":[],"logoMediaId":null}}',
            $request["body"],
        );
        $this->assertSame(["look" => $look], $response);
    }

    public function testUpdateLookSendsAnExplicitNullToClearIt(): void
    {
        self::setStubResponse(200, ["look" => null]);

        $response = $this->client->updateLook(null);

        $this->assertSame('{"look":null}', $this->onlyRequest()["body"]);
        $this->assertSame(["look" => null], $response);
    }

    public function testDraftLookFromUrlPostsTheAddressAndTheTarget(): void
    {
        self::setStubResponse(200, json_decode('{"url":"https://brand.test/","applied":false,"target":null,"look":{"description":"Acme: a light, clean look.","exampleCards":["<p>a</p>","<p>b</p>"],"logoMediaId":null},"descriptionSource":"facts","facts":{"siteName":"Acme","title":"Acme","tagline":null,"themeColor":null,"colors":{"primary":"#c2410c","accent":null,"background":"#ffffff","text":null,"palette":[{"hex":"#c2410c","count":3}]},"fonts":{"heading":"Inter","body":"Inter","families":["Inter"],"googleFonts":[]},"logo":null,"hasInlineSvgLogo":true,"stylesheetsRead":1},"warnings":["The site\'s logo is an inline svg."]}', true));

        $response = $this->client->draftLookFromUrl(
            "https://brand.test/",
            apply: true,
            connectionId: self::CONNECTION_ID,
        );

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/look/draft-from-url", $request["path"]);
        $this->assertSame(
            '{"url":"https://brand.test/","apply":true,"connectionId":"' . self::CONNECTION_ID . '"}',
            $request["body"],
        );
        $this->assertSame("facts", $response["descriptionSource"]);
    }

    public function testRenderImagePostsTheCardAndReadsTheStoredImage(): void
    {
        $rendered = [
            "mediaId" => self::MEDIA_ID,
            "contentType" => "image/png",
            "sizeBytes" => 2048,
            "width" => 1200,
            "height" => 627,
            "postId" => self::POST_ID,
            "rendersUsed" => 13,
            "rendersLimit" => 300,
        ];
        self::setStubResponse(200, $rendered);

        $response = $this->client->renderImage(
            "a card",
            preset: "landscape",
            format: "png",
            altText: "a card",
            postId: self::POST_ID,
        );

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/images/render", $request["path"]);
        $this->assertSame("application/json", $request["headers"]["content-type"]);
        $this->assertSame(
            '{"html":"a card","preset":"landscape","format":"png","altText":"a card","postId":"' . self::POST_ID . '"}',
            $request["body"],
        );
        $this->assertSame($rendered, $response);
    }

    public function testRenderImageSendsWidthAndHeightWhenThereIsNoPreset(): void
    {
        self::setStubResponse(200, ["mediaId" => self::MEDIA_ID, "postId" => null]);

        $this->client->renderImage("x", width: 800, height: 400);

        $this->assertSame('{"html":"x","width":800,"height":400}', $this->onlyRequest()["body"]);
    }

    public function testRenderImagePastTheAllowanceThrows(): void
    {
        self::setStubResponse(429, [
            "error" => "render_allowance_reached",
            "message" => "300 renders a month",
        ]);

        try {
            $this->client->renderImage("x", preset: "square");
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(429, $error->status);
            $this->assertSame("render_allowance_reached", $error->errorCode);
        }
    }

    public function testUpdateConnectionSendsAnEmptyExampleListAsGiven(): void
    {
        self::setStubResponse(200, ["connection" => self::LINKEDIN_CONNECTION]);

        $this->client->updateConnection(
            self::CONNECTION_ID,
            voice: ["toneDescription" => "x", "examplePosts" => []],
            look: ["description" => "bold", "exampleCards" => [], "logoMediaId" => null],
        );

        $this->assertSame(
            '{"voice":{"toneDescription":"x","examplePosts":[]},'
            . '"look":{"description":"bold","exampleCards":[],"logoMediaId":null}}',
            $this->onlyRequest()["body"],
        );
    }

    public function testUpdateConnectionMovesOutAndSetsTheVoiceInOneCall(): void
    {
        self::setStubResponse(200, ["connection" => self::LINKEDIN_CONNECTION]);

        $this->client->updateConnection(
            self::CONNECTION_ID,
            null,
            voice: ["toneDescription" => "x", "examplePosts" => []],
        );

        $this->assertSame(
            '{"voice":{"toneDescription":"x","examplePosts":[]},"profileId":null}',
            $this->onlyRequest()["body"],
        );
    }

    public function testUpdateConnectionWithNothingToChangeThrows(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        $this->client->updateConnection(self::CONNECTION_ID);
    }

    public function testMovingIntoAProfileThatHoldsTheAccountThrows(): void
    {
        self::setStubResponse(409, [
            "error" => "connection_conflict",
            "message" => "That profile already holds a connection to this account.",
        ]);

        try {
            $this->client->updateConnection(self::CONNECTION_ID, self::PROFILE_ID);
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(409, $error->status);
            $this->assertSame("connection_conflict", $error->errorCode);
        }
    }

    public function testListConnectionQueueReturnsWhatIsWaiting(): void
    {
        $queue = [
            "queue" => [
                [
                    "id" => self::POST_ID,
                    "text" => "goes out at the next open slot",
                    "scheduledFor" => "2026-09-07T06:00:00.000Z",
                    "mediaCount" => 0,
                ],
            ],
        ];
        self::setStubResponse(200, $queue);

        $response = $this->client->listConnectionQueue(self::CONNECTION_ID);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/connections/" . self::CONNECTION_ID . "/queue", $request["path"]);
        $this->assertSame($queue, $response);
    }

    public function testUpdateConnectionQueuePatchesTheSlotsAndTheTimezone(): void
    {
        $connection = [
            "connection" => [
                "id" => self::CONNECTION_ID,
                "slug" => "linkedin",
                "timezone" => "Europe/Helsinki",
                "queueSlots" => [["weekday" => 1, "time" => "09:00"], ["weekday" => 4, "time" => "17:30"]],
            ],
        ];
        self::setStubResponse(200, $connection);

        $response = $this->client->updateConnectionQueue(
            self::CONNECTION_ID,
            slots: [["weekday" => 1, "time" => "09:00"], ["weekday" => 4, "time" => "17:30"]],
            timezone: "Europe/Helsinki",
        );

        $request = $this->onlyRequest();
        $this->assertSame("PATCH", $request["method"]);
        $this->assertSame("/api/v2/connections/" . self::CONNECTION_ID . "/queue", $request["path"]);
        $this->assertSame("application/json", $request["headers"]["content-type"]);
        $this->assertSame(
            '{"slots":[{"weekday":1,"time":"09:00"},{"weekday":4,"time":"17:30"}],"timezone":"Europe/Helsinki"}',
            $request["body"],
        );
        $this->assertSame($connection, $response);
    }

    public function testUpdateConnectionQueueSendsOnlyTheTimezoneWhenThatIsAllItWasGiven(): void
    {
        self::setStubResponse(200, ["connection" => []]);

        $this->client->updateConnectionQueue(self::CONNECTION_ID, timezone: "UTC");

        $this->assertSame('{"timezone":"UTC"}', $this->onlyRequest()["body"]);
    }

    public function testUpdateConnectionQueueSendsAnEmptySlotListToClearTheSlots(): void
    {
        self::setStubResponse(200, ["connection" => []]);

        $this->client->updateConnectionQueue(self::CONNECTION_ID, slots: []);

        // An empty list, not an omitted field: the API reads the two
        // differently, and only the list takes the slots off
        $this->assertSame('{"slots":[]}', $this->onlyRequest()["body"]);
    }

    public function testDeleteConnectionSendsADelete(): void
    {
        self::setStubResponse(200, ["id" => self::CONNECTION_ID, "deleted" => true]);

        $response = $this->client->deleteConnection(self::CONNECTION_ID);

        $request = $this->onlyRequest();
        $this->assertSame("DELETE", $request["method"]);
        $this->assertSame("/api/v2/connections/" . self::CONNECTION_ID, $request["path"]);
        $this->assertSame(["id" => self::CONNECTION_ID, "deleted" => true], $response);
    }

    public function testDisconnectingTheLoginConnectionThrows(): void
    {
        self::setStubResponse(403, [
            "error" => "forbidden",
            "message" => "This connection is used to sign in to yeetpost, so it cannot be disconnected.",
        ]);

        try {
            $this->client->deleteConnection(self::CONNECTION_ID);
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(403, $error->status);
            $this->assertSame("forbidden", $error->errorCode);
        }
    }

    public function testListConnectionsNarrowsToOneProfile(): void
    {
        $acmeConnection = array_merge(self::LINKEDIN_CONNECTION, [
            "slug" => "acme_linkedin",
            "profileId" => self::PROFILE_ID,
        ]);
        self::setStubResponse(200, ["connections" => [$acmeConnection]]);

        $response = $this->client->listConnections(profileId: self::PROFILE_ID);

        $this->assertSame("/api/v2/connections?profileId=" . self::PROFILE_ID, $this->onlyRequest()["path"]);
        $this->assertSame(self::PROFILE_ID, $response["connections"][0]["profileId"]);
    }

    //
    // Profiles
    //

    public function testCreateProfileSendsTheNameAndTheExternalId(): void
    {
        self::setStubResponse(200, ["profile" => self::ACME_PROFILE]);

        $response = $this->client->createProfile("Acme Coffee", "cus_4821");

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/profiles", $request["path"]);
        $this->assertSame("application/json", $request["headers"]["content-type"]);
        $this->assertSame(["name" => "Acme Coffee", "externalId" => "cus_4821"], $this->decodedBody($request));
        $this->assertSame(["profile" => self::ACME_PROFILE], $response);
    }

    public function testCreateProfileLeavesOutAnExternalIdItWasNotGiven(): void
    {
        self::setStubResponse(200, ["profile" => array_merge(self::ACME_PROFILE, ["externalId" => null])]);

        $response = $this->client->createProfile("Acme Coffee");

        $this->assertSame(["name" => "Acme Coffee"], $this->decodedBody($this->onlyRequest()));
        $this->assertNull($response["profile"]["externalId"]);
    }

    public function testListProfilesPutsItsPagingInTheQueryString(): void
    {
        $profiles = ["profiles" => [self::ACME_PROFILE], "limit" => 10, "offset" => 20];
        self::setStubResponse(200, $profiles);

        $response = $this->client->listProfiles(limit: 10, offset: 20);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/profiles?limit=10&offset=20", $request["path"]);
        $this->assertSame($profiles, $response);
    }

    public function testListProfilesSendsNoQueryStringWithoutPaging(): void
    {
        self::setStubResponse(200, ["profiles" => [], "limit" => 25, "offset" => 0]);

        $this->client->listProfiles();

        $this->assertSame("/api/v2/profiles", $this->onlyRequest()["path"]);
    }

    public function testGetActivityPutsItsPagingInTheQueryString(): void
    {
        $activity = [
            "items" => [
                [
                    "id" => "evt_1",
                    "at" => "2026-10-20T09:00:00.000Z",
                    "kind" => "post_sent",
                    "title" => "Post sent",
                    "detail" => "Hello",
                    "href" => "/posts/1",
                    "actor" => "Mari",
                ],
            ],
            "cursor" => "abc",
            "refusedRequests" => [],
        ];
        self::setStubResponse(200, $activity);

        $response = $this->client->getActivity(limit: 10, cursor: "abc");

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/activity?limit=10&cursor=abc", $request["path"]);
        $this->assertSame($activity, $response);
    }

    public function testGetActivitySendsNoQueryStringWithoutPaging(): void
    {
        self::setStubResponse(200, ["items" => [], "cursor" => null, "refusedRequests" => []]);

        $this->client->getActivity();

        $this->assertSame("/api/v2/activity", $this->onlyRequest()["path"]);
    }

    public function testPreviewSourcePostsTheUrl(): void
    {
        $preview = [
            "kind" => "feed",
            "name" => "Herizon courses",
            "resolvedUrl" => null,
            "itemCount" => 0,
            "items" => [],
        ];
        self::setStubResponse(200, $preview);

        $response = $this->client->previewSource("https://herizon.io/courses.xml");

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/sources/preview", $request["path"]);
        $this->assertSame(["url" => "https://herizon.io/courses.xml"], $this->decodedBody($request));
        $this->assertSame($preview, $response);
    }

    public function testCreateSourceSendsWhatItIsGivenAndLeavesOutTheRest(): void
    {
        self::setStubResponse(200, ["source" => self::HERIZON_SOURCE]);

        $response = $this->client->createSource(
            ["herizon_linkedin"],
            "queue",
            url: "https://herizon.io/courses.xml",
            instructions: "one post per course",
            backfillCount: 2,
        );

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/sources", $request["path"]);
        $this->assertSame(
            [
                "url" => "https://herizon.io/courses.xml",
                "connectionSlugs" => ["herizon_linkedin"],
                "mode" => "queue",
                "instructions" => "one post per course",
                "backfillCount" => 2,
            ],
            $this->decodedBody($request),
        );
        $this->assertSame(["source" => self::HERIZON_SOURCE], $response);
    }

    public function testCreateSourceMakesAPushSourceAndSendsMakeCardFalse(): void
    {
        self::setStubResponse(200, ["source" => self::HERIZON_SOURCE]);

        $this->client->createSource(["herizon_linkedin"], "draft", kind: "push", makeCard: false);

        $this->assertSame(
            [
                "kind" => "push",
                "connectionSlugs" => ["herizon_linkedin"],
                "mode" => "draft",
                "makeCard" => false,
            ],
            $this->decodedBody($this->onlyRequest()),
        );
    }

    public function testListSourcesPutsItsPagingInTheQueryString(): void
    {
        $sources = ["sources" => [self::HERIZON_SOURCE], "limit" => 10, "offset" => 5];
        self::setStubResponse(200, $sources);

        $response = $this->client->listSources(limit: 10, offset: 5);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/sources?limit=10&offset=5", $request["path"]);
        $this->assertSame($sources, $response);
    }

    public function testListSourcesSendsNoQueryStringWithoutPaging(): void
    {
        self::setStubResponse(200, ["sources" => [], "limit" => 25, "offset" => 0]);

        $this->client->listSources();

        $this->assertSame("/api/v2/sources", $this->onlyRequest()["path"]);
    }

    public function testGetSourceReadsOneSourceById(): void
    {
        self::setStubResponse(200, ["source" => self::HERIZON_SOURCE]);

        $response = $this->client->getSource(self::SOURCE_ID);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/sources/" . self::SOURCE_ID, $request["path"]);
        $this->assertSame(["source" => self::HERIZON_SOURCE], $response);
    }

    public function testUpdateSourcePatchesOnlyWhatItIsGiven(): void
    {
        self::setStubResponse(200, ["source" => self::HERIZON_SOURCE]);

        $this->client->updateSource(self::SOURCE_ID, instructions: "", status: "paused");

        $request = $this->onlyRequest();
        $this->assertSame("PATCH", $request["method"]);
        $this->assertSame("/api/v2/sources/" . self::SOURCE_ID, $request["path"]);
        $this->assertSame('{"instructions":"","status":"paused"}', $request["body"]);
    }

    public function testDeleteSourceDeletesById(): void
    {
        self::setStubResponse(200, ["id" => self::SOURCE_ID, "deleted" => true]);

        $response = $this->client->deleteSource(self::SOURCE_ID);

        $request = $this->onlyRequest();
        $this->assertSame("DELETE", $request["method"]);
        $this->assertSame("/api/v2/sources/" . self::SOURCE_ID, $request["path"]);
        $this->assertSame(["id" => self::SOURCE_ID, "deleted" => true], $response);
    }

    public function testCheckSourcePostsToTheCheckPath(): void
    {
        $checked = [
            "source" => self::HERIZON_SOURCE,
            "newItems" => [
                [
                    "id" => self::SOURCE_ITEM_ID,
                    "title" => "Leading without a title",
                    "url" => "https://herizon.io/courses/leading-without-a-title",
                ],
            ],
        ];
        self::setStubResponse(200, $checked);

        $response = $this->client->checkSource(self::SOURCE_ID);

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/sources/" . self::SOURCE_ID . "/check", $request["path"]);
        $this->assertSame($checked, $response);
    }

    public function testListSourceItemsSendsTheStatusAndPaging(): void
    {
        $items = ["items" => [], "limit" => 10, "offset" => 0];
        self::setStubResponse(200, $items);

        $response = $this->client->listSourceItems(self::SOURCE_ID, status: "failed", limit: 10, offset: 0);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame(
            "/api/v2/sources/" . self::SOURCE_ID . "/items?status=failed&limit=10&offset=0",
            $request["path"],
        );
        $this->assertSame($items, $response);
    }

    public function testAddSourceItemsPostsTheItems(): void
    {
        self::setStubResponse(200, ["added" => 1, "duplicates" => 0]);
        $items = [
            [
                "id" => "course-4",
                "title" => "Pricing your work",
                "url" => "https://herizon.io/courses/pricing-your-work",
            ],
        ];

        $response = $this->client->addSourceItems(self::SOURCE_ID, $items);

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/sources/" . self::SOURCE_ID . "/items", $request["path"]);
        $this->assertSame(["items" => $items], $this->decodedBody($request));
        $this->assertSame(["added" => 1, "duplicates" => 0], $response);
    }

    public function testAddSourceItemsLeavesOutTheFieldsThatAreNull(): void
    {
        self::setStubResponse(200, ["added" => 1, "duplicates" => 0]);

        $this->client->addSourceItems(self::SOURCE_ID, [
            ["id" => "course-4", "title" => "Pricing", "url" => null, "summary" => null],
        ]);

        $this->assertSame(
            ["items" => [["id" => "course-4", "title" => "Pricing"]]],
            $this->decodedBody($this->onlyRequest()),
        );
    }

    public function testRetrySourceItemPostsToTheRetryPath(): void
    {
        self::setStubResponse(200, ["id" => self::SOURCE_ITEM_ID, "status" => "new"]);

        $response = $this->client->retrySourceItem(self::SOURCE_ID, self::SOURCE_ITEM_ID);

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame(
            "/api/v2/sources/" . self::SOURCE_ID . "/items/" . self::SOURCE_ITEM_ID . "/retry",
            $request["path"],
        );
        $this->assertSame(["id" => self::SOURCE_ITEM_ID, "status" => "new"], $response);
    }

    public function testATestKeys403OnSourcesIsAnApiError(): void
    {
        self::setStubResponse(403, [
            "error" => "forbidden",
            "message" => "Sources post to real connections, so they need a live API key. Test keys cannot use them.",
        ]);

        try {
            $this->client->listSources();
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(403, $error->status);
            $this->assertSame("forbidden", $error->errorCode);
        }
    }

    public function testCreateConnectUrlReconnectsWithoutARedirectUrl(): void
    {
        self::setStubResponse(200, self::CONNECT_SESSION);

        $this->client->createConnectUrl(self::PROFILE_ID, connectionId: self::CONNECTION_ID);

        $this->assertSame(["connectionId" => self::CONNECTION_ID], $this->decodedBody($this->onlyRequest()));
    }

    public function testGetProfileReadsOneProfile(): void
    {
        self::setStubResponse(200, ["profile" => self::ACME_PROFILE]);

        $response = $this->client->getProfile(self::PROFILE_ID);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/profiles/" . self::PROFILE_ID, $request["path"]);
        $this->assertSame(["profile" => self::ACME_PROFILE], $response);
    }

    public function testUpdateProfileSendsOnlyTheFieldsItWasGiven(): void
    {
        self::setStubResponse(200, ["profile" => array_merge(self::ACME_PROFILE, ["name" => "Acme Coffee Oy"])]);

        $response = $this->client->updateProfile(self::PROFILE_ID, "Acme Coffee Oy");

        $request = $this->onlyRequest();
        $this->assertSame("PATCH", $request["method"]);
        $this->assertSame("/api/v2/profiles/" . self::PROFILE_ID, $request["path"]);
        $this->assertSame(["name" => "Acme Coffee Oy"], $this->decodedBody($request));
        $this->assertSame("Acme Coffee Oy", $response["profile"]["name"]);
    }

    public function testUpdateProfileSendsTheExternalIdAsAString(): void
    {
        self::setStubResponse(200, ["profile" => array_merge(self::ACME_PROFILE, ["externalId" => "cus_9900"])]);

        $this->client->updateProfile(self::PROFILE_ID, externalId: "cus_9900");

        $this->assertSame('{"externalId":"cus_9900"}', $this->onlyRequest()["body"]);
    }

    public function testUpdateProfileClearsTheExternalIdWithANull(): void
    {
        self::setStubResponse(200, ["profile" => array_merge(self::ACME_PROFILE, ["externalId" => null])]);

        $this->client->updateProfile(self::PROFILE_ID, clearExternalId: true);

        // An explicit null, not an omitted field: the API reads the two
        // differently, and only the null takes the external id off
        $this->assertSame('{"externalId":null}', $this->onlyRequest()["body"]);
    }

    public function testUpdateProfileRefusesAnExternalIdAndAClear(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        $this->client->updateProfile(self::PROFILE_ID, externalId: "cus_4821", clearExternalId: true);
    }

    public function testUpdateProfileRefusesACallThatNamesNoField(): void
    {
        try {
            $this->client->updateProfile(self::PROFILE_ID);
            $this->fail("expected an InvalidArgumentException");
        } catch (\InvalidArgumentException $error) {
            $this->assertSame("pass a name, an externalId, or both", $error->getMessage());
        }

        // Refused here rather than by the API: nothing went out
        $this->assertSame([], $this->recordedRequests());
    }

    public function testDeleteProfileSaysHowManyConnectionsWent(): void
    {
        $deleted = ["id" => self::PROFILE_ID, "deleted" => true, "removedConnections" => 2];
        self::setStubResponse(200, $deleted);

        $response = $this->client->deleteProfile(self::PROFILE_ID);

        $request = $this->onlyRequest();
        $this->assertSame("DELETE", $request["method"]);
        $this->assertSame("/api/v2/profiles/" . self::PROFILE_ID, $request["path"]);
        $this->assertSame($deleted, $response);
    }

    public function testASecondProfileWithTheSameExternalIdThrows(): void
    {
        self::setStubResponse(409, [
            "error" => "profile_external_id_conflict",
            "message" => "A profile with this externalId already exists.",
        ]);

        try {
            $this->client->createProfile("Acme Coffee", "cus_4821");
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(409, $error->status);
            $this->assertSame("profile_external_id_conflict", $error->errorCode);
        }
    }

    //
    // Keys
    //

    public function testCreateProfileKeySendsTheNameTypeAndAllowlist(): void
    {
        self::setStubResponse(201, ["key" => self::ACME_KEY, "secret" => "yp_secret_4f9a2c8e"]);

        $response = $this->client->createProfileKey(
            self::PROFILE_ID,
            "Acme integration",
            "live",
            ["https://acme.example.com"],
        );

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/profiles/" . self::PROFILE_ID . "/keys", $request["path"]);
        $this->assertSame("application/json", $request["headers"]["content-type"]);
        $this->assertSame(
            [
                "name" => "Acme integration",
                "type" => "live",
                "redirectAllowlist" => ["https://acme.example.com"],
            ],
            $this->decodedBody($request),
        );
        $this->assertSame(["key" => self::ACME_KEY, "secret" => "yp_secret_4f9a2c8e"], $response);
    }

    public function testCreateProfileKeyLeavesOutAnAllowlistItWasNotGiven(): void
    {
        self::setStubResponse(201, [
            "key" => array_merge(self::ACME_KEY, ["redirectAllowlist" => null]),
            "secret" => "yp_secret_4f9a2c8e",
        ]);

        $response = $this->client->createProfileKey(self::PROFILE_ID, "Acme integration", "live");

        $this->assertSame(
            ["name" => "Acme integration", "type" => "live"],
            $this->decodedBody($this->onlyRequest()),
        );
        $this->assertNull($response["key"]["redirectAllowlist"]);
    }

    public function testListProfileKeysPutsIncludeRevokedInTheQuery(): void
    {
        $revokedKey = array_merge(self::ACME_KEY, ["revokedAt" => "2026-08-30T10:00:00.000Z"]);
        self::setStubResponse(200, ["keys" => [self::ACME_KEY, $revokedKey], "limit" => 25, "offset" => 0]);

        $response = $this->client->listProfileKeys(self::PROFILE_ID, includeRevoked: true);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/profiles/" . self::PROFILE_ID . "/keys?includeRevoked=true", $request["path"]);
        $this->assertSame("2026-08-30T10:00:00.000Z", $response["keys"][1]["revokedAt"]);
    }

    public function testListProfileKeysSendsAnExplicitIncludeRevokedFalse(): void
    {
        self::setStubResponse(200, ["keys" => [], "limit" => 25, "offset" => 0]);

        $this->client->listProfileKeys(self::PROFILE_ID, includeRevoked: false);

        // The literal "false" the API takes, not PHP's empty string for false
        $this->assertSame(
            "/api/v2/profiles/" . self::PROFILE_ID . "/keys?includeRevoked=false",
            $this->onlyRequest()["path"],
        );
    }

    public function testListProfileKeysPutsItsPagingInTheQuery(): void
    {
        $keys = ["keys" => [self::ACME_KEY], "limit" => 10, "offset" => 20];
        self::setStubResponse(200, $keys);

        $response = $this->client->listProfileKeys(self::PROFILE_ID, limit: 10, offset: 20);

        $this->assertSame(
            "/api/v2/profiles/" . self::PROFILE_ID . "/keys?limit=10&offset=20",
            $this->onlyRequest()["path"],
        );
        $this->assertSame($keys, $response);
    }

    public function testListProfileKeysSendsNoQueryStringWithoutIt(): void
    {
        $keys = ["keys" => [self::ACME_KEY], "limit" => 25, "offset" => 0];
        self::setStubResponse(200, $keys);

        $response = $this->client->listProfileKeys(self::PROFILE_ID);

        $this->assertSame("/api/v2/profiles/" . self::PROFILE_ID . "/keys", $this->onlyRequest()["path"]);
        $this->assertSame($keys, $response);
    }

    public function testAnIdWithASlashIsEscapedIntoOnePathSegment(): void
    {
        self::setStubResponse(200, ["id" => "acme/key", "revoked" => true]);

        $this->client->revokeKey("acme/key");

        // The slash is %2F, so the id cannot open a path of its own
        $this->assertSame("/api/v2/keys/acme%2Fkey", $this->onlyRequest()["path"]);
    }

    public function testRevokeProfileKeyDeletesTheKeyUnderItsProfile(): void
    {
        self::setStubResponse(200, ["id" => self::KEY_ID, "revoked" => true]);

        $response = $this->client->revokeProfileKey(self::PROFILE_ID, self::KEY_ID);

        $request = $this->onlyRequest();
        $this->assertSame("DELETE", $request["method"]);
        $this->assertSame("/api/v2/profiles/" . self::PROFILE_ID . "/keys/" . self::KEY_ID, $request["path"]);
        $this->assertSame(["id" => self::KEY_ID, "revoked" => true], $response);
    }

    public function testListKeysReadsEveryKeyOfTheAccount(): void
    {
        $accountKey = array_merge(self::ACME_KEY, ["profileId" => null]);
        self::setStubResponse(200, ["keys" => [$accountKey, self::ACME_KEY], "limit" => 25, "offset" => 0]);

        $response = $this->client->listKeys();

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/keys", $request["path"]);
        $this->assertNull($response["keys"][0]["profileId"]);
        $this->assertSame(self::PROFILE_ID, $response["keys"][1]["profileId"]);
    }

    public function testListKeysPutsIncludeRevokedInTheQueryString(): void
    {
        self::setStubResponse(200, ["keys" => [self::ACME_KEY], "limit" => 25, "offset" => 0]);

        $this->client->listKeys(includeRevoked: false);

        $this->assertSame("/api/v2/keys?includeRevoked=false", $this->onlyRequest()["path"]);
    }

    public function testListKeysPutsItsPagingInTheQueryString(): void
    {
        self::setStubResponse(200, ["keys" => [self::ACME_KEY], "limit" => 50, "offset" => 100]);

        $response = $this->client->listKeys(limit: 50, offset: 100);

        $this->assertSame("/api/v2/keys?limit=50&offset=100", $this->onlyRequest()["path"]);
        $this->assertSame(50, $response["limit"]);
        $this->assertSame(100, $response["offset"]);
    }

    public function testRevokeKeyRevokesAnyKeyOfTheAccountById(): void
    {
        self::setStubResponse(200, ["id" => self::KEY_ID, "revoked" => true]);

        $response = $this->client->revokeKey(self::KEY_ID);

        $request = $this->onlyRequest();
        $this->assertSame("DELETE", $request["method"]);
        $this->assertSame("/api/v2/keys/" . self::KEY_ID, $request["path"]);
        $this->assertSame(["id" => self::KEY_ID, "revoked" => true], $response);
    }

    public function testMintingAKeyWithAKeyScopedToAProfileThrows(): void
    {
        self::setStubResponse(403, ["error" => "forbidden", "message" => self::SCOPED_KEY_MESSAGE]);

        try {
            $this->client->createProfileKey(self::PROFILE_ID, "Acme integration", "live");
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(403, $error->status);
            $this->assertSame("forbidden", $error->errorCode);
            $this->assertSame(self::SCOPED_KEY_MESSAGE, $error->getMessage());
        }
    }

    //
    // Connect sessions
    //

    public function testCreateConnectUrlPostsThePlatformAndRedirectUrl(): void
    {
        self::setStubResponse(200, self::CONNECT_SESSION);

        $response = $this->client->createConnectUrl(
            self::PROFILE_ID,
            "https://acme.example.com/settings/social",
            "linkedin",
        );

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/profiles/" . self::PROFILE_ID . "/connect", $request["path"]);
        $this->assertSame(
            ["platform" => "linkedin", "redirectUrl" => "https://acme.example.com/settings/social"],
            $this->decodedBody($request),
        );
        $this->assertSame(self::CONNECT_SESSION, $response);
    }

    public function testCreateConnectUrlLeavesThePlatformOutForAPicker(): void
    {
        self::setStubResponse(200, self::CONNECT_SESSION);

        $this->client->createConnectUrl(
            self::PROFILE_ID,
            "https://acme.example.com/settings/social",
            headless: true,
        );

        $this->assertSame(
            ["redirectUrl" => "https://acme.example.com/settings/social", "headless" => true],
            $this->decodedBody($this->onlyRequest()),
        );
    }

    public function testGetConnectSessionReadsHowALinkEnded(): void
    {
        self::setStubResponse(200, [
            "connectSession" => [
                "id" => self::CONNECT_SESSION_ID,
                "profileId" => self::PROFILE_ID,
                "platform" => "linkedin",
                "status" => "connected",
                "connectionId" => self::CONNECTION_ID,
                "error" => null,
                "redirectUrl" => "https://acme.example.com/settings/social",
                "headless" => false,
                "expiresAt" => "2026-08-29T09:39:11.412Z",
                "createdAt" => "2026-08-29T09:24:11.412Z",
            ],
        ]);

        $response = $this->client->getConnectSession(self::CONNECT_SESSION_ID);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/connect-sessions/" . self::CONNECT_SESSION_ID, $request["path"]);
        $this->assertSame("connected", $response["connectSession"]["status"]);
        $this->assertSame(self::CONNECTION_ID, $response["connectSession"]["connectionId"]);
    }

    //
    // Posts
    //

    public function testPostToConnectionSendsTheTextAsTheBody(): void
    {
        $published = [
            "platform" => "linkedin",
            "link" => "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
        ];
        self::setStubResponse(200, $published);

        $response = $this->client->postToConnection("linkedin", "shipped the new api docs today");

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/post/linkedin", $request["path"]);
        $this->assertSame("text/plain", $request["headers"]["content-type"]);
        $this->assertSame("shipped the new api docs today", $request["body"]);
        $this->assertSame($published, $response);
    }

    public function testPostToConnectionSchedulesAndEscapesTheSlug(): void
    {
        $scheduled = ["scheduled" => true, "scheduled_for" => "2026-09-15T15:00:00.000Z"];
        self::setStubResponse(200, $scheduled);

        $response = $this->client->postToConnection(
            "alex/doe",
            "scheduled from a real integration",
            scheduledFor: "2026-09-15T15:00:00Z",
        );

        $this->assertSame(
            "/api/v2/post/alex%2Fdoe?scheduled_for=2026-09-15T15%3A00%3A00Z",
            $this->onlyRequest()["path"],
        );
        $this->assertSame($scheduled, $response);
    }

    public function testCreatePostsSendsTheBodyAndTheIdempotencyKey(): void
    {
        $failedItem = [
            "connectionSlug" => "x",
            "status" => "failed",
            "postId" => "0b7e4a52-9f0c-4a1c-8b3a-6d2f5b1c0e44",
            "url" => null,
            "scheduledFor" => null,
            "threadCount" => 0,
            "hasFirstComment" => false,
            "error" => ["code" => "platform_rejected", "message" => "X: duplicate post was detected"],
        ];
        self::setStubResponse(200, [
            "results" => [
                [
                    "connectionSlug" => "linkedin",
                    "status" => "sent",
                    "postId" => self::POST_ID,
                    "url" => "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
                    "scheduledFor" => null,
                    "threadCount" => 0,
                    "hasFirstComment" => false,
                    "error" => null,
                ],
                $failedItem,
            ],
        ]);

        $response = $this->client->createPosts(
            text: "shipped the new api docs today",
            connectionSlugs: ["linkedin", "x"],
            idempotencyKey: "release-v2.4.0-announcement",
        );

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/posts", $request["path"]);
        $this->assertSame("application/json", $request["headers"]["content-type"]);
        $this->assertSame("release-v2.4.0-announcement", $request["headers"]["idempotency-key"]);
        $this->assertSame(
            '{"text":"shipped the new api docs today","connectionSlugs":["linkedin","x"]}',
            $request["body"],
        );
        $this->assertCount(2, $response["results"]);
        $this->assertSame($failedItem, $response["results"][1]);
    }

    public function testCreatePostsSendsAFilteredArrayAsAList(): void
    {
        self::setStubResponse(200, ["results" => []]);

        // array_filter keeps the old keys, 0 and 2, and json_encode would
        // write that as an object; the API wants a list
        $this->client->createPosts(
            text: "to the slugs that are left",
            connectionSlugs: array_filter(["linkedin", "", "x"]),
            tags: array_filter(["launch", "", "q3"]),
        );

        $this->assertSame(
            '{"text":"to the slugs that are left","connectionSlugs":["linkedin","x"],"tags":["launch","q3"]}',
            $this->onlyRequest()["body"],
        );
    }

    public function testABodyThatIsNotValidUtf8IsRefusedBeforeTheCall(): void
    {
        try {
            $this->client->createPosts(text: "not utf-8: \xff", connectionSlugs: ["linkedin"]);
            $this->fail("expected an InvalidArgumentException");
        } catch (\InvalidArgumentException $error) {
            $this->assertSame(
                "the request body could not be encoded as json: Malformed UTF-8 characters, possibly incorrectly encoded",
                $error->getMessage(),
            );
        }

        $this->assertSame([], $this->recordedRequests());
    }

    public function testCreatePostsSendsTheProfileItGoesOutFor(): void
    {
        self::setStubResponse(200, ["results" => []]);

        $this->client->createPosts(
            text: "our new roast is out",
            connectionSlugs: ["acme_linkedin"],
            profileId: self::PROFILE_ID,
        );

        $this->assertSame(
            ["text" => "our new roast is out", "connectionSlugs" => ["acme_linkedin"], "profileId" => self::PROFILE_ID],
            $this->decodedBody($this->onlyRequest()),
        );
    }

    public function testCreatePostsSendsScheduledForWhenItIsGiven(): void
    {
        self::setStubResponse(200, ["results" => []]);

        $this->client->createPosts(
            text: "scheduled from a real integration",
            connectionSlugs: ["linkedin"],
            scheduledFor: "2026-09-15T15:00:00Z",
        );

        $this->assertSame(
            [
                "text" => "scheduled from a real integration",
                "connectionSlugs" => ["linkedin"],
                "scheduledFor" => "2026-09-15T15:00:00Z",
            ],
            $this->decodedBody($this->onlyRequest()),
        );
    }

    public function testCreatePostsReadsAFourthPositionalAsTheIdempotencyKey(): void
    {
        self::setStubResponse(200, ["results" => []]);

        $this->client->createPosts("v2.4.0 is out", ["linkedin"], null, "release-v2.4.0-announcement");

        $request = $this->onlyRequest();
        $this->assertSame("release-v2.4.0-announcement", $request["headers"]["idempotency-key"]);
        $this->assertSame(
            ["text" => "v2.4.0 is out", "connectionSlugs" => ["linkedin"]],
            $this->decodedBody($request),
        );
    }

    public function testCreatePostsSendsATimezoneWithALocalTime(): void
    {
        self::setStubResponse(200, ["results" => []]);

        $this->client->createPosts(
            text: "nine in the morning, helsinki",
            connectionSlugs: ["linkedin"],
            scheduledFor: "2026-09-15T09:00:00",
            timezone: "Europe/Helsinki",
        );

        $this->assertSame(
            [
                "text" => "nine in the morning, helsinki",
                "connectionSlugs" => ["linkedin"],
                "scheduledFor" => "2026-09-15T09:00:00",
                "timezone" => "Europe/Helsinki",
            ],
            $this->decodedBody($this->onlyRequest()),
        );
    }

    public function testCreatePostsSendsQueueAndReadsBackTheSlot(): void
    {
        self::setStubResponse(200, [
            "results" => [
                [
                    "connectionSlug" => "linkedin",
                    "status" => "scheduled",
                    "postId" => self::POST_ID,
                    "url" => null,
                    "scheduledFor" => "2026-09-07T06:00:00.000Z",
                    "threadCount" => 0,
                    "hasFirstComment" => false,
                    "error" => null,
                ],
            ],
        ]);

        $response = $this->client->createPosts(
            text: "goes out at the next open slot",
            connectionSlugs: ["linkedin"],
            queue: true,
        );

        $this->assertSame(
            ["text" => "goes out at the next open slot", "connectionSlugs" => ["linkedin"], "queue" => true],
            $this->decodedBody($this->onlyRequest()),
        );
        $this->assertSame("scheduled", $response["results"][0]["status"]);
        $this->assertSame("2026-09-07T06:00:00.000Z", $response["results"][0]["scheduledFor"]);
    }

    public function testCreatePostsSendsMediaIdsThreadAndFirstComment(): void
    {
        self::setStubResponse(200, ["results" => []]);

        $this->client->createPosts(
            text: "the head post",
            connectionSlugs: ["x", "bluesky"],
            mediaIds: [self::MEDIA_ID],
            thread: ["second", "third"],
            firstComment: "the link is here",
        );

        $this->assertSame(
            [
                "text" => "the head post",
                "connectionSlugs" => ["x", "bluesky"],
                "mediaIds" => [self::MEDIA_ID],
                "thread" => ["second", "third"],
                "firstComment" => "the link is here",
            ],
            $this->decodedBody($this->onlyRequest()),
        );
    }

    public function testCreatePostsSendsMediaWithItsOwnAltText(): void
    {
        self::setStubResponse(200, ["results" => []]);

        $this->client->createPosts(
            text: "with a described image",
            connectionSlugs: ["bluesky"],
            media: [["id" => self::MEDIA_ID, "altText" => "the new docs page"]],
        );

        $this->assertSame(
            [
                "text" => "with a described image",
                "connectionSlugs" => ["bluesky"],
                "media" => [["id" => self::MEDIA_ID, "altText" => "the new docs page"]],
            ],
            $this->decodedBody($this->onlyRequest()),
        );
    }

    public function testCreatePostsSendsMediaUrls(): void
    {
        self::setStubResponse(200, ["results" => []]);

        $this->client->createPosts(
            text: "fetched from the web",
            connectionSlugs: ["bluesky"],
            mediaUrls: ["https://example.com/launch.png"],
        );

        $this->assertSame(
            [
                "text" => "fetched from the web",
                "connectionSlugs" => ["bluesky"],
                "mediaUrls" => ["https://example.com/launch.png"],
            ],
            $this->decodedBody($this->onlyRequest()),
        );
    }

    public function testCreatePostsSendsIsDraftAndTags(): void
    {
        self::setStubResponse(200, [
            "results" => [
                [
                    "connectionSlug" => "linkedin",
                    "status" => "draft",
                    "postId" => self::POST_ID,
                    "url" => null,
                    "scheduledFor" => null,
                    "threadCount" => 0,
                    "hasFirstComment" => false,
                    "error" => null,
                ],
            ],
        ]);

        $response = $this->client->createPosts(
            text: "half an idea",
            connectionSlugs: ["linkedin"],
            isDraft: true,
            tags: ["launch"],
        );

        $this->assertSame(
            ["text" => "half an idea", "connectionSlugs" => ["linkedin"], "isDraft" => true, "tags" => ["launch"]],
            $this->decodedBody($this->onlyRequest()),
        );
        $this->assertSame("draft", $response["results"][0]["status"]);
    }

    public function testPublishPostSendsAnEmptyBody(): void
    {
        self::setStubResponse(200, [
            "result" => [
                "connectionSlug" => "linkedin",
                "status" => "sent",
                "postId" => self::POST_ID,
                "url" => "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
                "scheduledFor" => null,
                "threadCount" => 0,
                "hasFirstComment" => false,
                "error" => null,
            ],
        ]);

        $response = $this->client->publishPost(self::POST_ID);

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/posts/" . self::POST_ID . "/publish", $request["path"]);
        $this->assertSame("application/json", $request["headers"]["content-type"]);
        // An object with nothing in it, which is what the API reads as "now".
        // PHP would write an empty array as [] on its own.
        $this->assertSame("{}", $request["body"]);
        $this->assertSame("sent", $response["result"]["status"]);
    }

    public function testPublishPostSendsATimeAndAnIdempotencyKey(): void
    {
        self::setStubResponse(200, ["result" => []]);

        $this->client->publishPost(
            self::POST_ID,
            "2026-09-15T09:00:00",
            "publish-the-launch-post",
            timezone: "Europe/Helsinki",
        );

        $request = $this->onlyRequest();
        $this->assertSame("publish-the-launch-post", $request["headers"]["idempotency-key"]);
        $this->assertSame(
            ["scheduledFor" => "2026-09-15T09:00:00", "timezone" => "Europe/Helsinki"],
            $this->decodedBody($request),
        );
    }

    public function testPublishPostSendsTheQueueFlag(): void
    {
        self::setStubResponse(200, ["result" => []]);

        $this->client->publishPost(self::POST_ID, queue: true);

        $this->assertSame(["queue" => true], $this->decodedBody($this->onlyRequest()));
    }

    public function testUpdateDraftSendsOnlyTheFieldsItWasGiven(): void
    {
        self::setStubResponse(200, [
            "post" => [
                "id" => self::POST_ID,
                "connectionSlug" => "linkedin",
                "profileId" => null,
                "text" => "a better idea",
                "status" => "draft",
                "url" => null,
                "scheduledFor" => null,
                "createdAt" => "2026-08-26T09:24:11.412Z",
                "tags" => ["launch"],
                "platformPostId" => null,
                "deletedAt" => null,
                "error" => null,
            ],
        ]);

        $response = $this->client->updateDraft(self::POST_ID, "a better idea", tags: ["launch"]);

        $request = $this->onlyRequest();
        $this->assertSame("PATCH", $request["method"]);
        $this->assertSame("/api/v2/posts/" . self::POST_ID, $request["path"]);
        $this->assertSame(["text" => "a better idea", "tags" => ["launch"]], $this->decodedBody($request));
        $this->assertSame(["launch"], $response["post"]["tags"]);
    }

    public function testUpdateDraftSendsAnEmptyListToClearTheThreadAndTheImages(): void
    {
        self::setStubResponse(200, ["post" => []]);

        $this->client->updateDraft(self::POST_ID, thread: [], mediaIds: []);

        // Empty lists, not omitted fields: an omitted field keeps what the
        // draft had, and only the empty list takes it off
        $this->assertSame('{"thread":[],"mediaIds":[]}', $this->onlyRequest()["body"]);
    }

    public function testUpdateDraftSendsTheFirstCommentAsAString(): void
    {
        self::setStubResponse(200, ["post" => []]);

        $this->client->updateDraft(self::POST_ID, firstComment: "what do you think?");

        $this->assertSame('{"firstComment":"what do you think?"}', $this->onlyRequest()["body"]);
    }

    public function testUpdateDraftClearsTheFirstCommentWithANull(): void
    {
        self::setStubResponse(200, ["post" => []]);

        $this->client->updateDraft(self::POST_ID, clearFirstComment: true);

        // An explicit null, not an omitted field: the API reads the two
        // differently, and only the null takes the comment off
        $this->assertSame('{"firstComment":null}', $this->onlyRequest()["body"]);
    }

    public function testUpdateDraftReplacesTheImagesWithMedia(): void
    {
        self::setStubResponse(200, ["post" => []]);

        $this->client->updateDraft(self::POST_ID, media: [["id" => self::MEDIA_ID, "altText" => "the new docs page"]]);

        $this->assertSame(
            ["media" => [["id" => self::MEDIA_ID, "altText" => "the new docs page"]]],
            $this->decodedBody($this->onlyRequest()),
        );
    }

    public function testUpdateDraftRefusesAFirstCommentAndAClear(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        $this->client->updateDraft(self::POST_ID, firstComment: "what do you think?", clearFirstComment: true);
    }

    public function testUpdateDraftMovesAScheduledPostsTime(): void
    {
        self::setStubResponse(200, [
            "post" => [
                "id" => self::POST_ID,
                "connectionSlug" => "linkedin",
                "profileId" => null,
                "text" => "a better idea",
                "status" => "scheduled",
                "url" => null,
                "scheduledFor" => "2026-09-20T15:00:00.000Z",
                "createdAt" => "2026-08-26T09:24:11.412Z",
                "tags" => [],
                "platformPostId" => null,
                "deletedAt" => null,
                "error" => null,
            ],
        ]);

        $response = $this->client->updateDraft(
            self::POST_ID,
            scheduledFor: "2026-09-20T18:00:00",
            timezone: "Europe/Helsinki",
        );

        $this->assertSame(
            ["scheduledFor" => "2026-09-20T18:00:00", "timezone" => "Europe/Helsinki"],
            $this->decodedBody($this->onlyRequest()),
        );
        $this->assertSame("scheduled", $response["post"]["status"]);
        $this->assertSame("2026-09-20T15:00:00.000Z", $response["post"]["scheduledFor"]);
    }

    public function testUpdateDraftTakesTheNextFreeSlotWithQueue(): void
    {
        self::setStubResponse(200, ["post" => []]);

        $this->client->updateDraft(self::POST_ID, queue: true);

        $this->assertSame('{"queue":true}', $this->onlyRequest()["body"]);
    }

    public function testUpdateDraftSendsAnEmptyBodyWhenItWasGivenNothing(): void
    {
        self::setStubResponse(200, ["post" => []]);

        $this->client->updateDraft(self::POST_ID);

        $this->assertSame("{}", $this->onlyRequest()["body"]);
    }

    public function testListPostsPutsItsFiltersInTheQueryString(): void
    {
        self::setStubResponse(200, ["posts" => [], "limit" => 10, "offset" => 0]);

        $this->client->listPosts(status: "scheduled", limit: 10);

        $this->assertSame("/api/v2/posts?status=scheduled&limit=10", $this->onlyRequest()["path"]);
    }

    public function testListPostsRepeatsTagOncePerLabel(): void
    {
        self::setStubResponse(200, ["posts" => [], "limit" => 25, "offset" => 0]);

        $this->client->listPosts(status: "draft", tag: ["launch", "q3"]);

        // Once per value, not tag[]=: the API reads the repeats as a list
        $this->assertSame("/api/v2/posts?status=draft&tag=launch&tag=q3", $this->onlyRequest()["path"]);
    }

    public function testListPostsNarrowsToOneProfile(): void
    {
        self::setStubResponse(200, ["posts" => [], "limit" => 25, "offset" => 0]);

        $this->client->listPosts(profileId: self::PROFILE_ID);

        $this->assertSame("/api/v2/posts?profileId=" . self::PROFILE_ID, $this->onlyRequest()["path"]);
    }

    public function testListPostsSendsTheNewFilters(): void
    {
        self::setStubResponse(200, ["posts" => [], "limit" => 25, "offset" => 0]);

        $this->client->listPosts(
            scheduledAfter: "2026-09-01T00:00:00.000Z",
            scheduledBefore: "2026-09-30T00:00:00.000Z",
            connectionSlug: "linkedin",
            platform: "linkedin",
            sendGroupId: self::POST_ID,
        );

        $this->assertSame(
            "/api/v2/posts?scheduledAfter=2026-09-01T00%3A00%3A00.000Z&scheduledBefore=2026-09-30T00%3A00%3A00.000Z"
                . "&connectionSlug=linkedin&platform=linkedin&sendGroupId=" . self::POST_ID,
            $this->onlyRequest()["path"],
        );
    }

    public function testListPostsSendsTheCreatedAndSortFilters(): void
    {
        self::setStubResponse(200, [
            "posts" => [],
            "limit" => 10,
            "offset" => 20,
            "total" => 31,
            "hasMore" => true,
            "nextOffset" => 30,
        ]);

        $response = $this->client->listPosts(
            limit: 10,
            offset: 20,
            createdAfter: "2026-09-01T00:00:00.000Z",
            createdBefore: "2026-09-30T00:00:00.000Z",
            sort: "created_asc",
        );

        $this->assertSame(
            "/api/v2/posts?createdAfter=2026-09-01T00%3A00%3A00.000Z&createdBefore=2026-09-30T00%3A00%3A00.000Z"
                . "&sort=created_asc&limit=10&offset=20",
            $this->onlyRequest()["path"],
        );
        $this->assertSame(31, $response["total"]);
        $this->assertTrue($response["hasMore"]);
        $this->assertSame(30, $response["nextOffset"]);
    }

    public function testListPostsSendsNoQueryStringWithoutFilters(): void
    {
        self::setStubResponse(200, ["posts" => [], "limit" => 25, "offset" => 0]);

        $this->client->listPosts();

        $this->assertSame("/api/v2/posts", $this->onlyRequest()["path"]);
    }

    public function testGetPostReadsThePost(): void
    {
        $post = [
            "post" => [
                "id" => self::POST_ID,
                "connectionSlug" => "x",
                "profileId" => null,
                "text" => "shipped the new api docs today",
                "status" => "deleted",
                "url" => "https://x.com/alexdoe/status/1234567890",
                "scheduledFor" => null,
                "createdAt" => "2026-08-26T09:24:11.412Z",
                "tags" => [],
                "platformPostId" => "1234567890",
                "deletedAt" => "2026-08-29T11:02:44.108Z",
                "error" => null,
            ],
        ];
        self::setStubResponse(200, $post);

        $response = $this->client->getPost(self::POST_ID);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/posts/" . self::POST_ID, $request["path"]);
        $this->assertSame($post, $response);
    }

    public function testGetPostMetricsReadsTheLatestAndTheHistory(): void
    {
        self::setStubResponse(200, [
            "latest" => [
                "fetchedAt" => "2026-08-30T10:00:00.000Z",
                "impressions" => null,
                "likes" => 12,
                "reposts" => 3,
                "replies" => 1,
                "clicks" => null,
            ],
            "history" => [
                [
                    "fetchedAt" => "2026-08-29T10:00:00.000Z",
                    "impressions" => null,
                    "likes" => 4,
                    "reposts" => 1,
                    "replies" => 0,
                    "clicks" => null,
                ],
                [
                    "fetchedAt" => "2026-08-30T10:00:00.000Z",
                    "impressions" => null,
                    "likes" => 12,
                    "reposts" => 3,
                    "replies" => 1,
                    "clicks" => null,
                ],
            ],
        ]);

        $response = $this->client->getPostMetrics(self::POST_ID);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/posts/" . self::POST_ID . "/metrics", $request["path"]);
        $this->assertSame(12, $response["latest"]["likes"]);
        // Bluesky reports no impressions, and null says so rather than
        // claiming zero
        $this->assertNull($response["latest"]["impressions"]);
        $this->assertCount(2, $response["history"]);
    }

    public function testGetPostMetricsAnswersNullBeforeTheFirstRead(): void
    {
        self::setStubResponse(200, ["latest" => null, "history" => []]);

        $response = $this->client->getPostMetrics(self::POST_ID);

        $this->assertNull($response["latest"]);
        $this->assertSame([], $response["history"]);
    }

    public function testGetAnalyticsPutsItsWindowInTheQueryString(): void
    {
        self::setStubResponse(200, [
            "totals" => ["posts" => 2, "impressions" => 0, "likes" => 16, "reposts" => 4, "replies" => 1, "clicks" => 0],
            "days" => [
                ["day" => "2026-08-29", "posts" => 1, "impressions" => 0, "likes" => 4, "reposts" => 1, "replies" => 0],
                ["day" => "2026-08-30", "posts" => 1, "impressions" => 0, "likes" => 12, "reposts" => 3, "replies" => 1],
            ],
            "byPlatform" => [
                [
                    "platformId" => "bluesky",
                    "posts" => 2,
                    "impressions" => 0,
                    "likes" => 16,
                    "reposts" => 4,
                    "replies" => 1,
                    "clicks" => 0,
                ],
            ],
            "from" => "2026-08-29",
            "to" => "2026-08-30",
        ]);

        $response = $this->client->getAnalytics(from: "2026-08-29", to: "2026-08-30", platform: "bluesky");

        $this->assertSame(
            "/api/v2/analytics?from=2026-08-29&to=2026-08-30&platform=bluesky",
            $this->onlyRequest()["path"],
        );
        $this->assertSame(16, $response["totals"]["likes"]);
        $this->assertCount(2, $response["days"]);
        $this->assertSame("bluesky", $response["byPlatform"][0]["platformId"]);
    }

    public function testGetAnalyticsWithNoWindowAsksForTheDefault(): void
    {
        self::setStubResponse(200, [
            "totals" => ["posts" => 0, "impressions" => 0, "likes" => 0, "reposts" => 0, "replies" => 0, "clicks" => 0],
            "days" => [],
            "byPlatform" => [],
            "from" => "2026-08-01",
            "to" => "2026-08-30",
        ]);

        $this->client->getAnalytics();

        $this->assertSame("/api/v2/analytics", $this->onlyRequest()["path"]);
    }

    public function testDeletePostCancelsAScheduledPost(): void
    {
        self::setStubResponse(200, ["id" => self::POST_ID, "status" => "cancelled", "deletedAt" => null]);

        $response = $this->client->deletePost(self::POST_ID);

        $request = $this->onlyRequest();
        $this->assertSame("DELETE", $request["method"]);
        $this->assertSame("/api/v2/posts/" . self::POST_ID, $request["path"]);
        $this->assertSame(["id" => self::POST_ID, "status" => "cancelled", "deletedAt" => null], $response);
    }

    public function testDeletePostAnswersWithTheDeletedPost(): void
    {
        $deleted = ["id" => self::POST_ID, "status" => "deleted", "deletedAt" => "2026-08-29T11:02:44.108Z"];
        self::setStubResponse(200, $deleted);

        $response = $this->client->deletePost(self::POST_ID);

        $request = $this->onlyRequest();
        $this->assertSame("DELETE", $request["method"]);
        $this->assertSame("/api/v2/posts/" . self::POST_ID, $request["path"]);
        $this->assertSame($deleted, $response);
    }

    public function testDeletePostReallyDeletesADraft(): void
    {
        self::setStubResponse(200, ["id" => self::POST_ID, "deleted" => true]);

        $response = $this->client->deletePost(self::POST_ID);

        $this->assertSame("DELETE", $this->onlyRequest()["method"]);
        $this->assertSame(["id" => self::POST_ID, "deleted" => true], $response);
    }

    public function testDeleteDraftSendsADelete(): void
    {
        self::setStubResponse(200, ["id" => self::POST_ID, "deleted" => true]);

        $response = $this->client->deleteDraft(self::POST_ID);

        $request = $this->onlyRequest();
        $this->assertSame("DELETE", $request["method"]);
        $this->assertSame("/api/v2/posts/" . self::POST_ID, $request["path"]);
        $this->assertSame(["id" => self::POST_ID, "deleted" => true], $response);
    }

    public function testCancelPostIsTheOldNameOfDeletePost(): void
    {
        self::setStubResponse(200, ["id" => self::POST_ID, "status" => "cancelled"]);

        $response = $this->client->cancelPost(self::POST_ID);

        $request = $this->onlyRequest();
        $this->assertSame("DELETE", $request["method"]);
        $this->assertSame("/api/v2/posts/" . self::POST_ID, $request["path"]);
        $this->assertSame(["id" => self::POST_ID, "status" => "cancelled"], $response);
    }

    public function testDrawCardPostsInstructionsAndAttachToTheCardPath(): void
    {
        $card = ["mediaId" => self::POST_ID, "html" => "<html></html>", "attached" => true];
        self::setStubResponse(200, $card);

        $response = $this->client->drawCard(self::POST_ID, "use a chart", true);

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/posts/" . self::POST_ID . "/card", $request["path"]);
        $this->assertSame(["instructions" => "use a chart", "attach" => true], $this->decodedBody($request));
        $this->assertSame($card, $response);
    }

    public function testRetryPostSendsAPostToTheRetryPath(): void
    {
        self::setStubResponse(200, ["id" => self::POST_ID, "status" => "sent"]);

        $response = $this->client->retryPost(self::POST_ID);

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/posts/" . self::POST_ID . "/retry", $request["path"]);
        $this->assertSame(["id" => self::POST_ID, "status" => "sent"], $response);
    }

    public function testRetryPostReadsBackAWarning(): void
    {
        self::setStubResponse(200, ["id" => self::POST_ID, "status" => "sent", "warning" => "image dropped"]);

        $response = $this->client->retryPost(self::POST_ID);

        $this->assertSame("image dropped", $response["warning"]);
    }

    public function testRetryingAPostThatDidNotFailThrows(): void
    {
        self::setStubResponse(400, [
            "error" => "invalid_request",
            "message" => "Only a post that failed can be retried.",
        ]);

        try {
            $this->client->retryPost(self::POST_ID);
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(400, $error->status);
            $this->assertSame("invalid_request", $error->errorCode);
        }
    }

    //
    // Media
    //

    public function testUploadMediaSendsTheRawBytesWithTheContentType(): void
    {
        self::setStubResponse(200, ["mediaId" => self::MEDIA_ID, "contentType" => "image/png", "sizeBytes" => 4]);

        // What is asserted is that the body is the bytes themselves, with no
        // multipart around them
        $response = $this->client->uploadMedia("PNGB", "image/png", altText: "the new docs page");

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/media?alt_text=the+new+docs+page", $request["path"]);
        $this->assertSame("image/png", $request["headers"]["content-type"]);
        $this->assertSame("PNGB", $request["body"]);
        $this->assertSame(self::MEDIA_ID, $response["mediaId"]);
    }

    public function testUploadMediaSendsEveryByteOfTheBodyWhateverTheContentTypeIs(): void
    {
        self::setStubResponse(200, ["mediaId" => self::MEDIA_ID, "contentType" => "image/gif", "sizeBytes" => 8]);

        // A body that is not text, with a null and a byte above ascii in it
        $image = "GIF89a\x00\xff";

        $this->client->uploadMedia($image, "image/gif");

        $request = $this->onlyRequest();
        $this->assertSame("/api/v2/media", $request["path"]);
        $this->assertSame("image/gif", $request["headers"]["content-type"]);
        $this->assertSame($image, $request["body"]);
    }

    public function testUploadMediaRefusesAnEmptyContentTypeBeforeTheCall(): void
    {
        try {
            $this->client->uploadMedia("PNGB", "");
            $this->fail("expected an InvalidArgumentException");
        } catch (\InvalidArgumentException $error) {
            $this->assertSame("contentType is required", $error->getMessage());
        }

        $this->assertSame([], $this->recordedRequests());
    }

    public function testGetMediaReadsTheBytesBackWithTheContentType(): void
    {
        self::setStubResponse(200, "PNGB", contentType: "image/png");

        $response = $this->client->getMedia(self::MEDIA_ID);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/media/" . self::MEDIA_ID, $request["path"]);
        $this->assertSame(["bytes" => "PNGB", "contentType" => "image/png"], $response);
    }

    public function testGetMediaKeepsOnlyTheMediaTypeOfTheHeader(): void
    {
        self::setStubResponse(200, "PNGB", contentType: "image/png; charset=binary");

        $response = $this->client->getMedia(self::MEDIA_ID);

        $this->assertSame("image/png", $response["contentType"]);
    }

    public function testDeleteMediaSendsADelete(): void
    {
        self::setStubResponse(200, ["id" => self::MEDIA_ID, "deleted" => true]);

        $response = $this->client->deleteMedia(self::MEDIA_ID);

        $request = $this->onlyRequest();
        $this->assertSame("DELETE", $request["method"]);
        $this->assertSame("/api/v2/media/" . self::MEDIA_ID, $request["path"]);
        $this->assertSame(["id" => self::MEDIA_ID, "deleted" => true], $response);
    }

    public function testListMediaPutsItsFiltersInTheQueryString(): void
    {
        self::setStubResponse(200, ["media" => [], "cursor" => null]);

        $response = $this->client->listMedia(connectionSlug: "linkedin", limit: 10);

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/media?connectionSlug=linkedin&limit=10", $request["path"]);
        $this->assertSame(["media" => [], "cursor" => null], $response);
    }

    //
    // Webhooks
    //

    public function testCreateWebhookReturnsTheSecret(): void
    {
        self::setStubResponse(200, [
            "webhook" => [
                "id" => self::WEBHOOK_ID,
                "url" => "https://example.com/hooks/yeetpost",
                "events" => ["post.sent", "post.failed"],
                "secret" => "yp_whsec_3f1a",
                "createdAt" => "2026-08-26T09:24:11.412Z",
            ],
        ]);

        $response = $this->client->createWebhook("https://example.com/hooks/yeetpost", ["post.sent"]);

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/webhooks", $request["path"]);
        $this->assertSame(
            ["url" => "https://example.com/hooks/yeetpost", "events" => ["post.sent"]],
            $this->decodedBody($request),
        );
        $this->assertSame("yp_whsec_3f1a", $response["webhook"]["secret"]);
    }

    public function testListWebhooksReturnsThemWithoutSecrets(): void
    {
        $webhooks = [
            "webhooks" => [
                [
                    "id" => self::WEBHOOK_ID,
                    "url" => "https://example.com/hooks/yeetpost",
                    "events" => ["post.sent", "post.failed"],
                    "createdAt" => "2026-08-26T09:24:11.412Z",
                ],
            ],
        ];
        self::setStubResponse(200, $webhooks);

        $response = $this->client->listWebhooks();

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/webhooks", $request["path"]);
        $this->assertSame($webhooks, $response);
    }

    public function testDeleteWebhookSendsADelete(): void
    {
        self::setStubResponse(200, ["id" => self::WEBHOOK_ID, "deleted" => true]);

        $response = $this->client->deleteWebhook(self::WEBHOOK_ID);

        $request = $this->onlyRequest();
        $this->assertSame("DELETE", $request["method"]);
        $this->assertSame("/api/v2/webhooks/" . self::WEBHOOK_ID, $request["path"]);
        $this->assertSame(["id" => self::WEBHOOK_ID, "deleted" => true], $response);
    }

    public function testListWebhookDeliveriesHitsTheDeliveriesPath(): void
    {
        self::setStubResponse(200, ["deliveries" => [], "limit" => 10, "hasMore" => false]);

        $this->client->listWebhookDeliveries(self::WEBHOOK_ID, limit: 10);

        $this->assertSame("/api/v2/webhooks/" . self::WEBHOOK_ID . "/deliveries?limit=10", $this->onlyRequest()["path"]);
    }

    public function testListWebhookDeliveriesFiltersByStatusAndPages(): void
    {
        self::setStubResponse(200, ["deliveries" => [], "limit" => 10, "hasMore" => true]);

        $response = $this->client->listWebhookDeliveries(
            self::WEBHOOK_ID,
            status: "dead",
            limit: 10,
            startingAfter: self::DELIVERY_ID,
        );

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame(
            "/api/v2/webhooks/" . self::WEBHOOK_ID . "/deliveries?status=dead&limit=10&startingAfter=" . self::DELIVERY_ID,
            $request["path"],
        );
        $this->assertTrue($response["hasMore"]);
    }

    public function testReplayDeliveryPostsToTheReplayPath(): void
    {
        self::setStubResponse(200, ["delivery" => self::PENDING_DELIVERY]);

        $response = $this->client->replayDelivery(self::WEBHOOK_ID, self::DELIVERY_ID);

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame(
            "/api/v2/webhooks/" . self::WEBHOOK_ID . "/deliveries/" . self::DELIVERY_ID . "/replay",
            $request["path"],
        );
        $this->assertSame(self::PENDING_DELIVERY, $response["delivery"]);
    }

    public function testReplayingADeliveryThatIsAlreadyQueuedThrows(): void
    {
        self::setStubResponse(400, [
            "error" => "invalid_request",
            "message" => "This delivery is already queued for another attempt.",
        ]);

        try {
            $this->client->replayDelivery(self::WEBHOOK_ID, self::DELIVERY_ID);
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(400, $error->status);
            $this->assertSame("invalid_request", $error->errorCode);
            $this->assertSame("This delivery is already queued for another attempt.", $error->getMessage());
        }
    }

    public function testSendTestEventPostsToTheTestPath(): void
    {
        $delivery = array_merge(self::PENDING_DELIVERY, [
            "id" => "4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b",
            "eventId" => "4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b",
            "nextAttemptAt" => "2026-08-26T09:24:12.004Z",
        ]);
        self::setStubResponse(200, ["delivery" => $delivery]);

        $response = $this->client->sendTestEvent(self::WEBHOOK_ID);

        $request = $this->onlyRequest();
        $this->assertSame("POST", $request["method"]);
        $this->assertSame("/api/v2/webhooks/" . self::WEBHOOK_ID . "/test", $request["path"]);
        $this->assertSame("pending", $response["delivery"]["status"]);
        $this->assertSame("4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b", $response["delivery"]["eventId"]);
    }

    //
    // Health, stats and the spec
    //

    public function testGetHealthReadsTheChecksBehindTheStatus(): void
    {
        $health = [
            "status" => "degraded",
            "checks" => [
                "database" => ["ok" => true, "latencyMs" => 3],
                "scheduledPosts" => ["ok" => false, "lastRunAt" => "2026-08-29T11:04:58.120Z", "lastOkAt" => null],
                "webhookDeliveries" => [
                    "ok" => true,
                    "lastRunAt" => "2026-08-29T11:04:57.870Z",
                    "lastOkAt" => "2026-08-29T11:04:57.870Z",
                ],
                "xUsageSweep" => [
                    "ok" => true,
                    "lastRunAt" => "2026-08-29T11:04:31.004Z",
                    "lastOkAt" => "2026-08-29T11:04:31.004Z",
                ],
                "postMetrics" => [
                    "ok" => true,
                    "lastRunAt" => "2026-08-29T11:04:12.311Z",
                    "lastOkAt" => "2026-08-29T11:04:12.311Z",
                ],
            ],
            "version" => "2.0.0",
            "time" => "2026-08-29T11:05:00.512Z",
        ];
        self::setStubResponse(200, $health);

        $response = $this->client->getHealth();

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/health", $request["path"]);
        $this->assertSame($health, $response);
    }

    public function testGetHealthNeedsNoApiKeyAndSendsNoHeader(): void
    {
        self::setStubResponse(200, ["status" => "ok"]);

        $response = (new Yeetpost("", self::$baseUrl))->getHealth();

        $request = $this->onlyRequest();
        $this->assertSame("/api/v2/health", $request["path"]);
        $this->assertArrayNotHasKey("x-api-key", $request["headers"]);
        $this->assertSame(["status" => "ok"], $response);
    }

    public function testGetHealthHistoryPutsTheWindowInTheQueryString(): void
    {
        $history = [
            "days" => [
                ["day" => "2026-08-27", "uptimePercent" => null, "samples" => 0, "degradedMinutes" => 0],
                ["day" => "2026-08-28", "uptimePercent" => 100, "samples" => 1440, "degradedMinutes" => 0],
                ["day" => "2026-08-29", "uptimePercent" => 99.72, "samples" => 718, "degradedMinutes" => 2],
            ],
        ];
        self::setStubResponse(200, $history);

        $response = $this->client->getHealthHistory(days: 3);

        $this->assertSame("/api/v2/health/history?days=3", $this->onlyRequest()["path"]);
        $this->assertSame($history, $response);
    }

    public function testGetHealthHistorySendsNoQueryStringWithoutAWindow(): void
    {
        self::setStubResponse(200, ["days" => []]);

        $this->client->getHealthHistory();

        $this->assertSame("/api/v2/health/history", $this->onlyRequest()["path"]);
    }

    public function testGetStatsReadsThePublicCountsWithoutAnApiKey(): void
    {
        $stats = [
            "postsThisWeek" => 412,
            "postsAllTime" => 18930,
            "liveConnections" => 87,
            "platformsLive" => ["linkedin", "x", "bluesky", "mastodon", "discord", "telegram", "google_business"],
            "time" => "2026-08-29T11:05:00.512Z",
        ];
        self::setStubResponse(200, $stats);

        $response = (new Yeetpost("", self::$baseUrl))->getStats();

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/stats", $request["path"]);
        $this->assertArrayNotHasKey("x-api-key", $request["headers"]);
        $this->assertSame($stats, $response);
    }

    public function testGetOpenapiSpecReadsTheDocumentWithoutAnApiKey(): void
    {
        $spec = ["openapi" => "3.1.0", "info" => ["title" => "yeetpost API", "version" => "2.0.0"]];
        self::setStubResponse(200, $spec);

        $response = (new Yeetpost("", self::$baseUrl))->getOpenapiSpec();

        $request = $this->onlyRequest();
        $this->assertSame("GET", $request["method"]);
        $this->assertSame("/api/v2/openapi.json", $request["path"]);
        $this->assertArrayNotHasKey("x-api-key", $request["headers"]);
        $this->assertSame($spec, $response);
    }

    public function testACallThatNeedsAKeyIsRefusedBeforeTheRequest(): void
    {
        $client = new Yeetpost("", self::$baseUrl);

        try {
            $client->listConnections();
            $this->fail("expected an InvalidArgumentException");
        } catch (\InvalidArgumentException $error) {
            $this->assertSame("apiKey is required for this call", $error->getMessage());
        }

        $this->assertSame([], $this->recordedRequests());
    }

    public function testABaseUrlWithATrailingSlashIsTrimmed(): void
    {
        self::setStubResponse(200, ["connections" => []]);

        (new Yeetpost("yp_secret_test", self::$baseUrl . "/"))->listConnections();

        $this->assertSame("/api/v2/connections", $this->onlyRequest()["path"]);
    }

    //
    // Errors
    //

    public function testAnErrorResponseBecomesAYeetpostApiError(): void
    {
        self::setStubResponse(400, [
            "error" => "invalid_connection",
            "message" => "Connection 'linkedn' not found. Available connections: linkedin, x",
        ]);

        try {
            $this->client->createPosts(text: "hello", connectionSlugs: ["linkedn"]);
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(400, $error->status);
            $this->assertSame("invalid_connection", $error->errorCode);
            $this->assertSame(
                "Connection 'linkedn' not found. Available connections: linkedin, x",
                $error->getMessage(),
            );
            $this->assertNull($error->requestId);
        }
    }

    public function testReqIdOnAnErrorIsExposedAsRequestId(): void
    {
        self::setStubResponse(422, [
            "error" => "platform_rejected",
            "message" => "LinkedIn: duplicate post was detected",
            "req_id" => "req_12345678",
        ]);

        try {
            $this->client->postToConnection("linkedin", "hello");
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(422, $error->status);
            $this->assertSame("platform_rejected", $error->errorCode);
            $this->assertSame("req_12345678", $error->requestId);
        }
    }

    public function testTheXRequestIdHeaderLeadsTheBodyReqId(): void
    {
        self::setStubResponse(
            422,
            [
                "error" => "platform_rejected",
                "message" => "LinkedIn: duplicate post was detected",
                "req_id" => "req_from_the_body",
            ],
            extraHeaders: ["x-request-id" => "req_from_the_header"],
        );

        try {
            $this->client->postToConnection("linkedin", "hello");
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame("req_from_the_header", $error->requestId);
        }
    }

    public function testThe429BodyWhichHasNoMessageStillThrows(): void
    {
        self::setStubResponse(
            429,
            ["error" => "too many requests"],
            extraHeaders: [
                "x-ratelimit-limit" => "60",
                "x-ratelimit-remaining" => "0",
                "x-ratelimit-reset" => "1787653500",
            ],
        );

        try {
            $this->client->listPosts();
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(429, $error->status);
            $this->assertSame("too many requests", $error->errorCode);
            $this->assertSame("too many requests", $error->getMessage());
            $this->assertNull($error->requestId);
            $this->assertSame(60, $error->rateLimitLimit);
            $this->assertSame(0, $error->rateLimitRemaining);
            $this->assertSame(1787653500, $error->rateLimitReset);
        }
    }

    public function testTheRateLimitFieldsAreMinusOneWithoutTheHeaders(): void
    {
        self::setStubResponse(401, ["error" => "unauthorized", "message" => "invalid api key"]);

        try {
            $this->client->listPosts();
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(-1, $error->rateLimitLimit);
            $this->assertSame(-1, $error->rateLimitRemaining);
            $this->assertSame(-1, $error->rateLimitReset);
        }
    }

    public function testAnErrorBodyThatIsNotJsonStillThrows(): void
    {
        self::setStubResponse(502, "<html>bad gateway</html>", contentType: "text/html");

        try {
            $this->client->listConnections();
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(502, $error->status);
            $this->assertSame("internal_server_error", $error->errorCode);
            $this->assertSame("the yeetpost api returned an error that was not json", $error->getMessage());
        }
    }

    public function testAnErrorBodyWithoutACodeStillThrows(): void
    {
        self::setStubResponse(500, ["message" => "something went wrong"]);

        try {
            $this->client->listConnections();
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(500, $error->status);
            $this->assertSame("internal_server_error", $error->errorCode);
            $this->assertSame("the yeetpost api returned an error without a code", $error->getMessage());
        }
    }

    public function testAnErrorBodyThatIsJsonNullIsReadAsNotJson(): void
    {
        self::setStubResponse(500, "null");

        try {
            $this->client->listConnections();
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame("the yeetpost api returned an error that was not json", $error->getMessage());
        }
    }

    public function testAnErrorBodyThatIsAJsonArrayIsReadAsWithoutACode(): void
    {
        self::setStubResponse(500, "[]");

        try {
            $this->client->listConnections();
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame("the yeetpost api returned an error without a code", $error->getMessage());
        }
    }

    public function testASuccessBodyThatIsNotJsonBecomesAYeetpostApiError(): void
    {
        self::setStubResponse(
            200,
            "<html>a captive portal</html>",
            contentType: "text/html",
            extraHeaders: [
                "x-request-id" => "req_from_the_header",
                "x-ratelimit-limit" => "60",
                "x-ratelimit-remaining" => "59",
                "x-ratelimit-reset" => "1787653500",
            ],
        );

        try {
            $this->client->listConnections();
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(200, $error->status);
            $this->assertSame("internal_server_error", $error->errorCode);
            $this->assertSame("the yeetpost api returned a response that was not json", $error->getMessage());
            // The headers are read the same way they are on a non-2xx
            $this->assertSame("req_from_the_header", $error->requestId);
            $this->assertSame(60, $error->rateLimitLimit);
            $this->assertSame(59, $error->rateLimitRemaining);
            $this->assertSame(1787653500, $error->rateLimitReset);
        }
    }

    public function testARateLimitHeaderThatIsNotAWholeNumberIsReadAsNotCarried(): void
    {
        self::setStubResponse(
            429,
            ["error" => "too many requests"],
            extraHeaders: [
                "x-ratelimit-limit" => "60.5",
                "x-ratelimit-remaining" => "1e3",
                "x-ratelimit-reset" => "soon",
            ],
        );

        try {
            $this->client->listPosts();
            $this->fail("expected a YeetpostApiError");
        } catch (YeetpostApiError $error) {
            $this->assertSame(-1, $error->rateLimitLimit);
            $this->assertSame(-1, $error->rateLimitRemaining);
            $this->assertSame(-1, $error->rateLimitReset);
        }
    }
}
