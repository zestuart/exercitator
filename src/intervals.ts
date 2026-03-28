/**
 * intervals.icu API client.
 *
 * Authentication: HTTP Basic with username "API_KEY" and the user's API key.
 * Base URL: https://intervals.icu/api/v1
 * Athlete ID "0" is shorthand for "the athlete owning this API key".
 */

const BASE_URL = "https://intervals.icu/api/v1";

export interface IntervalsConfig {
	apiKey: string;
	athleteId?: string;
}

export class IntervalsClient {
	private readonly headers: Headers;
	readonly athleteId: string;

	constructor(config: IntervalsConfig) {
		this.athleteId = config.athleteId ?? "0";
		this.headers = new Headers({
			Authorization: `Basic ${btoa(`API_KEY:${config.apiKey}`)}`,
			"Content-Type": "application/json",
		});
	}

	async request<T = unknown>(
		method: string,
		path: string,
		body?: unknown,
		query?: Record<string, string>,
	): Promise<T> {
		const url = new URL(`${BASE_URL}${path}`);
		if (query) {
			for (const [k, v] of Object.entries(query)) {
				if (v !== undefined && v !== "") {
					url.searchParams.set(k, v);
				}
			}
		}

		const res = await fetch(url, {
			method,
			headers: this.headers,
			body: body ? JSON.stringify(body) : undefined,
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`intervals.icu ${method} ${path}: ${res.status} ${res.statusText} ${text}`);
		}

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return (await res.json()) as T;
		}
		return (await res.text()) as unknown as T;
	}

	get<T = unknown>(path: string, query?: Record<string, string>): Promise<T> {
		return this.request<T>("GET", path, undefined, query);
	}

	put<T = unknown>(path: string, body: unknown): Promise<T> {
		return this.request<T>("PUT", path, body);
	}

	post<T = unknown>(path: string, body: unknown): Promise<T> {
		return this.request<T>("POST", path, body);
	}

	delete(path: string): Promise<unknown> {
		return this.request("DELETE", path);
	}

	/** Upload a binary file via multipart/form-data (e.g. FIT file upload). */
	async uploadFile(path: string, fileBuffer: Buffer, filename: string): Promise<unknown> {
		const url = new URL(`${BASE_URL}${path}`);

		// Copy auth header but omit Content-Type — let fetch set the multipart boundary
		const headers = new Headers();
		headers.set("Authorization", this.headers.get("Authorization") ?? "");

		const formData = new FormData();
		formData.append("file", new Blob([fileBuffer]), filename);

		const res = await fetch(url, {
			method: "POST",
			headers,
			body: formData,
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`intervals.icu POST ${path}: ${res.status} ${res.statusText} ${text}`);
		}

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json();
		}
		return res.text();
	}
}
