#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_BASE_URL, Yeetpost, YeetpostApiError } from "./yeetpost.ts";

// The yeetpost CLI. Ten commands, each a thin call into the client in
// yeetpost.ts: nothing here speaks HTTP. Output is JSON on stdout by default,
// so an agent or a pipe can read it without parsing a table.
//
// Profiles have no command of their own. Creating and deleting one is a
// platform-builder job, done from the server that owns the api key, so the CLI
// carries only the reading end of them: --profile on connections, post and
// posts.

//
// Config
//

interface StoredConfig {
  apiKey: string;
  baseUrl: string;
}

const getConfigPath = (): string => {
  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");

  return path.join(configHome, "yeetpost", "config.json");
};

const readStoredConfig = (): StoredConfig | null => {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return null;
  }

  const fileContents = fs.readFileSync(configPath, "utf8");

  let parsed: unknown = null;

  try {
    parsed = JSON.parse(fileContents);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  // The file is whatever is on disk, so every field is checked below rather
  // than trusted: the cast only says "an object with these two keys, maybe"
  const config = parsed as { apiKey?: unknown; baseUrl?: unknown };

  if (typeof config.apiKey !== "string") {
    return null;
  }

  return {
    apiKey: config.apiKey,
    baseUrl:
      typeof config.baseUrl === "string" ? config.baseUrl : DEFAULT_BASE_URL,
  };
};

const writeStoredConfig = (config: StoredConfig): string => {
  const configPath = getConfigPath();

  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });

  // writeFileSync only applies mode when it creates the file, so an existing
  // one keeps whatever permissions it had. The key is in there either way.
  fs.chmodSync(configPath, 0o600);

  return configPath;
};

//
// Errors
//

// Anything the caller typed wrong. Exit code 2, so a script can tell a bad
// command line from an API that said no.
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

//
// Output
//

interface OutputMode {
  isPretty: boolean;
  isQuiet: boolean;
}

// Every command builds all three shapes and lets the flags pick one.
interface CommandOutput {
  json: unknown;
  ids: string[];
  table: {
    headers: string[];
    rows: string[][];
  };
}

const printTable = (headers: string[], rows: string[][]): void => {
  if (rows.length === 0) {
    process.stdout.write("nothing to show\n");
    return;
  }

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );

  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join("  ")
      .trimEnd();

  process.stdout.write(`${renderRow(headers)}\n`);
  process.stdout.write(
    `${widths.map((width) => "-".repeat(width)).join("  ")}\n`,
  );

  for (const row of rows) {
    process.stdout.write(`${renderRow(row)}\n`);
  }
};

const printOutput = (output: CommandOutput, mode: OutputMode): void => {
  if (mode.isQuiet) {
    for (const id of output.ids) {
      process.stdout.write(`${id}\n`);
    }
    return;
  }

  if (mode.isPretty) {
    printTable(output.table.headers, output.table.rows);
    return;
  }

  process.stdout.write(`${JSON.stringify(output.json, null, 2)}\n`);
};

//
// Help
//

const commandHelp: Record<
  string,
  { usage: string; summary: string; example: string; note?: string }
