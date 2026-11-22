// Daily: refresh NHTSA recalls for everyone's cars, then send phone notifications.
// Runs from GitHub Actions (.github/workflows/reminders.yml). Needs Node 20+ and the web-push package.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, optional VAPID_SUBJECT.
// Optional: DRY_RUN=1 prints what would be sent without sending or saving anything.
//
// Reminders (each sent once; reminders_sent remembers what went out):
//   a new NHTSA recall appears for a car's make, model and year
//   a maintenance item is coming due (within 14 days or 500 miles), and again once it's due
//   no odometer reading for 30 days (asks again every 30 days)
// Nothing is sent to Claude; notifications go through Apple's / the browser's push service.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { fetchRecalls, vehicleKey } from "../netlify/lib/nhtsa.js";

new Function(readFileSync(fileURLToPath(new URL("../public/due.js", import.meta.url)), "utf8"))();
const { todayIso, itemDue, odometerAge, latest } = globalThis.CarDue;

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
const DRY = !!process.env.DRY_RUN;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || (!DRY && (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY))) {
  console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY");
  process.exit(1);
}
if (!DRY) webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const base = SUPABASE_URL.trim().replace(/\/+$/, "").replace(/\/(rest|auth)\/v1.*$/, "");
const H = { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" };
async function sb(path, opts = {}) {
  const r = await fetch(`${base}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Supabase ${r.status} on ${path.split("?")[0]}: ${await r.text()}`);
  return r.status === 204 || opts.method === "DELETE" ? null : r.json().catch(() => null);
}
const upsert = (table, rows, conflict) => DRY || !rows.length ? null : sb(`${table}?on_conflict=${conflict}`, {
  method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows),
});

const today = todayIso();
const carName = c => c.nickname || [c.year, c.make, c.model].filter(Boolean).join(" ") || "Your car";
const num = n => Math.round(n).toLocaleString("en-US");

// 1. Cars and their data
const cars = (await sb("cars?select=id,user_id,nickname,year,make,model&archived=eq.false")) || [];
if (!cars.length) { console.log("No cars yet."); process.exit(0); }
const [readings, items, statuses, sent, subs] = await Promise.all([
  sb("odometer_readings?select=car_id,day,miles"),
  sb("schedule_items?select=id,car_id,title,every_miles,every_months,last_day,last_miles"),
  sb("recall_status?select=car_id,campaign"),
  sb(`reminders_sent?select=user_id,tag&sent_at=gte.${new Date(Date.now() - 400 * 864e5).toISOString()}`),
  sb("push_subscriptions?select=endpoint,user_id,p256dh,auth"),
]);
const group = (rows, key) => rows.reduce((m, r) => (m.get(r[key]) || m.set(r[key], []).get(r[key])).push(r) && m, new Map());
const readingsByCar = group(readings, "car_id"), itemsByCar = group(items, "car_id");
const statusKeys = new Set(statuses.map(s => `${s.car_id}|${s.campaign}`));
const sentKeys = new Set(sent.map(s => `${s.user_id}|${s.tag}`));

// 2. Refresh recalls once per make/model/year
const vehicles = new Map();
for (const c of cars) if (c.make && c.model && c.year) vehicles.set(vehicleKey(c.make, c.model, c.year), c);
const recallsByKey = new Map();
for (const [vkey, c] of vehicles) {
  try {
    const list = await fetchRecalls(c.make, c.model, c.year);
    recallsByKey.set(vkey, list);
    await upsert("recall_sets", [{ vkey, items: list, checked_at: new Date().toISOString() }], "vkey");
  } catch (e) { console.log(`Recalls for ${vkey} failed: ${e.message}`); }
  await new Promise(r => setTimeout(r, 300)); // be polite to NHTSA
}

