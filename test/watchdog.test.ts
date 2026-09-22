import test from "node:test";
import assert from "node:assert/strict";
import { ProviderIdleWatchdog, classifyRateLimitError, shouldRotateAfterWatchdogTimeout, shouldWatchProvider } from "../src/index.ts";

class FakeTimers {
	private nextId = 1;
	private timers = new Map<number, { callback: () => void; ms: number }>();

	setTimeout = (callback: () => void, ms: number): number => {
		const id = this.nextId++;
		this.timers.set(id, { callback, ms });
		return id;
	};

	clearTimeout = (id: number): void => {
		this.timers.delete(id);
	};

	fireAll(): void {
		const callbacks = [...this.timers.values()].map((entry) => entry.callback);
		this.timers.clear();
		for (const callback of callbacks) callback();
	}

	fireByDelay(ms: number): void {
		const pending = [...this.timers.entries()].filter(([, entry]) => entry.ms === ms);
		for (const [id, entry] of pending) {
			this.timers.delete(id);
			entry.callback();
		}
	}

	get size(): number {
		return this.timers.size;
	}
}

class FakeClock {
	time = 0;

	now = (): number => this.time;

	advance(ms: number): void {
		this.time += ms;
	}
}


test("shouldWatchProvider only enables the watchdog for opencode-go", () => {
	assert.equal(shouldWatchProvider("opencode-go"), true);
	assert.equal(shouldWatchProvider("anthropic"), false);
	assert.equal(shouldWatchProvider(undefined), false);
});

test("classifyRateLimitError distinguishes fixed-window quota errors from transient limits", () => {
	assert.equal(
		classifyRateLimitError("You have exceeded the 5-hour usage quota. It will reset at 2026-08-01T12:00:00Z"),
		"fixed-window-quota",
	);
	assert.equal(classifyRateLimitError("429 rate limit"), "transient");
	assert.equal(classifyRateLimitError("provider unavailable"), undefined);
});

test("shouldRotateAfterWatchdogTimeout reuses the already-rotated key after a 429", () => {
	const timeoutInfo = {
		phase: "waiting-for-stream" as const,
		idleMs: 90_000,
		elapsedMs: 90_000,
		idleForMs: 90_000,
		lastStatus: 429,
	};

	assert.equal(shouldRotateAfterWatchdogTimeout(timeoutInfo, true), false);
	assert.equal(shouldRotateAfterWatchdogTimeout(timeoutInfo, false), true);
});

test("shouldRotateAfterWatchdogTimeout rotates for non-429 hangs", () => {
	assert.equal(shouldRotateAfterWatchdogTimeout({
		phase: "waiting-for-response",
		idleMs: 90_000,
		elapsedMs: 90_000,
		idleForMs: 90_000,
	}, false), true);
	assert.equal(shouldRotateAfterWatchdogTimeout({
		phase: "waiting-for-stream",
		idleMs: 90_000,
		elapsedMs: 90_000,
		idleForMs: 90_000,
		lastStatus: 200,
	}, false), true);
});

test("ProviderIdleWatchdog fires once after an idle provider request", () => {
	const timers = new FakeTimers();
	let timeouts = 0;
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 90_000,
		onTimeout: () => timeouts++,
		timers,
	});

	watchdog.start();
	timers.fireAll();
	timers.fireAll();

	assert.equal(timeouts, 1);
	assert.equal(watchdog.consumeTimeoutInfo()?.phase, "waiting-for-response");
	assert.equal(watchdog.consumeTimeoutInfo(), undefined);
});

test("ProviderIdleWatchdog resets the idle timer when activity is observed", () => {
	const timers = new FakeTimers();
	let timeouts = 0;
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 90_000,
		onTimeout: () => timeouts++,
		timers,
	});

	watchdog.start();
	assert.equal(timers.size, 1);
	watchdog.activity();
	assert.equal(timers.size, 1);

	timers.fireAll();

	assert.equal(timeouts, 1);
});

test("ProviderIdleWatchdog stop prevents timeout", () => {
	const timers = new FakeTimers();
	let timeouts = 0;
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 90_000,
		onTimeout: () => timeouts++,
		timers,
	});

	watchdog.start();
	watchdog.stop();
	timers.fireAll();

	assert.equal(timeouts, 0);
});

test("ProviderIdleWatchdog reports a pre-response stall", () => {
	const timers = new FakeTimers();
	const clock = new FakeClock();
	let timeoutPhase = "";
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 90_000,
		onTimeout: () => {
			timeoutPhase = watchdog.currentTimeoutInfo()?.phase ?? "";
		},
		timers,
		clock,
	});

	watchdog.start();
	clock.advance(90_000);
	timers.fireAll();

	const info = watchdog.consumeTimeoutInfo();
	assert.equal(timeoutPhase, "waiting-for-response");
	assert.equal(info?.phase, "waiting-for-response");
	assert.equal(info?.elapsedMs, 90_000);
	assert.equal(info?.idleForMs, 90_000);
});

