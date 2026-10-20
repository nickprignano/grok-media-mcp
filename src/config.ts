// Models, prices and caps. Prices are xAI list prices on PRICES_AS_OF; media_budget warns when
// this table is more than 90 days old. All money inside the server is integer micro-dollars
// (1 USD = 1,000,000) so caps compare exactly.

export const PRICES_AS_OF = "2026-10-19";
export const XAI_API = "https://api.x.ai";

export const USD = 1_000_000;
const cents = (n: number) => Math.round(n * 10_000);

export const IMAGE_MODELS = {
	standard: { id: "grok-imagine-image-2.0", perImage: cents(4) },
	high: { id: "grok-imagine-image-quality", perImage: cents(5) },
} as const;
export type ImageQuality = keyof typeof IMAGE_MODELS;

export const VIDEO_MODELS = {
	lite: { id: "grok-imagine-video-1.5-lite", perSecond: cents(2) },
	standard: { id: "grok-imagine-video", perSecond: cents(5) },
	best: { id: "grok-imagine-video-1.5", perSecond: cents(8) },
} as const;
export type VideoTier = keyof typeof VIDEO_MODELS;

// $15 per million characters, $0.10 per hour of audio.
export const SPEECH_PER_MILLION_CHARS = 15 * USD;
export const TRANSCRIBE_PER_HOUR = cents(10);
// Transcription is quoted before the length is known: 25 MB of low-bitrate audio is under 2 hours.
export const TRANSCRIBE_QUOTE = cents(20);

// xAI's built-in voices. Custom and cloned voices are never accepted.
export const VOICES = [
	"ara", "altair", "atlas", "carina", "castor", "celeste", "cosmo", "eve", "helios", "helix",
	"iris", "kepler", "leo", "lumen", "luna", "lux", "naksh", "orion", "perseus", "rex", "rigel",
	"sal", "sirius", "ursa", "zagan", "zenith",
] as const;

export const IMAGE_ASPECTS = ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"] as const;
export const VIDEO_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;

export const LIMITS = {
	promptChars: 2_000,
	speechChars: 5_000,
	imagesPerCall: 4,
	editSources: 5,
	videoSeconds: 15,
	imageBytes: 20 * 1024 * 1024,
	// Held in memory inside the Durable Object (128 MB), so well under that. 15 s at 720p is far smaller.
	videoBytes: 40 * 1024 * 1024,
	audioBytes: 25 * 1024 * 1024,
	fileDays: 30,
	ledgerDays: 90,
	dedupeMinutes: 10,
	reservationMinutes: 15,
	videoJobHours: 2,
	linkSeconds: 3600,
	previewLinkSeconds: 900,
};

// Hosts the server will download generated media from. Anything else is refused.
export const XAI_MEDIA_HOST = /(^|\.)x\.ai$/;

export interface Caps {
	perCall: number;
	perSession: number;
	perDay: number;
	perMonth: number;
	callsPerMinute: number;
	armHours: number;
}

function dollars(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? Math.round(n * USD) : fallback;
}

/** The cap settings, as Worker vars or the local config file gives them (strings). */
export interface CapSettings {
	CAP_PER_CALL_USD?: string;
	CAP_PER_SESSION_USD?: string;
	CAP_PER_DAY_USD?: string;
	CAP_PER_MONTH_USD?: string;
	CALLS_PER_MINUTE?: string;
	ARM_HOURS?: string;
}

export function readCaps(env: CapSettings): Caps {
	const calls = Number(env.CALLS_PER_MINUTE);
	const hours = Number(env.ARM_HOURS);
	return {
		perCall: dollars(env.CAP_PER_CALL_USD, 1.5 * USD),
		perSession: dollars(env.CAP_PER_SESSION_USD, 3 * USD),
		perDay: dollars(env.CAP_PER_DAY_USD, 5 * USD),
		perMonth: dollars(env.CAP_PER_MONTH_USD, 25 * USD),
		callsPerMinute: Number.isInteger(calls) && calls > 0 ? calls : 6,
		armHours: Number.isFinite(hours) && hours > 0 && hours <= 12 ? hours : 2,
	};
}

export function formatUsd(micro: number): string {
	return `$${(micro / USD).toFixed(micro !== 0 && Math.abs(micro) < 10_000 ? 4 : 2)}`;
}

// xAI reports cost in ticks: 1 USD = 10^10 ticks.
export function ticksToMicro(ticks: unknown): number | undefined {
	return typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0
		? Math.round(ticks / 10_000)
		: undefined;
}

export function pricesAgeDays(now = Date.now()): number {
	return Math.floor((now - Date.parse(`${PRICES_AS_OF}T00:00:00Z`)) / 86_400_000);
}

const REQUIRED = [
	"XAI_API_KEY",
	"ACCESS_CLIENT_ID",
	"ACCESS_CLIENT_SECRET",
	"ACCESS_ISSUER",
	"INBOX_ACCESS_AUD",
	"COOKIE_ENCRYPTION_KEY",
	"LINK_SIGNING_KEY",
	"PUBLIC_URL",
	"ALLOWED_EMAIL",
] as const;

// Names of required settings that are missing or too weak. The server refuses all traffic
// until this is empty, so a half-configured deploy fails closed.
type Settings = Partial<Record<(typeof REQUIRED)[number], string>>;

export function missingSettings(env: Settings): string[] {
	const missing: string[] = REQUIRED.filter((name) => !env[name]);
	for (const name of ["COOKIE_ENCRYPTION_KEY", "LINK_SIGNING_KEY"] as const) {
		if (env[name] && env[name].length < 32) missing.push(`${name} (needs 32+ characters)`);
	}
	if (env.ACCESS_ISSUER && !/^https:\/\/[a-z0-9.-]+\/cdn-cgi\/access\/sso\/oidc\/[A-Za-z0-9_-]+$/.test(env.ACCESS_ISSUER)) {
		missing.push("ACCESS_ISSUER (https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>, no trailing slash)");
	}
	if (env.PUBLIC_URL && !/^https:\/\/[a-z0-9.-]+$/.test(env.PUBLIC_URL)) {
		missing.push("PUBLIC_URL (https://host, no path or trailing slash)");
	}
	return missing;
}

export function publicHost(env: { PUBLIC_URL: string }): string {
	return new URL(env.PUBLIC_URL).host;
}
