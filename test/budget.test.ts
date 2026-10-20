import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Budget, type ReserveInput } from "../src/budget";
import { USD } from "../src/config";
import { MP4, budget, json, mockFetch, resetBudget } from "./helpers";

const NOW = Date.parse("2026-10-20T12:00:00Z");
let n = 0;
const input = (quoted: number, overrides: Partial<ReserveInput> = {}): ReserveInput => ({
	tool: "make_image",
	model: "m",
	params: {},
	prompt: "a fox",
	quoted,
	dedupe: `d${n++}`,
	...overrides,
});

const run = <R>(fn: (b: Budget) => R | Promise<R>) => runInDurableObject(budget(), (instance: Budget) => fn(instance));

beforeEach(() => resetBudget());
afterEach(() => vi.restoreAllMocks());

describe("arming", () => {
	it("refuses paid calls until armed, and after the window ends", async () => {
		await run((b) => {
			expect(b.reserve(input(USD / 10), NOW)).toEqual({ ok: false, reason: expect.stringContaining("not armed") });
			b.arm("blog", NOW);
			expect(b.reserve(input(USD / 10), NOW + 1000).ok).toBe(true);
			expect(b.reserve(input(USD / 10), NOW + 2 * 3600_000 + 1).ok).toBe(false);
			b.arm("blog", NOW);
			b.disarm();
			expect(b.reserve(input(USD / 10), NOW + 2000).ok).toBe(false);
		});
	});
});

describe("caps", () => {
	it("refuses a call over the per-call cap", async () => {
		await run((b) => {
			b.arm("blog", NOW);
			expect(b.reserve(input(1.51 * USD), NOW)).toEqual({ ok: false, reason: expect.stringContaining("per-call") });
		});
	});

	it("counts open reservations at their quote and stops at the session cap", async () => {
		await run((b) => {
			b.arm("blog", NOW);
			expect(b.reserve(input(1.4 * USD), NOW).ok).toBe(true);
			expect(b.reserve(input(1.4 * USD), NOW + 61_000).ok).toBe(true);
			expect(b.reserve(input(0.3 * USD), NOW + 122_000)).toEqual({ ok: false, reason: expect.stringContaining("arming session") });
		});
	});

	it("uses the actual cost once settled", async () => {
		await run((b) => {
			b.arm("blog", NOW);
			const first = b.reserve(input(1.4 * USD), NOW);
			if (!first.ok) throw new Error("expected ok");
			expect(b.settle(first.id, { actual: 0.1 * USD })).toBe(true);
			expect(b.settle(first.id, { actual: 1.4 * USD })).toBe(false); // second settle is a no-op
			expect(b.status(NOW).spentToday).toBe(0.1 * USD);
		});
	});

	it("stops at the daily cap across arming sessions", async () => {
		await run((b) => {
			for (let i = 0; i < 4; i++) {
				b.arm("blog", NOW + i * 600_000);
				const r = b.reserve(input(1.25 * USD), NOW + i * 600_000 + 1);
				expect(r.ok).toBe(true);
			}
			b.arm("blog", NOW + 3_000_000);
			expect(b.reserve(input(0.5 * USD), NOW + 3_000_001)).toEqual({ ok: false, reason: expect.stringContaining("today") });
		});
	});

	it("limits calls per minute", async () => {
		await run((b) => {
			b.arm("blog", NOW);
			for (let i = 0; i < 6; i++) expect(b.reserve(input(1000), NOW + i).ok).toBe(true);
			expect(b.reserve(input(1000), NOW + 10)).toEqual({ ok: false, reason: expect.stringContaining("last minute") });
			expect(b.reserve(input(1000), NOW + 61_000).ok).toBe(true);
		});
	});

	it("counts an unsettled reservation at its quote once it expires", async () => {
		await run((b) => {
			b.arm("blog", NOW);
			const r = b.reserve(input(0.5 * USD), NOW);
			expect(r.ok).toBe(true);
			const status = b.status(NOW + 16 * 60_000);
			expect(status.spentToday).toBe(0.5 * USD);
			if (r.ok) expect(b.settle(r.id, { actual: 0 })).toBe(false);
		});
	});

	it("does not charge a failure xAI never accepted", async () => {
		await run((b) => {
			b.arm("blog", NOW);
			const r = b.reserve(input(0.5 * USD), NOW);
			if (!r.ok) throw new Error("expected ok");
			b.fail(r.id, "connection error", false);
			expect(b.status(NOW).spentToday).toBe(0);
			const s = b.reserve(input(0.5 * USD), NOW + 1);
			if (!s.ok) throw new Error("expected ok");
			b.fail(s.id, "500", true);
			expect(b.status(NOW).spentToday).toBe(0.5 * USD);
		});
	});
});

describe("duplicates", () => {
	it("returns the earlier result for an identical request within 10 minutes", async () => {
		await run((b) => {
			b.arm("blog", NOW);
			const first = b.reserve(input(1000, { dedupe: "same" }), NOW);
			if (!first.ok) throw new Error("expected ok");
			expect(b.reserve(input(1000, { dedupe: "same" }), NOW + 1)).toEqual({ ok: false, reason: expect.stringContaining("already running") });
			b.settle(first.id, { actual: 1000, result: { file_ids: ["x"] } });
			expect(b.reserve(input(1000, { dedupe: "same" }), NOW + 2)).toEqual({ ok: false, duplicate: { file_ids: ["x"] } });
			expect(b.reserve(input(1000, { dedupe: "same" }), NOW + 11 * 60_000).ok).toBe(true);
		});
	});
});