test("ProviderIdleWatchdog enforces an absolute dispatch deadline with zero response bytes", () => {
	const timers = new FakeTimers();
	const clock = new FakeClock();
	let timeouts = 0;
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 3_600_000,
		deadlineMs: 600_000,
		onTimeout: () => timeouts++,
		timers,
		clock,
	});

	watchdog.start();
	assert.equal(timers.size, 2);
	clock.advance(600_000);
	timers.fireByDelay(600_000);

	const info = watchdog.consumeTimeoutInfo();
	assert.equal(timeouts, 1);
	assert.equal(info?.deadlineMs, 600_000);
	assert.equal(info?.elapsedMs, 600_000);
	assert.equal(info?.idleForMs, 600_000);
	assert.equal(info?.phase, "waiting-for-response");
});

test("ProviderIdleWatchdog keeps a slow-but-progressing stream alive until the absolute dispatch deadline", () => {
	const timers = new FakeTimers();
	const clock = new FakeClock();
	const fired: Array<{ deadlineMs?: number; elapsedMs: number; idleForMs: number }> = [];
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 90_000,
		deadlineMs: 600_000,
		onTimeout: () => {
			const info = watchdog.currentTimeoutInfo();
			if (info) fired.push(info);
		},
		timers,
		clock,
	});

	watchdog.start();
	// One 60s progress tick per idle window: the 90s idle timer is re-armed every
	// time and never fires, while the absolute 600s deadline is untouched.
	for (let elapsed = 60_000; elapsed <= 300_000; elapsed += 60_000) {
		clock.advance(60_000);
		watchdog.streamActivity();
	}
	assert.equal(fired.length, 0);
	assert.equal(timers.size, 2);

	clock.advance(300_000);
	timers.fireByDelay(600_000);

	assert.equal(fired.length, 1);
	assert.equal(fired[0]?.deadlineMs, 600_000);
	assert.equal(fired[0]?.elapsedMs, 600_000);
	assert.equal(fired[0]?.idleForMs, 300_000);
});

test("ProviderIdleWatchdog ignores a disabled dispatch deadline", () => {
	const timers = new FakeTimers();
	const clock = new FakeClock();
	let timeouts = 0;
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 3_600_000,
		deadlineMs: 0,
		onTimeout: () => timeouts++,
		timers,
		clock,
	});

	watchdog.start();
	assert.equal(timers.size, 1);
	clock.advance(600_000);
	timers.fireByDelay(600_000);

	assert.equal(timeouts, 0);
});

test("ProviderIdleWatchdog clears the dispatch deadline when the idle timer wins", () => {
	const timers = new FakeTimers();
	const clock = new FakeClock();
	let timeouts = 0;
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 90_000,
		deadlineMs: 600_000,
		onTimeout: () => timeouts++,
		timers,
		clock,
	});

	watchdog.start();
	assert.equal(timers.size, 2);
	clock.advance(90_000);
	timers.fireByDelay(90_000);

	assert.equal(timeouts, 1);
	assert.equal(timers.size, 0);
	timers.fireByDelay(600_000);
	assert.equal(timeouts, 1);
});

test("ProviderIdleWatchdog reports a stream stall after response headers", () => {
	const timers = new FakeTimers();
	const clock = new FakeClock();
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 90_000,
		onTimeout: () => {},
		timers,
		clock,
	});

	watchdog.start();
	clock.advance(1_000);
	watchdog.response(200);
	clock.advance(90_000);
	timers.fireAll();

	const info = watchdog.consumeTimeoutInfo();
	assert.equal(info?.phase, "waiting-for-stream");
	assert.equal(info?.lastStatus, 200);
	assert.equal(info?.elapsedMs, 91_000);
	assert.equal(info?.idleForMs, 90_000);
});

test("ProviderIdleWatchdog reports stream activity stalls separately", () => {
	const timers = new FakeTimers();
	const clock = new FakeClock();
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 90_000,
		onTimeout: () => {},
		timers,
		clock,
	});

	watchdog.start();
	clock.advance(1_000);
	watchdog.response(200);
	clock.advance(2_000);
	watchdog.streamActivity();
	clock.advance(90_000);
	timers.fireAll();

	const info = watchdog.consumeTimeoutInfo();
	assert.equal(info?.phase, "streaming");
	assert.equal(info?.lastStatus, 200);
	assert.equal(info?.elapsedMs, 93_000);
	assert.equal(info?.idleForMs, 90_000);
});
