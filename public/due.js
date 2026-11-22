// When is maintenance due? Shared by the page and the daily reminder script (scripts/send-reminders.mjs).
// Dates are plain calendar days ("YYYY-MM-DD") in Central time. An item is due on whichever comes first:
// its months since it was last done, or the day its miles are expected to be reached at your usual driving pace.
(function (root) {
  const DEFAULT_MILES_PER_DAY = 35; // about 12,800 a year, close to the US average
  const dayNum = s => { const [y, m, d] = String(s || "").split("-").map(Number); return y && m && d ? Math.round(Date.UTC(y, m - 1, d) / 864e5) : null; };
  const isoOf = n => new Date(n * 864e5).toISOString().slice(0, 10);
  const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  function addMonths(iso, months) {
    const [y, m, d] = iso.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1 + months, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, last));
    return t.toISOString().slice(0, 10);
  }

  const sorted = readings => (readings || []).filter(r => r && r.day && Number.isFinite(+r.miles)).slice()
    .sort((a, b) => a.day.localeCompare(b.day) || a.miles - b.miles);
  function latest(readings) { const s = sorted(readings); return s.length ? s[s.length - 1] : null; }

  // Miles per day from your readings over the last year (needs two readings at least two weeks apart).
  function pace(readings, today) {
    const t = dayNum(today || todayIso());
    const s = sorted(readings).filter(r => dayNum(r.day) >= t - 400);
    if (s.length >= 2) {
      const a = s[0], b = s[s.length - 1], days = dayNum(b.day) - dayNum(a.day), miles = b.miles - a.miles;
      if (days >= 14 && miles > 0) return { perDay: Math.min(300, Math.max(2, miles / days)), measured: true };
    }
    return { perDay: DEFAULT_MILES_PER_DAY, measured: false };
  }

  function estMiles(readings, today) {
    const l = latest(readings); if (!l) return null;
    const t = dayNum(today || todayIso());
    return Math.round(l.miles + pace(readings, today).perDay * Math.max(0, t - dayNum(l.day)));
  }

  // item: { every_miles, every_months, last_day, last_miles }
  // Returns { status: "unknown" | "overdue" | "due" | "soon" | "ok", dueDay, dueMiles, daysLeft, milesLeft, by }
  function itemDue(item, readings, today) {
    today = today || todayIso();
    const t = dayNum(today);
    const hasDay = !!item.last_day, hasMiles = item.last_miles != null && item.last_miles !== "";
    const em = +item.every_miles || 0, mo = +item.every_months || 0;
    if ((!hasDay && !hasMiles) || (!em && !mo)) return { status: "unknown" };
    const options = [];
    if (hasDay && mo) options.push({ by: "date", day: dayNum(addMonths(item.last_day, mo)) });
    let dueMiles = null, milesLeft = null;
    if (hasMiles && em) {
      dueMiles = +item.last_miles + em;
      const l = latest(readings), p = pace(readings, today);
      if (l) {
        milesLeft = dueMiles - estMiles(readings, today);
        options.push({ by: "miles", day: Math.round(dayNum(l.day) + (dueMiles - l.miles) / p.perDay) });
      }
    }
    if (!options.length) return { status: "unknown" };
    const first = options.reduce((a, b) => (b.day < a.day ? b : a));
    const daysLeft = first.day - t;
    const status = daysLeft < 0 ? "overdue" : daysLeft <= 14 || (milesLeft != null && milesLeft <= 500) ? "due" : daysLeft <= 45 ? "soon" : "ok";
    return { status, dueDay: isoOf(first.day), dueMiles, daysLeft, milesLeft, by: first.by };
  }

  // Days since the last odometer reading (null if none).
  function odometerAge(readings, today) { const l = latest(readings); return l ? dayNum(today || todayIso()) - dayNum(l.day) : null; }

  root.CarDue = { DEFAULT_MILES_PER_DAY, dayNum, isoOf, todayIso, addMonths, latest, pace, estMiles, itemDue, odometerAge };
})(typeof window !== "undefined" ? window : globalThis);
