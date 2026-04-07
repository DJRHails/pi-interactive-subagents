import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * File-based debug logger for the subagents extension.
 *
 * Writes to `~/.pi/logs/pi-interactive-subagents.log`. The TUI eats stdout/stderr,
 * so a file is the only place warnings/errors can reliably surface.
 *
 * Levels:
 *   - `warn` / `error`: always written.
 *   - `debug`: only written when `PI_SUBAGENT_DEBUG` is set to a truthy value.
 *
 * The logger is best-effort: any failure (missing dir, permissions, etc.) is
 * swallowed so logging never breaks the caller.
 */

const LOG_PATH = join(homedir(), ".pi", "logs", "pi-interactive-subagents.log");

function debugEnabled(): boolean {
  const v = process.env.PI_SUBAGENT_DEBUG;
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}

function write(level: "debug" | "warn" | "error", module: string, msg: string, data?: unknown): void {
  if (level === "debug" && !debugEnabled()) return;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const ts = new Date().toISOString();
    const suffix = data === undefined ? "" : ` ${formatData(data)}`;
    appendFileSync(LOG_PATH, `${ts} [${level}] [${module}] ${msg}${suffix}\n`);
  } catch {
    // logging must never throw
  }
}

function formatData(data: unknown): string {
  if (data instanceof Error) {
    return JSON.stringify({ name: data.name, message: data.message, stack: data.stack });
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function debug(module: string, msg: string, data?: unknown): void {
  write("debug", module, msg, data);
}

export function warn(module: string, msg: string, data?: unknown): void {
  write("warn", module, msg, data);
}

export function error(module: string, msg: string, data?: unknown): void {
  write("error", module, msg, data);
}

export const logPath = LOG_PATH;
