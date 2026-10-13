import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { DEFAULT_BASE_URL } from "./yeetpost.ts";

// The CLI is exercised the way a user runs it: a real child process against a
// real http server on a random port, with XDG_CONFIG_HOME pointed at a temp
// directory so the config file it writes is this test's and not yours.

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

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let stubResponse: StubResponse;
let recordedRequests: RecordedRequest[];
let baseUrl: string;
let configHome: string;

const cliPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "cli.ts",
);

const ACME_PROFILE_ID = "b2d1f0a3-5c6e-4f70-8a9b-0c1d2e3f4a5b";

// Word for word what the API attaches to a send while the account is over the
// free connection limit and the grace window is still open
const GRACE_WARNING =
  "This account has 4 connected accounts, over the free limit of 3. Subscribe or disconnect down to 3 by 2026-09-18 to keep posting.";

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on("end", () => {
    recordedRequests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers as Record<string, string>,
      body: Buffer.concat(chunks).toString("utf8"),
    });

    res.writeHead(stubResponse.status, {
      "content-type": stubResponse.contentType,
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

const runCli = async (
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<CliResult> => {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", cliPath, ...args],
    {
      env: {
        PATH: process.env.PATH ?? "",
        XDG_CONFIG_HOME: configHome,
        YEETPOST_BASE_URL: baseUrl,
        ...options.env,
      },
    },
  );

  child.stdin.end(options.stdin ?? "");

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const code = await new Promise<number>((resolve) => {
    child.on("close", (exitCode) => resolve(exitCode ?? 0));
  });

  return { code, stdout, stderr };
};

const getConfigPath = (): string =>
  path.join(configHome, "yeetpost", "config.json");

const writeConfig = (apiKey: string): void => {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify({ apiKey, baseUrl }, null, 2),
    { mode: 0o600 },
  );
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
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), "yeetpost-cli-"));
});

after(async () => {
  fs.rmSync(configHome, { recursive: true, force: true });

  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  recordedRequests = [];
  setStubResponse(200, {});
  fs.rmSync(path.join(configHome, "yeetpost"), {
    recursive: true,
    force: true,
  });
});

//
// Help and version
//

test("--help lists the ten commands", async () => {
  const result = await runCli(["--help"]);

  assert.equal(result.code, 0);

  const commandNames = [
    "login",
    "logout",
    "whoami",
    "connections",
    "post",
    "posts",
    "post:get",
    "post:cancel",
    "media:upload",
    "webhooks",
  ];

  for (const commandName of commandNames) {
    assert.equal(result.stdout.includes(`\n  ${commandName}`), true);
  }
});

test("a command's --help carries one example", async () => {
  const result = await runCli(["post", "--help"]);

  assert.equal(result.code, 0);
  assert.equal(
    result.stdout.includes(
      'yeetpost post "shipped the new api docs today" --to linkedin,x',
    ),
    true,
  );
});

test("--version prints the package version", async () => {
  const packagePath = path.join(path.dirname(cliPath), "..", "package.json");
  const { version } = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    version: string;
  };

  const result = await runCli(["--version"]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, `${version}\n`);
});

//
// login, logout, whoami
//

test("login verifies the key and stores it in a 0600 file", async () => {
  setStubResponse(200, {
    connections: [
      {
        slug: "linkedin",
        platformId: "linkedin",
        description: "Alex Doe (LinkedIn)",
      },
    ],
  });

  const result = await runCli(["login", "--base-url", baseUrl], {
    stdin: "yp_secret_abcdef0123\n",
  });

  assert.equal(result.code, 0);
  assert.equal(recordedRequests.length, 1);
  assert.equal(recordedRequests[0].url, "/api/v2/connections");
  assert.equal(
    recordedRequests[0].headers["x-api-key"],
    "yp_secret_abcdef0123",
  );

  const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as {
    apiKey: string;
    baseUrl: string;
  };

  assert.deepEqual(stored, {
    apiKey: "yp_secret_abcdef0123",
    baseUrl,
  });

  const mode = fs.statSync(getConfigPath()).mode & 0o777;
  assert.equal(mode, 0o600);

  assert.deepEqual(JSON.parse(result.stdout), {
    configPath: getConfigPath(),
    keyPrefix: "yp_secret_abcdef",
    mode: "live",
    baseUrl,
    connectionCount: 1,
  });
});