> = {
  login: {
    usage: "yeetpost login [--base-url <url>]",
    summary: "Store an API key, after checking it against the API",
    example: "yeetpost login",
  },
  logout: {
    usage: "yeetpost logout",
    summary: "Forget the stored API key",
    example: "yeetpost logout",
  },
  whoami: {
    usage: "yeetpost whoami",
    summary: "Which key, which mode, which base url, how many connections",
    example: "yeetpost whoami --pretty",
  },
  connections: {
    usage: "yeetpost connections [--profile <id>]",
    summary: "What you can post to",
    example: "yeetpost connections --pretty",
    note:
      "--profile narrows the list to one end customer's accounts. The profiles\n" +
      "themselves are a platform-builder concern, so they are created, renamed\n" +
      "and deleted through the api rather than here: POST, PATCH and DELETE on\n" +
      "/profiles, or createProfile and friends in an sdk.",
  },
  post: {
    usage:
      'yeetpost post "text" --to <slug,slug|all> [--profile <id>]\n' +
      "  [--schedule <iso> [--timezone <zone>] | --queue | --draft]\n" +
      "  [--media <id>]... [--thread <text>]... [--first-comment <text>]\n" +
      "  [--tag <tag>]... [--idempotency-key <key>]",
    summary: "Post text to one or more connections, now, later or as a draft",
    example: 'yeetpost post "shipped the new api docs today" --to linkedin,x',
    note:
      "Exit 0 when at least one connection took the post, 1 when every one of\n" +
      "them failed. A partial failure is still 0, so read the per-item status.\n" +
      "--queue takes each connection's next free posting slot instead of a\n" +
      "time, and --timezone names the clock a --schedule with no offset is read\n" +
      "on. --draft stores the post and publishes nothing: publish it from the\n" +
      "api or an sdk, with POST /posts/{postId}/publish.\n" +
      "--profile posts for one end customer, and every slug has to be one of\n" +
      "that profile's. Without it every slug has to be one of your own.\n" +
      "There is no --rewrite flag here: AI polish follows the connection's own\n" +
      "mode (and the account's default when the connection has none). Set it\n" +
      "per post with the api or an sdk's rewrite parameter.",
  },
  posts: {
    usage:
      "yeetpost posts [--limit <n>] [--status <status>] [--connection <slug>]\n" +
      "  [--profile <id>] [--tag <tag>]...",
    summary: "Your posts, newest first",
    example: "yeetpost posts --status draft --tag launch",
    note:
      "--profile narrows to the posts that went out for one end customer. A\n" +
      "deleted profile still answers here, so a customer you have offboarded\n" +
      "keeps its history.",
  },
  "post:get": {
    usage: "yeetpost post:get <id>",
    summary: "One post by id",
    example: "yeetpost post:get 6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  },
  "post:cancel": {
    usage: "yeetpost post:cancel <id>",
    summary:
      "Cancel a scheduled post, throw a draft away, or delete a published one",
    example: "yeetpost post:cancel 6f1b0c8a-1f3d-4d3e-9a2b-2f5a1c9e7d10",
  },
  "media:upload": {
    usage: 'yeetpost media:upload <file> [--alt "description"]',
    summary: "Upload an image and print the id you attach to a post",
    example: 'yeetpost media:upload ./shot.png --alt "the new docs page"',
  },
  webhooks: {
    usage: "yeetpost webhooks",
    summary: "Your webhook endpoints (register and delete them in the console)",
    example: "yeetpost webhooks --pretty",
  },
};

const getVersion = (): string => {
  const packagePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "package.json",
  );
  // package.json is ours, but JSON.parse answers unknown, so the version is
  // read as unknown and checked before it is printed
  const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    version?: unknown;
  };

  if (typeof parsed.version !== "string") {
    return "unknown";
  }

  return parsed.version;
};

const getTopLevelHelp = (): string => {
  const commandNames = Object.keys(commandHelp);
  const width = Math.max(...commandNames.map((name) => name.length));

  const commandLines = commandNames
    .map((name) => `  ${name.padEnd(width)}  ${commandHelp[name].summary}`)
    .join("\n");

  return [
    "yeetpost <command> [options]",
    "",
    "Commands:",
    commandLines,
    "",
    "Options:",
    "  --pretty              A table for a human, instead of json",
    "  --quiet               Ids only, one per line",
    "  --base-url <url>      Point at a self-hosted api or the sandbox",
    "  --help                This, or one example for a command",
    "  --version             Print the package version",
    "",
    "Output is json on stdout by default, one object or array, so an agent or",
    "a pipe can read it. Exit 0 on success, 1 on an api error (the error body",
    "goes to stderr as json), 2 when the command line is wrong.",
    "",
    "Environment: YEETPOST_API_KEY overrides the stored key, YEETPOST_BASE_URL",
    "overrides the stored base url, XDG_CONFIG_HOME moves the config file.",
    "",
    "yeetpost <command> --help for one example each.",
  ].join("\n");
};