// 3. Work out reminders per person
const byUser = new Map();
const add = (uid, msg) => { if (!sentKeys.has(`${uid}|${msg.tag}`)) (byUser.get(uid) || byUser.set(uid, []).get(uid)).push(msg); };
const newStatusRows = [];
for (const c of cars) {
  const name = carName(c), url = `#car/${c.id}`;
  // New recalls: campaigns this car has never had a status for. The app records a status for every recall it shows,
  // so recalls that were already listed when the car was added don't trigger a notification.
  const list = recallsByKey.get(vehicleKey(c.make, c.model, c.year)) || [];
  const fresh = list.filter(r => !statusKeys.has(`${c.id}|${r.campaign}`));
  for (const r of fresh) newStatusRows.push({ user_id: c.user_id, car_id: c.id, campaign: r.campaign, status: "open" });
  if (fresh.length === 1) add(c.user_id, { tag: `recall-${c.id}-${fresh[0].campaign}`, title: `New recall: ${name}`, body: `${fresh[0].component || "Safety recall"}. Tap for what to do.${fresh[0].parkIt ? " NHTSA says don't drive it until it's fixed." : ""}`, url });
  else if (fresh.length > 1) add(c.user_id, { tag: `recall-${c.id}-${fresh.map(r => r.campaign).sort().join(",")}`.slice(0, 200), title: `${fresh.length} new recalls: ${name}`, body: "Tap to see what they cover and what to do.", url });

  const rs = readingsByCar.get(c.id) || [];
  for (const it of itemsByCar.get(c.id) || []) {
    const d = itemDue(it, rs, today);
    if (!["due", "overdue"].includes(d.status) && !(d.status === "soon" && d.daysLeft <= 14)) continue;
    const cycle = `${it.last_day || ""}|${it.last_miles ?? ""}`;
    const isDue = d.status === "overdue" || d.daysLeft <= 0 || (d.milesLeft != null && d.milesLeft <= 0);
    const detail = d.by === "miles" && d.dueMiles ? `at about ${num(d.dueMiles)} miles` : `by ${d.dueDay}`;
    add(c.user_id, isDue
      ? { tag: `svc-${it.id}-${cycle}-due`, title: `${name}: ${it.title} is due`, body: `It's due ${detail}. Log it in Car Helper when it's done.`, url }
      : { tag: `svc-${it.id}-${cycle}-soon`, title: `${name}: ${it.title} coming up`, body: `Due ${detail}. Typical interval, check your owner's manual.`, url });
  }

  const age = odometerAge(rs, today);
  if (age != null && age >= 30) add(c.user_id, { tag: `odo-${c.id}-${latest(rs).day}-${Math.floor(age / 30)}`, title: `${name}: what's the mileage?`, body: "Update the odometer so mileage reminders stay accurate.", url });
}
await upsert("recall_status", newStatusRows, "car_id,campaign");

// 4. Send (at most 5 per person per day; the rest wait until tomorrow)
const subsByUser = group(subs, "user_id");
let sentCount = 0, gone = 0;
const done = [];
for (const [uid, msgs] of byUser) {
  const devices = subsByUser.get(uid) || [];
  if (!devices.length) continue;
  for (const m of msgs.slice(0, 5)) {
    if (DRY) { console.log(`[dry run] ${uid}: ${m.title} — ${m.body}`); continue; }
    let ok = false;
    for (const sub of devices) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({ ...m, url: "/?src=push" + m.url }), { TTL: 60 * 60 * 20 });
        ok = true; sentCount++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { await sb(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: "DELETE" }); gone++; }
        else console.log("Push failed", e.statusCode || "", String(e.body || e.message || e).slice(0, 200));
      }
    }
    if (ok) done.push({ user_id: uid, tag: m.tag });
  }
}
await upsert("reminders_sent", done, "user_id,tag");
console.log(`${today}: ${vehicles.size} vehicles checked for recalls, ${newStatusRows.length} new recall rows, sent ${sentCount} notifications, removed ${gone} expired devices.`);
