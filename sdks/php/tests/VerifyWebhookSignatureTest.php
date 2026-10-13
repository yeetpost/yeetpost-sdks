<?php

declare(strict_types=1);

namespace Yeetpost\Tests;

use PHPUnit\Framework\TestCase;
use Yeetpost\Yeetpost;

final class VerifyWebhookSignatureTest extends TestCase
{
    private const WEBHOOK_SECRET = "yp_whsec_3f1a";

    // The fixture the node, python and go sdks sign, byte for byte: no spaces
    // and no escaped slashes, which is what node's JSON.stringify writes, so
    // the four clients agree on the bytes that get signed.
    private const WEBHOOK_BODY = '{"event":"post.sent","timestamp":"2026-08-26T09:24:12.004Z"}';

    private static function signatureHeader(string $body, int $timestampSeconds): string
    {
        $signature = hash_hmac("sha256", $timestampSeconds . "." . $body, self::WEBHOOK_SECRET);

        return "t=" . $timestampSeconds . ",v1=" . $signature;
    }

    public function testAValidSignatureVerifies(): void
    {
        $timestampSeconds = time();

        $this->assertTrue(Yeetpost::verifyWebhookSignature(
            self::WEBHOOK_BODY,
            self::signatureHeader(self::WEBHOOK_BODY, $timestampSeconds),
            self::WEBHOOK_SECRET,
        ));
    }

    // The vector the go and python sdks pin too, computed by the node sdk's
    // own hmac, so a signature one client accepts is one the others accept.
    // The timestamp is fixed, so it needs a tolerance wide enough to reach it.
    public function testTheSharedCrossSdkVectorVerifies(): void
    {
        $header = "t=1787653452,v1=f1d967b462aab2a3e8bf662c933d9e2181dc0a09271f22e27076c509c791c9b3";

        $this->assertTrue(Yeetpost::verifyWebhookSignature(
            self::WEBHOOK_BODY,
            $header,
            self::WEBHOOK_SECRET,
            toleranceSeconds: 100 * 365 * 24 * 60 * 60,
        ));
    }

    public function testATamperedBodyDoesNotVerify(): void
    {
        $timestampSeconds = time();

        $this->assertFalse(Yeetpost::verifyWebhookSignature(
            self::WEBHOOK_BODY . " ",
            self::signatureHeader(self::WEBHOOK_BODY, $timestampSeconds),
            self::WEBHOOK_SECRET,
        ));
    }

    public function testTheWrongSecretDoesNotVerify(): void
    {
        $timestampSeconds = time();

        $this->assertFalse(Yeetpost::verifyWebhookSignature(
            self::WEBHOOK_BODY,
            self::signatureHeader(self::WEBHOOK_BODY, $timestampSeconds),
            "yp_whsec_someoneelse",
        ));
    }

    public function testAnExpiredTimestampDoesNotVerify(): void
    {
        $timestampSeconds = time() - 400;

        $this->assertFalse(Yeetpost::verifyWebhookSignature(
            self::WEBHOOK_BODY,
            self::signatureHeader(self::WEBHOOK_BODY, $timestampSeconds),
            self::WEBHOOK_SECRET,
        ));
    }

    public function testAnExpiredTimestampVerifiesWithAWiderTolerance(): void
    {
        $timestampSeconds = time() - 400;

        $this->assertTrue(Yeetpost::verifyWebhookSignature(
            self::WEBHOOK_BODY,
            self::signatureHeader(self::WEBHOOK_BODY, $timestampSeconds),
            self::WEBHOOK_SECRET,
            toleranceSeconds: 600,
        ));
    }

    public function testATimestampFromTheFutureIsHeldToTheSameTolerance(): void
    {
        $timestampSeconds = time() + 400;

        $this->assertFalse(Yeetpost::verifyWebhookSignature(
            self::WEBHOOK_BODY,
            self::signatureHeader(self::WEBHOOK_BODY, $timestampSeconds),
            self::WEBHOOK_SECRET,
        ));
    }

    public function testAMalformedSignatureHeaderDoesNotVerify(): void
    {
        $this->assertFalse(Yeetpost::verifyWebhookSignature(self::WEBHOOK_BODY, "v1=deadbeef", self::WEBHOOK_SECRET));
    }

    public function testAHeaderWithATrailingNewlineDoesNotVerify(): void
    {
        $timestampSeconds = time();

        // Node and Go refuse this one, so PHP must too: $ on its own would let
        // the newline through
        $this->assertFalse(Yeetpost::verifyWebhookSignature(
            self::WEBHOOK_BODY,
            self::signatureHeader(self::WEBHOOK_BODY, $timestampSeconds) . "\n",
            self::WEBHOOK_SECRET,
        ));
    }

    public function testAnEmptySignatureHeaderDoesNotVerify(): void
    {
        $this->assertFalse(Yeetpost::verifyWebhookSignature(self::WEBHOOK_BODY, "", self::WEBHOOK_SECRET));
    }
}