describe("video jobs", () => {
	const startJob = (b: Budget) => {
		b.arm("blog", NOW);
		const r = b.reserve(input(0.3 * USD, { tool: "make_video" }), NOW);
		if (!r.ok) throw new Error("expected ok");
		return { ledgerId: r.id, job: b.addVideoJob({ ledgerId: r.id, xaiId: "xai-req-1", prompt: "a fox", model: "grok-imagine-video", params: {}, session: r.session }, NOW) };
	};

	it("stores the finished video, settles at xAI's cost, and is safe to run twice", async () => {
		const { calls } = mockFetch(
			(url) => (url.pathname === "/v1/videos/xai-req-1" ? json({ status: "done", video: { url: "https://vidgen.x.ai/v/1.mp4", duration: 6, respect_moderation: true }, usage: { cost_in_usd_ticks: 2_500_000_000 } }) : undefined),
			(url) => (url.hostname === "vidgen.x.ai" ? new Response(MP4, { headers: { "content-length": String(MP4.length) } }) : undefined),
		);
		await run(async (b) => {
			const { job } = startJob(b);
			await b.runMaintenance(NOW + 20_000);
			await b.runMaintenance(NOW + 40_000); // duplicate alarm run
			const view = b.getJob(job.id);
			expect(view?.status).toBe("done");
			const file = b.getFile(view!.fileId!);
			expect(file?.kind).toBe("video");
			expect(await env.MEDIA.get(file!.key)).not.toBeNull();
			expect(b.status(NOW + 40_000).spentToday).toBe(0.25 * USD);
		});
		expect(calls.filter((c) => c.url.includes("/v1/videos/")).length).toBe(1);
	});

	it("recovers when the run crashed after the ledger write", async () => {
		mockFetch(
			(url) => (url.pathname === "/v1/videos/xai-req-1" ? json({ status: "done", video: { url: "https://vidgen.x.ai/v/1.mp4", duration: 6, respect_moderation: true } }) : undefined),
			(url) => (url.hostname === "vidgen.x.ai" ? new Response(MP4) : undefined),
		);
		await run(async (b) => {
			const { ledgerId, job } = startJob(b);
			// Simulate a crash between settling and marking the job done.
			b.settle(ledgerId, { actual: 0.3 * USD });
			await b.runMaintenance(NOW + 20_000);
			expect(b.getJob(job.id)?.status).toBe("done");
			expect(b.status(NOW + 20_000).spentToday).toBe(0.3 * USD);
		});
	});

	it("refuses to download from a host that is not xAI's", async () => {
		mockFetch((url) => (url.pathname === "/v1/videos/xai-req-1" ? json({ status: "done", video: { url: "https://evil.example.net/v.mp4", duration: 6, respect_moderation: true } }) : undefined));
		await run(async (b) => {
			const { job } = startJob(b);
			await b.runMaintenance(NOW + 20_000);
			expect(b.getJob(job.id)?.status).toBe("pending"); // retried later, never downloaded
		});
	});

	it("marks a moderated video failed and charges only what xAI reports", async () => {
		mockFetch((url) => (url.pathname === "/v1/videos/xai-req-1" ? json({ status: "done", video: { url: "", duration: 6, respect_moderation: false } }) : undefined));
		await run(async (b) => {
			const { job } = startJob(b);
			await b.runMaintenance(NOW + 20_000);
			expect(b.getJob(job.id)).toMatchObject({ status: "failed" });
			expect(b.status(NOW + 20_000).spentToday).toBe(0);
		});
	});

	it("keeps polling while pending and survives errors", async () => {
		let answer: Response = new Response("boom", { status: 503 });
		mockFetch((url) => (url.pathname === "/v1/videos/xai-req-1" ? answer : undefined));
		await run(async (b) => {
			const { job } = startJob(b);
			await b.runMaintenance(NOW + 20_000);
			expect(b.getJob(job.id)?.status).toBe("pending");
			answer = json({ status: "pending", progress: 40 });
			await b.runMaintenance(NOW + 10 * 60_000);
			expect(b.getJob(job.id)?.status).toBe("pending");
		});
	});
});

describe("daily cleanup", () => {
	it("folds old ledger rows into monthly totals and deletes expired files", async () => {
		await run(async (b) => {
			b.arm("blog", NOW - 100 * 86_400_000);
			const r = b.reserve(input(1000), NOW - 100 * 86_400_000);
			if (r.ok) b.settle(r.id, { actual: 900 });
			const key = "2026-09-01/image-oldoldoldoldoldo.png";
			await env.MEDIA.put(key, "x");
			b.addFile({ id: "oldoldoldoldoldo", key, kind: "image", mime: "image/png", source: "generated", size: 1, created: NOW - 31 * 86_400_000 });
			await b.runMaintenance(NOW);
			expect(b.recentLedger(10)).toEqual([]);
			expect(b.getFile("oldoldoldoldoldo")).toBeNull();
			expect(await env.MEDIA.get(key)).toBeNull();
		});
	});
});
