import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.resolve(__dirname, "..", "src", "entry.js");

function runEntry(args, env = {}) {
  return spawnSync(process.execPath, [entryPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 8000,
  });
}

test("installed CLI entrypoint does not expose the conversational agent", () => {
  const help = runEntry(["--help"]);
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.doesNotMatch(help.stdout, /^\s+agent\b/im);
  assert.doesNotMatch(help.stdout, /socialseal agent run/i);

  const result = runEntry(["agent", "run", "--message", "ping"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown command ['"]agent['"]/i);
});

test("installed CLI entrypoint includes Explore when the CLI policy allows it", () => {
  const result = runEntry(["--help"], {
    EXPLORE_FEATURE_POLICY: JSON.stringify({ mode: "live", allowedChannels: ["cli"] }),
    SOCIALSEAL_CONFIG: "/tmp/socialseal-cli-entry-test-config.json",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^\s+explore\b/im);
});
