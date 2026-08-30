import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "..", "src", "index.js");
const packageVersion = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
).version;

function parseLastJsonLine(text) {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  assert.ok(line, "expected a JSON line");
  return JSON.parse(line);
}

function createTempConfig(initialConfig = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socialseal-cli-test-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`);
  return configPath;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPLORE_FEATURE_POLICY: JSON.stringify({ mode: "live", allowedChannels: ["cli"] }),
      ...options.env,
    },
    timeout: options.timeout ?? 8000,
  });
}

function runCliAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        EXPLORE_FEATURE_POLICY: JSON.stringify({ mode: "live", allowedChannels: ["cli"] }),
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeout ?? 8000;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: null, signal: "SIGKILL", stdout, stderr });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      finish({ status, signal, stdout, stderr });
    });
  });
}

test("shows help output", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /SocialSeal CLI/i);
  assert.match(result.stdout, /Usage:/i);
});

test("prints the runtime package version instead of a hardcoded source version", () => {
  const result = runCli(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), packageVersion);
});

test("whoami without credentials hints login and exits auth code", () => {
  const configPath = createTempConfig({});
  const result = runCli(["whoami", "--json"], {
    env: {
      SOCIALSEAL_CONFIG: configPath,
      SOCIALSEAL_API_KEY: "",
    },
  });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /socialseal login/);
});

test("login completes device flow, masks output, and stores config mode 0600", async () => {
  const rawKey = "ss_cli_abcdefghijklmnopqrstuvwxyz123456";
  const configPath = createTempConfig({});
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/cli/device/authorize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            verification_uri: "https://app.example.test/activate",
            verification_uri_complete: "https://app.example.test/activate?user_code=ABCDEFGH",
            user_code: "ABCDEFGH",
            device_code: "device-code",
            interval: 1,
            expires_in: 600,
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/cli/device/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            token_type: "socialseal_cli_key",
            api_key: rawKey,
            key_suffix: "123456",
            workspace_id: "workspace-1",
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", url: req.url }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const apiBase = `http://127.0.0.1:${address.port}`;
    const result = await runCliAsync(
      [
        "login",
        "--api-base",
        apiBase,
        "--no-open",
        "--json",
        "--poll-interval",
        "10",
        "--timeout",
        "5000",
      ],
      {
        env: { SOCIALSEAL_CONFIG: configPath },
        timeout: 8000,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(rawKey));
    assert.match(result.stdout, /123456/);

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(config.apiKey, rawKey);
    assert.equal(config.workspaceId, "workspace-1");
    assert.equal(config.apiBase, apiBase);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("whoami verifies the configured key against workspace discovery", async () => {
  const rawKey = "ss_cli_abcdefghijklmnopqrstuvwxyz123456";
  let receivedKey = null;
  const configPath = createTempConfig({
    apiKey: rawKey,
    workspaceId: "workspace-1",
  });
  const server = createServer((req, res) => {
    receivedKey = req.headers["x-cli-key"];
    if (req.method === "GET" && req.url === "/cli/workspaces") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            defaultWorkspaceId: "workspace-1",
            workspaces: [{ id: "workspace-1", name: "Workspace 1" }],
          },
        }),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const result = await runCliAsync(
      ["whoami", "--api-base", `http://127.0.0.1:${address.port}`, "--json"],
      {
        env: { SOCIALSEAL_CONFIG: configPath },
      },
    );
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(receivedKey, rawKey);
    assert.equal(payload.authenticated, true);
    assert.equal(payload.key, "…123456");
    assert.equal(payload.workspace.name, "Workspace 1");
    assert.doesNotMatch(result.stdout, new RegExp(rawKey));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("invalid JSON body returns structured error", () => {
  const result = runCli([
    "tools",
    "call",
    "--function",
    "tracking",
    "--body",
    "{bad",
    "--json",
    "--api-key",
    "test",
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /"code":"INVALID_JSON"/);
  assert.match(result.stderr, /"message":"Invalid body JSON"/);
});

test("tools list returns built-in registry metadata", () => {
  const result = runCli(["tools", "list", "--json"]);
  assert.equal(result.status, 0);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.discovery, "built_in_registry");
  assert.match(payload.note, /not live backend enumeration/i);
  assert.match(payload.schemaNote, /schema hints are static cli docs/i);
  assert.ok(Array.isArray(payload.tools));
  assert.ok(payload.tools.some((tool) => tool.name === "tracking"));
  assert.ok(
    payload.tools.some((tool) => tool.name === "tracking" && tool.objectType === "tracking_item"),
  );
  assert.ok(
    payload.tools.some(
      (tool) => tool.name === "tracking" && tool.actionAliases?.includes("resolve"),
    ),
  );
  assert.ok(
    payload.tools.some(
      (tool) =>
        tool.name === "group-management" &&
        tool.actionAliases?.includes("group_add_item") &&
        tool.schemaAvailable === true,
    ),
  );
  assert.ok(payload.tools.some((tool) => tool.name === "google-ai-search"));
  assert.ok(
    payload.tools.some(
      (tool) => tool.name === "search-journey-run" && tool.schemaAvailable === true,
    ),
  );
  assert.ok(payload.tools.some((tool) => tool.name === "get-google-ai-search-runs"));
  assert.ok(
    payload.tools.some(
      (tool) =>
        tool.name === "vnext-clips-read" &&
        tool.category === "asset-studio" &&
        tool.schemaAvailable === true,
    ),
  );
  assert.ok(
    payload.tools.some(
      (tool) =>
        tool.name === "vnext-generated-asset-create" &&
        tool.category === "asset-studio" &&
        tool.workspaceScoped === true,
    ),
  );
  assert.ok(
    payload.tools.some(
      (tool) =>
        tool.name === "vnext-blueprints-shots-read" &&
        tool.category === "video-production" &&
        tool.schemaAvailable === true,
    ),
  );
});

test("Explore stays out of CLI discovery and commands when the shared policy is off", () => {
  const env = { EXPLORE_FEATURE_POLICY: JSON.stringify({ mode: "off" }) };
  const list = runCli(["tools", "list", "--json"], { env });
  assert.equal(list.status, 0);
  assert.equal(
    JSON.parse(list.stdout).tools.some((tool) => tool.name === "explore-api"),
    false,
  );

  const schema = runCli(["tools", "schema", "--function", "explore-api", "--json"], { env });
  assert.equal(schema.status, 2);
  assert.match(schema.stderr, /Unknown tool: explore-api/);

  const command = runCli(["explore", "list", "--json"], { env });
  assert.notEqual(command.status, 0);
  assert.match(command.stderr, /unknown command ['"]explore['"]/i);
});

test("tools list can filter Asset Studio and video production categories", () => {
  const assetResult = runCli(["tools", "list", "--category", "asset-studio", "--json"]);
  assert.equal(assetResult.status, 0);
  const assetPayload = JSON.parse(assetResult.stdout);
  assert.equal(assetPayload.category, "asset-studio");
  assert.ok(assetPayload.tools.length > 0);
  assert.ok(assetPayload.tools.every((tool) => tool.category === "asset-studio"));
  assert.ok(assetPayload.tools.some((tool) => tool.name === "vnext-clips-read"));

  const productionResult = runCli(["tools", "list", "--category", "video-production", "--json"]);
  assert.equal(productionResult.status, 0);
  const productionPayload = JSON.parse(productionResult.stdout);
  assert.ok(productionPayload.tools.length > 0);
  assert.ok(productionPayload.tools.every((tool) => tool.category === "video-production"));
  assert.ok(productionPayload.tools.some((tool) => tool.name === "vnext-blueprints-shots-read"));
});

test("tools schema exposes required search-journey-run fields and examples", () => {
  const result = runCli(["tools", "schema", "--function", "search-journey-run", "--json"]);

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.function, "search-journey-run");
  assert.ok(Array.isArray(payload.schema.operations));
  assert.ok(payload.schema.operations[0].required.includes("subjectType"));
  assert.ok(payload.schema.operations[0].required.includes("region"));
  assert.ok(Array.isArray(payload.schema.cliExamples));
  assert.ok(payload.schema.cliExamples.some((line) => /tools status/.test(line)));
});

test("tools schema exposes tracked-video-extract URL and identifier examples", () => {
  const result = runCli(["tools", "schema", "--function", "tracked-video-extract", "--json"]);

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.function, "tracked-video-extract");
  assert.ok(Array.isArray(payload.schema.operations));
  assert.ok(payload.schema.operations[0].required.includes("items[] with exactly one selector"));
  assert.equal(payload.schema.operations[0].example.allowUntracked, true);
  assert.equal(
    payload.schema.operations[0].example.items[0].url,
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  assert.ok(
    payload.schema.cliExamples.some(
      (line) => /video extract --url/.test(line) && /--allow-untracked/.test(line),
    ),
  );
  assert.ok(payload.schema.cliExamples.some((line) => /--video-uid/.test(line)));
});

test("tools schema exposes Asset Studio and video production tools", () => {
  const clipsResult = runCli(["tools", "schema", "--function", "vnext-clips-create", "--json"]);
  assert.equal(clipsResult.status, 0);
  const clipsPayload = JSON.parse(clipsResult.stdout);
  assert.equal(clipsPayload.function, "vnext-clips-create");
  assert.ok(clipsPayload.schema.operations[0].required.includes("fileName"));
  assert.ok(
    clipsPayload.schema.operations.some((operation) =>
      operation.required.includes("rightsAttested=true"),
    ),
  );

  const assetResult = runCli([
    "tools",
    "schema",
    "--function",
    "vnext-generated-asset-create",
    "--json",
  ]);
  assert.equal(assetResult.status, 0);
  const assetPayload = JSON.parse(assetResult.stdout);
  assert.equal(assetPayload.function, "vnext-generated-asset-create");
  assert.ok(assetPayload.schema.operations[0].required.includes("editSpec"));

  const shotsResult = runCli([
    "tools",
    "schema",
    "--function",
    "vnext-blueprints-shots-read",
    "--json",
  ]);
  assert.equal(shotsResult.status, 0);
  const shotsPayload = JSON.parse(shotsResult.stdout);
  assert.equal(shotsPayload.function, "vnext-blueprints-shots-read");
  assert.ok(shotsPayload.schema.operations[0].required.includes("blueprintId"));
});

test("tools schema documents non-TikTok group creation", () => {
  const result = runCli(["tools", "schema", "--function", "group-management", "--json"]);

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.function, "group-management");
  assert.ok(Array.isArray(payload.schema.operations));
  assert.match(payload.schema.operations[0].notes, /youtube/);
  assert.equal(payload.schema.operations[0].example.platform, "youtube");
  assert.ok(payload.schema.cliExamples.some((line) => /platform":"instagram/.test(line)));
});

test("tools status resolves numeric Google AI run ids and can include results payloads", async () => {
  const requestBodies = [];

  const httpServer = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }
    const parsed = JSON.parse(body || "{}");
    requestBodies.push({ url: req.url, body: parsed });

    if (req.url === "/cli/tools/get-google-ai-search-runs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: [
            {
              id: 6809,
              status: "succeeded",
              totalQueries: 7,
              completedQueries: 7,
              progressPercent: 100,
              lastErrorMessage: null,
            },
          ],
          total: 1,
          limit: 1,
          offset: 0,
        }),
      );
      return;
    }

    if (req.url === "/cli/tools/get-google-ai-search-results") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: [
            {
              id: 1,
              runId: 6809,
              query: "east africa itinerary",
              summaryText: "summary",
              citations: [],
            },
          ],
          total: 1,
          limit: 2,
          offset: 0,
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "status",
      "6809",
      "--kind",
      "google_ai_run",
      "--include-results",
      "--results-limit",
      "2",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.kind, "google_ai_run");
    assert.equal(payload.id, 6809);
    assert.equal(payload.status, "succeeded");
    assert.equal(payload.progress.totalQueries, 7);
    assert.equal(payload.progress.completedQueries, 7);
    assert.ok(payload.results);
    assert.equal(payload.results.items[0].runId, 6809);

    assert.equal(requestBodies[0].url, "/cli/tools/get-google-ai-search-runs");
    assert.deepEqual(requestBodies[0].body, {
      runId: 6809,
      limit: 1,
      offset: 0,
    });
    assert.equal(requestBodies[1].url, "/cli/tools/get-google-ai-search-results");
    assert.deepEqual(requestBodies[1].body, {
      runId: 6809,
      includeCitations: true,
      limit: 2,
      offset: 0,
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools status auto resolves UUID ids through agent-tool-jobs status", async () => {
  const requestBodies = [];
  const jobId = "b6aaf12b-4bc6-4fec-b106-ee6211fd6174";

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/agent-tool-jobs") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBodies.push(JSON.parse(body || "{}"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jobId,
          workspaceId: null,
          toolName: "search_videos",
          status: "pending",
          result: null,
          error: null,
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "status",
      jobId,
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.kind, "agent_tool_job");
    assert.equal(payload.id, jobId);
    assert.equal(payload.status, "pending");
    assert.equal(payload.toolName, "search_videos");
    assert.equal(payload.workspaceId, null);
    assert.deepEqual(requestBodies[0], { action: "status", jobId });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools status auto falls back to search-journey-run status when agent job UUID is not found", async () => {
  const journeyRunId = "38fecb2f-0db0-423d-ba27-2ce5ba4139c3";
  const requestBodies = [];

  const httpServer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }
    const parsed = JSON.parse(body || "{}");
    requestBodies.push({ url: req.url, body: parsed });

    if (req.method === "POST" && req.url === "/cli/tools/agent-tool-jobs") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "NOT_FOUND" }));
      return;
    }

    if (req.method === "POST" && req.url === "/cli/tools/search-journey-run") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          journeyId: "journey-123",
          runId: journeyRunId,
          status: "completed",
          error: null,
          stagedKeywords: [{ keyword: "safari itinerary" }],
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "status",
      journeyRunId,
      "--workspace-id",
      "workspace-journey",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.kind, "search_journey_run");
    assert.equal(payload.id, journeyRunId);
    assert.equal(payload.status, "completed");
    assert.equal(payload.workspaceId, "workspace-journey");
    assert.equal(payload.stagedKeywordsCount, 1);
    assert.deepEqual(requestBodies[0], {
      url: "/cli/tools/agent-tool-jobs",
      body: { action: "status", jobId: journeyRunId },
    });
    assert.deepEqual(requestBodies[1], {
      url: "/cli/tools/search-journey-run",
      body: {
        action: "status",
        workspaceId: "workspace-journey",
        runId: journeyRunId,
      },
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools status --wait exits non-zero on terminal failed status", async () => {
  const jobId = "c6aaf12b-4bc6-4fec-b106-ee6211fd6174";

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/agent-tool-jobs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jobId,
          workspaceId: null,
          toolName: "search_videos",
          status: "failed",
          result: null,
          error: "backend timeout",
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "status",
      jobId,
      "--kind",
      "agent_job",
      "--wait",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 5, result.stdout);
    const payload = parseLastJsonLine(result.stderr);
    assert.equal(payload.error.code, "STATUS_FAILED");
    assert.match(payload.error.message, /terminal failed status/i);
    assert.equal(payload.error.details.kind, "agent_tool_job");
    assert.equal(payload.error.details.status, "failed");
    assert.equal(payload.error.details.error, "backend timeout");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call normalizes workspaceId to workspace_id for brand-group-management", async () => {
  let requestBody = null;
  let requestWorkspaceHeader = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/brand-group-management") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");
      requestWorkspaceHeader = req.headers["x-workspace-id"] || null;

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "group-1", object_type: "brand_group" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "brand-group-management",
      "--body",
      '{"name":"Heymax Smoke","workspaceId":"11111111-1111-4111-8111-111111111111"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestWorkspaceHeader, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual(requestBody, {
      name: "Heymax Smoke",
      workspace_id: "11111111-1111-4111-8111-111111111111",
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call injects workspaceId into object payloads when --workspace-id is provided", async () => {
  let requestBody = null;
  let requestWorkspaceHeader = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/vnext-intents") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");
      requestWorkspaceHeader = req.headers["x-workspace-id"] || null;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "vnext-intents",
      "--body",
      '{"action":"list"}',
      "--workspace-id",
      "workspace-from-flag",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestWorkspaceHeader, "workspace-from-flag");
    assert.deepEqual(requestBody, {
      action: "list",
      workspaceId: "workspace-from-flag",
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call does not overwrite an explicit workspaceId already present in the JSON body", async () => {
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/vnext-intents") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "vnext-intents",
      "--body",
      '{"action":"list","workspaceId":"workspace-from-body"}',
      "--workspace-id",
      "workspace-from-flag",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(requestBody, {
      action: "list",
      workspaceId: "workspace-from-body",
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call translates tracking action=list into a GET request with query params", async () => {
  let requestMethod = null;
  let requestUrl = null;
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    requestMethod = req.method;
    requestUrl = req.url;

    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }
    requestBody = body;

    if (req.method === "GET" && req.url?.startsWith("/cli/tools/tracking?")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "tracking",
      "--body",
      '{"action":"list","workspaceId":"11111111-1111-4111-8111-111111111111","type":"keyword","value":"heymax","limit":10,"page":2}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestMethod, "GET");
    assert.match(requestUrl, /^\/cli\/tools\/tracking\?/);
    assert.match(requestUrl, /workspace_id=11111111-1111-4111-8111-111111111111/);
    assert.match(requestUrl, /track_type=search/);
    assert.match(requestUrl, /track_value=heymax/);
    assert.match(requestUrl, /limit=10/);
    assert.match(requestUrl, /offset=10/);
    assert.equal(requestBody, "");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call translates tracking action=refresh into POST /tracking/:id/refresh", async () => {
  let requestMethod = null;
  let requestUrl = null;
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    requestMethod = req.method;
    requestUrl = req.url;
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }
    requestBody = JSON.parse(body || "{}");

    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "POST" &&
      parsedUrl.pathname === "/cli/tools/tracking/42/refresh" &&
      parsedUrl.searchParams.get("workspace_id") === "11111111-1111-4111-8111-111111111111"
    ) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "tracking",
      "--body",
      '{"action":"refresh","itemId":42,"workspaceId":"11111111-1111-4111-8111-111111111111"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestMethod, "POST");
    const parsedRequestUrl = new URL(requestUrl, "http://127.0.0.1");
    assert.equal(parsedRequestUrl.pathname, "/cli/tools/tracking/42/refresh");
    assert.equal(
      parsedRequestUrl.searchParams.get("workspace_id"),
      "11111111-1111-4111-8111-111111111111",
    );
    assert.deepEqual(requestBody, {});
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call translates tracking action=create into POST /tracking with workspace_id query scope", async () => {
  let requestMethod = null;
  let requestUrl = null;
  let requestWorkspaceHeader = null;
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    requestMethod = req.method;
    requestUrl = req.url;
    requestWorkspaceHeader = req.headers["x-workspace-id"] || null;
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }
    requestBody = JSON.parse(body || "{}");

    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "POST" &&
      parsedUrl.pathname === "/cli/tools/tracking" &&
      parsedUrl.searchParams.get("workspace_id") === "workspace-1"
    ) {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 27926, workspace_id: "workspace-1" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "tracking",
      "--body",
      '{"action":"create","name":"daily commute miles earning","type":"keyword","value":"daily commute miles earning","region":"SG","platform":"tiktok"}',
      "--workspace-id",
      "workspace-1",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestMethod, "POST");
    assert.equal(requestUrl, "/cli/tools/tracking?workspace_id=workspace-1");
    assert.equal(requestWorkspaceHeader, "workspace-1");
    assert.deepEqual(requestBody, {
      name: "daily commute miles earning",
      track_type: "search",
      track_value: "daily commute miles earning",
      region: "SG",
      platform: "tiktok",
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call translates tracking action=resolve into duplicate-lookup GET semantics", async () => {
  let requestMethod = null;
  let requestUrl = null;
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    requestMethod = req.method;
    requestUrl = req.url;

    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }
    requestBody = body;

    if (req.method === "GET" && req.url?.startsWith("/cli/tools/tracking?")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 77 }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "tracking",
      "--body",
      '{"action":"resolve","workspaceId":"11111111-1111-4111-8111-111111111111","type":"keyword","value":"heymax","platform":"tiktok","region":"US"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestMethod, "GET");
    assert.match(requestUrl, /resolve=true/);
    assert.match(requestUrl, /track_type=search/);
    assert.match(requestUrl, /track_value=heymax/);
    assert.match(requestUrl, /platform=tiktok/);
    assert.match(requestUrl, /region=US/);
    assert.equal(requestBody, "");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call translates group-management action=group_add_item into POST /groups/:id/items", async () => {
  let requestMethod = null;
  let requestUrl = null;
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    requestMethod = req.method;
    requestUrl = req.url;
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }
    requestBody = JSON.parse(body || "{}");

    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "POST" &&
      parsedUrl.pathname === "/cli/tools/group-management/groups/248/items" &&
      parsedUrl.searchParams.get("workspace_id") === "workspace-1"
    ) {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 1 }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "group-management",
      "--body",
      '{"action":"group_add_item","groupId":248,"itemId":1234,"workspaceId":"workspace-1"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestMethod, "POST");
    assert.equal(
      requestUrl,
      "/cli/tools/group-management/groups/248/items?workspace_id=workspace-1",
    );
    assert.deepEqual(requestBody, { item_id: 1234 });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call translates group-management action=group_add_items into bulk item-id payloads", async () => {
  let requestMethod = null;
  let requestUrl = null;
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    requestMethod = req.method;
    requestUrl = req.url;
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }
    requestBody = JSON.parse(body || "[]");

    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "POST" &&
      parsedUrl.pathname === "/cli/tools/group-management/groups/248/items/bulk" &&
      parsedUrl.searchParams.get("workspace_id") === "workspace-1"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items_added: 2 }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "group-management",
      "--body",
      '{"action":"group_add_items","groupId":248,"itemIds":[1234,5678],"workspaceId":"workspace-1"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestMethod, "POST");
    assert.equal(
      requestUrl,
      "/cli/tools/group-management/groups/248/items/bulk?workspace_id=workspace-1",
    );
    assert.deepEqual(requestBody, [{ item_id: 1234 }, { item_id: 5678 }]);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call translates group-management action=group_completeness into backend completeness request", async () => {
  let requestMethod = null;
  let requestUrl = null;
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    requestMethod = req.method;
    requestUrl = req.url;
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }
    requestBody = JSON.parse(body || "{}");

    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "POST" &&
      parsedUrl.pathname === "/cli/tools/group-management/groups/248/completeness" &&
      parsedUrl.searchParams.get("workspace_id") === "workspace-1"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, complete: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "group-management",
      "--body",
      '{"action":"group_completeness","groupId":248,"expectedItems":[{"track_type":"search","track_value":"heymax","region":"SG"}],"workspaceId":"workspace-1"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestMethod, "POST");
    assert.equal(
      requestUrl,
      "/cli/tools/group-management/groups/248/completeness?workspace_id=workspace-1",
    );
    assert.deepEqual(requestBody, {
      expected_items: [
        {
          track_type: "search",
          track_value: "heymax",
          region: "SG",
        },
      ],
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      success: true,
      complete: true,
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call blocks empty group refresh unless forced", async () => {
  const requests = [];

  const httpServer = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });

    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "GET" &&
      parsedUrl.pathname === "/cli/tools/group-management/groups/248/items" &&
      parsedUrl.searchParams.get("workspace_id") === "workspace-1"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [], total: 0 }));
      return;
    }

    if (
      req.method === "POST" &&
      parsedUrl.pathname === "/cli/tools/group-management/groups/248/refresh"
    ) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "group-management",
      "--body",
      '{"action":"group_refresh","groupId":248,"workspaceId":"workspace-1"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 2, result.stdout);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/groups\/248\/items/);
    const payload = parseLastJsonLine(result.stderr);
    assert.equal(payload.error.code, "EMPTY_GROUP_REFRESH");
    assert.equal(payload.error.details.itemCount, 0);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call allows forced empty group refresh", async () => {
  const requests = [];

  const httpServer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
    }
    requests.push({ method: req.method, url: req.url, body });

    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "POST" &&
      parsedUrl.pathname === "/cli/tools/group-management/groups/248/refresh" &&
      parsedUrl.searchParams.get("workspace_id") === "workspace-1"
    ) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "group-management",
      "--body",
      '{"action":"group_refresh","groupId":248,"workspaceId":"workspace-1","force":true}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      "/cli/tools/group-management/groups/248/refresh?workspace_id=workspace-1",
    );
    assert.equal(requests[0].body, "{}");
    assert.deepEqual(JSON.parse(result.stdout), { success: true });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call fails group-management add_items when backend returns item errors", async () => {
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "POST" &&
      parsedUrl.pathname === "/cli/tools/group-management/groups/295/items/bulk" &&
      parsedUrl.searchParams.get("workspace_id") === "workspace-1"
    ) {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "[]");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items_processed: 10,
          items_added: 9,
          items_linked: 0,
          errors: [
            {
              item_value: "rently cancellation",
              error: "canceling statement due to statement timeout",
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "group-management",
      "--body",
      '{"action":"add_items","groupId":295,"itemIds":[1,2,3,4,5,6,7,8,9,10],"workspaceId":"workspace-1"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 5, result.stdout);
    assert.deepEqual(requestBody, [
      { item_id: 1 },
      { item_id: 2 },
      { item_id: 3 },
      { item_id: 4 },
      { item_id: 5 },
      { item_id: 6 },
      { item_id: 7 },
      { item_id: 8 },
      { item_id: 9 },
      { item_id: 10 },
    ]);

    const payload = parseLastJsonLine(result.stderr);
    assert.equal(payload.type, "error");
    assert.equal(payload.error.code, "PARTIAL_FAILURE");
    assert.match(payload.error.message, /partially failed/i);
    assert.equal(payload.error.details.expected, 10);
    assert.equal(payload.error.details.processed, 10);
    assert.equal(payload.error.details.added, 9);
    assert.equal(payload.error.details.linked, 0);
    assert.equal(payload.error.details.alreadyLinked, 0);
    assert.equal(payload.error.details.successful, 9);
    assert.equal(payload.error.details.failed, 1);
    assert.match(payload.error.details.errors[0].error, /statement timeout/i);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call fails group-management add_items when added count misses expected count", async () => {
  const httpServer = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "POST" &&
      parsedUrl.pathname === "/cli/tools/group-management/groups/248/items/bulk" &&
      parsedUrl.searchParams.get("workspace_id") === "workspace-1"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items_processed: 2,
          items_added: 1,
          items_linked: 0,
          errors: [],
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "group-management",
      "--body",
      '{"action":"group_add_items","groupId":248,"itemIds":[1234,5678],"workspaceId":"workspace-1"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 5, result.stdout);
    const payload = parseLastJsonLine(result.stderr);
    assert.equal(payload.error.code, "PARTIAL_FAILURE");
    assert.equal(payload.error.details.expected, 2);
    assert.equal(payload.error.details.successful, 1);
    assert.equal(payload.error.details.failed, 0);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call accepts idempotent group-management already-linked counts", async () => {
  const httpServer = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "POST" &&
      parsedUrl.pathname === "/cli/tools/group-management/groups/248/items/bulk" &&
      parsedUrl.searchParams.get("workspace_id") === "workspace-1"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items_processed: 2,
          items_added: 1,
          items_linked: 0,
          items_already_linked: 1,
          errors: [],
          verified: true,
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "group-management",
      "--body",
      '{"action":"group_add_items","groupId":248,"itemIds":[1234,5678],"workspaceId":"workspace-1"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      items_processed: 2,
      items_added: 1,
      items_linked: 0,
      items_already_linked: 1,
      errors: [],
      verified: true,
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call fails group-management add_items when backend verification fails", async () => {
  const httpServer = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "POST" &&
      parsedUrl.pathname === "/cli/tools/group-management/groups/248/items/bulk" &&
      parsedUrl.searchParams.get("workspace_id") === "workspace-1"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items_processed: 2,
          items_added: 1,
          items_linked: 1,
          items_already_linked: 0,
          errors: [],
          verified: false,
          expected_final_group_item_count: 12,
          final_group_item_count: 11,
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "group-management",
      "--body",
      '{"action":"group_add_items","groupId":248,"itemIds":[1234,5678],"workspaceId":"workspace-1"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 5, result.stdout);
    const payload = parseLastJsonLine(result.stderr);
    assert.equal(payload.error.code, "PARTIAL_FAILURE");
    assert.equal(payload.error.details.expected, 2);
    assert.equal(payload.error.details.successful, 2);
    assert.equal(payload.error.details.verified, false);
    assert.equal(payload.error.details.expectedFinalGroupItemCount, 12);
    assert.equal(payload.error.details.finalGroupItemCount, 11);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call rejects UUID group ids for export_tracking_data before sending the request", () => {
  const result = runCli([
    "tools",
    "call",
    "--function",
    "export_tracking_data",
    "--body",
    '{"groupId":"89421c97-41f1-44f0-995b-2a742d15b1be","timePeriod":"30d"}',
    "--api-key",
    "test",
    "--json",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /expected a positive integer/i);
  assert.match(result.stderr, /brand-group ids are UUIDs/i);
});

test("tools call prefers body workspace_id over --workspace-id for tracking refresh", async () => {
  let requestUrl = null;
  let requestWorkspaceHeader = null;

  const httpServer = createServer(async (req, res) => {
    requestUrl = req.url;
    requestWorkspaceHeader = req.headers["x-workspace-id"] || null;

    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    if (
      req.method === "POST" &&
      parsedUrl.pathname === "/cli/tools/tracking/42/refresh" &&
      parsedUrl.searchParams.get("workspace_id") === "workspace-from-body"
    ) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "tracking",
      "--workspace-id",
      "workspace-from-flag",
      "--body",
      '{"action":"refresh","itemId":42,"workspace_id":"workspace-from-body"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsedRequestUrl = new URL(requestUrl, "http://127.0.0.1");
    assert.equal(parsedRequestUrl.pathname, "/cli/tools/tracking/42/refresh");
    assert.equal(parsedRequestUrl.searchParams.get("workspace_id"), "workspace-from-body");
    assert.equal(requestWorkspaceHeader, "workspace-from-body");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call preserves body-only workspace scope for export_tracking_data", async () => {
  let requestBody = null;
  let requestWorkspaceHeader = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/export_tracking_data") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");
      requestWorkspaceHeader = req.headers["x-workspace-id"] || null;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "export_tracking_data",
      "--body",
      '{"groupId":42,"timePeriod":"30d","workspaceId":"workspace-from-body"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestWorkspaceHeader, "workspace-from-body");
    assert.deepEqual(requestBody, {
      workspace_id: "workspace-from-body",
      group_id: 42,
      time_period: "30d",
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("data export-tracking sends coerced numeric ids in the request body", async () => {
  let requestBody = null;
  let requestWorkspaceHeader = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/export_tracking_data") {
      requestWorkspaceHeader = req.headers["x-workspace-id"] || null;
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "data",
      "export-tracking",
      "--group-id",
      "42",
      "--item-id",
      "7",
      "--time-period",
      "30d",
      "--workspace-id",
      "workspace-1",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestWorkspaceHeader, "workspace-1");
    assert.deepEqual(requestBody, {
      tracking_item_id: 7,
      group_id: 42,
      time_period: "30d",
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("data export-tracking requires a workspace selection", () => {
  const result = runCli([
    "data",
    "export-tracking",
    "--group-id",
    "42",
    "--time-period",
    "30d",
    "--api-key",
    "test",
    "--json",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /"code":"WORKSPACE_REQUIRED"/);
  assert.match(result.stderr, /before exporting tracking data/i);
});

test("data export-options lists discoverable export flows", () => {
  const result = runCli(["data", "export-options", "--json"]);
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.exports));
  assert.ok(payload.exports.some((entry) => entry.id === "search_results_enriched"));
  assert.ok(Array.isArray(payload.supportedReportTypes));
  assert.ok(payload.supportedReportTypes.includes("search_results_enriched"));
});

test("data export-search-results calls export-data template and downloads the signed CSV artifact", async () => {
  let requestBody = null;
  let requestWorkspaceHeader = null;
  const outFile = path.join(os.tmpdir(), `socialseal-ranked-export-${Date.now()}.csv`);

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/export-data") {
      requestWorkspaceHeader = req.headers["x-workspace-id"] || null;
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");

      const { port } = httpServer.address();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          metadata: {
            status: "completed",
            filename: "ranked.csv",
            file_url: `http://127.0.0.1:${port}/download/ranked.csv`,
          },
        }),
      );
      return;
    }

    if (req.method === "GET" && req.url === "/download/ranked.csv") {
      res.writeHead(200, { "Content-Type": "text/csv" });
      res.end("keyword,rank\nheymax,1\n");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "data",
      "export-search-results",
      "--group-ids",
      "123,124",
      "--tracking-item-ids",
      "7,8",
      "--date-from",
      "2026-01-01T00:00:00Z",
      "--date-to",
      "2026-01-31T23:59:59Z",
      "--workspace-id",
      "workspace-1",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--out",
      outFile,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestWorkspaceHeader, "workspace-1");
    assert.deepEqual(requestBody, {
      template: "tracking_ranked_videos_raw",
      format: "csv",
      payload: {
        workspaceId: "workspace-1",
        groupIds: [123, 124],
        trackingItemIds: [7, 8],
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-01-31T23:59:59.000Z",
      },
    });
    assert.ok(fs.existsSync(outFile));
    assert.equal(fs.readFileSync(outFile, "utf8"), "keyword,rank\nheymax,1\n");
  } finally {
    if (fs.existsSync(outFile)) {
      fs.unlinkSync(outFile);
    }
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("data export-search-results prints an instructive message when export is still processing", async () => {
  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/export-data") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          metadata: {
            status: "processing",
            export_history_id: "exp-123",
          },
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "data",
      "export-search-results",
      "--group-ids",
      "123",
      "--workspace-id",
      "workspace-1",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--pretty",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /still processing/i);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.metadata.status, "processing");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("data export-group-evidence routes social groups to ranked search export", async () => {
  const requests = [];
  const outFile = path.join(os.tmpdir(), `socialseal-evidence-social-${Date.now()}.csv`);

  const httpServer = createServer(async (req, res) => {
    if (req.method === "GET") {
      requests.push({ method: req.method, url: req.url, body: null });

      if (req.url === "/cli/tools/group-management/groups/123?workspace_id=workspace-1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: 123,
            name: "TikTok evidence",
            platform_id: 1,
            platform: "tiktok",
          }),
        );
        return;
      }

      if (req.url === "/download/social-evidence.csv") {
        res.writeHead(200, { "Content-Type": "text/csv" });
        res.end("keyword,rank\nheymax,1\n");
        return;
      }
    }

    if (req.method === "POST" && req.url === "/cli/tools/export-data") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requests.push({
        method: req.method,
        url: req.url,
        body: JSON.parse(body || "{}"),
      });

      const { port } = httpServer.address();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          metadata: {
            status: "completed",
            filename: "social-evidence.csv",
            file_url: `http://127.0.0.1:${port}/download/social-evidence.csv`,
            row_count: 1,
            template: "tracking_ranked_videos_raw",
          },
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "data",
      "export-group-evidence",
      "--group-id",
      "123",
      "--tracking-item-ids",
      "7,8",
      "--date-from",
      "2026-01-01T00:00:00Z",
      "--workspace-id",
      "workspace-1",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--out",
      outFile,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(requests[0], {
      method: "GET",
      url: "/cli/tools/group-management/groups/123?workspace_id=workspace-1",
      body: null,
    });
    assert.deepEqual(requests[1], {
      method: "POST",
      url: "/cli/tools/export-data",
      body: {
        template: "tracking_ranked_videos_raw",
        format: "csv",
        payload: {
          workspaceId: "workspace-1",
          groupIds: [123],
          trackingItemIds: [7, 8],
          dateFrom: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    assert.ok(fs.existsSync(outFile));
    assert.equal(fs.readFileSync(outFile, "utf8"), "keyword,rank\nheymax,1\n");
  } finally {
    if (fs.existsSync(outFile)) {
      fs.unlinkSync(outFile);
    }
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("data export-group-evidence routes Google AI groups to Google AI summaries export and emits metadata", async () => {
  const requests = [];

  const httpServer = createServer(async (req, res) => {
    if (req.method === "GET") {
      requests.push({ method: req.method, url: req.url, body: null });

      if (req.url === "/cli/tools/group-management/groups/456?workspace_id=workspace-1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: 456,
            name: "Google AI evidence",
            platform_id: 11,
            platform: "google_ai",
          }),
        );
        return;
      }
    }

    if (req.method === "POST" && req.url === "/cli/tools/export-data") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requests.push({
        method: req.method,
        url: req.url,
        body: JSON.parse(body || "{}"),
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          metadata: {
            status: "completed",
            filename: "google-ai-evidence.csv",
            row_count: 0,
            template: "google_ai_search_summaries_raw",
          },
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "data",
      "export-group-evidence",
      "--group-id",
      "456",
      "--tracking-item-ids",
      "77",
      "--workspace-id",
      "workspace-1",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--pretty",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /did not include a file URL/i);
    assert.deepEqual(requests[0], {
      method: "GET",
      url: "/cli/tools/group-management/groups/456?workspace_id=workspace-1",
      body: null,
    });
    assert.deepEqual(requests[1], {
      method: "POST",
      url: "/cli/tools/export-data",
      body: {
        template: "google_ai_search_summaries_raw",
        format: "csv",
        payload: {
          workspaceId: "workspace-1",
          groupId: 456,
          trackingItemIds: [77],
        },
      },
    });

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.metadata.status, "completed");
    assert.equal(payload.evidence.group_id, 456);
    assert.equal(payload.evidence.workspace_id, "workspace-1");
    assert.equal(payload.evidence.platform, "google_ai");
    assert.equal(payload.evidence.surface, "google_ai");
    assert.equal(payload.evidence.row_count, 0);
    assert.equal(payload.evidence.header_only, true);
    assert.equal(payload.evidence.template, "google_ai_search_summaries_raw");
    assert.match(payload.evidence.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("data group-completeness reports missing extra and platform mismatches", async () => {
  const manifestPath = path.join(os.tmpdir(), `socialseal-completeness-${Date.now()}.json`);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      items: [
        {
          track_type: "search",
          track_value: "expected present",
          region: "US",
          platform_id: 1,
        },
        {
          track_type: "search",
          track_value: "missing keyword",
          region: "US",
          platform_id: 1,
        },
        {
          track_type: "search",
          track_value: "wrong platform",
          region: "US",
          platform_id: 1,
        },
      ],
    }),
  );

  const httpServer = createServer(async (req, res) => {
    if (
      req.method === "POST" &&
      req.url?.startsWith("/cli/tools/group-management/groups/321/completeness?")
    ) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
      return;
    }

    if (
      req.method === "GET" &&
      req.url?.startsWith("/cli/tools/group-management/groups/321/items?")
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: [
            {
              id: 1,
              user_tracking: {
                id: 10,
                track_type: "search",
                track_value: "expected present",
                region: "US",
                platform_id: 1,
              },
            },
            {
              id: 2,
              user_tracking: {
                id: 11,
                track_type: "search",
                track_value: "wrong platform",
                region: "US",
                platform_id: 2,
              },
            },
            {
              id: 3,
              user_tracking: {
                id: 12,
                track_type: "search",
                track_value: "extra keyword",
                region: "US",
                platform_id: 1,
              },
            },
          ],
          total: 3,
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "data",
      "group-completeness",
      "--group-id",
      "321",
      "--manifest",
      `@${manifestPath}`,
      "--workspace-id",
      "workspace-1",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 5, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.success, false);
    assert.equal(payload.complete, false);
    assert.equal(payload.group_id, 321);
    assert.equal(payload.workspace_id, "workspace-1");
    assert.equal(payload.source, "manifest_fallback");
    assert.equal(payload.expected_count, 3);
    assert.equal(payload.actual_count, 3);
    assert.equal(payload.missing_count, 1);
    assert.equal(payload.extra_count, 1);
    assert.equal(payload.platform_mismatch_count, 1);
    assert.equal(payload.missing[0].track_value, "missing keyword");
    assert.equal(payload.extra[0].track_value, "extra keyword");
    assert.equal(payload.platform_mismatches[0].expected_platform, "id:1");
    assert.equal(payload.platform_mismatches[0].actual_platform, "id:2");
  } finally {
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath);
    }
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("data group-completeness exits zero when manifest matches group items", async () => {
  const httpServer = createServer(async (req, res) => {
    if (
      req.method === "POST" &&
      req.url?.startsWith("/cli/tools/group-management/groups/322/completeness?")
    ) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
      return;
    }

    if (
      req.method === "GET" &&
      req.url?.startsWith("/cli/tools/group-management/groups/322/items?")
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: [
            {
              id: 1,
              user_tracking: {
                id: 99,
                track_type: "search",
                track_value: "present keyword",
                region: "SG",
                platform_id: 1,
              },
            },
          ],
          total: 1,
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "data",
      "group-completeness",
      "--group-id",
      "322",
      "--manifest",
      '{"items":[{"track_type":"search","track_value":"present keyword","region":"SG","platform_id":1}]}',
      "--workspace-id",
      "workspace-1",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.success, true);
    assert.equal(payload.complete, true);
    assert.equal(payload.source, "manifest_fallback");
    assert.equal(payload.missing_count, 0);
    assert.equal(payload.extra_count, 0);
    assert.equal(payload.platform_mismatch_count, 0);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("data group-completeness uses backend completeness when available", async () => {
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    if (
      req.method === "POST" &&
      req.url?.startsWith("/cli/tools/group-management/groups/323/completeness?")
    ) {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: false,
          complete: false,
          source: "backend",
          group_id: 323,
          workspace_id: "workspace-1",
          expected_count: 1,
          actual_count: 0,
          missing_count: 1,
          extra_count: 0,
          platform_mismatch_count: 0,
          missing: [{ track_value: "missing keyword" }],
          extra: [],
          platform_mismatches: [],
          refresh_status: {
            active: true,
            active_count: 1,
            counts_by_status: { processing: 1 },
            latest_error: null,
          },
        }),
      );
      return;
    }

    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("fallback should not be called");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "data",
      "group-completeness",
      "--group-id",
      "323",
      "--manifest",
      '{"items":[{"track_type":"search","track_value":"missing keyword","region":"SG","platform_id":1}]}',
      "--workspace-id",
      "workspace-1",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 5, result.stderr || result.stdout);
    assert.deepEqual(requestBody, {
      expected_items: [
        {
          track_type: "search",
          track_value: "missing keyword",
          region: "SG",
          platform_id: 1,
        },
      ],
      include_refresh_status: true,
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.source, "backend");
    assert.equal(payload.complete, false);
    assert.equal(payload.refresh_status.active, true);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("data export-report search_results_enriched alias routes to export-data template", async () => {
  let requestBody = null;
  let requestWorkspaceHeader = null;
  const outFile = path.join(os.tmpdir(), `socialseal-ranked-alias-${Date.now()}.csv`);

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/export-data") {
      requestWorkspaceHeader = req.headers["x-workspace-id"] || null;
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");
      const { port } = httpServer.address();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          metadata: {
            status: "completed",
            filename: "alias.csv",
            file_url: `http://127.0.0.1:${port}/download/alias.csv`,
          },
        }),
      );
      return;
    }

    if (req.method === "GET" && req.url === "/download/alias.csv") {
      res.writeHead(200, { "Content-Type": "text/csv" });
      res.end("keyword,rank\npoints,2\n");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "data",
      "export-report",
      "--report-type",
      "search_results_enriched",
      "--format",
      "csv",
      "--payload",
      '{"groupIds":[200,201],"dateFrom":"2026-02-01T00:00:00Z"}',
      "--workspace-id",
      "workspace-2",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--out",
      outFile,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestWorkspaceHeader, "workspace-2");
    assert.deepEqual(requestBody, {
      template: "tracking_ranked_videos_raw",
      format: "csv",
      payload: {
        workspaceId: "workspace-2",
        groupIds: [200, 201],
        dateFrom: "2026-02-01T00:00:00.000Z",
      },
    });
    assert.ok(fs.existsSync(outFile));
    assert.equal(fs.readFileSync(outFile, "utf8"), "keyword,rank\npoints,2\n");
  } finally {
    if (fs.existsSync(outFile)) {
      fs.unlinkSync(outFile);
    }
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("data export-report search_results_enriched rejects non-csv formats", () => {
  const result = runCli([
    "data",
    "export-report",
    "--report-type",
    "search_results_enriched",
    "--format",
    "json",
    "--payload",
    '{"groupIds":[123]}',
    "--workspace-id",
    "workspace-1",
    "--api-key",
    "test",
    "--json",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /supports only csv format/i);
});

test("data export-report rejects unsupported report types with guidance", () => {
  const result = runCli([
    "data",
    "export-report",
    "--report-type",
    "ranked_search_raw",
    "--format",
    "csv",
    "--payload",
    '{"groupIds":[123]}',
    "--workspace-id",
    "workspace-1",
    "--api-key",
    "test",
    "--json",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unsupported report type/i);
  assert.match(result.stderr, /export-options/i);
});

test("tools call uses the configured default workspace when no --workspace-id flag is provided", async () => {
  let requestBody = null;
  let requestWorkspaceHeader = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/vnext-intents") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");
      requestWorkspaceHeader = req.headers["x-workspace-id"] || null;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  const configPath = createTempConfig({ workspaceId: "workspace-from-config" });

  try {
    const result = await runCliAsync(
      [
        "tools",
        "call",
        "--function",
        "vnext-intents",
        "--body",
        '{"action":"list"}',
        "--api-key",
        "test",
        "--api-base",
        `http://127.0.0.1:${port}`,
        "--json",
      ],
      {
        env: {
          SOCIALSEAL_CONFIG: configPath,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestWorkspaceHeader, "workspace-from-config");
    assert.deepEqual(requestBody, {
      action: "list",
      workspaceId: "workspace-from-config",
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call rejects group-management without a workspace selection", () => {
  const result = runCli([
    "tools",
    "call",
    "--function",
    "group-management",
    "--body",
    '{"action":"list"}',
    "--api-key",
    "test",
    "--json",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /"code":"WORKSPACE_REQUIRED"/);
  assert.match(result.stderr, /personal workspace/i);
});

test("tools call rejects Asset Studio tools without a workspace selection", () => {
  const result = runCli([
    "tools",
    "call",
    "--function",
    "vnext-clips-read",
    "--body",
    "{}",
    "--api-key",
    "test",
    "--json",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /"code":"WORKSPACE_REQUIRED"/);
  assert.match(result.stderr, /vnext-clips-read/);
});

test("tools call rejects video production tools without a workspace selection", () => {
  const result = runCli([
    "tools",
    "call",
    "--function",
    "vnext-blueprints-shots-read",
    "--body",
    '{"blueprintId":"22222222-2222-4222-8222-222222222222"}',
    "--api-key",
    "test",
    "--json",
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /"code":"WORKSPACE_REQUIRED"/);
  assert.match(result.stderr, /vnext-blueprints-shots-read/);
});

test("tools call accepts body workspace for generated asset share create", async () => {
  let requestBody = null;
  let requestWorkspaceHeader = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/vnext-generated-asset-share") {
      requestWorkspaceHeader = req.headers["x-workspace-id"] || null;
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "vnext-generated-asset-share",
      "--body",
      '{"action":"create","workspaceId":"workspace-in-body","assetId":"asset-1"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestWorkspaceHeader, "workspace-in-body");
    assert.deepEqual(requestBody, {
      action: "create",
      workspaceId: "workspace-in-body",
      assetId: "asset-1",
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call warns when tracking create runs without a workspace", async () => {
  let requestUrl = null;
  let requestWorkspaceHeader = null;
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/tracking") {
      requestUrl = req.url;
      requestWorkspaceHeader = req.headers["x-workspace-id"] || null;
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 27926, workspace_id: null }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "tools",
      "call",
      "--function",
      "tracking",
      "--body",
      '{"action":"create","name":"daily commute miles earning","type":"keyword","value":"daily commute miles earning","region":"SG","platform":"tiktok"}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestUrl, "/cli/tools/tracking");
    assert.equal(requestWorkspaceHeader, null);
    assert.deepEqual(requestBody, {
      name: "daily commute miles earning",
      track_type: "search",
      track_value: "daily commute miles earning",
      region: "SG",
      platform: "tiktok",
    });
    assert.match(result.stderr, /personal\/null-scope item/i);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call polls async search-journey-run to completion", async () => {
  const requestBodies = [];
  let statusPolls = 0;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/search-journey-run") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      const parsed = JSON.parse(body || "{}");
      requestBodies.push(parsed);

      if (parsed.action === "status") {
        statusPolls += 1;
        if (statusPolls === 1) {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              journeyId: "journey-1",
              runId: "run-1",
              paramsFingerprint: "fp-1",
              status: "processing",
              error: null,
              stagedKeywords: [],
            }),
          );
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            journeyId: "journey-1",
            runId: "run-1",
            paramsFingerprint: "fp-1",
            status: "completed",
            error: null,
            stagedKeywords: [
              {
                keyword: "heymax",
                canonicalKeyword: "heymax",
                stage: "awareness",
                source: "seed",
                confidence: 1,
              },
            ],
          }),
        );
        return;
      }

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          journeyId: "journey-1",
          runId: "run-1",
          paramsFingerprint: "fp-1",
          status: "pending",
          error: null,
          stagedKeywords: [],
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync(
      [
        "tools",
        "call",
        "--function",
        "search-journey-run",
        "--body",
        '{"subject":"Heymax","subjectType":"brand","region":"SG","locale":"en-SG"}',
        "--workspace-id",
        "workspace-async",
        "--async",
        "--poll-interval",
        "10",
        "--timeout",
        "1000",
        "--api-key",
        "test",
        "--api-base",
        `http://127.0.0.1:${port}`,
        "--json",
      ],
      {
        timeout: 4000,
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestBodies.length, 3);
    assert.equal(requestBodies[0].executionMode, "async");
    assert.equal(requestBodies[0].workspaceId, "workspace-async");
    assert.deepEqual(requestBodies[1], {
      action: "status",
      workspaceId: "workspace-async",
      runId: "run-1",
    });

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.runId, "run-1");
    assert.equal(payload.stagedKeywords[0].keyword, "heymax");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools call can return async search-journey-run start responses without polling", async () => {
  const requestBodies = [];

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/search-journey-run") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBodies.push(JSON.parse(body || "{}"));

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          journeyId: "journey-1",
          runId: "run-1",
          paramsFingerprint: "fp-1",
          status: "pending",
          error: null,
          stagedKeywords: [],
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync(
      [
        "tools",
        "call",
        "--function",
        "search-journey-run",
        "--body",
        '{"subject":"Heymax","subjectType":"brand","region":"SG","locale":"en-SG"}',
        "--workspace-id",
        "workspace-async",
        "--async",
        "--no-poll",
        "--timeout",
        "1000",
        "--api-key",
        "test",
        "--api-base",
        `http://127.0.0.1:${port}`,
        "--json",
      ],
      {
        timeout: 4000,
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestBodies.length, 1);
    assert.equal(requestBodies[0].executionMode, "async");

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "pending");
    assert.equal(payload.runId, "run-1");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("workspace use persists the selected default workspace to config", async () => {
  const httpServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/cli/workspaces") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            workspaces: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                name: "Personal Workspace",
                slug: "personal-workspace",
                role: "owner",
                isPersonalWorkspace: true,
              },
              {
                id: "22222222-2222-4222-8222-222222222222",
                name: "Team Workspace",
                slug: "team-workspace",
                role: "admin",
                isPersonalWorkspace: false,
              },
            ],
            personalWorkspaceId: "11111111-1111-4111-8111-111111111111",
            defaultWorkspaceId: "11111111-1111-4111-8111-111111111111",
            scope: {
              allowAllWorkspaces: true,
              allowedWorkspaceIds: null,
            },
          },
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  const configPath = createTempConfig({ apiKey: "test" });

  try {
    const result = await runCliAsync(
      [
        "workspace",
        "use",
        "team-workspace",
        "--api-key",
        "test",
        "--api-base",
        `http://127.0.0.1:${port}`,
        "--json",
      ],
      {
        env: {
          SOCIALSEAL_CONFIG: configPath,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(config.workspaceId, "22222222-2222-4222-8222-222222222222");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("workspace list explains that workspace ids are not brand ids", async () => {
  const httpServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/cli/workspaces") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            workspaces: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                name: "Heymax",
                slug: "heymax",
                role: "owner",
                isPersonalWorkspace: false,
              },
            ],
            personalWorkspaceId: "99999999-9999-4999-8999-999999999999",
            defaultWorkspaceId: "11111111-1111-4111-8111-111111111111",
            scope: {
              allowAllWorkspaces: true,
              allowedWorkspaceIds: null,
            },
          },
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "workspace",
      "list",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /workspace ids are not brand ids/i);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("agent run fails fast on websocket error events", async () => {
  const httpServer = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/cli/agent/session") {
      const { port } = httpServer.address();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            sessionId: "session-test",
            activeConversationId: "conversation-test",
            websocketUrl: `ws://127.0.0.1:${port}/cli/agent/ws?ws_token=test`,
          },
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    socket.on("message", () => {
      socket.send(
        JSON.stringify({
          type: "error",
          payload: {
            code: "AI_ERROR",
            message: "Backend failed",
            retryable: false,
            errorId: "err_cli_test",
          },
          timestamp: Date.now(),
        }),
      );
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/cli/agent/ws")) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "agent",
      "run",
      "--message",
      "ping",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--verbose",
    ]);

    assert.equal(result.status, 5, result.stderr || result.stdout);
    assert.match(result.stderr, /Agent error: Backend failed/);
    assert.match(result.stderr, /err_cli_test/);
    assert.ok(!/timed out/i.test(result.stderr), result.stderr);
  } finally {
    for (const client of wss.clients) {
      client.close();
    }
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("video extract builds a tracked-video-extract request with workspace scope and defaults", async () => {
  let requestWorkspaceHeader = null;
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/tracked-video-extract") {
      requestWorkspaceHeader = req.headers["x-workspace-id"] || null;
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ workspaceId: requestBody.workspaceId, results: [] }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "video",
      "extract",
      "--search-result-id",
      "123",
      "--workspace-id",
      "11111111-1111-4111-8111-111111111111",
      "--frame-count",
      "2",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestWorkspaceHeader, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual(requestBody, {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      items: [{ searchResultId: 123 }],
      ensureAnalysis: false,
      includeAssets: true,
      includeSourceVideo: false,
      frameStrategy: "brief_shots",
      frameCount: 2,
      signedUrlSeconds: 3600,
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("video extract builds an ad hoc URL request with allowUntracked and wait defaults", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "socialseal-video-url-extract-"));
  let requestWorkspaceHeader = null;
  let requestBody = null;
  let requestCount = 0;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/tracked-video-extract") {
      requestCount += 1;
      requestWorkspaceHeader = req.headers["x-workspace-id"] || null;
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          workspaceId: requestBody.workspaceId,
          results: [
            {
              request: requestBody.items[0],
              status: "completed",
              resolved: { videoUid: "video-url-1" },
              analysis: { normalizedStatus: "completed" },
              assets: {},
              failures: [],
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "video",
      "extract",
      "--url",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "--allow-untracked",
      "--wait",
      "--out-dir",
      outDir,
      "--workspace-id",
      "11111111-1111-4111-8111-111111111111",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestCount, 1);
    assert.equal(requestWorkspaceHeader, "11111111-1111-4111-8111-111111111111");
    assert.deepEqual(requestBody, {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      items: [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }],
      allowUntracked: true,
      ensureAnalysis: true,
      includeAssets: true,
      includeSourceVideo: false,
      frameStrategy: "brief_shots",
      frameCount: 3,
      signedUrlSeconds: 3600,
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.downloadsRoot, path.resolve(outDir));
    assert.equal(payload.results[0].request.url, requestBody.items[0].url);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("video queue-analysis sends URL items with request-level allowUntracked and normalized wait", async () => {
  const requestBodies = [];

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/tracked-video-extract") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      const parsed = JSON.parse(body || "{}");
      requestBodies.push(parsed);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          workspaceId: parsed.workspaceId,
          results: [
            requestBodies.length === 1
              ? {
                  request: parsed.items[0],
                  status: "processing",
                  resolvedVideo: {
                    videoUid: "video-url-queued",
                    platformVideoId: "7348293840000000000",
                    platformId: 1,
                  },
                  analysis: { normalizedStatus: "processing", jobId: "job-1" },
                  failures: [],
                }
              : {
                  request: parsed.items[0],
                  status: "completed",
                  analysis: {
                    normalizedStatus: "completed",
                    resultId: "analysis-1",
                  },
                  failures: [],
                },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync(
      [
        "video",
        "queue-analysis",
        "--url",
        "https://www.tiktok.com/@creator/video/7348293840000000000",
        "--allow-untracked",
        "--wait",
        "--poll-interval",
        "10",
        "--workspace-id",
        "11111111-1111-4111-8111-111111111111",
        "--api-key",
        "test",
        "--api-base",
        `http://127.0.0.1:${port}`,
        "--json",
      ],
      { timeout: 8000 },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestBodies.length, 2);
    assert.deepEqual(requestBodies[0], {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      items: [
        {
          url: "https://www.tiktok.com/@creator/video/7348293840000000000",
        },
      ],
      allowUntracked: true,
      ensureAnalysis: true,
      includeAssets: false,
      includeSourceVideo: false,
      frameStrategy: "brief_shots",
      frameCount: 3,
      signedUrlSeconds: 3600,
      queueOnly: true,
      includeRawAnalysis: false,
    });
    assert.deepEqual(requestBodies[1], {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      action: "status",
      items: [{ videoUid: "video-url-queued" }],
      includeRawAnalysis: false,
      includeAssets: false,
      includeSourceVideo: false,
      ensureAnalysis: false,
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.results[0].status, "completed");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("video URL analysis requires allowUntracked before sending the request", async () => {
  let requestCount = 0;

  const httpServer = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/tracked-video-extract") {
      requestCount += 1;
    }
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("should not be called");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "video",
      "extract",
      "--url",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "--workspace-id",
      "11111111-1111-4111-8111-111111111111",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(requestCount, 0);
    assert.match(result.stderr, /requires --allow-untracked/i);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("video extract preserves upstream URL failure details", async () => {
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/tracked-video-extract") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "URL resolve failed",
          error_code: "PROVIDER_UNAVAILABLE",
          results: [
            {
              request: requestBody.items[0],
              status: "failed",
              failures: [
                {
                  code: "PROVIDER_UNAVAILABLE",
                  message: "provider unavailable for URL",
                },
              ],
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "video",
      "extract",
      "--url",
      "https://www.instagram.com/reel/SHORTCODE/",
      "--allow-untracked",
      "--workspace-id",
      "11111111-1111-4111-8111-111111111111",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--verbose",
      "--json",
    ]);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(requestBody.allowUntracked, true);
    assert.match(result.stderr, /Tracked video extract failed: 422/);
    assert.match(result.stderr, /PROVIDER_UNAVAILABLE/);
    assert.match(result.stderr, /provider unavailable for URL/);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("video extract warns when --video-id looks like a short internal row id", async () => {
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/tracked-video-extract") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ workspaceId: requestBody.workspaceId, results: [] }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "video",
      "extract",
      "--video-id",
      "27924",
      "--workspace-id",
      "11111111-1111-4111-8111-111111111111",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(requestBody, {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      items: [{ videoId: "27924" }],
      ensureAnalysis: false,
      includeAssets: true,
      includeSourceVideo: false,
      frameStrategy: "brief_shots",
      frameCount: 3,
      signedUrlSeconds: 3600,
    });
    assert.match(result.stderr, /looks like a short internal row id/i);
    assert.match(result.stderr, /search-result-id/i);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("video queue-analysis sends queue-only analysis requests for batch payloads", async () => {
  let requestBody = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/tracked-video-extract") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requestBody = JSON.parse(body || "{}");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          workspaceId: requestBody.workspaceId,
          results: [
            {
              analysis: { status: "pending" },
              assets: { thumbnail: null, frames: [] },
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "video",
      "queue-analysis",
      "--body",
      '{"workspaceId":"11111111-1111-4111-8111-111111111111","items":[{"videoId":"734829384"},{"platformVideoId":"native-2"}]}',
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(requestBody, {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      items: [{ videoId: "734829384" }, { platformVideoId: "native-2" }],
      ensureAnalysis: true,
      queueOnly: true,
      includeAssets: false,
      includeRawAnalysis: false,
      includeSourceVideo: false,
      frameStrategy: "brief_shots",
      frameCount: 3,
      signedUrlSeconds: 3600,
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("video extract polls until pending analysis settles when --wait is enabled", async () => {
  let requestCount = 0;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/tracked-video-extract") {
      requestCount += 1;
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      const parsed = JSON.parse(body || "{}");
      const payload =
        requestCount === 1
          ? {
              workspaceId: parsed.workspaceId,
              results: [
                {
                  resolved: { videoUid: "video-1" },
                  analysis: { status: "pending" },
                  assets: {
                    thumbnail: { status: "missing", url: null },
                    frames: [],
                  },
                },
              ],
            }
          : {
              workspaceId: parsed.workspaceId,
              results: [
                {
                  resolved: { videoUid: "video-1" },
                  analysis: { status: "completed" },
                  assets: {
                    thumbnail: { status: "missing", url: null },
                    frames: [],
                  },
                },
              ],
            };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync(
      [
        "video",
        "extract",
        "--video-uid",
        "video-1",
        "--workspace-id",
        "11111111-1111-4111-8111-111111111111",
        "--wait",
        "--poll-interval",
        "10",
        "--api-key",
        "test",
        "--api-base",
        `http://127.0.0.1:${port}`,
        "--json",
      ],
      { timeout: 8000 },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(requestCount, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.results[0].analysis.status, "completed");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("video extract polls normalized queued states and stops on terminal failures", async () => {
  let queuedRequestCount = 0;
  let failedRequestCount = 0;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/tracked-video-extract") {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      const parsed = JSON.parse(body || "{}");
      const item = parsed.items?.[0] || {};

      if (item.videoUid === "video-queued") {
        queuedRequestCount += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            workspaceId: parsed.workspaceId,
            results: [
              queuedRequestCount === 1
                ? {
                    request: item,
                    status: "queued",
                    resolvedVideo: { videoUid: "video-queued" },
                    analysis: { normalizedStatus: "queued", jobId: "job-1" },
                    artifacts: {},
                    failures: [],
                  }
                : {
                    request: item,
                    status: "completed",
                    resolvedVideo: { videoUid: "video-queued" },
                    analysis: {
                      normalizedStatus: "completed",
                      resultId: "result-1",
                    },
                    artifacts: {},
                    failures: [],
                  },
            ],
          }),
        );
        return;
      }

      failedRequestCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          workspaceId: parsed.workspaceId,
          results: [
            {
              request: item,
              status: "failed",
              resolvedVideo: { videoUid: "video-failed" },
              analysis: {
                normalizedStatus: "failed",
                failureReason: "provider timed out",
              },
              failures: [{ code: "ANALYSIS_FAILED" }],
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const queued = await runCliAsync(
      [
        "video",
        "extract",
        "--video-uid",
        "video-queued",
        "--workspace-id",
        "11111111-1111-4111-8111-111111111111",
        "--wait",
        "--poll-interval",
        "10",
        "--api-key",
        "test",
        "--api-base",
        `http://127.0.0.1:${port}`,
        "--json",
      ],
      { timeout: 8000 },
    );

    assert.equal(queued.status, 0, queued.stderr || queued.stdout);
    assert.equal(queuedRequestCount, 2);
    assert.equal(JSON.parse(queued.stdout).results[0].status, "completed");

    const failed = await runCliAsync(
      [
        "video",
        "extract",
        "--video-uid",
        "video-failed",
        "--workspace-id",
        "11111111-1111-4111-8111-111111111111",
        "--wait",
        "--poll-interval",
        "10",
        "--api-key",
        "test",
        "--api-base",
        `http://127.0.0.1:${port}`,
        "--json",
      ],
      { timeout: 8000 },
    );

    assert.equal(failed.status, 0, failed.stderr || failed.stdout);
    assert.equal(failedRequestCount, 1);
    assert.equal(JSON.parse(failed.stdout).results[0].status, "failed");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("video extract downloads returned assets into --out-dir", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "socialseal-video-extract-"));

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/tools/tracked-video-extract") {
      const { port } = httpServer.address();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          workspaceId: "11111111-1111-4111-8111-111111111111",
          results: [
            {
              resolved: {
                videoUid: "vid-1",
                platformVideoId: "platform-1",
              },
              analysis: {
                status: "completed",
              },
              assets: {
                thumbnail: {
                  status: "ok",
                  url: `http://127.0.0.1:${port}/assets/thumb.jpg`,
                },
                sourceVideo: {
                  status: "ok",
                  signedUrl: `http://127.0.0.1:${port}/assets/source.mp4`,
                },
                frames: [
                  {
                    kind: "poster_frame",
                    timestamp: "0:03",
                    signedUrl: `http://127.0.0.1:${port}/assets/frame.jpg`,
                  },
                ],
              },
            },
          ],
        }),
      );
      return;
    }

    if (req.method === "GET" && req.url === "/assets/thumb.jpg") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(Buffer.from("thumb-bytes"));
      return;
    }

    if (req.method === "GET" && req.url === "/assets/frame.jpg") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(Buffer.from("frame-bytes"));
      return;
    }

    if (req.method === "GET" && req.url === "/assets/source.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(Buffer.from("source-bytes"));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();

  try {
    const result = await runCliAsync([
      "video",
      "extract",
      "--search-result-id",
      "321",
      "--workspace-id",
      "11111111-1111-4111-8111-111111111111",
      "--include-source-video",
      "--out-dir",
      outDir,
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--pretty",
      "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.downloadsRoot, path.resolve(outDir));
    assert.ok(fs.existsSync(payload.results[0].downloads.thumbnail.path));
    assert.ok(fs.existsSync(payload.results[0].downloads.sourceVideo.path));
    assert.ok(fs.existsSync(payload.results[0].downloads.frames[0].path));
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("agent run uses the configured default workspace when no --workspace-id flag is provided", async () => {
  let sessionWorkspaceHeader = null;

  const httpServer = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/cli/agent/session") {
      sessionWorkspaceHeader = req.headers["x-workspace-id"] || null;
      const { port } = httpServer.address();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            sessionId: "session-configured",
            activeConversationId: "conversation-configured",
            workspaceId: "11111111-1111-4111-8111-111111111111",
            websocketUrl: `ws://127.0.0.1:${port}/cli/agent/ws?ws_token=test`,
          },
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    socket.on("message", () => {
      socket.send(
        JSON.stringify({
          type: "assistant_chunk",
          payload: { chunk: "ok", done: true },
          timestamp: Date.now(),
        }),
      );
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/cli/agent/ws")) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  const configPath = createTempConfig({
    workspaceId: "11111111-1111-4111-8111-111111111111",
  });

  try {
    const result = await runCliAsync(
      [
        "agent",
        "run",
        "--message",
        "configured run",
        "--api-key",
        "test",
        "--api-base",
        `http://127.0.0.1:${port}`,
      ],
      {
        env: {
          SOCIALSEAL_CONFIG: configPath,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(sessionWorkspaceHeader, "11111111-1111-4111-8111-111111111111");
  } finally {
    for (const client of wss.clients) {
      client.close();
    }
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("tools registry and schema expose the released Explore contract", () => {
  const list = runCli(["tools", "list", "--json"]);
  assert.equal(list.status, 0);
  const tool = JSON.parse(list.stdout).tools.find((entry) => entry.name === "explore-api");
  assert.equal(tool.category, "explore");
  assert.equal(tool.workspaceScoped, true);
  assert.equal(tool.schemaAvailable, true);

  const schema = runCli(["tools", "schema", "--function", "explore-api", "--json"]);
  assert.equal(schema.status, 0);
  const operations = JSON.parse(schema.stdout).schema.operations.map((entry) => entry.action);
  assert.ok(operations.includes("startLineage"));
  assert.ok(operations.includes("activateSearches"));
  assert.ok(operations.includes("applyInterpretationCorrection"));
  assert.ok(operations.includes("createDeliverable"));
});

test("first-class Explore correction, activation preview, and deliverable commands preserve canonical actions", async () => {
  const observed = [];
  const httpServer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    observed.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: { ok: true } }));
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  const common = [
    "--api-key",
    "test",
    "--api-base",
    `http://127.0.0.1:${port}`,
    "--workspace-id",
    "workspace-explore",
    "--json",
  ];
  try {
    const correction = await runCliAsync([
      "explore",
      "correct",
      ...common,
      "--body",
      JSON.stringify({
        lineageId: "11111111-1111-4111-8111-111111111111",
        snapshotId: "22222222-2222-4222-8222-222222222222",
        expectedRevisionId: null,
        labels: [],
        memberships: [],
        idempotencyKey: "correction-1",
      }),
    ]);
    const preview = await runCliAsync([
      "explore",
      "preview-activation",
      ...common,
      "--selection-id",
      "33333333-3333-4333-8333-333333333333",
    ]);
    const deliverable = await runCliAsync([
      "explore",
      "deliverable",
      ...common,
      "--selection-id",
      "33333333-3333-4333-8333-333333333333",
      "--idempotency-key",
      "deliverable-1",
    ]);
    assert.equal(correction.status, 0, correction.stderr);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(deliverable.status, 0, deliverable.stderr);
    assert.deepEqual(
      observed.map(({ action }) => action),
      ["applyInterpretationCorrection", "activationPreview", "createDeliverable"],
    );
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("Explore CLI enforces canonical read limits before calling the backend", () => {
  const result = runCli([
    "explore",
    "get",
    "--workspace-id",
    "workspace-explore",
    "--resource",
    "snapshot",
    "--snapshot-id",
    "33333333-3333-4333-8333-333333333333",
    "--page-size",
    "501",
    "--api-key",
    "test",
    "--json",
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /canonical limit/i);
});

test("Explore CLI rejects empty, excluded-only, and contradictory selections before transport", () => {
  const base = {
    lineageId: "11111111-1111-4111-8111-111111111111",
    snapshotId: "22222222-2222-4222-8222-222222222222",
    interpretationRevisionId: "33333333-3333-4333-8333-333333333333",
    intendedDestination: "monitor",
    intendedUse: "focused demand monitoring",
    idempotencyKey: "selection-1",
  };
  const cases = [
    { items: [], message: /included item/i },
    {
      items: [{ itemKind: "search_term", targetId: "44444444-4444-4444-8444-444444444444", inclusionState: "excluded" }],
      message: /included item/i,
    },
    {
      items: [
        { itemKind: "search_term", targetId: "44444444-4444-4444-8444-444444444444", inclusionState: "included" },
        { itemKind: "search_term", targetId: "44444444-4444-4444-8444-444444444444", inclusionState: "excluded" },
      ],
      message: /identit/i,
    },
  ];
  for (const { items, message } of cases) {
    const result = runCli([
      "explore",
      "select",
      "--workspace-id",
      "workspace-explore",
      "--body",
      JSON.stringify({ ...base, items }),
      "--api-key",
      "test",
      "--json",
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, message);
  }
});

test("explore start forwards the canonical body and workspace without a second pipeline", async () => {
  const httpServer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    assert.equal(req.url, "/cli/tools/explore-api");
    assert.equal(req.headers["x-workspace-id"], "workspace-explore");
    const parsed = JSON.parse(body);
    assert.equal(parsed.action, "startLineage");
    assert.equal(parsed.workspaceId, "workspace-explore");
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        result: { runId: "11111111-1111-4111-8111-111111111111" },
        evidenceRefs: [{ id: "evidence-1" }],
      }),
    );
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  try {
    const result = await runCliAsync([
      "explore",
      "start",
      "--api-key",
      "test",
      "--api-base",
      `http://127.0.0.1:${port}`,
      "--workspace-id",
      "workspace-explore",
      "--body",
      JSON.stringify({
        anchor: { anchorKind: "search_term", subjectId: "22222222-2222-4222-8222-222222222222" },
        marketCode: "SG",
        languageTag: "en",
        previewFingerprint: "preview-1",
        idempotencyKey: "start-1",
      }),
      "--no-poll",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.evidenceRefs, [{ id: "evidence-1" }]);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
