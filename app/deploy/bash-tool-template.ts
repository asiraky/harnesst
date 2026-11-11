/**
 * The generated `bash` tool, baked into EVERY agent image in place of eve's framework `bash`.
 *
 * eve 0.22.6's framework `bash` has no timeout, and nothing in eve ever aborts a running turn: a
 * command that never exits (a test runner whose teardown leaves a `workerd` alive, a dev server
 * started in the foreground) parks the whole turn forever. For a ledger-woken agent that also
 * holds the issue's lease, so the team stalls with nobody told. This tool is the same shell runner
 * with a wall clock: the command runs under `timeout`, which kills its whole process group, and a
 * killed command comes back as an ordinary result the model can act on.
 *
 * eve lets an authored `agent/tools/bash.ts` replace the framework tool of the same name; it is
 * written at the agent root (the inline `agent` copies share the root's tools) and into every
 * declared subagent, which does not inherit the root's tools. A repo file at a path wins.
 *
 * Same contract as the other generated files: imports only `eve/tools`, plain JavaScript in a
 * `.ts` file, and `execute` never throws.
 */

export const BASH_TOOL_FILE = "tools/bash.ts";

export const BASH_TOOL_SOURCE = `// @ts-nocheck -- generated, plain JS: harnesst bakes this into every agent image.
import { defineTool } from "eve/tools";

// harnesst replaces eve's framework bash with this file (see app/deploy/bash-tool-template.ts):
// the same tool, but a command that runs too long is killed instead of hanging the turn forever.
// Do not edit; a repo file at this path overrides it.

var DEFAULT_SECONDS = 600;
var MAX_SECONDS = 3600;
var KILL_GRACE_SECONDS = 10;
// Backstop past timeout's own kill, for a process that escaped its group (setsid) and holds the
// output open: eve kills the whole tree inside the sandbox when the signal aborts.
var BACKSTOP_SECONDS = 30;
// eve's own output limits, so results look the same as the framework tool's.
var MAX_LINES = 2000;
var MAX_BYTES = 50 * 1024;
var MAX_LINE = 2000;

function limitSeconds(value) {
  if (typeof value !== "number" || !isFinite(value) || value <= 0) return DEFAULT_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(1, Math.ceil(value)));
}

function quote(text) {
  return "'" + text.replace(/'/g, "'\\\\''") + "'";
}

/** Keep the end of the output, where errors and results are. */
function tail(text, name) {
  var body = String(text || "");
  var ending = body.endsWith("\\n") ? "\\n" : "";
  var lines = ending ? body.slice(0, -1).split("\\n") : body.split("\\n");
  var total = body ? lines.length : 0;
  var kept = [];
  var bytes = 0;
  var capped = false;
  for (var i = lines.length - 1; i >= 0 && kept.length < MAX_LINES; i--) {
    var line = lines[i];
    if (line.length > MAX_LINE) {
      line = line.slice(0, MAX_LINE) + " [truncated]";
      capped = true;
    }
    var size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size > MAX_BYTES && kept.length > 0) break;
    kept.unshift(line);
    bytes += size;
  }
  if (kept.length >= total) {
    return capped ? { output: kept.join("\\n") + ending, truncated: true } : { output: body, truncated: false };
  }
  return {
    output: "[" + name + " truncated: showing last " + kept.length + " of " + total + " lines]\\n" + kept.join("\\n") + ending,
    truncated: true,
  };
}

function killedNote(seconds) {
  return (
    "[The command was still running after " + seconds + " seconds and was killed. If it is a " +
    "test runner, watcher or server that does not exit on its own, fix that (close servers and " +
    "runtimes in teardown, use a run-once mode) or start it in the background with its output " +
    "sent to a log file. Raise timeout_seconds only for work that is genuinely slow.]"
  );
}

export default defineTool({
  description:
    "Execute a shell command in the shared workspace environment. The command is killed if it " +
    "is still running after timeout_seconds (default " + DEFAULT_SECONDS + ", at most " +
    MAX_SECONDS + "); start long-lived servers in the background instead of waiting on them.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      timeout_seconds: {
        type: "number",
        description:
          "Seconds before the command is killed. Default " + DEFAULT_SECONDS + ", at most " +
          MAX_SECONDS + ". Raise it only for work you expect to be slow, such as a large build.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute({ command, timeout_seconds }, ctx) {
    var seconds = limitSeconds(timeout_seconds);
    var wrapped =
      "if command -v timeout >/dev/null 2>&1; then exec timeout -k " + KILL_GRACE_SECONDS + " " +
      seconds + " bash -c " + quote(String(command)) + "; else exec bash -c " +
      quote(String(command)) + "; fi";
    var started = Date.now();
    var result;
    try {
      var sandbox = await ctx.getSandbox();
      result = await sandbox.run({
        command: wrapped,
        abortSignal: AbortSignal.timeout((seconds + KILL_GRACE_SECONDS + BACKSTOP_SECONDS) * 1000),
      });
    } catch (error) {
      if (Date.now() - started >= seconds * 1000) {
        return { exitCode: 124, stdout: "", stderr: killedNote(seconds), truncated: false, timedOut: true };
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: "The sandbox could not run the command: " + (error && error.message ? error.message : String(error)),
        truncated: false,
      };
    }
    var timedOut =
      (result.exitCode === 124 || result.exitCode === 137) && Date.now() - started >= seconds * 1000;
    var stdout = tail(result.stdout, "stdout");
    var stderr = tail(result.stderr, "stderr");
    return {
      exitCode: result.exitCode,
      stdout: stdout.output,
      stderr: timedOut ? (stderr.output ? stderr.output + "\\n" : "") + killedNote(seconds) : stderr.output,
      truncated: stdout.truncated || stderr.truncated,
      ...(timedOut ? { timedOut: true } : {}),
    };
  },
});
`;
