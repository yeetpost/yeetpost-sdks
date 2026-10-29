#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type AddSourceItemsParams,
  DEFAULT_BASE_URL,
  type GetSourceResponse,
  Yeetpost,
  YeetpostApiError,
} from "./yeetpost.ts";

// The yeetpost CLI. The commands are each a thin call into the client in
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
      "yeetpost posts [--limit <n>] [--offset <n>] [--status <status>]\n" +
      "  [--connection <slug>] [--profile <id>] [--tag <tag>]...\n" +
      "  [--created-after <time>] [--created-before <time>] [--sort <order>]",
    summary: "Your posts, newest first",
    example: "yeetpost posts --status draft --tag launch",
    note:
      "--profile narrows to the posts that went out for one end customer. A\n" +
      "deleted profile still answers here, so a customer you have offboarded\n" +
      "keeps its history.\n" +
      "--created-after and --created-before take ISO 8601 timestamps, both\n" +
      "inclusive. --sort is created_desc (the default), created_asc,\n" +
      "scheduled_desc or scheduled_asc. Page with --offset; the json answer has\n" +
      "total, hasMore and nextOffset.",
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
  sources: {
    usage: "yeetpost sources [--limit <n>] [--offset <n>]",
    summary: "The links yeetpost watches to post what is new",
    example: "yeetpost sources --pretty",
    note:
      "The commands that act on a source are spelled sources:<action>, or\n" +
      "yeetpost sources <action>: preview, create, get, update, delete, check,\n" +
      "items, push and retry. yeetpost sources:create --help has the details.\n" +
      "Sources post for real, so they need a live key.",
  },
  "sources:preview": {
    usage: "yeetpost sources:preview <url>",
    summary: "See what yeetpost finds at a link before saving anything",
    example: "yeetpost sources:preview https://herizon.io/courses",
    note:
      "The link can be a page that lists things, an RSS, Atom or JSON feed, or a\n" +
      "sitemap. Prints the kind, the item count and the newest 5 items.",
  },
  "sources:create": {
    usage:
      "yeetpost sources:create <url> --to <slug,slug> --mode <queue|draft>\n" +
      '  [--instructions "text"] [--name <name>] [--no-card] [--backfill <n>]\n' +
      "  [--profile <id>]\n" +
      "yeetpost sources:create --push --to <slug,slug> --mode <queue|draft>",
    summary: "Watch a link and post what is new into your connections",
    example:
      'yeetpost sources:create https://herizon.io/courses --to herizon_linkedin --mode queue --instructions "one post per course"',
    note:
      "Each new item becomes a post per connection, in its voice and look, in\n" +
      "the queue or as a draft. Items already on the page are not posted unless\n" +
      "--backfill asks for the newest few (0 to 20). --push makes a source an app\n" +
      "fills itself, with sources:push.",
  },
  "sources:get": {
    usage: "yeetpost sources:get <id>",
    summary: "One source with its status, last error and item counts",
    example: "yeetpost sources:get 7d1f0c52-3a8e-4d6b-9c41-0b2e5a9f1c33",
  },
  "sources:update": {
    usage:
      "yeetpost sources:update <id> [--to <slug,slug>] [--mode <queue|draft>]\n" +
      '  [--instructions "text"] [--card | --no-card] [--status <active|paused>]',
    summary:
      "Change a source's connections, mode, instructions or card, or pause it",
    example:
      "yeetpost sources:update 7d1f0c52-3a8e-4d6b-9c41-0b2e5a9f1c33 --status paused",
  },
  "sources:delete": {
    usage: "yeetpost sources:delete <id>",
    summary: "Stop watching a link; the posts it already made are not touched",
    example: "yeetpost sources:delete 7d1f0c52-3a8e-4d6b-9c41-0b2e5a9f1c33",
  },
  "sources:check": {
    usage: "yeetpost sources:check <id>",
    summary: "Check a source now and print the new items it found",
    example: "yeetpost sources:check 7d1f0c52-3a8e-4d6b-9c41-0b2e5a9f1c33",
  },
  "sources:items": {
    usage:
      "yeetpost sources:items <id> [--status <status>] [--limit <n>] [--offset <n>]",
    summary: "A source's items, with their status and the posts they made",
    example:
      "yeetpost sources:items 7d1f0c52-3a8e-4d6b-9c41-0b2e5a9f1c33 --status failed",
    note:
      "--status is baseline, new, writing, posted, failed or skipped. A failed\n" +
      "item carries an error that says the fix: sources:retry tries it again.",
  },
  "sources:push": {
    usage: "yeetpost sources:push <id> --items <file|->",
    summary: "Push items to a push source from a json file or stdin",
    example:
      "yeetpost sources:push 7d1f0c52-3a8e-4d6b-9c41-0b2e5a9f1c33 --items items.json",
    note:
      "The file holds a json array of 1 to 20 items: { id, title, and optionally\n" +
      "url, summary, content, publishedAt }. An id already sent is left as it is.",
  },
  "sources:retry": {
    usage: "yeetpost sources:retry <id> <item id>",
    summary: "Try a failed source item again",
    example:
      "yeetpost sources:retry 7d1f0c52-3a8e-4d6b-9c41-0b2e5a9f1c33 2c9e4b1a-6d3f-4e58-b7a0-5f1d8c3e9a42",
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
    mode?: string;
    instructions?: string;
    name?: string;
    card?: boolean;
    "no-card"?: boolean;
    backfill?: string;
    offset?: string;
    push?: boolean;
    items?: string;
    "created-after"?: string;
    "created-before"?: string;
    sort?: string;
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

const POST_SORTS = [
  "created_desc",
  "created_asc",
  "scheduled_desc",
  "scheduled_asc",
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

const getOffset = (offsetOption: string | undefined): number | undefined => {
  if (offsetOption === undefined) {
    return undefined;
  }

  const offset = Number(offsetOption);

  if (!Number.isInteger(offset) || offset < 0) {
    throw new UsageError("--offset must be a whole number, 0 or more");
  }

  return offset;
};

const getBackfillCount = (
  backfillOption: string | undefined,
): number | undefined => {
  if (backfillOption === undefined) {
    return undefined;
  }

  const backfillCount = Number(backfillOption);

  if (
    !Number.isInteger(backfillCount) ||
    backfillCount < 0 ||
    backfillCount > 20
  ) {
    throw new UsageError("--backfill must be a whole number between 0 and 20");
  }

  return backfillCount;
};

const SOURCES_ACTIONS = [
  "preview",
  "create",
  "get",
  "update",
  "delete",
  "check",
  "items",
  "push",
  "retry",
];

const SOURCE_MODES = ["queue", "draft"];

const getSourceMode = (
  modeOption: string | undefined,
): "queue" | "draft" | undefined => {
  if (modeOption === undefined) {
    return undefined;
  }

  if (modeOption === "queue" || modeOption === "draft") {
    return modeOption;
  }

  throw new UsageError(`--mode must be one of ${SOURCE_MODES.join(", ")}`);
};

const SOURCE_ITEM_STATUSES = [
  "baseline",
  "new",
  "writing",
  "posted",
  "failed",
  "skipped",
];

const SOURCE_STATUSES = ["active", "paused"];

// --card and --no-card both set makeCard, and naming both is a contradiction
const getMakeCard = (values: CommandContext["values"]): boolean | undefined => {
  if (values.card && values["no-card"]) {
    throw new UsageError("--card and --no-card cannot be used together");
  }

  if (values.card) {
    return true;
  }

  if (values["no-card"]) {
    return false;
  }

  return undefined;
};

const getSourceSlugs = (toOption: string | undefined): string[] | undefined => {
  if (toOption === undefined) {
    return undefined;
  }

  return toOption
    .split(",")
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0);
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

  if (values.sort && !POST_SORTS.includes(values.sort)) {
    throw new UsageError(`--sort must be one of ${POST_SORTS.join(", ")}`);
  }

  const yeetpost = getClient(context);

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
    connectionSlug: values.connection,
    createdAfter: values["created-after"],
    createdBefore: values["created-before"],
    sort: values.sort as
      | "created_desc"
      | "created_asc"
      | "scheduled_desc"
      | "scheduled_asc"
      | undefined,
    limit: getLimit(values.limit),
    offset: getOffset(values.offset),
  });

  const posts = response.posts;

  printOutput(
    {
      json: {
        posts,
        limit: response.limit,
        offset: response.offset,
        total: response.total,
        hasMore: response.hasMore,
        nextOffset: response.nextOffset,
      },
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

const getSourceRow = (source: GetSourceResponse["source"]): string[] => {
  return [
    source.id,
    source.name,
    source.kind,
    source.status,
    source.mode,
    source.connectionSlugs.join(","),
    source.lastCheckedAt ?? "",
  ];
};

const SOURCE_TABLE_HEADERS = [
  "id",
  "name",
  "kind",
  "status",
  "mode",
  "connections",
  "last checked",
];

const runSources = async (context: CommandContext): Promise<void> => {
  const { values, mode } = context;
  const yeetpost = getClient(context);
  const response = await yeetpost.listSources({
    limit: getLimit(values.limit),
    offset: getOffset(values.offset),
  });

  printOutput(
    {
      json: response,
      ids: response.sources.map((source) => source.id),
      table: {
        headers: SOURCE_TABLE_HEADERS,
        rows: response.sources.map(getSourceRow),
      },
    },
    mode,
  );
};

const runSourcesPreview = async (context: CommandContext): Promise<void> => {
  const url = context.positionals[0];

  if (!url) {
    throw new UsageError("sources:preview needs a url");
  }

  const yeetpost = getClient(context);
  const preview = await yeetpost.previewSource({ url });

  printOutput(
    {
      json: preview,
      ids: preview.items.flatMap((item) => (item.url ? [item.url] : [])),
      table: {
        headers: ["kind", "name", "items found", "title", "url"],
        rows: preview.items.map((item) => [
          preview.kind,
          preview.name,
          String(preview.itemCount),
          item.title,
          item.url ?? "",
        ]),
      },
    },
    context.mode,
  );
};

const runSourcesCreate = async (context: CommandContext): Promise<void> => {
  const { values, positionals } = context;
  const url = positionals[0];

  if (!url && !values.push) {
    throw new UsageError("sources:create needs a url, or --push");
  }

  if (url && values.push) {
    throw new UsageError("sources:create takes a url or --push, not both");
  }

  const connectionSlugs = getSourceSlugs(values.to);

  if (!connectionSlugs || connectionSlugs.length === 0) {
    throw new UsageError("sources:create needs --to <slug,slug>");
  }

  const sourceMode = getSourceMode(values.mode);

  if (!sourceMode) {
    throw new UsageError("sources:create needs --mode queue or --mode draft");
  }

  const yeetpost = getClient(context);
  const { source } = await yeetpost.createSource({
    url,
    kind: values.push ? "push" : undefined,
    name: values.name,
    connectionSlugs,
    mode: sourceMode,
    instructions: values.instructions,
    makeCard: getMakeCard(values),
    backfillCount: getBackfillCount(values.backfill),
    profileId: values.profile,
  });

  printOutput(
    {
      json: { source },
      ids: [source.id],
      table: { headers: SOURCE_TABLE_HEADERS, rows: [getSourceRow(source)] },
    },
    context.mode,
  );
};

const runSourcesGet = async (context: CommandContext): Promise<void> => {
  const sourceId = context.positionals[0];

  if (!sourceId) {
    throw new UsageError("sources:get needs a source id");
  }

  const yeetpost = getClient(context);
  const { source } = await yeetpost.getSource(sourceId);

  printOutput(
    {
      json: { source },
      ids: [source.id],
      table: { headers: SOURCE_TABLE_HEADERS, rows: [getSourceRow(source)] },
    },
    context.mode,
  );
};

const runSourcesUpdate = async (context: CommandContext): Promise<void> => {
  const { values, positionals } = context;
  const sourceId = positionals[0];

  if (!sourceId) {
    throw new UsageError("sources:update needs a source id");
  }

  if (values.status && !SOURCE_STATUSES.includes(values.status)) {
    throw new UsageError(
      `--status must be one of ${SOURCE_STATUSES.join(", ")}`,
    );
  }

  const connectionSlugs = getSourceSlugs(values.to);
  const sourceMode = getSourceMode(values.mode);
  const makeCard = getMakeCard(values);

  if (
    connectionSlugs === undefined &&
    sourceMode === undefined &&
    values.instructions === undefined &&
    makeCard === undefined &&
    values.status === undefined
  ) {
    throw new UsageError(
      "sources:update needs at least one of --to, --mode, --instructions, --card, --no-card or --status",
    );
  }

  const yeetpost = getClient(context);
  const { source } = await yeetpost.updateSource(sourceId, {
    connectionSlugs,
    mode: sourceMode,
    instructions: values.instructions,
    makeCard,
    // The guard above is what narrows the string to the client's union
    status: values.status as "active" | "paused" | undefined,
  });

  printOutput(
    {
      json: { source },
      ids: [source.id],
      table: { headers: SOURCE_TABLE_HEADERS, rows: [getSourceRow(source)] },
    },
    context.mode,
  );
};

const runSourcesDelete = async (context: CommandContext): Promise<void> => {
  const sourceId = context.positionals[0];

  if (!sourceId) {
    throw new UsageError("sources:delete needs a source id");
  }

  const yeetpost = getClient(context);
  const response = await yeetpost.deleteSource(sourceId);

  printOutput(
    {
      json: response,
      ids: [response.id],
      table: {
        headers: ["id", "deleted"],
        rows: [[response.id, String(response.deleted)]],
      },
    },
    context.mode,
  );
};

const runSourcesCheck = async (context: CommandContext): Promise<void> => {
  const sourceId = context.positionals[0];

  if (!sourceId) {
    throw new UsageError("sources:check needs a source id");
  }

  const yeetpost = getClient(context);
  const response = await yeetpost.checkSource(sourceId);

  printOutput(
    {
      json: response,
      ids: response.newItems.map((item) => item.id),
      table: {
        headers: ["id", "title", "url"],
        rows: response.newItems.map((item) => [
          item.id,
          item.title,
          item.url ?? "",
        ]),
      },
    },
    context.mode,
  );
};

const runSourcesItems = async (context: CommandContext): Promise<void> => {
  const { values, positionals } = context;
  const sourceId = positionals[0];

  if (!sourceId) {
    throw new UsageError("sources:items needs a source id");
  }

  if (values.status && !SOURCE_ITEM_STATUSES.includes(values.status)) {
    throw new UsageError(
      `--status must be one of ${SOURCE_ITEM_STATUSES.join(", ")}`,
    );
  }

  const yeetpost = getClient(context);
  const response = await yeetpost.listSourceItems(sourceId, {
    // The guard above is what narrows the string to the client's union
    status: values.status as
      | "baseline"
      | "new"
      | "writing"
      | "posted"
      | "failed"
      | "skipped"
      | undefined,
    limit: getLimit(values.limit),
    offset: getOffset(values.offset),
  });

  printOutput(
    {
      json: response,
      ids: response.items.map((item) => item.id),
      table: {
        headers: ["id", "status", "posts", "title"],
        rows: response.items.map((item) => [
          item.id,
          item.status,
          String(item.posts.length),
          item.title.replace(/\s+/g, " ").slice(0, 48),
        ]),
      },
    },
    context.mode,
  );
};

const runSourcesPush = async (context: CommandContext): Promise<void> => {
  const { values, positionals } = context;
  const sourceId = positionals[0];

  if (!sourceId) {
    throw new UsageError("sources:push needs a source id");
  }

  if (!values.items) {
    throw new UsageError("sources:push needs --items <file>, or - for stdin");
  }

  let itemsText = "";

  if (values.items === "-") {
    itemsText = await readStdinText();
  } else {
    if (!fs.existsSync(values.items)) {
      throw new UsageError(`no such file: ${values.items}`);
    }

    try {
      itemsText = fs.readFileSync(values.items, "utf8");
    } catch {
      throw new UsageError(`could not read ${values.items}`);
    }
  }

  let items: unknown = null;

  try {
    items = JSON.parse(itemsText);
  } catch {
    throw new UsageError("--items must be a json array of items");
  }

  if (!Array.isArray(items)) {
    throw new UsageError("--items must be a json array of items");
  }

  const yeetpost = getClient(context);
  const response = await yeetpost.addSourceItems(sourceId, {
    // The API checks every item; this only knows it is an array
    items: items as AddSourceItemsParams["items"],
  });

  printOutput(
    {
      json: response,
      ids: [],
      table: {
        headers: ["added", "duplicates"],
        rows: [[String(response.added), String(response.duplicates)]],
      },
    },
    context.mode,
  );
};

const runSourcesRetry = async (context: CommandContext): Promise<void> => {
  const [sourceId, itemId] = context.positionals;

  if (!sourceId || !itemId) {
    throw new UsageError("sources:retry needs a source id and an item id");
  }

  const yeetpost = getClient(context);
  const response = await yeetpost.retrySourceItem(sourceId, itemId);

  printOutput(
    {
      json: response,
      ids: [response.id],
      table: {
        headers: ["id", "status"],
        rows: [[response.id, response.status]],
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
  mode: { type: "string" },
  instructions: { type: "string" },
  name: { type: "string" },
  card: { type: "boolean" },
  "no-card": { type: "boolean" },
  backfill: { type: "string" },
  offset: { type: "string" },
  push: { type: "boolean" },
  items: { type: "string" },
  "created-after": { type: "string" },
  "created-before": { type: "string" },
  sort: { type: "string" },
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
  posts: [
    "limit",
    "offset",
    "status",
    "connection",
    "profile",
    "tag",
    "created-after",
    "created-before",
    "sort",
  ],
  "post:get": [],
  "post:cancel": [],
  "media:upload": ["alt"],
  webhooks: [],
  sources: ["limit", "offset"],
  "sources:preview": [],
  "sources:create": [
    "to",
    "mode",
    "instructions",
    "name",
    "no-card",
    "backfill",
    "profile",
    "push",
  ],
  "sources:get": [],
  "sources:update": ["to", "mode", "instructions", "card", "no-card", "status"],
  "sources:delete": [],
  "sources:check": [],
  "sources:items": ["status", "limit", "offset"],
  "sources:push": ["items"],
  "sources:retry": [],
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

  if (commandName === "sources") {
    return runSources(context);
  }

  if (commandName === "sources:preview") {
    return runSourcesPreview(context);
  }

  if (commandName === "sources:create") {
    return runSourcesCreate(context);
  }

  if (commandName === "sources:get") {
    return runSourcesGet(context);
  }

  if (commandName === "sources:update") {
    return runSourcesUpdate(context);
  }

  if (commandName === "sources:delete") {
    return runSourcesDelete(context);
  }

  if (commandName === "sources:check") {
    return runSourcesCheck(context);
  }

  if (commandName === "sources:items") {
    return runSourcesItems(context);
  }

  if (commandName === "sources:push") {
    return runSourcesPush(context);
  }

  if (commandName === "sources:retry") {
    return runSourcesRetry(context);
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

  // "sources preview <url>" is the spelling the docs use for sources:preview
  if (
    commandName === "sources" &&
    SOURCES_ACTIONS.includes(positionals[0] ?? "")
  ) {
    commandName = `sources:${positionals[0]}`;
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
    process.stderr.write("yeetpost --help for the commands\n");
    process.exitCode = 2;
    return;
  }

  process.stderr.write(
    `${error instanceof Error ? error.message : "something went wrong"}\n`,
  );
  process.exitCode = 1;
});
