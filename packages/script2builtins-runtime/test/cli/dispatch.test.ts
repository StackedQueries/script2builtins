/**
 * Smoke-test the CLI binary by running it as a subprocess. This is
 * a low-fidelity check — full coverage of dispatch lives in the
 * harness/e2e tests — but it catches obvious shebang / import /
 * dist-output regressions.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const execFileP = promisify(execFile);
const root = resolve(__dirname, "..", "..");
const cli = resolve(root, "dist", "cli.js");

describe("CLI smoke", () => {
  beforeAll(() => {
    if (!existsSync(cli)) {
      console.warn(`[skip] ${cli} not built; run \`npm run build\` first`);
    }
  });

  it("prints help with --help", async () => {
    if (!existsSync(cli)) return;
    const { stdout } = await execFileP("node", [cli, "--help"]);
    expect(stdout).toContain("s2b — script2builtins unified CLI");
    expect(stdout).toContain("static analysis");
    expect(stdout).toContain("dynamic analysis");
  });

  it("runs static mode on a file", async () => {
    if (!existsSync(cli)) return;
    const example = resolve(root, "examples", "example.js");
    if (!existsSync(example)) return;
    const { stdout } = await execFileP("node", [cli, example, "--no-color"]);
    expect(stdout).toContain("script2builtins forensic report");
    expect(stdout).toContain("navigator.userAgent");
  });

  it("exits non-zero on unknown flag", async () => {
    if (!existsSync(cli)) return;
    await expect(execFileP("node", [cli, "--no-such-flag"])).rejects.toMatchObject({
      code: 2,
    });
  });

  it("rejects --nav-timeout without a value", async () => {
    if (!existsSync(cli)) return;
    await expect(
      execFileP("node", [cli, "https://example.com/", "--nav-timeout"]),
    ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("requires a value") });
  });

  it("rejects --nav-timeout with a non-integer", async () => {
    if (!existsSync(cli)) return;
    await expect(
      execFileP("node", [cli, "https://example.com/", "--nav-timeout", "fast"]),
    ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("expects an integer") });
  });

  it("rejects --idle with a negative integer", async () => {
    if (!existsSync(cli)) return;
    await expect(
      execFileP("node", [cli, "https://example.com/", "--idle", "-1"]),
    ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("must be ≥") });
  });
});