test("login stores the default base url, never the one from the environment", async () => {
  setStubResponse(200, { connections: [] });

  // YEETPOST_BASE_URL is what runCli sets, so the key is checked against the
  // stub while the file keeps the durable value
  const result = await runCli(["login"], { stdin: "yp_secret_abcdef0123\n" });

  assert.equal(result.code, 0);
  assert.equal(recordedRequests[0].url, "/api/v2/connections");

  const stored = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as {
    apiKey: string;
    baseUrl: string;
  };

  assert.deepEqual(stored, {
    apiKey: "yp_secret_abcdef0123",
    baseUrl: DEFAULT_BASE_URL,
  });
  assert.equal(JSON.parse(result.stdout).baseUrl, DEFAULT_BASE_URL);
});

test("login does not store a key the api refuses", async () => {
  setStubResponse(401, {
    error: "unauthorized",
    message: "Invalid API key.",
  });

  const result = await runCli(["login"], { stdin: "yp_secret_wrong\n" });

  assert.equal(result.code, 1);
  assert.equal(fs.existsSync(getConfigPath()), false);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: 401,
    error: "unauthorized",
    message: "Invalid API key.",
    requestId: null,
  });
});

test("logout removes the config file", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli(["logout"]);

  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(getConfigPath()), false);
  assert.deepEqual(JSON.parse(result.stdout), {
    configPath: getConfigPath(),
    wasLoggedIn: true,
  });
});

test("whoami reports the key prefix, the mode and the connection count", async () => {
  writeConfig("yp_test_0123456789abcdef");
  setStubResponse(200, {
    connections: [
      {
        slug: "sandbox",
        platformId: "sandbox",
        description: "Sandbox one (Sandbox)",
      },
    ],
  });

  const result = await runCli(["whoami"]);

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    keyPrefix: "yp_test_01234567",
    mode: "test",
    baseUrl,
    connectionCount: 1,
  });
});

test("YEETPOST_API_KEY overrides the stored key", async () => {
  writeConfig("yp_secret_stored0000");
  setStubResponse(200, { connections: [] });

  const result = await runCli(["whoami"], {
    env: { YEETPOST_API_KEY: "yp_test_fromtheenvironment" },
  });

  assert.equal(result.code, 0);
  assert.equal(
    recordedRequests[0].headers["x-api-key"],
    "yp_test_fromtheenvironment",
  );
  assert.equal(JSON.parse(result.stdout).keyPrefix, "yp_test_fromthee");
});

test("with no key at all the command is a usage error", async () => {
  const result = await runCli(["whoami"]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
  assert.equal(result.stderr.includes("no api key. run yeetpost login"), true);
});

//
// connections
//

test("connections lists the slug, platform, description, mode and profile", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, {
    connections: [
      {
        slug: "linkedin",
        platformId: "linkedin",
        description: "Alex Doe (LinkedIn)",
        profileId: null,
      },
      {
        slug: "x",
        platformId: "x",
        description: "@alexdoe (X)",
        profileId: null,
      },
      {
        slug: "acme_linkedin",
        platformId: "linkedin",
        description: "Acme Coffee (LinkedIn)",
        profileId: ACME_PROFILE_ID,
      },
      {
        slug: "sandbox",
        platformId: "sandbox",
        description: "Sandbox one (Sandbox)",
        profileId: null,
      },
    ],
  });

  const result = await runCli(["connections"]);

  assert.equal(result.code, 0);
  assert.equal(recordedRequests[0].url, "/api/v2/connections");
  assert.deepEqual(JSON.parse(result.stdout), {
    connections: [
      {
        slug: "linkedin",
        platform: "linkedin",
        description: "Alex Doe (LinkedIn)",
        mode: "live",
        profileId: null,
      },
      {
        slug: "x",
        platform: "x",
        description: "@alexdoe (X)",
        mode: "live",
        profileId: null,
      },
      {
        slug: "acme_linkedin",
        platform: "linkedin",
        description: "Acme Coffee (LinkedIn)",
        mode: "live",
        profileId: ACME_PROFILE_ID,
      },
      {
        slug: "sandbox",
        platform: "sandbox",
        description: "Sandbox one (Sandbox)",
        mode: "test",
        profileId: null,
      },
    ],
  });
});