const getCommandHelp = (commandName: string): string => {
  const help = commandHelp[commandName];

  const lines = [
    help.summary,
    "",
    "Usage:",
    `  ${help.usage}`,
    "",
    "Example:",
    `  ${help.example}`,
  ];

  if (help.note) {
    lines.push("", help.note);
  }

  return lines.join("\n");
};

//
// Client
//

interface CommandContext {
  values: {
    "base-url"?: string;
    to?: string;
    schedule?: string;
    timezone?: string;
    queue?: boolean;
    media?: string[];
    thread?: string[];
    "first-comment"?: string;
    draft?: boolean;
    tag?: string[];
    "idempotency-key"?: string;
    limit?: string;
    status?: string;
    connection?: string;
    profile?: string;
    alt?: string;
  };
  positionals: string[];
  mode: OutputMode;
}

const getBaseUrl = (
  storedConfig: StoredConfig | null,
  baseUrlOption: string | undefined,
): string => {
  if (baseUrlOption) {
    return baseUrlOption;
  }

  if (process.env.YEETPOST_BASE_URL) {
    return process.env.YEETPOST_BASE_URL;
  }

  if (storedConfig) {
    return storedConfig.baseUrl;
  }

  return DEFAULT_BASE_URL;
};

const getApiKey = (storedConfig: StoredConfig | null): string => {
  if (process.env.YEETPOST_API_KEY) {
    return process.env.YEETPOST_API_KEY;
  }

  if (storedConfig) {
    return storedConfig.apiKey;
  }

  throw new UsageError(
    "no api key. run yeetpost login, or set YEETPOST_API_KEY",
  );
};

const getClient = (context: CommandContext): Yeetpost => {
  const storedConfig = readStoredConfig();

  return new Yeetpost({
    apiKey: getApiKey(storedConfig),
    baseUrl: getBaseUrl(storedConfig, context.values["base-url"]),
  });
};

// A test key is told apart by its prefix alone, the same way the API tells
// them apart.
const getKeyMode = (apiKey: string): "live" | "test" => {
  if (apiKey.startsWith("yp_test_")) {
    return "test";
  }

  return "live";
};

// Enough of the key to recognise which one it is, never enough to use it.
const getKeyPrefix = (apiKey: string): string => apiKey.slice(0, 16);

//
// Connections
//

// Email, SMS and Slack are messaging channels, not places you broadcast to, so
// "--to all" leaves them out. Same rule as the quickstart: a copy-and-run
// example must never text a real person. The API draws the same line in
// usageMetricByPlatformId in yeetpost-api/src/lib/platforms.ts, where these
// three are the "message" ones.
const MESSAGING_PLATFORM_IDS = ["sms", "email", "slack"];

// "all" means the accounts the post can actually reach: one end customer's
// when --profile named one, and your own when it did not. A post that names no
// profile can only reach the connections outside every profile, so sweeping a
// customer's in would fail every one of those items.
const getAllSocialSlugs = async (
  yeetpost: Yeetpost,
  profileId: string | undefined,
): Promise<string[]> => {
  const { connections } = await yeetpost.listConnections({ profileId });

  const reachableConnections = profileId
    ? connections
    : connections.filter((connection) => connection.profileId === null);

  const socialSlugs = reachableConnections
    .filter(
      (connection) => !MESSAGING_PLATFORM_IDS.includes(connection.platformId),
    )
    .map((connection) => connection.slug);

  if (socialSlugs.length === 0) {
    throw new UsageError("--to all found no social connections to post to");
  }

  return socialSlugs;
};

//
// Input
//

const readFirstStdinLine = async (): Promise<string> => {
  const lines = readline.createInterface({ input: process.stdin });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();

  lines.close();

  if (first.done) {
    return "";
  }

  return first.value.trim();
};

