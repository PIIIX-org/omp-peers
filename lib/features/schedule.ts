// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright (c) 2026 PIIIX-org contributors

/**
 * Wall-clock schedules in an IANA time zone, computed with `Intl` only.
 *
 * A schedule is a sequence of local wall-clock times (hourly: minute MM of every hour; daily: HH:MM; weekly:
 * a weekday and HH:MM). Each one is a slot identified by its local start time, e.g. `2026-11-17T09:00`.
 * A slot fires at the first instant the zone's clock reads that wall time:
 * - spring-forward gap (the wall time does not exist): it fires once, at the first minute that does exist at or after it;
 * - fall-back overlap (the wall time occurs twice): it fires once, at the first occurrence;
 * - two wall times of an hourly schedule that map to the same instant (the gap) are one slot, named by the later wall time.
 */

export const CADENCES = ["hourly", "daily", "weekly"] as const;
export type Cadence = (typeof CADENCES)[number];
/** Index = `Date.getUTCDay()`. */
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Schedule {
	cadence: Cadence;
	/** `HH:MM`, 24 hour clock; for `hourly` only the minutes are used. */
	at: string;
	/** Used by `weekly` only. */
	weekday: Weekday;
	/** Canonical IANA zone name. */
	timezone: string;
}

export interface Slot {
	/** Local start time, `YYYY-MM-DDTHH:MM`. */
	id: string;
	/** Epoch milliseconds when the slot fires. */
	fire: number;
}

export const AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Wall-time search margin around a range: wider than any real offset change. */
const PAD = 26 * HOUR;
/** How far back or ahead one slot is always found. */
const SPAN: Record<Cadence, number> = { hourly: 6 * HOUR, daily: 3 * DAY, weekly: 9 * DAY };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
	let format = formatters.get(timezone);
	if (!format) {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
		});
		formatters.set(timezone, format);
	}
	return format;
}

/** The zone's wall clock at instant `t`, as the UTC milliseconds of the same calendar fields (minute resolution). */
function wallOf(timezone: string, t: number): number {
	const parts: Record<string, number> = {};
	for (const part of formatter(timezone).formatToParts(t)) if (part.type !== "literal") parts[part.type] = Number(part.value);
	return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute);
}

const floorMinute = (t: number): number => Math.floor(t / MIN) * MIN;

/** The zone the host resolves for itself; `UTC` when it cannot say. */
export function hostZone(): string {
	return validateZone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "") ?? "UTC";
}

/** The canonical name of an IANA zone, or undefined when `raw` is not one (offsets like `+01:00` are refused). */
export function validateZone(raw: string): string | undefined {
	if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(raw) || raw.length > 64) return undefined;
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
	} catch {
		return undefined;
	}
}

/** `YYYY-MM-DDTHH:MM` of the zone's wall clock at instant `t`. */
export function localMinute(timezone: string, t: number): string {
	return new Date(wallOf(timezone, t)).toISOString().slice(0, 16);
}

/** The first instant at which the zone's clock reads (or, in a gap, would first have reached) wall time `wall`. */
function fireOf(timezone: string, wall: number): number {
	const offsetAt = (t: number) => wallOf(timezone, t) - floorMinute(t);
	const candidates = [...new Set([wall - offsetAt(wall - DAY), wall - offsetAt(wall + DAY)])].sort((a, b) => a - b);
	const valid = candidates.filter(t => wallOf(timezone, t) === wall);
	if (valid.length) return valid[0];
	// The wall time does not exist: the smallest minute whose wall clock has reached it. The window holds only the gap.
	let lo = candidates[0];
	let hi = candidates[candidates.length - 1];
	while (hi - lo > MIN) {
		const mid = floorMinute(lo + (hi - lo) / 2);
		if (wallOf(timezone, mid) >= wall) hi = mid;
		else lo = mid;
	}
	return wallOf(timezone, lo) >= wall ? lo : hi;
}

/** Slots whose fire instant lies in (`after`, `upTo`], ascending, at most `limit` of them. */
export function slotsBetween(schedule: Schedule, after: number, upTo: number, limit = Number.POSITIVE_INFINITY): Slot[] {
	const [hour, minute] = AT_RE.exec(schedule.at)!.slice(1).map(Number);
	const weekday = WEEKDAYS.indexOf(schedule.weekday);
	const first = wallOf(schedule.timezone, after) - PAD;
	const last = wallOf(schedule.timezone, upTo) + PAD;
	const hourly = schedule.cadence === "hourly";
	const step = hourly ? HOUR : DAY;
	const origin = Math.floor(first / step) * step + (hourly ? minute * MIN : hour * HOUR + minute * MIN);
	const slots: Slot[] = [];
	for (let wall = origin; wall <= last && slots.length < limit; wall += step) {
		if (wall < first || (schedule.cadence === "weekly" && new Date(wall).getUTCDay() !== weekday)) continue;
		const fire = fireOf(schedule.timezone, wall);
		if (fire <= after || fire > upTo) continue;
		const slot = { id: new Date(wall).toISOString().slice(0, 16), fire };
		// Two wall times of an hourly schedule can collapse onto the instant a gap ends: one slot, the later name.
		if (slots.length && slots[slots.length - 1].fire === fire) slots[slots.length - 1] = slot;
		else slots.push(slot);
	}
	return slots;
}

/** The latest slot that has fired at or before `now`. */
export function latestSlot(schedule: Schedule, now: number): Slot | undefined {
	return slotsBetween(schedule, now - SPAN[schedule.cadence], now).pop();
}

/** The first slot that fires after `now`. */
export function nextSlot(schedule: Schedule, now: number): Slot | undefined {
	return slotsBetween(schedule, now, now + SPAN[schedule.cadence], 2)[0];
}