test("connections --profile asks the api for one customer's accounts", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, {
    connections: [
      {
        slug: "acme_linkedin",
        platformId: "linkedin",
        description: "Acme Coffee (LinkedIn)",
        profileId: ACME_PROFILE_ID,
      },
    ],
  });

  const result = await runCli(["connections", "--profile", ACME_PROFILE_ID]);

  assert.equal(result.code, 0);
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/connections?profileId=${ACME_PROFILE_ID}`,
  );
  assert.equal(
    JSON.parse(result.stdout).connections[0].profileId,
    ACME_PROFILE_ID,
  );
});

test("--pretty prints a table and --quiet prints slugs only", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, {
    connections: [
      {
        slug: "linkedin",
        platformId: "linkedin",
        description: "Alex Doe (LinkedIn)",
        profileId: null,
      },
      {
        slug: "x",
        platformId: "x",
        description: "@alexdoe (X)",
        profileId: null,
      },
    ],
  });

  const pretty = await runCli(["connections", "--pretty"]);

  assert.equal(pretty.code, 0);
  assert.equal(
    pretty.stdout,
    [
      "slug      platform  description          mode  profile",
      "--------  --------  -------------------  ----  -------",
      "linkedin  linkedin  Alex Doe (LinkedIn)  live",
      "x         x         @alexdoe (X)         live",
      "",
    ].join("\n"),
  );

  const quiet = await runCli(["connections", "--quiet"]);

  assert.equal(quiet.code, 0);
  assert.equal(quiet.stdout, "linkedin\nx\n");
});

//
// post
//

test("post sends the text and the slugs, and prints one result per connection", async () => {
  writeConfig("yp_secret_abcdef0123");
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
        error: null,
      },
    ],
  });

  const result = await runCli([
    "post",
    "shipped the new api docs today",
    "--to",
    "linkedin",
  ]);

  assert.equal(result.code, 0);
  assert.equal(recordedRequests.length, 1);
  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(recordedRequests[0].url, "/api/v2/posts");
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "shipped the new api docs today",
    connectionSlugs: ["linkedin"],
  });
  assert.equal(
    JSON.parse(result.stdout).results[0].postId,
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );
});

test("post takes its text from stdin when it is not an argument", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, { results: [] });

  const result = await runCli(["post", "--to", "linkedin"], {
    stdin: "piped in from a script\n",
  });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "piped in from a script",
    connectionSlugs: ["linkedin"],
  });
});

test("post sends the schedule, the media, the thread and the first comment", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, { results: [] });

  const result = await runCli([
    "post",
    "the head post",
    "--to",
    "x,bluesky",
    "--schedule",
    "2026-09-15T15:00:00Z",
    "--media",
    "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
    "--thread",
    "second",
    "--thread",
    "third",
    "--first-comment",
    "the link is here",
    "--idempotency-key",
    "release-v2.4.0-announcement",
  ]);

  assert.equal(result.code, 0);
  assert.equal(
    recordedRequests[0].headers["idempotency-key"],
    "release-v2.4.0-announcement",
  );
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "the head post",
    connectionSlugs: ["x", "bluesky"],
    scheduledFor: "2026-09-15T15:00:00Z",
    mediaIds: ["9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d"],
    thread: ["second", "third"],
    firstComment: "the link is here",
  });
});

test("post --draft stores the post and prints the draft it made", async () => {
  writeConfig("yp_secret_abcdef0123");
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

  const result = await runCli([
    "post",
    "half an idea",
    "--to",
    "linkedin",
    "--draft",
    "--tag",
    "launch",
    "--tag",
    "q3",
  ]);

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "half an idea",
    connectionSlugs: ["linkedin"],
    isDraft: true,
    tags: ["launch", "q3"],
  });
  assert.equal(JSON.parse(result.stdout).results[0].status, "draft");
});

test("post --draft with --schedule is refused before the request goes out", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli([
    "post",
    "half an idea",
    "--to",
    "linkedin",
    "--draft",
    "--schedule",
    "2026-09-15T15:00:00Z",
  ]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
});

test("post --queue sends the queue flag and prints the slot it took", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, {
    results: [
      {
        connectionSlug: "linkedin",
        status: "scheduled",
        postId: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        url: null,
        scheduledFor: "2026-09-14T06:00:00.000Z",
        threadCount: 0,
        hasFirstComment: false,
        error: null,
      },
    ],
  });

  const result = await runCli([
    "post",
    "goes out at the next open slot",
    "--to",
    "linkedin",
    "--queue",
  ]);

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "goes out at the next open slot",
    connectionSlugs: ["linkedin"],
    queue: true,
  });
  assert.equal(
    JSON.parse(result.stdout).results[0].scheduledFor,
    "2026-09-14T06:00:00.000Z",
  );
});

test("post --queue with --schedule is refused before the request goes out", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli([
    "post",
    "goes out at the next open slot",
    "--to",
    "linkedin",
    "--queue",
    "--schedule",
    "2026-09-15T15:00:00Z",
  ]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
  assert.equal(
    result.stderr.includes("--queue cannot be combined with --schedule"),
    true,
  );
});

test("post --draft with --queue is refused before the request goes out", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli([
    "post",
    "half an idea",
    "--to",
    "linkedin",
    "--draft",
    "--queue",
  ]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
});

test("post --timezone goes out alongside a local --schedule", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, { results: [] });

  const result = await runCli([
    "post",
    "nine in the morning, wherever the office is",
    "--to",
    "linkedin",
    "--schedule",
    "2026-09-15T09:00:00",
    "--timezone",
    "Europe/Helsinki",
  ]);

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "nine in the morning, wherever the office is",
    connectionSlugs: ["linkedin"],
    scheduledFor: "2026-09-15T09:00:00",
    timezone: "Europe/Helsinki",
  });
});

test("post --timezone without --schedule is refused before the request goes out", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli([
    "post",
    "nine in the morning",
    "--to",
    "linkedin",
    "--timezone",
    "Europe/Helsinki",
  ]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
  assert.equal(
    result.stderr.includes("--timezone needs a --schedule to read"),
    true,
  );
});

test("post --timezone with a --schedule that carries an offset is refused before the request goes out", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli([
    "post",
    "nine in the morning",
    "--to",
    "linkedin",
    "--schedule",
    "2026-09-15T09:00:00+03:00",
    "--timezone",
    "Europe/Helsinki",
  ]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
  assert.equal(
    result.stderr.includes(
      "--schedule already carries a UTC offset, so --timezone must be left out",
    ),
    true,
  );
});

test("post prints the warning a send carries inside the grace window", async () => {
  writeConfig("yp_secret_abcdef0123");
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

  const result = await runCli([
    "post",
    "shipped the new api docs today",
    "--to",
    "linkedin",
    "--pretty",
  ]);

  assert.equal(result.code, 0);
  assert.equal(
    result.stdout,
    [
      "connection  status  post id                               url                                                           error  warning",
      `----------  ------  ------------------------------------  ------------------------------------------------------------  -----  ${"-".repeat(GRACE_WARNING.length)}`,
      `linkedin    sent    6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10  https://www.linkedin.com/feed/update/urn:li:share:1234567890         ${GRACE_WARNING}`,
      "",
    ].join("\n"),
  );
});