const readMaskedApiKey = async (): Promise<string> => {
  // Piped input is a script handing us a key, and there is no terminal to mask
  if (!process.stdin.isTTY) {
    return readFirstStdinLine();
  }

  let isMuted = false;

  const maskedOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!isMuted) {
        process.stdout.write(chunk, encoding);
      }
      callback();
    },
  });

  const prompt = readline.createInterface({
    input: process.stdin,
    output: maskedOutput,
    terminal: true,
  });

  process.stdout.write("api key: ");
  isMuted = true;

  const apiKey = await prompt.question("");

  isMuted = false;
  prompt.close();
  process.stdout.write("\n");

  return apiKey.trim();
};

const readStdinText = async (): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").trim();
};

// The API checks the bytes against the content type it was sent as, so the
// type comes from the file signature rather than from its name.
const getImageContentType = (
  bytes: Buffer,
): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null => {
  const header = bytes.subarray(0, 12);

  if (header.subarray(0, 4).toString("hex") === "89504e47") {
    return "image/png";
  }

  if (header.subarray(0, 3).toString("hex") === "ffd8ff") {
    return "image/jpeg";
  }

  if (header.subarray(0, 3).toString("latin1") === "GIF") {
    return "image/gif";
  }

  if (
    header.subarray(0, 4).toString("latin1") === "RIFF" &&
    header.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
};

const POST_STATUSES = [
  "sent",
  "scheduled",
  "processing",
  "draft",
  "failed",
  "cancelled",
  "deleted",
];

// A tag is what the API takes: lowercase letters, digits, dashes,
// underscores, colons, dots and slashes, 1 to 40 characters. The API
// lowercases and trims before checking, so this does the same and passes the
// normalized tag through. Checking it here turns a typo into an exit 2 with a
// message, rather than a 400 the caller has to read out of the error body.
const TAG_PATTERN = /^[a-z0-9:_./-]{1,40}$/;

const getTags = (tagOptions: string[] | undefined): string[] | undefined => {
  if (tagOptions === undefined) {
    return undefined;
  }

  return tagOptions.map((tag) => {
    const normalizedTag = tag.trim().toLowerCase();

    if (!TAG_PATTERN.test(normalizedTag)) {
      throw new UsageError(
        `--tag ${tag} must be 1 to 40 characters of lowercase letters, digits, dashes, underscores, colons, dots and slashes`,
      );
    }

    return normalizedTag;
  });
};

const getLimit = (limitOption: string | undefined): number | undefined => {
  if (limitOption === undefined) {
    return undefined;
  }

  const limit = Number(limitOption);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new UsageError("--limit must be a whole number between 1 and 100");
  }

  return limit;
};

// The same pattern the API reads an offset with: a trailing Z or +HH:MM. A
// schedule that has one has named an instant, so there is no clock to read it
// on.
const UTC_OFFSET_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/;

const hasUtcOffset = (scheduledFor: string): boolean =>
  UTC_OFFSET_PATTERN.test(scheduledFor);

const getScheduledFor = (
  scheduleOption: string | undefined,
): string | undefined => {
  if (scheduleOption === undefined) {
    return undefined;
  }

  if (Number.isNaN(Date.parse(scheduleOption))) {
    throw new UsageError(
      "--schedule must be an ISO 8601 timestamp, for example 2026-09-15T15:00:00Z",
    );
  }

  return scheduleOption;
};

//
// Commands
//

