import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The one data folder for this user. Resolved from the home folder, not the current directory or
 * extra settings, so Claude Desktop and Claude Code (which start the server with different
 * environments) always share one ledger.
 */
export function dataDir(platform = process.platform, env = process.env, home = homedir()): string {
	if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "grok-media-mcp");
	if (platform === "darwin") return join(home, "Library", "Application Support", "grok-media-mcp");
	return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "grok-media-mcp");
}