test("a --tag the api would refuse is refused before the request goes out", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli([
    "post",
    "half an idea",
    "--to",
    "linkedin",
    "--tag",
    "Launch Day",
  ]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
});

test("--to all posts to your own social connections, leaving the messaging ones and every profile out", async () => {
  writeConfig("yp_secret_abcdef0123");

  // The listing comes first, then the post, and the stub answers both
  const responses = [
    {
      connections: [
        {
          slug: "linkedin",
          platformId: "linkedin",
          description: "Alex Doe (LinkedIn)",
          profileId: null,
        },
        {
          slug: "x",
          platformId: "x",
          description: "@alexdoe (X)",
          profileId: null,
        },
        {
          slug: "team-sms",
          platformId: "sms",
          description: "+3585550000 (SMS)",
          profileId: null,
        },
        {
          slug: "newsletter",
          platformId: "email",
          description: "alex@example.com (Email)",
          profileId: null,
        },
        {
          slug: "standup",
          platformId: "slack",
          description: "#standup (Slack)",
          profileId: null,
        },
        {
          slug: "acme_linkedin",
          platformId: "linkedin",
          description: "Acme Coffee (LinkedIn)",
          profileId: ACME_PROFILE_ID,
        },
      ],
    },
    { results: [] },
  ];

  let responseIndex = 0;

  const responseServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      recordedRequests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks).toString("utf8"),
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responses[responseIndex]));
      responseIndex += 1;
    });
  });

  await new Promise<void>((resolve) => {
    responseServer.listen(0, "127.0.0.1", resolve);
  });

  const address = responseServer.address();

  if (address === null || typeof address === "string") {
    throw new Error("stub server did not get a port");
  }

  const result = await runCli(["post", "everywhere", "--to", "all"], {
    env: { YEETPOST_BASE_URL: `http://127.0.0.1:${address.port}/api/v2` },
  });

  await new Promise<void>((resolve, reject) => {
    responseServer.close((err) => (err ? reject(err) : resolve()));
  });

  assert.equal(result.code, 0);
  assert.equal(recordedRequests.length, 2);
  assert.equal(recordedRequests[0].url, "/api/v2/connections");
  assert.deepEqual(JSON.parse(recordedRequests[1].body), {
    text: "everywhere",
    connectionSlugs: ["linkedin", "x"],
  });
});

