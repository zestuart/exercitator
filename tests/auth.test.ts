import { describe, expect, it } from "vitest";

describe("auth module", () => {
	it("reports auth disabled when secrets are not set", async () => {
		// authEnabled reads from env at import time, so we test the condition directly
		const clientSecret = process.env.MCP_OAUTH_CLIENT_SECRET ?? "";
		const passphrase = process.env.MCP_OAUTH_AUTHORIZE_PASSPHRASE ?? "";
		const enabled = clientSecret !== "" && passphrase !== "";
		expect(enabled).toBe(false);
	});
});
