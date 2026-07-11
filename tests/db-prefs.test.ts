import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetDb,
	deleteUserPref,
	getPowerSourceOverride,
	getUserPref,
	setPowerSourceOverride,
	setUserPref,
} from "../src/db.js";

describe("user_preferences DB helpers", () => {
	beforeEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = ":memory:";
	});

	afterEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = undefined;
	});

	it("returns null for an unset preference", () => {
		expect(getUserPref("ze", "missing")).toBeNull();
	});

	it("round-trips a preference value", () => {
		setUserPref("ze", "colour", "green");
		expect(getUserPref("ze", "colour")).toBe("green");
	});

	it("upserts (overwrites) an existing preference", () => {
		setUserPref("ze", "colour", "green");
		setUserPref("ze", "colour", "blue");
		expect(getUserPref("ze", "colour")).toBe("blue");
	});

	it("scopes preferences per user", () => {
		setUserPref("ze", "colour", "green");
		setUserPref("pam", "colour", "red");
		expect(getUserPref("ze", "colour")).toBe("green");
		expect(getUserPref("pam", "colour")).toBe("red");
	});

	it("deletes a preference", () => {
		setUserPref("ze", "colour", "green");
		deleteUserPref("ze", "colour");
		expect(getUserPref("ze", "colour")).toBeNull();
	});
});

describe("power-source override helpers", () => {
	beforeEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = ":memory:";
	});

	afterEach(() => {
		_resetDb();
		process.env.EXERCITATOR_DB_PATH = undefined;
	});

	it("defaults to null (auto) when unset", () => {
		expect(getPowerSourceOverride("ze")).toBeNull();
	});

	it("persists and reads back stryd / garmin", () => {
		setPowerSourceOverride("ze", "stryd");
		expect(getPowerSourceOverride("ze")).toBe("stryd");
		setPowerSourceOverride("ze", "garmin");
		expect(getPowerSourceOverride("ze")).toBe("garmin");
	});

	it("clears the override when set to auto", () => {
		setPowerSourceOverride("ze", "garmin");
		setPowerSourceOverride("ze", "auto");
		expect(getPowerSourceOverride("ze")).toBeNull();
	});

	it("ignores a corrupt stored value", () => {
		setUserPref("ze", "power_source_override", "bogus");
		expect(getPowerSourceOverride("ze")).toBeNull();
	});
});