const runLogin = async (context: CommandContext): Promise<void> => {
  const storedConfig = readStoredConfig();
  const baseUrl = getBaseUrl(storedConfig, context.values["base-url"]);
  const apiKey = await readMaskedApiKey();

  if (!apiKey) {
    throw new UsageError("no api key given");
  }

  // The key is only stored once the API has agreed it is a key
  const yeetpost = new Yeetpost({ apiKey, baseUrl });
  const { connections } = await yeetpost.listConnections();

  // YEETPOST_BASE_URL is ambient: it can point the check at a sandbox for one
  // shell, and writing it to the file would outlive that shell. What is stored
  // is what --base-url said, or the default.
  const storedBaseUrl = context.values["base-url"] ?? DEFAULT_BASE_URL;
  const configPath = writeStoredConfig({ apiKey, baseUrl: storedBaseUrl });

  printOutput(
    {
      json: {
        configPath,
        keyPrefix: getKeyPrefix(apiKey),
        mode: getKeyMode(apiKey),
        baseUrl: storedBaseUrl,
        connectionCount: connections.length,
      },
      ids: [],
      table: {
        headers: ["key", "mode", "base url", "connections", "config"],
        rows: [
          [
            getKeyPrefix(apiKey),
            getKeyMode(apiKey),
            storedBaseUrl,
            String(connections.length),
            configPath,
          ],
        ],
      },
    },
    context.mode,
  );
};

const runLogout = (context: CommandContext): void => {
  const configPath = getConfigPath();
  const wasLoggedIn = fs.existsSync(configPath);

  if (wasLoggedIn) {
    fs.rmSync(configPath);
  }

  printOutput(
    {
      json: { configPath, wasLoggedIn },
      ids: [],
      table: {
        headers: ["config", "was logged in"],
        rows: [[configPath, String(wasLoggedIn)]],
      },
    },
    context.mode,
  );
};

const runWhoami = async (context: CommandContext): Promise<void> => {
  const storedConfig = readStoredConfig();
  const apiKey = getApiKey(storedConfig);
  const baseUrl = getBaseUrl(storedConfig, context.values["base-url"]);

  const yeetpost = new Yeetpost({ apiKey, baseUrl });
  const { connections } = await yeetpost.listConnections();

  printOutput(
    {
      json: {
        keyPrefix: getKeyPrefix(apiKey),
        mode: getKeyMode(apiKey),
        baseUrl,
        connectionCount: connections.length,
      },
      ids: [getKeyPrefix(apiKey)],
      table: {
        headers: ["key", "mode", "base url", "connections"],
        rows: [
          [
            getKeyPrefix(apiKey),
            getKeyMode(apiKey),
            baseUrl,
            String(connections.length),
          ],
        ],
      },
    },
    context.mode,
  );
};

const runConnections = async (context: CommandContext): Promise<void> => {
  const yeetpost = getClient(context);
  const { connections } = await yeetpost.listConnections({
    profileId: context.values.profile,
  });

  // A sandbox connection is the one a test key reaches, so that is its mode.
  // profileId is the end customer the account was connected for, and null when
  // it is one of your own.
  const items = connections.map((connection) => ({
    slug: connection.slug,
    platform: connection.platformId,
    description: connection.description,
    mode: connection.platformId === "sandbox" ? "test" : "live",
    profileId: connection.profileId,
  }));

  printOutput(
    {
      json: { connections: items },
      ids: items.map((item) => item.slug),
      table: {
        headers: ["slug", "platform", "description", "mode", "profile"],
        rows: items.map((item) => [
          item.slug,
          item.platform,
          item.description,
          item.mode,
          item.profileId ?? "",
        ]),
      },
    },
    context.mode,
  );
};

