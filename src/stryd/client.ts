/**
 * Stryd PowerCenter API client.
 *
 * Authenticates via email/password and downloads FIT files with full
 * developer fields (Form Power, LSS, ILR, Air Power, etc.) that are
 * stripped when recording via Apple Watch + HealthKit.
 *
 * Zero external dependencies — uses Node.js native fetch.
 */

const LOGIN_URL = "https://www.stryd.com/b/email/signin";
const API_BASE = "https://api.stryd.com/b/api/v1";

const API_TIMEOUT_MS = 30_000;
const FIT_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Maximum FIT file size (10 MB — largest real Stryd FIT is ~200 KB). */
const MAX_FIT_SIZE_BYTES = 10 * 1024 * 1024;

/** Allowed hostnames for Stryd FIT download URLs. */
const ALLOWED_FIT_HOSTS = ["storage.googleapis.com", "storage.cloud.google.com"];

const BROWSER_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
		"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
	Origin: "https://www.stryd.com",
	Referer: "https://www.stryd.com/",
};

export interface StrydConfig {
	email: string;
	password: string;
}

export interface StrydActivity {
	id: number;
	timestamp: number;
	distance: number;
	elapsed_time: number;
	average_power: number;
	/** 1-10 RPE from Stryd post-run report (if submitted) */
	rpe?: number;
	/** Subjective feel from Stryd post-run report */
	feel?: string;
	/** Surface tag from Stryd post-run report */
	surface_type?: string;
}

export class StrydClient {
	private token: string | null = null;
	private userId: string | null = null;
	private readonly email: string;
	private readonly password: string;

	constructor(config: StrydConfig) {
		this.email = config.email;
		this.password = config.password;
	}

	private authHeaders(): Record<string, string> {
		if (!this.token) throw new Error("StrydClient: not authenticated — call login() first");
		return {
			...BROWSER_HEADERS,
			// Non-standard "Bearer:" format (with colon) — required by Stryd's API
			Authorization: `Bearer: ${this.token}`,
		};
	}

	async login(): Promise<void> {
		const res = await fetch(LOGIN_URL, {
			method: "POST",
			headers: { ...BROWSER_HEADERS, "Content-Type": "application/json" },
			body: JSON.stringify({ email: this.email, password: this.password }),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Stryd login failed (HTTP ${res.status}): ${text}`);
		}

		const data = (await res.json()) as { token: string; id: string };
		this.token = data.token;
		this.userId = data.id;
	}

	async listActivities(days = 14): Promise<StrydActivity[]> {
		if (!this.userId) throw new Error("StrydClient: not authenticated");

		const now = Math.floor(Date.now() / 1000);
		const from = now - days * 86_400;
		const to = now + 86_400; // tomorrow

		const params = new URLSearchParams({
			from: String(from),
			to: String(to),
			include_deleted: "false",
		});

		// User-scoped calendar endpoint on api.stryd.com
		const url = `${API_BASE}/users/${this.userId}/calendar?${params}`;
		const res = await fetch(url, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});

		if (!res.ok) {
			throw new Error(`Stryd listActivities failed (HTTP ${res.status})`);
		}

		const data = (await res.json()) as { activities: StrydActivity[] };
		return data.activities ?? [];
	}

	async downloadFit(activityId: number): Promise<Buffer> {
		if (!this.userId) throw new Error("StrydClient: not authenticated");

		// Step 1: Get signed GCS URL
		const metaUrl = `${API_BASE}/users/${this.userId}/activities/${activityId}/fit`;
		const metaRes = await fetch(metaUrl, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});

		if (!metaRes.ok) {
			throw new Error(`Stryd FIT URL fetch failed (HTTP ${metaRes.status})`);
		}

		const { url: signedUrl } = (await metaRes.json()) as { url: string };

		// Validate signed URL against allowed hosts (SSRF prevention)
		const parsedUrl = new URL(signedUrl);
		if (!ALLOWED_FIT_HOSTS.includes(parsedUrl.hostname)) {
			throw new Error(`Stryd FIT download URL on unexpected host: ${parsedUrl.hostname}`);
		}

		// Step 2: Download binary FIT (no auth needed — signed URL)
		const fitRes = await fetch(signedUrl, {
			signal: AbortSignal.timeout(FIT_DOWNLOAD_TIMEOUT_MS),
		});

		if (!fitRes.ok) {
			throw new Error(`Stryd FIT download failed (HTTP ${fitRes.status})`);
		}

		const arrayBuffer = await fitRes.arrayBuffer();
		if (arrayBuffer.byteLength > MAX_FIT_SIZE_BYTES) {
			throw new Error(
				`Stryd FIT file too large (${arrayBuffer.byteLength} bytes, limit ${MAX_FIT_SIZE_BYTES})`,
			);
		}
		return Buffer.from(arrayBuffer);
	}

	/** Fetch the most recent critical power value (watts) from CP history.
	 *  Returns null if no CP data is available. */
	async getLatestCriticalPower(): Promise<number | null> {
		if (!this.userId) throw new Error("StrydClient: not authenticated");

		const end = new Date();
		const start = new Date(end.getTime() - 90 * 86_400_000); // 90 days lookback
		const fmt = (d: Date) => d.toISOString().slice(0, 10);

		const url = `${API_BASE}/users/${this.userId}/cp/history?startDate=${fmt(start)}&endDate=${fmt(end)}`;
		const res = await fetch(url, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});

		if (!res.ok) {
			throw new Error(`Stryd CP history failed (HTTP ${res.status})`);
		}

		const entries = (await res.json()) as { critical_power: number; created: number }[];
		if (!Array.isArray(entries) || entries.length === 0) return null;

		// Find the most recent entry with a non-zero created timestamp
		const valid = entries.filter((e) => e.created > 0);
		if (valid.length === 0) return null;

		const latest = valid.reduce((a, b) => (b.created > a.created ? b : a));
		return latest.critical_power;
	}

	get isAuthenticated(): boolean {
		return this.token !== null;
	}
}