test("--to all with --profile sweeps that customer's accounts and nothing else", async () => {
  writeConfig("yp_secret_abcdef0123");

  // The api answers the filtered listing, so the customer's accounts are all
  // the CLI ever sees
  const responses = [
    {
      connections: [
        {
          slug: "acme_linkedin",
          platformId: "linkedin",
          description: "Acme Coffee (LinkedIn)",
          profileId: ACME_PROFILE_ID,
        },
        {
          slug: "acme_x",
          platformId: "x",
          description: "@acmecoffee (X)",
          profileId: ACME_PROFILE_ID,
        },
      ],
    },
    { results: [] },
  ];

  let responseIndex = 0;

  const responseServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      recordedRequests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks).toString("utf8"),
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responses[responseIndex]));
      responseIndex += 1;
    });
  });

  await new Promise<void>((resolve) => {
    responseServer.listen(0, "127.0.0.1", resolve);
  });

  const address = responseServer.address();

  if (address === null || typeof address === "string") {
    throw new Error("stub server did not get a port");
  }

  const result = await runCli(
    [
      "post",
      "our new roast is out",
      "--to",
      "all",
      "--profile",
      ACME_PROFILE_ID,
    ],
    { env: { YEETPOST_BASE_URL: `http://127.0.0.1:${address.port}/api/v2` } },
  );

  await new Promise<void>((resolve, reject) => {
    responseServer.close((err) => (err ? reject(err) : resolve()));
  });

  assert.equal(result.code, 0);
  assert.equal(recordedRequests.length, 2);
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/connections?profileId=${ACME_PROFILE_ID}`,
  );
  assert.deepEqual(JSON.parse(recordedRequests[1].body), {
    text: "our new roast is out",
    connectionSlugs: ["acme_linkedin", "acme_x"],
    profileId: ACME_PROFILE_ID,
  });
});

test("post --profile sends the profile the post goes out for", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, { results: [] });

  const result = await runCli([
    "post",
    "our new roast is out",
    "--to",
    "acme_linkedin",
    "--profile",
    ACME_PROFILE_ID,
  ]);

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(recordedRequests[0].body), {
    text: "our new roast is out",
    connectionSlugs: ["acme_linkedin"],
    profileId: ACME_PROFILE_ID,
  });
});

test("post exits 1 when every connection failed", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, {
    results: [
      {
        connectionSlug: "linkedin",
        status: "failed",
        postId: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        url: null,
        scheduledFor: null,
        threadCount: 0,
        hasFirstComment: false,
        error: {
          code: "platform_rejected",
          message: "LinkedIn: token expired",
        },
      },
      {
        connectionSlug: "x",
        status: "failed",
        postId: "0b7e4a52-9f0c-4a1c-8b3a-6d2f5b1c0e44",
        url: null,
        scheduledFor: null,
        threadCount: 0,
        hasFirstComment: false,
        error: {
          code: "platform_rejected",
          message: "X: duplicate post was detected",
        },
      },
    ],
  });

  const result = await runCli(["post", "nowhere", "--to", "linkedin,x"]);

  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).results.length, 2);
});

test("post exits 0 when one connection failed and another took it", async () => {
  writeConfig("yp_secret_abcdef0123");
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
        error: null,
      },
      {
        connectionSlug: "x",
        status: "failed",
        postId: "0b7e4a52-9f0c-4a1c-8b3a-6d2f5b1c0e44",
        url: null,
        scheduledFor: null,
        threadCount: 0,
        hasFirstComment: false,
        error: {
          code: "platform_rejected",
          message: "X: duplicate post was detected",
        },
      },
    ],
  });

  const result = await runCli(["post", "half of it", "--to", "linkedin,x"]);

  assert.equal(result.code, 0);
});

test("a --schedule that is not a timestamp is refused before the request goes out", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli([
    "post",
    "later",
    "--to",
    "linkedin",
    "--schedule",
    "tomorrow morning",
  ]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
  assert.equal(
    result.stderr.includes("--schedule must be an ISO 8601 timestamp"),
    true,
  );
});

test("post without --to is a usage error", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli(["post", "no target"]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
  assert.equal(result.stderr.includes("--to is required"), true);
});

test("an unknown flag is a usage error", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli(["posts", "--limt", "5"]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
});

test("a flag that belongs to another command is a usage error", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli(["posts", "--to", "linkedin"]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
  assert.equal(result.stderr.includes("--to is not an option of posts"), true);
});

test("--profile belongs to the three commands that read a profile", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli(["whoami", "--profile", ACME_PROFILE_ID]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
  assert.equal(
    result.stderr.includes("--profile is not an option of whoami"),
    true,
  );
});

test("connections --help says profiles themselves are an api job", async () => {
  const result = await runCli(["connections", "--help"]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes("--profile narrows the list"), true);
  assert.equal(result.stdout.includes("/profiles"), true);
});

test("posts --help says a deleted profile still answers its history", async () => {
  const result = await runCli(["posts", "--help"]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes("--profile narrows to the posts"), true);
  assert.equal(
    result.stdout.includes("A\ndeleted profile still answers"),
    true,
  );
});

test("an api error goes to stderr as json and exits 1", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(400, {
    error: "invalid_connection",
    message: "None of the given connections were found: linkedn",
  });

  const result = await runCli(["post", "hello", "--to", "linkedn"]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    status: 400,
    error: "invalid_connection",
    message: "None of the given connections were found: linkedn",
    requestId: null,
  });
});

//
// posts, post:get, post:cancel
//

test("posts puts its filters in the query string", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, { posts: [], limit: 10, offset: 0 });

  const result = await runCli([
    "posts",
    "--status",
    "scheduled",
    "--limit",
    "10",
  ]);

  assert.equal(result.code, 0);
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts?status=scheduled&limit=10",
  );
});

test("posts --connection narrows the page the api answered", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, {
    posts: [
      {
        id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
        connectionSlug: "linkedin",
        text: "one",
        status: "sent",
        url: null,
        scheduledFor: null,
        createdAt: "2026-08-26T09:24:11.412Z",
        error: null,
      },
      {
        id: "0b7e4a52-9f0c-4a1c-8b3a-6d2f5b1c0e44",
        connectionSlug: "x",
        text: "two",
        status: "sent",
        url: null,
        scheduledFor: null,
        createdAt: "2026-08-26T09:24:11.412Z",
        error: null,
      },
    ],
    limit: 25,
    offset: 0,
  });

  const result = await runCli(["posts", "--connection", "x", "--quiet"]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "0b7e4a52-9f0c-4a1c-8b3a-6d2f5b1c0e44\n");
});

test("a bad --status is refused before the request goes out", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli(["posts", "--status", "posted"]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
});

test("posts takes the draft and deleted statuses the api has", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, { posts: [], limit: 25, offset: 0 });

  const draftResult = await runCli(["posts", "--status", "draft"]);

  assert.equal(draftResult.code, 0);
  assert.equal(recordedRequests[0].url, "/api/v2/posts?status=draft");

  const deletedResult = await runCli(["posts", "--status", "deleted"]);

  assert.equal(deletedResult.code, 0);
  assert.equal(recordedRequests[1].url, "/api/v2/posts?status=deleted");
});

test("posts --tag goes on the query string once per tag", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, { posts: [], limit: 25, offset: 0 });

  const result = await runCli([
    "posts",
    "--status",
    "draft",
    "--tag",
    "launch",
    "--tag",
    "q3",
  ]);

  assert.equal(result.code, 0);
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts?status=draft&tag=launch&tag=q3",
  );
});

test("posts --profile asks the api for one customer's history", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, { posts: [], limit: 25, offset: 0 });

  const result = await runCli(["posts", "--profile", ACME_PROFILE_ID]);

  assert.equal(result.code, 0);
  assert.equal(
    recordedRequests[0].url,
    `/api/v2/posts?profileId=${ACME_PROFILE_ID}`,
  );
});

test("post:cancel prints deleted for a draft, which answers without a status", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, {
    id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    deleted: true,
  });

  const result = await runCli([
    "post:cancel",
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    "--pretty",
  ]);

  assert.equal(result.code, 0);
  assert.equal(recordedRequests[0].method, "DELETE");
  assert.equal(
    result.stdout,
    [
      "id                                    status",
      "------------------------------------  -------",
      "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10  deleted",
      "",
    ].join("\n"),
  );
});

test("post:get fetches one post by id", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, {
    post: {
      id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
      connectionSlug: "linkedin",
      text: "shipped the new api docs today",
      status: "sent",
      url: "https://www.linkedin.com/feed/update/urn:li:share:1234567890",
      scheduledFor: null,
      createdAt: "2026-08-26T09:24:11.412Z",
      error: null,
    },
  });

  const result = await runCli([
    "post:get",
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  ]);

  assert.equal(result.code, 0);
  assert.equal(recordedRequests[0].method, "GET");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/posts/6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );
  assert.equal(
    JSON.parse(result.stdout).post.id,
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  );
});

test("post:cancel deletes the scheduled post", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, {
    id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    status: "cancelled",
  });

  const result = await runCli([
    "post:cancel",
    "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  ]);

  assert.equal(result.code, 0);
  assert.equal(recordedRequests[0].method, "DELETE");
  assert.deepEqual(JSON.parse(result.stdout), {
    id: "6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
    status: "cancelled",
  });
});

test("post:get without an id is a usage error", async () => {
  writeConfig("yp_secret_abcdef0123");

  const result = await runCli(["post:get"]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
});

//
// media:upload
//

const pngBytes = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);

test("media:upload sends the bytes and prints the id", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, {
    mediaId: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
    contentType: "image/png",
    sizeBytes: pngBytes.length,
  });

  const filePath = path.join(configHome, "shot.png");
  fs.writeFileSync(filePath, pngBytes);

  const result = await runCli([
    "media:upload",
    filePath,
    "--alt",
    "the new docs page",
    "--quiet",
  ]);

  assert.equal(result.code, 0);
  assert.equal(recordedRequests[0].method, "POST");
  assert.equal(
    recordedRequests[0].url,
    "/api/v2/media?alt_text=the+new+docs+page",
  );
  assert.equal(recordedRequests[0].headers["content-type"], "image/png");
  assert.equal(result.stdout, "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d\n");
});

test("media upload is the same command written with a space", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, {
    mediaId: "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d",
    contentType: "image/png",
    sizeBytes: pngBytes.length,
  });

  const filePath = path.join(configHome, "shot.png");
  fs.writeFileSync(filePath, pngBytes);

  const result = await runCli(["media", "upload", filePath, "--quiet"]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "9b1c2d3e-4f50-4a6b-8c7d-1e2f3a4b5c6d\n");
});

test("a file that is not an image we take is a usage error", async () => {
  writeConfig("yp_secret_abcdef0123");

  const filePath = path.join(configHome, "notes.txt");
  fs.writeFileSync(filePath, "not an image");

  const result = await runCli(["media:upload", filePath]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
  assert.equal(result.stderr.includes("is not a png, jpeg, gif or webp"), true);
});

test("a path that exists but cannot be read is a usage error", async () => {
  writeConfig("yp_secret_abcdef0123");

  const directoryPath = path.join(configHome, "pictures");
  fs.mkdirSync(directoryPath, { recursive: true });

  const result = await runCli(["media:upload", directoryPath]);

  assert.equal(result.code, 2);
  assert.equal(recordedRequests.length, 0);
  assert.equal(result.stderr.includes(`could not read ${directoryPath}`), true);
});

//
// webhooks
//

test("webhooks lists the endpoints", async () => {
  writeConfig("yp_secret_abcdef0123");
  setStubResponse(200, {
    webhooks: [
      {
        id: "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
        url: "https://example.com/hooks/yeetpost",
        events: ["post.sent", "post.failed"],
        createdAt: "2026-08-26T09:24:11.412Z",
      },
    ],
  });

  const result = await runCli(["webhooks"]);

  assert.equal(result.code, 0);
  assert.equal(recordedRequests[0].url, "/api/v2/webhooks");
  assert.equal(
    JSON.parse(result.stdout).webhooks[0].id,
    "2c9a4f3b-77d1-4b0e-9f2a-8c3e1a5b7d90",
  );
});

test("--base-url beats the environment and the stored config", async () => {
  writeConfig("yp_secret_abcdef0123");

  const otherServer = http.createServer((req, res) => {
    recordedRequests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers as Record<string, string>,
      body: "",
    });

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ webhooks: [] }));
  });

  await new Promise<void>((resolve) => {
    otherServer.listen(0, "127.0.0.1", resolve);
  });

  const address = otherServer.address();

  if (address === null || typeof address === "string") {
    throw new Error("stub server did not get a port");
  }

  const result = await runCli([
    "webhooks",
    "--base-url",
    `http://127.0.0.1:${address.port}/api/v3`,
  ]);

  await new Promise<void>((resolve, reject) => {
    otherServer.close((err) => (err ? reject(err) : resolve()));
  });

  assert.equal(result.code, 0);
  assert.equal(recordedRequests.length, 1);
  assert.equal(recordedRequests[0].url, "/api/v3/webhooks");
});