const runPost = async (context: CommandContext): Promise<void> => {
  const { values, positionals, mode } = context;

  if (!values.to) {
    throw new UsageError("--to is required: slugs, or all");
  }

  // The API refuses these pairs, and saying so here saves a round trip
  if (values.draft && values.schedule) {
    throw new UsageError("--draft cannot be combined with --schedule");
  }

  if (values.draft && values.queue) {
    throw new UsageError("--draft cannot be combined with --queue");
  }

  if (values.queue && values.schedule) {
    throw new UsageError("--queue cannot be combined with --schedule");
  }

  // A timezone is only ever read against a schedule, so on its own it is a
  // typo rather than an instruction
  if (values.timezone && !values.schedule) {
    throw new UsageError("--timezone needs a --schedule to read");
  }

  const scheduledFor = getScheduledFor(values.schedule);

  // A schedule that already carries an offset is an instant, and the API
  // refuses a timezone alongside one rather than guessing which clock wins
  if (values.timezone && scheduledFor && hasUtcOffset(scheduledFor)) {
    throw new UsageError(
      "--schedule already carries a UTC offset, so --timezone must be left out",
    );
  }
  const tags = getTags(values.tag);

  // Nothing is piped at a terminal, so waiting on stdin there would just hang
  if (!positionals[0] && process.stdin.isTTY) {
    throw new UsageError("no text: pass it as an argument or on stdin");
  }

  const text = positionals[0] ?? (await readStdinText());

  if (!text) {
    throw new UsageError("no text: pass it as an argument or on stdin");
  }

  const yeetpost = getClient(context);

  const connectionSlugs =
    values.to === "all"
      ? await getAllSocialSlugs(yeetpost, values.profile)
      : values.to
          .split(",")
          .map((slug) => slug.trim())
          .filter((slug) => slug.length > 0);

  if (connectionSlugs.length === 0) {
    throw new UsageError("--to named no connections");
  }

  const response = await yeetpost.createPosts({
    text,
    connectionSlugs,
    profileId: values.profile,
    scheduledFor,
    timezone: values.timezone,
    queue: values.queue,
    mediaIds: values.media,
    thread: values.thread,
    firstComment: values["first-comment"],
    isDraft: values.draft,
    tags,
    idempotencyKey: values["idempotency-key"],
  });

  // A warning is the API saying the post went out this time and the next one
  // will not: it belongs in the table, not only in the json
  printOutput(
    {
      json: response,
      ids: response.results
        .map((result) => result.postId)
        .filter((postId) => postId !== null),
      table: {
        headers: ["connection", "status", "post id", "url", "error", "warning"],
        rows: response.results.map((result) => [
          result.connectionSlug,
          result.status,
          result.postId ?? "",
          result.url ?? "",
          result.error ? `${result.error.code}: ${result.error.message}` : "",
          result.warning ?? "",
        ]),
      },
    },
    mode,
  );

  // One connection failing is a failed item, not a failed command, so a partial
  // failure still exits 0. Nothing landing anywhere is a failed command.
  const hasEveryConnectionFailed =
    response.results.length > 0 &&
    response.results.every((result) => result.status === "failed");

  if (hasEveryConnectionFailed) {
    process.exitCode = 1;
  }
};

const runPosts = async (context: CommandContext): Promise<void> => {
  const { values, mode } = context;

  if (values.status && !POST_STATUSES.includes(values.status)) {
    throw new UsageError(`--status must be one of ${POST_STATUSES.join(", ")}`);
  }

  const yeetpost = getClient(context);

  // GET /posts has no connection filter, so --connection narrows the page the
  // API answered rather than asking for a filtered one
  // The guard above is what narrows the string to the client's union, and the
  // compiler cannot see that through an includes() call
  const response = await yeetpost.listPosts({
    status: values.status as
      | "sent"
      | "scheduled"
      | "processing"
      | "draft"
      | "failed"
      | "cancelled"
      | "deleted"
      | undefined,
    tag: getTags(values.tag),
    profileId: values.profile,
    limit: getLimit(values.limit),
  });

  const posts = values.connection
    ? response.posts.filter((post) => post.connectionSlug === values.connection)
    : response.posts;

  printOutput(
    {
      json: { posts, limit: response.limit, offset: response.offset },
      ids: posts.map((post) => post.id),
      table: {
        headers: ["id", "connection", "status", "created", "text"],
        rows: posts.map((post) => [
          post.id,
          post.connectionSlug,
          post.status,
          post.createdAt,
          post.text.replace(/\s+/g, " ").slice(0, 48),
        ]),
      },
    },
    mode,
  );
};

