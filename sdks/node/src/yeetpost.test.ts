import assert from "node:assert/strict";
import crypto from "crypto";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import {
  type WebhookEvent,
  Yeetpost,
  YeetpostApiError,
  parseConnectRedirect,
  verifyWebhookSignature,
} from "./yeetpost.ts";

// The client is exercised against a real http server on a random port, so the
// request it actually puts on the wire (method, path, query, headers, body)
// is what gets asserted. Nothing here reaches the network.

interface StubResponse {
  status: number;
  body: string;
  contentType: string;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

let stubResponse: StubResponse;
// extraHeaders go out with the response, for the request id and rate limit
// headers. Set them before the call.
let extraHeaders: Record<string, string>;
let recordedRequests: RecordedRequest[];
let baseUrl: string;

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on("end", () => {
    recordedRequests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      // Node lowercases incoming header names, and every value here is a single
      // string, so the array case does not arise
      headers: req.headers as Record<string, string>,
      body: Buffer.concat(chunks).toString("utf8"),
    });

    res.writeHead(stubResponse.status, {
      "content-type": stubResponse.contentType,
      ...extraHeaders,
    });
    res.end(stubResponse.body);
  });
});

const setStubResponse = (status: number, body: unknown): void => {
  stubResponse = {
    status,
    body: JSON.stringify(body),
    contentType: "application/json",
  };
};

before(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("stub server did not get a port");
  }

  baseUrl = `http://127.0.0.1:${address.port}/api/v2`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  recordedRequests = [];
  extraHeaders = {};
  setStubResponse(200, {});
});

const linkedinConnection = {
  id: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
  slug: "linkedin",
  platformId: "linkedin",
  description: "Alex Doe (LinkedIn)",
  profileId: null,
  timezone: "Europe/Helsinki",
  queueSlots: [{ weekday: 1, time: "09:00" }],
  status: "active",
  loginExpiresAt: null,
  voice: null,
  look: null,
};

const acmeProfileId = "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b";

const acmeProfile = {
  id: acmeProfileId,
  name: "Acme Coffee",
  externalId: "cus_4821",
  createdAt: "2026-08-29T09:24:11.412Z",
};

const acmeKeyId = "9c4e1d75-6b3a-4f28-9d10-7e5c2a8b4f31";

// Word for word what the API answers a scoped key that tries to manage keys,
// so the stub is the real refusal rather than an approximation of one
const SCOPED_KEY_MESSAGE = `This API key is scoped to profile ${acmeProfileId}, which cannot manage API keys. Use an unscoped key for that.`;

const acmeKey = {
  id: acmeKeyId,
  name: "Acme integration",
  type: "live",
  prefix: "yp_secret_4f9a2c",
  profileId: acmeProfileId,
  redirectAllowlist: ["https://acme.example.com"],
  createdAt: "2026-08-30T09:24:11.412Z",
  lastUsedAt: null,
  revokedAt: null,
};

// Word for word what the API attaches to a send while the account is over the
// free connection limit and the grace window is still open
const GRACE_WARNING =
  "This account has 4 connected accounts, over the free limit of 3. Subscribe or disconnect down to 3 by 2026-09-18 to keep posting.";

const connectSessionId = "7f3c9a10-2b4d-4e88-9f01-3a5b7c9d1e2f";

const connectSession = {
  url: "https://yeetpost.com/connect/8Qm2rXk9vT1sB4nE6yPzL0aJdHcWfUgR",
  expiresAt: "2026-08-29T09:39:11.412Z",
  connectSessionId,
};

test("sends the api key as the x-api-key header", async () => {
  setStubResponse(200, { connections: [linkedinConnection] });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listConnections();

  assert.equal(recordedRequests.length, 1);
  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(recordedRequests[0].url, "/api/v2/connections");
  assert.equal(recordedRequests[0].headers["x-api-key"], "yp_secret_test");
  assert.deepEqual(response, { connections: [linkedinConnection] });
});

test("getConnection reads one connection and its queue settings", async () => {
  setStubResponse(200, { connection: linkedinConnection });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getConnection(linkedinConnection.id);

  assert.equal(
    recordedRequests[0].url,
    `/api/v2/connections/${linkedinConnection.id}`,
  );
  assert.deepEqual(response, { connection: linkedinConnection });
});