const runPostGet = async (context: CommandContext): Promise<void> => {
  const postId = context.positionals[0];

  if (!postId) {
    throw new UsageError("post:get needs a post id");
  }

  const yeetpost = getClient(context);
  const { post } = await yeetpost.getPost(postId);

  printOutput(
    {
      json: { post },
      ids: [post.id],
      table: {
        headers: ["id", "connection", "status", "url", "text"],
        rows: [
          [
            post.id,
            post.connectionSlug,
            post.status,
            post.url ?? "",
            post.text.replace(/\s+/g, " ").slice(0, 48),
          ],
        ],
      },
    },
    context.mode,
  );
};

const runPostCancel = async (context: CommandContext): Promise<void> => {
  const postId = context.positionals[0];

  if (!postId) {
    throw new UsageError("post:cancel needs a post id");
  }

  const yeetpost = getClient(context);
  const response = await yeetpost.deletePost(postId);

  // One endpoint, three shapes: a scheduled post comes back cancelled, one that
  // went out comes back deleted with a deletedAt, and a draft comes back as
  // deleted: true with no status at all, because it left no record behind.
  const status = "status" in response ? response.status : "deleted";

  printOutput(
    {
      json: response,
      ids: [response.id],
      table: {
        headers: ["id", "status"],
        rows: [[response.id, status]],
      },
    },
    context.mode,
  );
};

const runMediaUpload = async (context: CommandContext): Promise<void> => {
  const filePath = context.positionals[0];

  if (!filePath) {
    throw new UsageError("media:upload needs a file");
  }

  if (!fs.existsSync(filePath)) {
    throw new UsageError(`no such file: ${filePath}`);
  }

  // A directory, or a file we may not read, exists but cannot be uploaded
  let bytes: Buffer;

  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    throw new UsageError(`could not read ${filePath}`);
  }

  const contentType = getImageContentType(bytes);

  if (!contentType) {
    throw new UsageError(`${filePath} is not a png, jpeg, gif or webp`);
  }

  const yeetpost = getClient(context);
  const media = await yeetpost.uploadMedia({
    bytes,
    contentType,
    altText: context.values.alt,
  });

  printOutput(
    {
      json: media,
      ids: [media.mediaId],
      table: {
        headers: ["media id", "content type", "bytes"],
        rows: [[media.mediaId, media.contentType, String(media.sizeBytes)]],
      },
    },
    context.mode,
  );
};

const runWebhooks = async (context: CommandContext): Promise<void> => {
  const yeetpost = getClient(context);
  const { webhooks } = await yeetpost.listWebhooks();

  printOutput(
    {
      json: { webhooks },
      ids: webhooks.map((webhook) => webhook.id),
      table: {
        headers: ["id", "url", "events", "created"],
        rows: webhooks.map((webhook) => [
          webhook.id,
          webhook.url,
          webhook.events.join(","),
          webhook.createdAt,
        ]),
      },
    },
    context.mode,
  );
};

//
// Entry point
//

// One option table for every command, so the parser stays a single call.
// parseArgs refuses a flag that is not in here at all; allowedOptionsByCommand
// below refuses a flag that is real but belongs to another command.
const options = {
  pretty: { type: "boolean" },
  quiet: { type: "boolean" },
  help: { type: "boolean" },
  version: { type: "boolean" },
  "base-url": { type: "string" },
  to: { type: "string" },
  schedule: { type: "string" },
  timezone: { type: "string" },
  queue: { type: "boolean" },
  media: { type: "string", multiple: true },
  thread: { type: "string", multiple: true },
  "first-comment": { type: "string" },
  draft: { type: "boolean" },
  tag: { type: "string", multiple: true },
  "idempotency-key": { type: "string" },
  limit: { type: "string" },
  status: { type: "string" },
  connection: { type: "string" },
  profile: { type: "string" },
  alt: { type: "string" },
} as const;

// These say how to reach the api and how to print the answer, so every command
// takes them.
const GLOBAL_OPTIONS = ["pretty", "quiet", "base-url", "help", "version"];

const allowedOptionsByCommand: Record<string, string[]> = {
  login: [],
  logout: [],
  whoami: [],
  connections: ["profile"],
  post: [
    "to",
    "profile",
    "schedule",
    "timezone",
    "queue",
    "media",
    "thread",
    "first-comment",
    "draft",
    "tag",
    "idempotency-key",
  ],
  posts: ["limit", "status", "connection", "profile", "tag"],
  "post:get": [],
  "post:cancel": [],
  "media:upload": ["alt"],
  webhooks: [],
};

const assertOptionsAreAllowed = (
  commandName: string,
  values: Record<string, unknown>,
): void => {
  const allowedOptions = allowedOptionsByCommand[commandName];

  // An unknown command is runCommand's error to raise
  if (!allowedOptions) {
    return;
  }

  for (const optionName of Object.keys(values)) {
    if (GLOBAL_OPTIONS.includes(optionName)) {
      continue;
    }

    if (allowedOptions.includes(optionName)) {
      continue;
    }

    throw new UsageError(`--${optionName} is not an option of ${commandName}`);
  }
};

const runCommand = async (
  commandName: string,
  context: CommandContext,
): Promise<void> => {
  if (commandName === "login") {
    return runLogin(context);
  }

  if (commandName === "logout") {
    return runLogout(context);
  }

  if (commandName === "whoami") {
    return runWhoami(context);
  }

  if (commandName === "connections") {
    return runConnections(context);
  }

  if (commandName === "post") {
    return runPost(context);
  }

  if (commandName === "posts") {
    return runPosts(context);
  }

  if (commandName === "post:get") {
    return runPostGet(context);
  }

  if (commandName === "post:cancel") {
    return runPostCancel(context);
  }

  if (commandName === "media:upload") {
    return runMediaUpload(context);
  }

  if (commandName === "webhooks") {
    return runWebhooks(context);
  }

  throw new UsageError(`unknown command: ${commandName}`);
};

const main = async (): Promise<void> => {
  // parseArgs throws on a flag that is not in the table, which is the caller's
  // typo rather than ours
  let parsed: {
    values: CommandContext["values"] & {
      pretty?: boolean;
      quiet?: boolean;
      help?: boolean;
      version?: boolean;
    };
    positionals: string[];
  };

  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (error: unknown) {
    throw new UsageError(
      error instanceof Error ? error.message : "could not read the arguments",
    );
  }

  const { values } = parsed;

  if (values.version) {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }

  let commandName = parsed.positionals[0] ?? "";
  let positionals = parsed.positionals.slice(1);

  // "media upload" is the spelling the docs use for media:upload
  if (commandName === "media" && positionals[0] === "upload") {
    commandName = "media:upload";
    positionals = positionals.slice(1);
  }

  if (!commandName) {
    process.stdout.write(`${getTopLevelHelp()}\n`);
    return;
  }

  if (values.help) {
    if (!commandHelp[commandName]) {
      throw new UsageError(`unknown command: ${commandName}`);
    }

    process.stdout.write(`${getCommandHelp(commandName)}\n`);
    return;
  }

  assertOptionsAreAllowed(commandName, values);

  await runCommand(commandName, {
    values,
    positionals,
    mode: {
      isPretty: values.pretty === true,
      isQuiet: values.quiet === true,
    },
  });
};

main().catch((error: unknown) => {
  if (error instanceof YeetpostApiError) {
    process.stderr.write(
      `${JSON.stringify(
        {
          status: error.status,
          error: error.code,
          message: error.message,
          requestId: error.requestId,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`);
    process.stderr.write("yeetpost --help for the ten commands\n");
    process.exitCode = 2;
    return;
  }

  process.stderr.write(
    `${error instanceof Error ? error.message : "something went wrong"}\n`,
  );
  process.exitCode = 1;
});