test("getConnection reads an expiring login's status and when it expires", async () => {
  setStubResponse(200, {
    connection: {
      ...linkedinConnection,
      status: "expiring",
      loginExpiresAt: "2026-09-20T09:24:11.412Z",
    },
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getConnection(linkedinConnection.id);

  assert.equal(response.connection.status, "expiring");
  assert.equal(response.connection.loginExpiresAt, "2026-09-20T09:24:11.412Z");
});

test("updateConnection moves a connection into a profile", async () => {
  setStubResponse(200, {
    connection: { ...linkedinConnection, profileId: acmeProfileId },
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.updateConnection(linkedinConnection.id, {
    profileId: acmeProfileId,
  });

  assert.equal(recordedRequests[0].method, "PATCH");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/connections/${linkedinConnection.id}`,
  );
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    profileId: acmeProfileId,
  });
  assert.equal(response.connection.profileId, acmeProfileId);
});

test("updateConnection moves a connection back out with a null profileId", async () => {
  setStubResponse(200, { connection: linkedinConnection });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.updateConnection(linkedinConnection.id, {
    profileId: null,
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), { profileId: null });
  assert.equal(response.connection.profileId, null);
});

test("updateConnection sets a voice without sending a profileId", async () => {
  const voice = {
    toneDescription: "Warm and brief.",
    examplePosts: ["Fresh roast is out."],
  };
  setStubResponse(200, { connection: { ...linkedinConnection, voice } });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.updateConnection(linkedinConnection.id, {
    voice,
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), { voice });
  assert.deepEqual(response.connection.voice, voice);
});

test("updateConnection sets a look without sending a profileId", async () => {
  const look = {
    description: "Dark navy, one orange accent.",
    exampleCards: ["<html><body>Card</body></html>"],
    logoMediaId: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
  };
  setStubResponse(200, { connection: { ...linkedinConnection, look } });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.updateConnection(linkedinConnection.id, {
    look,
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), { look });
  assert.deepEqual(response.connection.look, look);
});

test("moving into a profile that already holds the account is a YeetpostApiError", async () => {
  setStubResponse(409, {
    error: "connection_conflict",
    message: "That profile already holds a connection to this account.",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(
    () =>
      yeetpost.updateConnection(linkedinConnection.id, {
        profileId: acmeProfileId,
      }),
    (error: unknown) => {
      assert.ok(error instanceof YeetpostApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "connection_conflict");
      return true;
    },
  );
});

test("deleteConnection sends a DELETE and returns the disconnected id", async () => {
  setStubResponse(200, {
    id: linkedinConnection.id,
    deleted: true,
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.deleteConnection(linkedinConnection.id);

  assert.equal(recordedRequests[0].method, "DELETE");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/connections/${linkedinConnection.id}`,
  );
  assert.deepEqual(response, {
    id: linkedinConnection.id,
    deleted: true,
  });
});

test("disconnecting the connection you sign in with is a YeetpostApiError", async () => {
  setStubResponse(403, {
    error: "forbidden",
    message:
      "This connection is used to sign in to yeetpost, so it cannot be disconnected.",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(
    () => yeetpost.deleteConnection(linkedinConnection.id),
    (error: unknown) => {
      assert.ok(error instanceof YeetpostApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "forbidden");
      return true;
    },
  );
});

test("listConnectionQueue returns what is waiting, in slot order", async () => {
  setStubResponse(200, {
    queue: [
      {
        id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        text: "goes out at the next open slot",
        scheduledFor: "2026-09-07T06:00:00.000Z",
        mediaCount: 0,
      },
    ],
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listConnectionQueue(linkedinConnection.id);

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/connections/${linkedinConnection.id}/queue`,
  );
  assert.equal(response.queue[0].scheduledFor, "2026-09-07T06:00:00.000Z");
});

test("updateConnectionQueue patches the slots and the timezone", async () => {
  setStubResponse(200, {
    connection: {
      id: linkedinConnection.id,
      slug: "linkedin",
      timezone: "Europe/Helsinki",
      queueSlots: [{ weekday: 1, time: "09:00" }],
    },
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.updateConnectionQueue(linkedinConnection.id, {
    slots: [{ weekday: 1, time: "09:00" }],
    timezone: "Europe/Helsinki",
  });

  assert.equal(recordedRequests[0].method, "PATCH");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/connections/${linkedinConnection.id}/queue`,
  );
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    slots: [{ weekday: 1, time: "09:00" }],
    timezone: "Europe/Helsinki",
  });
  assert.equal(response.connection.timezone, "Europe/Helsinki");
});

test("listConnections narrows to one profile with a query parameter", async () => {
  setStubResponse(200, {
    connections: [{ ...linkedinConnection, profileId: acmeProfileId }],
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listConnections({ profileId: acmeProfileId });

  assert.equal(
    recordedRequests[0].url,
    `/api/v2/connections?profileId=${acmeProfileId}`,
  );
  assert.equal(response.connections[0].profileId, acmeProfileId);
});

test("createProfile sends the name and the external id", async () => {
  setStubResponse(200, { profile: acmeProfile });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createProfile({
    name: "Acme Coffee",
    externalId: "cus_4821",
  });

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(recordedRequests[0].url, "/api/v2/profiles");
  assert.equal(recordedRequests[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    name: "Acme Coffee",
    externalId: "cus_4821",
  });
  assert.deepEqual(response, { profile: acmeProfile });
});

test("createProfile leaves the external id out when it was not given", async () => {
  setStubResponse(200, { profile: { ...acmeProfile, externalId: null } });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createProfile({ name: "Acme Coffee" });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    name: "Acme Coffee",
  });
  assert.equal(response.profile.externalId, null);
});

test("listProfiles puts its paging in the query string", async () => {
  setStubResponse(200, { profiles: [acmeProfile], limit: 10, offset: 0 });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listProfiles({ limit: 10, offset: 0 });

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(recordedRequests[0].url, "/api/v2/profiles?limit=10&offset=0");
  assert.deepEqual(response, {
    profiles: [acmeProfile],
    limit: 10,
    offset: 0,
  });
});

test("listProfiles sends no query string without paging", async () => {
  setStubResponse(200, { profiles: [], limit: 25, offset: 0 });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.listProfiles();

  assert.equal(recordedRequests[0].url, "/api/v2/profiles");
});

test("getProfile reads one profile by id", async () => {
  setStubResponse(200, { profile: acmeProfile });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getProfile(acmeProfileId);

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(recordedRequests[0].url, `/api/v2/profiles/${acmeProfileId}`);
  assert.deepEqual(response, { profile: acmeProfile });
});

test("updateProfile patches only the fields it was given", async () => {
  setStubResponse(200, { profile: { ...acmeProfile, name: "Acme Coffee Oy" } });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.updateProfile(acmeProfileId, {
    name: "Acme Coffee Oy",
  });

  assert.equal(recordedRequests[0].method, "PATCH");
  assert.equal(recordedRequests[0].url, `/api/v2/profiles/${acmeProfileId}`);
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    name: "Acme Coffee Oy",
  });
  assert.equal(response.profile.name, "Acme Coffee Oy");
});

test("updateProfile sends an explicit null to clear the external id", async () => {
  setStubResponse(200, { profile: { ...acmeProfile, externalId: null } });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.updateProfile(acmeProfileId, {
    externalId: null,
  });

  // An explicit null, not an omitted field: the API reads the two differently,
  // and only the null takes the external id off
  assert.deepEqual(JSON.parse(recordedRequests[0].body), { externalId: null });
  assert.equal(response.profile.externalId, null);
});

test("deleteProfile says how many connections went with it", async () => {
  setStubResponse(200, {
    id: acmeProfileId,
    deleted: true,
    removedConnections: 2,
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.deleteProfile(acmeProfileId);

  assert.equal(recordedRequests[0].method, "DELETE");
  assert.equal(recordedRequests[0].url, `/api/v2/profiles/${acmeProfileId}`);
  assert.deepEqual(response, {
    id: acmeProfileId,
    deleted: true,
    removedConnections: 2,
  });
});

test("updateProfile refuses a call that names no field", async () => {
  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(() => yeetpost.updateProfile(acmeProfileId, {}), {
    message: "send a name, an externalId, or both",
  });

  // Refused here rather than by the API: nothing went out
  assert.equal(recordedRequests.length, 0);
});

test("a second profile with the same external id is a YeetpostApiError", async () => {
  setStubResponse(409, {
    error: "profile_external_id_conflict",
    message: "A profile with this externalId already exists.",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(
    () =>
      yeetpost.createProfile({ name: "Acme Coffee", externalId: "cus_4821" }),
    (error: unknown) => {
      assert.ok(error instanceof YeetpostApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "profile_external_id_conflict");
      return true;
    },
  );
});

//
// Keys
//

test("createProfileKey sends the name, the type and the allowlist", async () => {
  setStubResponse(201, { key: acmeKey, secret: "yp_secret_4f9a2c8e" });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createProfileKey(acmeProfileId, {
    name: "Acme integration",
    type: "live",
    redirectAllowlist: ["https://acme.example.com"],
  });

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/profiles/${acmeProfileId}/keys`,
  );
  assert.equal(recordedRequests[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    name: "Acme integration",
    type: "live",
    redirectAllowlist: ["https://acme.example.com"],
  });
  assert.deepEqual(response, { key: acmeKey, secret: "yp_secret_4f9a2c8e" });
});

test("createProfileKey leaves the allowlist out when it was not given", async () => {
  setStubResponse(201, {
    key: { ...acmeKey, redirectAllowlist: null },
    secret: "yp_secret_4f9a2c8e",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createProfileKey(acmeProfileId, {
    name: "Acme integration",
    type: "live",
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    name: "Acme integration",
    type: "live",
  });
  assert.equal(response.key.redirectAllowlist, null);
});

test("listProfileKeys puts includeRevoked in the query string", async () => {
  setStubResponse(200, {
    keys: [acmeKey, { ...acmeKey, revokedAt: "2026-08-30T10:00:00.000Z" }],
    limit: 25,
    offset: 0,
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listProfileKeys(acmeProfileId, {
    includeRevoked: true,
  });

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/profiles/${acmeProfileId}/keys?includeRevoked=true`,
  );
  assert.equal(response.keys[1].revokedAt, "2026-08-30T10:00:00.000Z");
});

test("listProfileKeys puts its paging in the query string", async () => {
  setStubResponse(200, { keys: [acmeKey], limit: 10, offset: 20 });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listProfileKeys(acmeProfileId, {
    limit: 10,
    offset: 20,
  });

  assert.equal(
    recordedRequests[0].url,
    `/api/v2/profiles/${acmeProfileId}/keys?limit=10&offset=20`,
  );
  assert.deepEqual(response, { keys: [acmeKey], limit: 10, offset: 20 });
});

test("listProfileKeys sends no query string without includeRevoked", async () => {
  setStubResponse(200, { keys: [acmeKey], limit: 25, offset: 0 });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listProfileKeys(acmeProfileId);

  assert.equal(
    recordedRequests[0].url,
    `/api/v2/profiles/${acmeProfileId}/keys`,
  );
  assert.deepEqual(response, { keys: [acmeKey], limit: 25, offset: 0 });
});

test("an id with a slash is escaped into one path segment", async () => {
  setStubResponse(200, { id: "acme/key", revoked: true });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.revokeKey("acme/key");

  // The slash is %2F, so the id cannot open a path of its own
  assert.equal(recordedRequests[0].url, "/api/v2/keys/acme%2Fkey");
});

test("revokeProfileKey deletes the key under its profile", async () => {
  setStubResponse(200, { id: acmeKeyId, revoked: true });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.revokeProfileKey(acmeProfileId, acmeKeyId);

  assert.equal(recordedRequests[0].method, "DELETE");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/profiles/${acmeProfileId}/keys/${acmeKeyId}`,
  );
  assert.deepEqual(response, { id: acmeKeyId, revoked: true });
});

test("listKeys reads every key of the account", async () => {
  setStubResponse(200, {
    keys: [{ ...acmeKey, profileId: null }, acmeKey],
    limit: 25,
    offset: 0,
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listKeys();

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(recordedRequests[0].url, "/api/v2/keys");
  assert.equal(response.keys[0].profileId, null);
  assert.equal(response.keys[1].profileId, acmeProfileId);
});

test("listKeys puts includeRevoked in the query string", async () => {
  setStubResponse(200, { keys: [acmeKey], limit: 25, offset: 0 });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.listKeys({ includeRevoked: false });

  assert.equal(recordedRequests[0].url, "/api/v2/keys?includeRevoked=false");
});

test("listKeys puts its paging in the query string", async () => {
  setStubResponse(200, { keys: [acmeKey], limit: 50, offset: 100 });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listKeys({ limit: 50, offset: 100 });

  assert.equal(recordedRequests[0].url, "/api/v2/keys?limit=50&offset=100");
  assert.equal(response.limit, 50);
  assert.equal(response.offset, 100);
});

test("revokeKey revokes any key of the account by id", async () => {
  setStubResponse(200, { id: acmeKeyId, revoked: true });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.revokeKey(acmeKeyId);

  assert.equal(recordedRequests[0].method, "DELETE");
  assert.equal(recordedRequests[0].url, `/api/v2/keys/${acmeKeyId}`);
  assert.deepEqual(response, { id: acmeKeyId, revoked: true });
});

test("minting a key with a scoped key is a YeetpostApiError", async () => {
  setStubResponse(403, {
    error: "forbidden",
    message: SCOPED_KEY_MESSAGE,
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(
    () =>
      yeetpost.createProfileKey(acmeProfileId, {
        name: "Acme integration",
        type: "live",
      }),
    (error: unknown) => {
      assert.ok(error instanceof YeetpostApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "forbidden");
      assert.equal(error.message, SCOPED_KEY_MESSAGE);
      return true;
    },
  );
});

//
// Connect urls
//

test("createConnectUrl posts the platform and the redirect url", async () => {
  setStubResponse(200, connectSession);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createConnectUrl(acmeProfileId, {
    platform: "linkedin",
    redirectUrl: "https://acme.example.com/settings/social",
  });

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/profiles/${acmeProfileId}/connect`,
  );
  assert.equal(recordedRequests[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    platform: "linkedin",
    redirectUrl: "https://acme.example.com/settings/social",
  });
  assert.deepEqual(response, connectSession);
});

test("createConnectUrl reconnects a connection and may leave the redirect url out", async () => {
  setStubResponse(200, connectSession);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.createConnectUrl(acmeProfileId, {
    connectionId: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    connectionId: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
  });
});

test("createConnectUrl leaves the platform out so the page shows a picker", async () => {
  setStubResponse(200, connectSession);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.createConnectUrl(acmeProfileId, {
    redirectUrl: "https://acme.example.com/settings/social",
    headless: true,
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    redirectUrl: "https://acme.example.com/settings/social",
    headless: true,
  });
});

test("createConnectUrl opens a link for one of the platforms behind the Meta app", async () => {
  setStubResponse(200, connectSession);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.createConnectUrl(acmeProfileId, {
    platform: "threads",
    redirectUrl: "https://acme.example.com/settings/social",
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    platform: "threads",
    redirectUrl: "https://acme.example.com/settings/social",
  });
});

test("getConnectSession reads how a connect link ended", async () => {
  setStubResponse(200, {
    connectSession: {
      id: connectSessionId,
      profileId: acmeProfileId,
      platform: "linkedin",
      status: "connected",
      connectionId: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
      error: null,
      redirectUrl: "https://acme.example.com/settings/social",
      headless: false,
      expiresAt: "2026-08-29T09:39:11.412Z",
      createdAt: "2026-08-29T09:24:11.412Z",
    },
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getConnectSession(connectSessionId);

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/connect-sessions/${connectSessionId}`,
  );
  assert.equal(response.connectSession.status, "connected");
  assert.equal(
    response.connectSession.connectionId,
    "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
  );
});

test("parseConnectRedirect reads the query a connected customer came back on", () => {
  const redirect = parseConnectRedirect(
    new URLSearchParams({
      connectSessionId,
      connectionId: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
      profileId: acmeProfileId,
      slug: "acme_linkedin",
      platform: "linkedin",
    }),
  );

  assert.deepEqual(redirect, {
    connectSessionId,
    connectionId: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    profileId: acmeProfileId,
    slug: "acme_linkedin",
    platform: "linkedin",
  });
});

test("parseConnectRedirect reads a cancelled redirect off a query string", () => {
  const redirect = parseConnectRedirect(
    `?connectSessionId=${connectSessionId}&error=cancelled`,
  );

  // No connection was made, so the connection parameters are not there at all
  assert.deepEqual(redirect, { connectSessionId, error: "cancelled" });
});

test("parseConnectRedirect takes the parsed query object a framework hands you", () => {
  const redirect = parseConnectRedirect({
    connectSessionId: [connectSessionId],
    error: "connect_failed",
    utm_source: undefined,
  });

  assert.deepEqual(redirect, { connectSessionId, error: "connect_failed" });
});

test("parseConnectRedirect leaves the session id empty on a query that is not ours", () => {
  const redirect = parseConnectRedirect("?utm_source=newsletter");

  assert.deepEqual(redirect, { connectSessionId: "" });
});

test("createPosts sends the body and idempotency key, and returns the results", async () => {
  setStubResponse(200, {
    results: [
      {
        connectionSlug: "linkedin",
        status: "sent",
        postId: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        url: "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
        scheduledFor: null,
        error: null,
      },
      {
        connectionSlug: "x",
        status: "failed",
        postId: "0b7e4a52-9f0c-4a1c-8b3a-6d2f5b1c0e44",
        url: null,
        scheduledFor: null,
        error: {
          code: "platform_rejected",
          message: "X: duplicate post was detected",
        },
      },
    ],
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createPosts({
    text: "shipped the new api docs today",
    connectionSlugs: ["linkedin", "x"],
    idempotencyKey: "release-v2.4.0-announcement",
  });

  assert.equal(recordedRequests.length, 1);
  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(recordedRequests[0].url, "/api/v2/posts");
  assert.equal(recordedRequests[0].headers["content-type"], "application/json");
  assert.equal(
    recordedRequests[0].headers["idempotency-key"],
    "release-v2.4.0-announcement",
  );
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "shipped the new api docs today",
    connectionSlugs: ["linkedin", "x"],
  });
  assert.equal(response.results.length, 2);
  assert.deepEqual(response.results[1], {
    connectionSlug: "x",
    status: "failed",
    postId: "0b7e4a52-9f0c-4a1c-8b3a-6d2f5b1c0e44",
    url: null,
    scheduledFor: null,
    error: {
      code: "platform_rejected",
      message: "X: duplicate post was detected",
    },
  });
});

test("createPosts reads the warning a send carries inside the grace window", async () => {
  setStubResponse(200, {
    results: [
      {
        connectionSlug: "linkedin",
        status: "sent",
        postId: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        url: "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
        scheduledFor: null,
        threadCount: 0,
        hasFirstComment: false,
        warning: GRACE_WARNING,
        error: null,
      },
    ],
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createPosts({
    text: "shipped the new api docs today",
    connectionSlugs: ["linkedin"],
  });

  assert.equal(response.results[0].status, "sent");
  assert.equal(response.results[0].warning, GRACE_WARNING);
});

test("createPosts reads a connection_limit_exceeded refusal as a failed item", async () => {
  setStubResponse(200, {
    results: [
      {
        connectionSlug: "linkedin",
        status: "failed",
        postId: null,
        url: null,
        scheduledFor: null,
        threadCount: 0,
        hasFirstComment: false,
        error: {
          code: "connection_limit_exceeded",
          message:
            "This account has 4 connected accounts, over the free limit of 3. Subscribe or disconnect down to 3 to keep posting.",
        },
      },
    ],
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createPosts({
    text: "shipped the new api docs today",
    connectionSlugs: ["linkedin"],
  });

  assert.equal(response.results[0].status, "failed");
  assert.equal(response.results[0].warning, undefined);
  assert.equal(response.results[0].error?.code, "connection_limit_exceeded");
});

test("createPosts sends the profile the post goes out for", async () => {
  setStubResponse(200, { results: [] });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.createPosts({
    text: "our new roast is out",
    connectionSlugs: ["acme_linkedin"],
    profileId: acmeProfileId,
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "our new roast is out",
    connectionSlugs: ["acme_linkedin"],
    profileId: acmeProfileId,
  });
});

test("createPosts sends scheduledFor when it is given", async () => {
  setStubResponse(200, { results: [] });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.createPosts({
    text: "scheduled from a real integration",
    connectionSlugs: ["linkedin"],
    scheduledFor: "2026-09-15T15:00:00Z",
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "scheduled from a real integration",
    connectionSlugs: ["linkedin"],
    scheduledFor: "2026-09-15T15:00:00Z",
  });
});

test("createPosts sends a timezone alongside a local scheduledFor", async () => {
  setStubResponse(200, { results: [] });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.createPosts({
    text: "nine in the morning, helsinki",
    connectionSlugs: ["linkedin"],
    scheduledFor: "2026-09-15T09:00:00",
    timezone: "Europe/Helsinki",
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "nine in the morning, helsinki",
    connectionSlugs: ["linkedin"],
    scheduledFor: "2026-09-15T09:00:00",
    timezone: "Europe/Helsinki",
  });
});

test("createPosts sends queue and gets back the slot it took", async () => {
  setStubResponse(200, {
    results: [
      {
        connectionSlug: "linkedin",
        status: "scheduled",
        postId: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        url: null,
        scheduledFor: "2026-09-07T06:00:00.000Z",
        error: null,
      },
    ],
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createPosts({
    text: "goes out at the next open slot",
    connectionSlugs: ["linkedin"],
    queue: true,
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "goes out at the next open slot",
    connectionSlugs: ["linkedin"],
    queue: true,
  });
  assert.equal(response.results[0].status, "scheduled");
  assert.equal(response.results[0].scheduledFor, "2026-09-07T06:00:00.000Z");
});

test("createPosts sends mediaIds, thread and firstComment", async () => {
  setStubResponse(200, { results: [] });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.createPosts({
    text: "the head post",
    connectionSlugs: ["x", "bluesky"],
    mediaIds: ["9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d"],
    thread: ["second", "third"],
    firstComment: "the link is here",
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "the head post",
    connectionSlugs: ["x", "bluesky"],
    mediaIds: ["9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d"],
    thread: ["second", "third"],
    firstComment: "the link is here",
  });
});

test("uploadMedia sends the raw bytes with the content type and alt_text", async () => {
  setStubResponse(200, {
    mediaId: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
    contentType: "image/png",
    sizeBytes: 4,
  });

  // The stub records the body as utf8, so these bytes are ascii ones: what is
  // asserted is that the body is the bytes themselves, with no multipart around
  // them
  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.uploadMedia({
    bytes: Buffer.from("PNGB", "utf8"),
    contentType: "image/png",
    altText: "the new docs page",
  });

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/media?alt_text=the+new+docs+page",
  );
  assert.equal(recordedRequests[0].headers["content-type"], "image/png");
  assert.equal(recordedRequests[0].body, "PNGB");
  assert.equal(response.mediaId, "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d");
});

test("getLook reads the account's look", async () => {
  const look = {
    description: "Dark navy.",
    exampleCards: ["<p>card</p>"],
    logoMediaId: null,
  };
  setStubResponse(200, { look });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getLook();

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(recordedRequests[0].url, "/api/v2/look");
  assert.deepEqual(response, { look });
});

test("updateLook puts the look, and null to clear it", async () => {
  const look = {
    description: "Dark navy.",
    exampleCards: ["<p>card</p>"],
    logoMediaId: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
  };
  setStubResponse(200, { look });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const set = await yeetpost.updateLook(look);

  setStubResponse(200, { look: null });
  const cleared = await yeetpost.updateLook(null);

  assert.equal(recordedRequests[0].method, "PUT");
  assert.equal(recordedRequests[0].url, "/api/v2/look");
  assert.deepEqual(JSON.parse(recordedRequests[0].body), { look });
  assert.deepEqual(set, { look });
  assert.deepEqual(JSON.parse(recordedRequests[1].body), { look: null });
  assert.deepEqual(cleared, { look: null });
});

test("draftLookFromUrl posts the address and the target and answers the draft", async () => {
  const draft = {
    url: "https://brand.test/",
    applied: true,
    target: { type: "connection", connectionId: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b" },
    look: {
      description: "Acme: a light, clean look.",
      exampleCards: ["<p>a</p>", "<p>b</p>"],
      logoMediaId: null,
    },
    descriptionSource: "facts",
    warnings: [],
  };
  setStubResponse(200, draft);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.draftLookFromUrl({
    url: "https://brand.test/",
    apply: true,
    connectionId: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
  });

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(recordedRequests[0].url, "/api/v2/look/draft-from-url");
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    url: "https://brand.test/",
    apply: true,
    connectionId: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
  });
  assert.deepEqual(response, draft);
});

test("renderImage posts the card and answers the stored image", async () => {
  const rendered = {
    mediaId: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
    contentType: "image/jpeg",
    sizeBytes: 48213,
    width: 1200,
    height: 1200,
    postId: null,
    rendersUsed: 1,
    rendersLimit: 300,
  };
  setStubResponse(200, rendered);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.renderImage({
    html: "<html><body>Launch</body></html>",
    preset: "square",
    altText: "Launch card",
  });

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(recordedRequests[0].url, "/api/v2/images/render");
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    html: "<html><body>Launch</body></html>",
    preset: "square",
    altText: "Launch card",
  });
  assert.deepEqual(response, rendered);
});

test("createPosts sends media with its own alt text", async () => {
  setStubResponse(200, { results: [] });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.createPosts({
    text: "with a described image",
    connectionSlugs: ["bluesky"],
    media: [
      { id: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d", altText: "the docs page" },
      { id: "1f2e3d4c-5b6a-4798-8a1b-2c3d4e5f6a7b" },
    ],
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "with a described image",
    connectionSlugs: ["bluesky"],
    media: [
      { id: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d", altText: "the docs page" },
      { id: "1f2e3d4c-5b6a-4798-8a1b-2c3d4e5f6a7b" },
    ],
  });
});

test("createPosts sends mediaUrls to fetch and attach itself", async () => {
  setStubResponse(200, { results: [] });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.createPosts({
    text: "with an image already hosted elsewhere",
    connectionSlugs: ["bluesky"],
    mediaUrls: ["https://example.com/roast.jpg"],
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "with an image already hosted elsewhere",
    connectionSlugs: ["bluesky"],
    mediaUrls: ["https://example.com/roast.jpg"],
  });
});

test("getActivity sends the limit and cursor as query params", async () => {
  const activity = { items: [], cursor: null, refusedRequests: [] };
  setStubResponse(200, activity);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getActivity({ limit: 10, cursor: "abc" });

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(recordedRequests[0].url, "/api/v2/activity?limit=10&cursor=abc");
  assert.deepEqual(response, activity);
});

//
// Sources
//

const herizonSourceId = "7d1f0c52-3a8e-4d6b-9c41-0b2e5a9f1c33";
const herizonItemId = "2c9e4b1a-6d3f-4e58-b7a0-5f1d8c3e9a42";

const herizonSource = {
  id: herizonSourceId,
  slug: "herizon-io",
  name: "Herizon courses",
  url: "https://herizon.io/courses.xml",
  kind: "feed",
  resolvedUrl: null,
  profileId: null,
  connectionSlugs: ["herizon_linkedin"],
  mode: "queue",
  instructions: "",
  makeCard: true,
  status: "active",
  lastCheckedAt: null,
  nextCheckAt: "2026-10-27T10:00:00.000Z",
  lastError: null,
  itemCounts: {
    baseline: 3,
    new: 0,
    writing: 0,
    posted: 0,
    failed: 0,
    skipped: 0,
  },
  pushUrl: null,
  createdAt: "2026-10-27T09:00:00.000Z",
};

test("previewSource posts the url to /sources/preview", async () => {
  const preview = {
    kind: "feed",
    name: "Herizon courses",
    resolvedUrl: null,
    itemCount: 1,
    items: [
      {
        title: "Negotiating your salary",
        url: "https://herizon.io/courses/negotiating-your-salary",
        summary: "A short line.",
        publishedAt: "2026-10-20T08:00:00.000Z",
      },
    ],
  };
  setStubResponse(200, preview);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.previewSource({
    url: "https://herizon.io/courses.xml",
  });

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(recordedRequests[0].url, "/api/v2/sources/preview");
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    url: "https://herizon.io/courses.xml",
  });
  assert.deepEqual(response, preview);
});

test("createSource sends what it is given and leaves out the rest", async () => {
  setStubResponse(200, { source: herizonSource });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createSource({
    url: "https://herizon.io/courses.xml",
    connectionSlugs: ["herizon_linkedin"],
    mode: "queue",
    instructions: "one post per course",
    backfillCount: 2,
  });

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(recordedRequests[0].url, "/api/v2/sources");
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    url: "https://herizon.io/courses.xml",
    connectionSlugs: ["herizon_linkedin"],
    mode: "queue",
    instructions: "one post per course",
    backfillCount: 2,
  });
  assert.deepEqual(response, { source: herizonSource });
});

test("createSource makes a push source with kind push", async () => {
  setStubResponse(200, { source: { ...herizonSource, kind: "push" } });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.createSource({
    kind: "push",
    connectionSlugs: ["herizon_linkedin"],
    mode: "draft",
    makeCard: false,
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    kind: "push",
    connectionSlugs: ["herizon_linkedin"],
    mode: "draft",
    makeCard: false,
  });
});

test("listSources puts its paging in the query string", async () => {
  const list = { sources: [herizonSource], limit: 10, offset: 5 };
  setStubResponse(200, list);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listSources({ limit: 10, offset: 5 });

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(recordedRequests[0].url, "/api/v2/sources?limit=10&offset=5");
  assert.deepEqual(response, list);
});

test("listSources sends no query string without paging", async () => {
  setStubResponse(200, { sources: [], limit: 25, offset: 0 });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.listSources();

  assert.equal(recordedRequests[0].url, "/api/v2/sources");
});

test("getSource reads one source by id", async () => {
  setStubResponse(200, { source: herizonSource });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getSource(herizonSourceId);

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(recordedRequests[0].url, `/api/v2/sources/${herizonSourceId}`);
  assert.deepEqual(response, { source: herizonSource });
});

test("updateSource patches only what it is given", async () => {
  setStubResponse(200, { source: { ...herizonSource, status: "paused" } });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.updateSource(herizonSourceId, {
    status: "paused",
  });

  assert.equal(recordedRequests[0].method, "PATCH");
  assert.equal(recordedRequests[0].url, `/api/v2/sources/${herizonSourceId}`);
  assert.deepEqual(JSON.parse(recordedRequests[0].body), { status: "paused" });
  assert.equal(response.source.status, "paused");
});

test("deleteSource deletes by id", async () => {
  setStubResponse(200, { id: herizonSourceId, deleted: true });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.deleteSource(herizonSourceId);

  assert.equal(recordedRequests[0].method, "DELETE");
  assert.equal(recordedRequests[0].url, `/api/v2/sources/${herizonSourceId}`);
  assert.deepEqual(response, { id: herizonSourceId, deleted: true });
});

test("checkSource posts to the check path and returns the new items", async () => {
  const checked = {
    source: herizonSource,
    newItems: [
      {
        id: herizonItemId,
        title: "Leading without a title",
        url: "https://herizon.io/courses/leading-without-a-title",
      },
    ],
  };
  setStubResponse(200, checked);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.checkSource(herizonSourceId);

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/sources/${herizonSourceId}/check`,
  );
  assert.deepEqual(response, checked);
});

test("listSourceItems sends the status and paging as query params", async () => {
  const items = { items: [], limit: 10, offset: 0 };
  setStubResponse(200, items);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listSourceItems(herizonSourceId, {
    status: "failed",
    limit: 10,
    offset: 0,
  });

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/sources/${herizonSourceId}/items?status=failed&limit=10&offset=0`,
  );
  assert.deepEqual(response, items);
});

test("addSourceItems posts the items to a push source", async () => {
  setStubResponse(200, { added: 1, duplicates: 0 });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.addSourceItems(herizonSourceId, {
    items: [
      {
        id: "course-4",
        title: "Pricing your work",
        url: "https://herizon.io/courses/pricing-your-work",
      },
    ],
  });

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/sources/${herizonSourceId}/items`,
  );
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    items: [
      {
        id: "course-4",
        title: "Pricing your work",
        url: "https://herizon.io/courses/pricing-your-work",
      },
    ],
  });
  assert.deepEqual(response, { added: 1, duplicates: 0 });
});

test("retrySourceItem posts to the item's retry path", async () => {
  setStubResponse(200, { id: herizonItemId, status: "new" });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.retrySourceItem(
    herizonSourceId,
    herizonItemId,
  );

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/sources/${herizonSourceId}/items/${herizonItemId}/retry`,
  );
  assert.deepEqual(response, { id: herizonItemId, status: "new" });
});

test("a test key's 403 on sources is thrown as a YeetpostApiError", async () => {
  setStubResponse(403, {
    error: "forbidden",
    message:
      "Sources post to real connections, so they need a live API key. Test keys cannot use them.",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_test_key", baseUrl });

  await assert.rejects(yeetpost.listSources(), (err: unknown) => {
    assert.equal(err instanceof YeetpostApiError, true);
    assert.equal((err as YeetpostApiError).status, 403);
    assert.equal((err as YeetpostApiError).code, "forbidden");
    return true;
  });
});

test("getMedia reads the bytes back with the content type", async () => {
  stubResponse = {
    status: 200,
    body: "PNGB",
    contentType: "image/png",
  };

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getMedia(
    "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
  );

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/media/9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
  );
  assert.equal(response.contentType, "image/png");
  assert.equal(Buffer.from(response.bytes).toString("utf8"), "PNGB");
});

test("getMedia keeps only the media type when the header has parameters", async () => {
  stubResponse = {
    status: 200,
    body: "PNGB",
    contentType: "image/png; charset=binary",
  };

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getMedia(
    "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
  );

  assert.equal(response.contentType, "image/png");
});

test("listMedia puts its filters in the query string", async () => {
  setStubResponse(200, { media: [], cursor: null });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listMedia({
    connectionSlug: "linkedin",
    limit: 10,
  });

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/media?connectionSlug=linkedin&limit=10",
  );
  assert.deepEqual(response, { media: [], cursor: null });
});

test("deleteMedia sends a DELETE and returns the deleted image", async () => {
  setStubResponse(200, {
    id: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
    deleted: true,
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.deleteMedia(
    "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
  );

  assert.equal(recordedRequests[0].method, "DELETE");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/media/9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
  );
  assert.deepEqual(response, {
    id: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
    deleted: true,
  });
});

test("listPosts puts its filters in the query string", async () => {
  setStubResponse(200, { posts: [], limit: 10, offset: 0 });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.listPosts({ status: "scheduled", limit: 10 });

  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts?status=scheduled&limit=10",
  );
});

test("listPosts repeats tag once per label", async () => {
  setStubResponse(200, { posts: [], limit: 25, offset: 0 });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.listPosts({ status: "draft", tag: ["launch", "q3"] });

  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts?status=draft&tag=launch&tag=q3",
  );
});

test("listPosts puts scheduledAfter, scheduledBefore, connectionSlug, platform and sendGroupId in the query string", async () => {
  setStubResponse(200, { posts: [], limit: 25, offset: 0 });

  const sendGroupId = "2b6a1c9d-3e4f-4a70-8b9c-0d1e2f3a4b5c";

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.listPosts({
    scheduledAfter: "2026-09-01T00:00:00Z",
    scheduledBefore: "2026-09-30T00:00:00Z",
    connectionSlug: "linkedin",
    platform: "linkedin",
    sendGroupId,
  });

  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts?scheduledAfter=2026-09-01T00%3A00%3A00Z&scheduledBefore=2026-09-30T00%3A00%3A00Z&connectionSlug=linkedin&platform=linkedin&sendGroupId=" +
      sendGroupId,
  );
});

test("listPosts puts createdAfter, createdBefore, sort and offset in the query string", async () => {
  setStubResponse(200, {
    posts: [],
    limit: 10,
    offset: 20,
    total: 31,
    hasMore: true,
    nextOffset: 30,
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listPosts({
    createdAfter: "2026-09-01T00:00:00Z",
    createdBefore: "2026-09-30T00:00:00Z",
    sort: "created_asc",
    limit: 10,
    offset: 20,
  });

  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts?createdAfter=2026-09-01T00%3A00%3A00Z&createdBefore=2026-09-30T00%3A00%3A00Z&sort=created_asc&limit=10&offset=20",
  );
  assert.equal(response.total, 31);
  assert.equal(response.hasMore, true);
  assert.equal(response.nextOffset, 30);
});

test("listPosts narrows to one profile and reads its posts back", async () => {
  setStubResponse(200, {
    posts: [
      {
        id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        connectionSlug: "acme_linkedin",
        profileId: acmeProfileId,
        text: "our new roast is out",
        status: "sent",
        url: "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
        scheduledFor: null,
        createdAt: "2026-08-29T09:24:11.412Z",
        tags: [],
        platformPostId: "urn:li:share:1234567890",
        deletedAt: null,
        error: null,
        media: [],
        thread: [],
        firstComment: null,
        publishedAt: "2026-08-29T09:24:12.000Z",
      },
    ],
    limit: 25,
    offset: 0,
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listPosts({ profileId: acmeProfileId });

  assert.equal(
    recordedRequests[0].url,
    `/api/v2/posts?profileId=${acmeProfileId}`,
  );
  assert.equal(response.posts[0].profileId, acmeProfileId);
  assert.equal(response.posts[0].publishedAt, "2026-08-29T09:24:12.000Z");
  assert.deepEqual(response.posts[0].media, []);
  assert.deepEqual(response.posts[0].thread, []);
  assert.equal(response.posts[0].firstComment, null);
});

test("getPostMetrics reads the latest numbers and the whole history", async () => {
  setStubResponse(200, {
    latest: {
      fetchedAt: "2026-08-30T10:00:00.000Z",
      impressions: null,
      likes: 12,
      reposts: 3,
      replies: 1,
      clicks: null,
    },
    history: [
      {
        fetchedAt: "2026-08-29T10:00:00.000Z",
        impressions: null,
        likes: 4,
        reposts: 1,
        replies: 0,
        clicks: null,
      },
      {
        fetchedAt: "2026-08-30T10:00:00.000Z",
        impressions: null,
        likes: 12,
        reposts: 3,
        replies: 1,
        clicks: null,
      },
    ],
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getPostMetrics(
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10/metrics",
  );
  assert.equal(response.latest?.likes, 12);
  // Bluesky reports no impressions, and null says so rather than claiming zero
  assert.equal(response.latest?.impressions, null);
  assert.equal(response.history.length, 2);
});

test("getPostMetrics answers null latest for a post nothing has been read for", async () => {
  setStubResponse(200, { latest: null, history: [] });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getPostMetrics(
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );

  assert.equal(response.latest, null);
  assert.deepEqual(response.history, []);
});

test("getAnalytics puts its window and filters in the query string", async () => {
  setStubResponse(200, {
    totals: {
      posts: 2,
      impressions: 0,
      likes: 16,
      reposts: 4,
      replies: 1,
      clicks: 0,
    },
    days: [
      {
        day: "2026-08-29",
        posts: 1,
        impressions: 0,
        likes: 4,
        reposts: 1,
        replies: 0,
      },
      {
        day: "2026-08-30",
        posts: 1,
        impressions: 0,
        likes: 12,
        reposts: 3,
        replies: 1,
      },
    ],
    byPlatform: [
      {
        platformId: "bluesky",
        posts: 2,
        impressions: 0,
        likes: 16,
        reposts: 4,
        replies: 1,
        clicks: 0,
      },
    ],
    from: "2026-08-29",
    to: "2026-08-30",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getAnalytics({
    from: "2026-08-29",
    to: "2026-08-30",
    platform: "bluesky",
  });

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/analytics?from=2026-08-29&to=2026-08-30&platform=bluesky",
  );
  assert.equal(response.totals.likes, 16);
  assert.equal(response.days.length, 2);
  assert.equal(response.byPlatform[0].platformId, "bluesky");
});

test("getAnalytics with no window asks for the endpoint's own default", async () => {
  setStubResponse(200, {
    totals: {
      posts: 0,
      impressions: 0,
      likes: 0,
      reposts: 0,
      replies: 0,
      clicks: 0,
    },
    days: [],
    byPlatform: [],
    from: "2026-08-01",
    to: "2026-08-30",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.getAnalytics();

  assert.equal(recordedRequests[0].url, "/api/v2/analytics");
});

test("createPosts sends isDraft and tags, and gets drafts back", async () => {
  setStubResponse(200, {
    results: [
      {
        connectionSlug: "linkedin",
        status: "draft",
        postId: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        url: null,
        scheduledFor: null,
        threadCount: 0,
        hasFirstComment: false,
        error: null,
      },
    ],
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createPosts({
    text: "half an idea",
    connectionSlugs: ["linkedin"],
    isDraft: true,
    tags: ["launch"],
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "half an idea",
    connectionSlugs: ["linkedin"],
    isDraft: true,
    tags: ["launch"],
  });
  assert.equal(response.results[0].status, "draft");
  assert.equal(
    response.results[0].postId,
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );
});

test("publishPost sends an empty body and returns the result", async () => {
  setStubResponse(200, {
    result: {
      connectionSlug: "linkedin",
      status: "sent",
      postId: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
      url: "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
      scheduledFor: null,
      threadCount: 0,
      hasFirstComment: false,
      error: null,
    },
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.publishPost(
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10/publish",
  );
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {});
  assert.equal(response.result.status, "sent");
});

test("publishPost reads the warning a send carries inside the grace window", async () => {
  setStubResponse(200, {
    result: {
      connectionSlug: "linkedin",
      status: "sent",
      postId: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
      url: "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
      scheduledFor: null,
      threadCount: 0,
      hasFirstComment: false,
      warning: GRACE_WARNING,
      error: null,
    },
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.publishPost(
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );

  assert.equal(response.result.status, "sent");
  assert.equal(response.result.warning, GRACE_WARNING);
});

test("publishPost sends a time and an idempotency key", async () => {
  setStubResponse(200, { result: {} });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.publishPost("6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", {
    scheduledFor: "2026-09-15T09:00:00",
    timezone: "Europe/Helsinki",
    idempotencyKey: "publish-the-launch-post",
  });

  assert.equal(
    recordedRequests[0].headers["idempotency-key"],
    "publish-the-launch-post",
  );
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    scheduledFor: "2026-09-15T09:00:00",
    timezone: "Europe/Helsinki",
  });
});

test("updateDraft sends a PATCH with only the fields it was given", async () => {
  setStubResponse(200, {
    post: {
      id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
      connectionSlug: "linkedin",
      text: "a better idea",
      status: "draft",
      url: null,
      scheduledFor: null,
      createdAt: "2026-08-26T09:24:11.412Z",
      tags: ["launch"],
      error: null,
    },
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.updateDraft(
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    { text: "a better idea", tags: ["launch"] },
  );

  assert.equal(recordedRequests[0].method, "PATCH");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "a better idea",
    tags: ["launch"],
  });
  assert.equal(response.post.status, "draft");
  assert.deepEqual(response.post.tags, ["launch"]);
});

test("updateDraft replaces the images with media that carries alt text", async () => {
  setStubResponse(200, { post: {} });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.updateDraft("6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", {
    media: [
      { id: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d", altText: "the docs page" },
    ],
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    media: [
      { id: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d", altText: "the docs page" },
    ],
  });
});

test("updateDraft sends an explicit null to clear the first comment", async () => {
  setStubResponse(200, { post: {} });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.updateDraft("6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", {
    thread: [],
    firstComment: null,
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    thread: [],
    firstComment: null,
  });
});

test("updateDraft moves a scheduled post's time with scheduledFor and timezone", async () => {
  setStubResponse(200, {
    post: {
      id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
      connectionSlug: "linkedin",
      text: "a better idea",
      status: "scheduled",
      url: null,
      scheduledFor: "2026-09-20T15:00:00.000Z",
      createdAt: "2026-08-26T09:24:11.412Z",
      tags: [],
      error: null,
    },
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.updateDraft(
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    {
      scheduledFor: "2026-09-20T18:00:00",
      timezone: "Europe/Helsinki",
    },
  );

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    scheduledFor: "2026-09-20T18:00:00",
    timezone: "Europe/Helsinki",
  });
  assert.equal(response.post.status, "scheduled");
  assert.equal(response.post.scheduledFor, "2026-09-20T15:00:00.000Z");
});

test("updateDraft takes the next free slot with queue", async () => {
  setStubResponse(200, { post: {} });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.updateDraft("6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10", {
    queue: true,
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), { queue: true });
});

test("deleteDraft sends a DELETE and returns the deleted draft", async () => {
  setStubResponse(200, {
    id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    deleted: true,
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.deleteDraft(
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );

  assert.equal(recordedRequests[0].method, "DELETE");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );
  assert.deepEqual(response, {
    id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    deleted: true,
  });
});

test("postToConnection sends the text as the body", async () => {
  setStubResponse(200, {
    platform: "linkedin",
    link: "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.postToConnection(
    "linkedin",
    "shipped the new api docs today",
  );

  assert.equal(recordedRequests[0].url, "/api/v2/post/linkedin");
  assert.equal(recordedRequests[0].headers["content-type"], "text/plain");
  assert.equal(recordedRequests[0].body, "shipped the new api docs today");
  assert.deepEqual(response, {
    platform: "linkedin",
    link: "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
  });
});

test("postToConnection reads a reddit link back", async () => {
  setStubResponse(200, {
    platform: "reddit",
    link: "https://www.reddit.com/r/yeetpost/comments/1abc2de/shipped_the_new_api_docs_today/",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.postToConnection(
    "reddit",
    "shipped the new api docs today",
  );

  assert.equal(recordedRequests[0].url, "/api/v2/post/reddit");
  assert.deepEqual(response, {
    platform: "reddit",
    link: "https://www.reddit.com/r/yeetpost/comments/1abc2de/shipped_the_new_api_docs_today/",
  });
});

test("cancelPost sends a DELETE and returns the cancelled post", async () => {
  setStubResponse(200, {
    id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    status: "cancelled",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.cancelPost(
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );

  assert.equal(recordedRequests[0].method, "DELETE");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );
  assert.deepEqual(response, {
    id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    status: "cancelled",
  });
});

test("deletePost answers with the deleted post when it had gone out", async () => {
  setStubResponse(200, {
    id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    status: "deleted",
    deletedAt: "2026-08-29T11:02:44.108Z",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.deletePost(
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );

  assert.equal(recordedRequests[0].method, "DELETE");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );
  assert.deepEqual(response, {
    id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    status: "deleted",
    deletedAt: "2026-08-29T11:02:44.108Z",
  });
});

test("drawCard sends instructions and attach to the card path and returns the card", async () => {
  setStubResponse(200, {
    mediaId: "0d6f5b3e-8a41-4c53-b6c2-5e0d9f1a7b22",
    html: "<html></html>",
    attached: true,
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.drawCard(
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    { instructions: "use a chart", attach: true },
  );

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10/card",
  );
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    instructions: "use a chart",
    attach: true,
  });
  assert.deepEqual(response, {
    mediaId: "0d6f5b3e-8a41-4c53-b6c2-5e0d9f1a7b22",
    html: "<html></html>",
    attached: true,
  });
});

test("retryPost sends a POST to the retry path and returns the resent post", async () => {
  setStubResponse(200, {
    id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    status: "sent",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.retryPost(
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10/retry",
  );
  assert.deepEqual(response, {
    id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    status: "sent",
  });
});

test("retryPost reads the warning a retry carries inside the grace window", async () => {
  setStubResponse(200, {
    id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    status: "sent",
    warning: GRACE_WARNING,
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.retryPost(
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );

  assert.equal(response.status, "sent");
  assert.equal(response.warning, GRACE_WARNING);
});

test("retrying a post that did not fail is a YeetpostApiError", async () => {
  setStubResponse(400, {
    error: "invalid_request",
    message: "Only a post that failed can be retried.",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(
    () => yeetpost.retryPost("6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10"),
    (error: unknown) => {
      assert.ok(error instanceof YeetpostApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_request");
      return true;
    },
  );
});

test("createWebhook returns the secret, which is only sent once", async () => {
  setStubResponse(200, {
    webhook: {
      id: "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
      url: "https://example.com/hooks/yeetpost",
      events: ["post.sent", "post.failed"],
      secret: "yp_whsec_3f1a",
      createdAt: "2026-08-26T09:24:11.412Z",
    },
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createWebhook({
    url: "https://example.com/hooks/yeetpost",
    events: ["post.sent"],
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    url: "https://example.com/hooks/yeetpost",
    events: ["post.sent"],
  });
  assert.equal(response.webhook.secret, "yp_whsec_3f1a");
});

test("createWebhook subscribes to the connection events too", async () => {
  setStubResponse(200, {
    webhook: {
      id: "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
      url: "https://example.com/hooks/yeetpost",
      events: ["connection.created", "connection.removed"],
      secret: "yp_whsec_3f1a",
      createdAt: "2026-08-29T09:24:11.412Z",
    },
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.createWebhook({
    url: "https://example.com/hooks/yeetpost",
    events: ["connection.created", "connection.removed"],
  });

  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    url: "https://example.com/hooks/yeetpost",
    events: ["connection.created", "connection.removed"],
  });
  assert.deepEqual(response.webhook.events, [
    "connection.created",
    "connection.removed",
  ]);
});

test("listWebhookDeliveries puts its filter and cursor in the query string", async () => {
  setStubResponse(200, { deliveries: [], limit: 10, hasMore: true });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.listWebhookDeliveries(
    "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
    {
      status: "dead",
      limit: 10,
      startingAfter: "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
    },
  );

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90/deliveries?status=dead&limit=10&startingAfter=9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
  );
  assert.equal(response.hasMore, true);
});

test("replayDelivery posts to the replay path and returns the delivery", async () => {
  setStubResponse(200, {
    delivery: {
      id: "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
      eventId: "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
      event: "post.sent",
      status: "pending",
      attempts: 0,
      createdAt: "2026-08-26T09:24:12.004Z",
      nextAttemptAt: "2026-08-26T11:02:41.880Z",
      deliveredAt: null,
      deadAt: null,
      lastStatusCode: null,
      lastError: null,
    },
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.replayDelivery(
    "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
    "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
  );

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90/deliveries/9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68/replay",
  );
  assert.deepEqual(response.delivery, {
    id: "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
    eventId: "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
    event: "post.sent",
    status: "pending",
    attempts: 0,
    createdAt: "2026-08-26T09:24:12.004Z",
    nextAttemptAt: "2026-08-26T11:02:41.880Z",
    deliveredAt: null,
    deadAt: null,
    lastStatusCode: null,
    lastError: null,
  });
});

test("replaying a delivery that is already queued is a YeetpostApiError", async () => {
  setStubResponse(400, {
    error: "invalid_request",
    message: "This delivery is already queued for another attempt.",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(
    () =>
      yeetpost.replayDelivery(
        "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
        "9d5c2e71-4a08-4f6b-8c1d-3b7e0a2f5c68",
      ),
    (error: unknown) => {
      assert.ok(error instanceof YeetpostApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_request");
      assert.equal(
        error.message,
        "This delivery is already queued for another attempt.",
      );
      return true;
    },
  );
});

test("sendTestEvent posts to the test path and returns the queued delivery", async () => {
  setStubResponse(200, {
    delivery: {
      id: "4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b",
      eventId: "4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b",
      event: "post.sent",
      status: "pending",
      attempts: 0,
      createdAt: "2026-08-26T09:24:12.004Z",
      nextAttemptAt: "2026-08-26T09:24:12.004Z",
      deliveredAt: null,
      deadAt: null,
      lastStatusCode: null,
      lastError: null,
    },
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.sendTestEvent(
    "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
  );

  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/webhooks/2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90/test",
  );
  assert.equal(response.delivery.status, "pending");
  assert.equal(
    response.delivery.eventId,
    "4e8b1d90-63c7-4a52-9b0f-1d2c3e4f5a6b",
  );
});

test("getHealth reads the checks behind the status", async () => {
  const health = {
    status: "degraded",
    checks: {
      database: { ok: true, latencyMs: 3 },
      scheduledPosts: {
        ok: false,
        lastRunAt: "2026-08-29T11:04:58.120Z",
        lastOkAt: null,
      },
      webhookDeliveries: {
        ok: true,
        lastRunAt: "2026-08-29T11:04:57.870Z",
        lastOkAt: "2026-08-29T11:04:57.870Z",
      },
      xUsageSweep: {
        ok: true,
        lastRunAt: "2026-08-29T11:04:31.004Z",
        lastOkAt: "2026-08-29T11:04:31.004Z",
      },
    },
    version: "2.0.0",
    time: "2026-08-29T11:05:00.512Z",
  };

  setStubResponse(200, health);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getHealth();

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(recordedRequests[0].url, "/api/v2/health");
  assert.deepEqual(response, health);
});

test("getHealthHistory puts the window in the query string", async () => {
  const history = {
    days: [
      {
        day: "2026-08-27",
        uptimePercent: null,
        samples: 0,
        degradedMinutes: 0,
      },
      {
        day: "2026-08-28",
        uptimePercent: 100,
        samples: 1440,
        degradedMinutes: 0,
      },
      {
        day: "2026-08-29",
        uptimePercent: 99.72,
        samples: 718,
        degradedMinutes: 2,
      },
    ],
  };

  setStubResponse(200, history);

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  const response = await yeetpost.getHealthHistory({ days: 3 });

  assert.equal(recordedRequests[0].url, "/api/v2/health/history?days=3");
  assert.deepEqual(response, history);
});

test("getHealthHistory sends no query string without a window", async () => {
  setStubResponse(200, { days: [] });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });
  await yeetpost.getHealthHistory();

  assert.equal(recordedRequests[0].url, "/api/v2/health/history");
});

test("getStats reads the public counts without an api key", async () => {
  const stats = {
    postsThisWeek: 1284,
    postsAllTime: 48210,
    liveConnections: 391,
    platformsLive: [
      "linkedin",
      "x",
      "bluesky",
      "mastodon",
      "reddit",
      "google_business",
    ],
    time: "2026-09-06T11:05:00.512Z",
  };

  setStubResponse(200, stats);

  const yeetpost = new Yeetpost({ apiKey: "", baseUrl });
  const response = await yeetpost.getStats();

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(recordedRequests[0].url, "/api/v2/stats");
  assert.equal(recordedRequests[0].headers["x-api-key"], undefined);
  assert.deepEqual(response, stats);
});

test("getOpenapiSpec reads the document without an api key", async () => {
  const spec = {
    openapi: "3.1.0",
    info: { title: "yeetpost API", version: "2.0.0" },
  };

  setStubResponse(200, spec);

  const yeetpost = new Yeetpost({ apiKey: "", baseUrl });
  const response = await yeetpost.getOpenapiSpec();

  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(recordedRequests[0].url, "/api/v2/openapi.json");
  assert.equal(recordedRequests[0].headers["x-api-key"], undefined);
  assert.deepEqual(response, spec);
});

test("getHealth needs no api key, and sends no x-api-key header", async () => {
  setStubResponse(200, { status: "ok" });

  const yeetpost = new Yeetpost({ apiKey: "", baseUrl });
  const response = await yeetpost.getHealth();

  assert.equal(recordedRequests[0].url, "/api/v2/health");
  assert.equal(recordedRequests[0].headers["x-api-key"], undefined);
  assert.deepEqual(response, { status: "ok" });
});

test("a call that needs a key is refused before the request goes out", async () => {
  const yeetpost = new Yeetpost({ apiKey: "", baseUrl });

  await assert.rejects(
    () => yeetpost.listConnections(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "apiKey is required for this call");
      return true;
    },
  );

  assert.equal(recordedRequests.length, 0);
});

test("an error response becomes a YeetpostApiError with its code", async () => {
  setStubResponse(400, {
    error: "invalid_connection",
    message:
      "Connection 'linkedn' not found. Available connections: linkedin, x",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(
    () => yeetpost.createPosts({ text: "hello", connectionSlugs: ["linkedn"] }),
    (error: unknown) => {
      assert.ok(error instanceof YeetpostApiError);
      assert.equal(error.name, "YeetpostApiError");
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_connection");
      assert.equal(
        error.message,
        "Connection 'linkedn' not found. Available connections: linkedin, x",
      );
      assert.equal(error.requestId, null);
      return true;
    },
  );
});

test("req_id on an error is exposed as requestId", async () => {
  setStubResponse(422, {
    error: "platform_rejected",
    message: "LinkedIn: duplicate post was detected",
    req_id: "req_12345678",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(
    () => yeetpost.postToConnection("linkedin", "hello"),
    (error: unknown) => {
      assert.ok(error instanceof YeetpostApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "platform_rejected");
      assert.equal(error.requestId, "req_12345678");
      return true;
    },
  );
});

test("the x-request-id header is read as requestId, and leads the body", async () => {
  extraHeaders = { "x-request-id": "req_from_the_header" };
  setStubResponse(422, {
    error: "platform_rejected",
    message: "LinkedIn: duplicate post was detected",
    req_id: "req_from_the_body",
  });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(
    () => yeetpost.postToConnection("linkedin", "hello"),
    (error: unknown) => {
      assert.ok(error instanceof YeetpostApiError);
      assert.equal(error.requestId, "req_from_the_header");
      return true;
    },
  );
});

test("the 429 body, which has no message, still becomes a YeetpostApiError", async () => {
  extraHeaders = {
    "x-ratelimit-limit": "60",
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": "1787653500",
  };
  setStubResponse(429, { error: "too many requests" });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(
    () => yeetpost.listPosts(),
    (error: unknown) => {
      assert.ok(error instanceof YeetpostApiError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "too many requests");
      assert.equal(error.message, "too many requests");
      assert.equal(error.requestId, null);
      assert.equal(error.rateLimitLimit, 60);
      assert.equal(error.rateLimitRemaining, 0);
      assert.equal(error.rateLimitReset, 1787653500);
      return true;
    },
  );
});

test("the rate limit fields are -1 when the response carried no headers", async () => {
  setStubResponse(401, { error: "unauthorized", message: "invalid api key" });

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(
    () => yeetpost.listPosts(),
    (error: unknown) => {
      assert.ok(error instanceof YeetpostApiError);
      assert.equal(error.rateLimitLimit, -1);
      assert.equal(error.rateLimitRemaining, -1);
      assert.equal(error.rateLimitReset, -1);
      return true;
    },
  );
});

test("an error body that is not json still becomes a YeetpostApiError", async () => {
  stubResponse = {
    status: 502,
    body: "<html>bad gateway</html>",
    contentType: "text/html",
  };

  const yeetpost = new Yeetpost({ apiKey: "yp_secret_test", baseUrl });

  await assert.rejects(
    () => yeetpost.listConnections(),
    (error: unknown) => {
      assert.ok(error instanceof YeetpostApiError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "internal_server_error");
      assert.equal(
        error.message,
        "the yeetpost api returned an error that was not json",
      );
      return true;
    },
  );
});

//
// Webhook bodies
//

test("a connection.created body narrows out of the WebhookEvent union", () => {
  const body = JSON.stringify({
    eventId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    event: "connection.created",
    timestamp: "2026-08-29T09:24:12.004Z",
    connection: {
      id: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
      profileId: acmeProfileId,
      connectSessionId,
      platformId: "linkedin",
      slug: "acme_linkedin",
    },
  });

  const event: WebhookEvent = JSON.parse(body);

  // The discriminant is what gives the body its connection: the compiler only
  // sees that field on this side of the branch
  if (event.event !== "connection.created") {
    throw new Error("the body did not narrow to connection.created");
  }

  assert.equal(event.connection.slug, "acme_linkedin");
  assert.equal(event.connection.profileId, acmeProfileId);
  // The session the account came in through, so the connection can be filed
  // against the customer the link was made for without waiting for a browser
  assert.equal(event.connection.connectSessionId, connectSessionId);
});

test("a post.sent body still carries the post, with the profile it went out for", () => {
  const body = JSON.stringify({
    eventId: "8d3f2b7c-4e1a-4c6d-9b0f-1a2b3c4d5e6f",
    event: "post.sent",
    timestamp: "2026-08-29T09:24:12.004Z",
    post: {
      id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
      connectionSlug: "acme_linkedin",
      profileId: acmeProfileId,
      text: "our new roast is out",
      status: "sent",
      url: "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
      scheduledFor: null,
      createdAt: "2026-08-29T09:24:11.412Z",
      tags: [],
      mediaCount: 0,
      threadCount: 0,
      hasFirstComment: false,
      error: null,
    },
  });

  const event: WebhookEvent = JSON.parse(body);

  if (event.event !== "post.sent") {
    throw new Error("the body did not narrow to post.sent");
  }

  assert.equal(event.post.profileId, acmeProfileId);
});

//
// Webhook signatures
//

const webhookSecret = "yp_whsec_3f1a";
const webhookBody = JSON.stringify({
  event: "post.sent",
  timestamp: "2026-08-26T09:24:12.004Z",
});

const getSignatureHeader = (body: string, timestampSeconds: number): string => {
  const signature = crypto
    .createHmac("sha256", webhookSecret)
    .update(`${timestampSeconds}.${body}`)
    .digest("hex");

  return `t=${timestampSeconds},v1=${signature}`;
};

test("a valid signature verifies", () => {
  const timestampSeconds = Math.floor(Date.now() / 1000);

  assert.equal(
    verifyWebhookSignature({
      body: webhookBody,
      signatureHeader: getSignatureHeader(webhookBody, timestampSeconds),
      secret: webhookSecret,
    }),
    true,
  );
});

test("a tampered body does not verify", () => {
  const timestampSeconds = Math.floor(Date.now() / 1000);

  assert.equal(
    verifyWebhookSignature({
      body: `${webhookBody} `,
      signatureHeader: getSignatureHeader(webhookBody, timestampSeconds),
      secret: webhookSecret,
    }),
    false,
  );
});

test("the wrong secret does not verify", () => {
  const timestampSeconds = Math.floor(Date.now() / 1000);

  assert.equal(
    verifyWebhookSignature({
      body: webhookBody,
      signatureHeader: getSignatureHeader(webhookBody, timestampSeconds),
      secret: "yp_whsec_someoneelse",
    }),
    false,
  );
});

test("an expired timestamp does not verify", () => {
  const timestampSeconds = Math.floor(Date.now() / 1000) - 400;

  assert.equal(
    verifyWebhookSignature({
      body: webhookBody,
      signatureHeader: getSignatureHeader(webhookBody, timestampSeconds),
      secret: webhookSecret,
    }),
    false,
  );
});

test("an expired timestamp verifies with a wider tolerance", () => {
  const timestampSeconds = Math.floor(Date.now() / 1000) - 400;

  assert.equal(
    verifyWebhookSignature({
      body: webhookBody,
      signatureHeader: getSignatureHeader(webhookBody, timestampSeconds),
      secret: webhookSecret,
      toleranceSeconds: 600,
    }),
    true,
  );
});

test("a malformed signature header does not verify", () => {
  assert.equal(
    verifyWebhookSignature({
      body: webhookBody,
      signatureHeader: "v1=deadbeef",
      secret: webhookSecret,
    }),
    false,
  );
});

test("a raw body buffer verifies the same as a string", () => {
  const timestampSeconds = Math.floor(Date.now() / 1000);

  assert.equal(
    verifyWebhookSignature({
      body: Buffer.from(webhookBody, "utf8"),
      signatureHeader: getSignatureHeader(webhookBody, timestampSeconds),
      secret: webhookSecret,
    }),
    true,
  );
});
