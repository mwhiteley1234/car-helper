// POST /api/ask  { mode: "vin" | "light" | "schedule" | "price", car?: string, text?: string, image?: { type, data } }
// Checks the Supabase sign-in, enforces a daily per-person limit, then streams Claude's answer.
// The instructions for each mode live here on the server, so the safety rules for dashboard lights
// and price estimates can't be changed from the browser.
import { env, json, settings, signedInUser, serviceHeaders } from "../lib/auth.js";

const SYSTEM = {
  vin: `You read vehicle identification numbers (VINs) from photos of a car's door-jamb sticker, windshield VIN plate, registration or insurance card.
Reply with only the 17-character VIN in capital letters and nothing else. VINs never contain the letters I, O or Q (those are 1 and 0).
If you can't read all 17 characters clearly, reply with exactly: NONE`,

  light: `You help a driver understand a warning or indicator light on their car's dashboard from a photo. They may be on the side of the road, worried. Be calm, clear and cautious.

Safety rules. Follow every one:
- Name each lit symbol you can see. If you are not sure what a symbol is, say so plainly and give the most likely options. Never guess with confidence.
- RED warning lights (for example oil pressure, engine temperature, brake system, battery/charging, airbag, power steering) mean: pull over as soon as it is safe, turn the engine off, and don't keep driving until it has been checked. Suggest calling roadside assistance or a tow.
- A FLASHING check-engine light is serious: slow down, avoid hard acceleration, and pull over safely if the car shakes, runs rough or loses power. Get it checked right away.
- Yellow or amber lights mean: have it checked soon. Say what would make it urgent.
- Green or blue lights are information only (for example headlights or cruise control). Say so.
- NEVER say or suggest that it is fine, safe or OK to keep driving with a warning light on, and never say a warning light can be ignored.
- Only suggest simple, safe checks (for example: is the gas cap tight, check tire pressure with a gauge, check the oil level with the engine off and cooled down). Never tell them to open a hot radiator or coolant cap. No repair instructions.
- If they mention or the photo shows smoke, steam, a burning smell, grinding, a soft or failing brake pedal, or the car driving strangely: pull over safely and call roadside assistance; call 911 if anyone is in danger.
- If the photo doesn't show a dashboard light, say so and ask for a clearer photo.

Format: plain text, no markdown symbols (no ** or #). Use these headings, each on its own line, followed by one to three short lines:
What it is
How serious
What to do now
Simple checks
Get help right away if
Keep it under 200 words.`,

  schedule: `You draft a TYPICAL maintenance schedule for one vehicle, based on commonly published intervals for that make, model, year and engine under normal driving. The owner will be told to check their owner's manual.
Return JSON only, no prose, in this exact shape:
{"items":[{"title":"Oil and filter change","every_miles":7500,"every_months":12,"notes":"Synthetic oil. Shorter if you tow or drive in heavy heat."}]}
Rules:
- 8 to 14 items. Titles under 40 characters. Notes under 120 characters.
- every_miles and every_months are whole numbers or null. Give both where the item is usually done on whichever comes first.
- Include, where they apply: oil and filter, tire rotation, engine air filter, cabin air filter, brake inspection, brake fluid, coolant, transmission fluid, spark plugs, battery test, wiper blades, and any well-known item for this vehicle (for example a timing belt).
- Electric vehicles: no oil, spark plugs or transmission fluid; include tires, brakes, cabin filter, coolant for the battery system, and 12-volt battery.
- Austin is hot: mention heat where it shortens an interval (battery, oil), but keep the interval itself typical.`,

  price: `You give rough repair price ranges for car owners in Austin, Texas. You are not a shop and you don't know this exact car's condition.
Rules:
- Give a total range in US dollars (parts and labor) at independent shops in the Austin area, and a dealer range if it is usually much higher.
- Never name, recommend or rank any shop, chain or business.
- If the request is vague or could be several jobs, give the range for the most likely job and say what to ask the shop to narrow it down.
- If it involves brakes, steering, tires or anything safety related, say briefly not to put it off.
- Don't make up precise part numbers or labor hours.
Format: plain text, no markdown symbols (no ** or #). Use these headings, each on its own line:
Typical range
What changes the price
Good to know
Then end with this exact line: Final quote after inspection. These are rough estimates, not a quote.
Keep it under 180 words.`,
};

const MAX_TOKENS = { vin: 60, light: 1200, schedule: 2500, price: 1000 };
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export default async (request) => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const s = settings();
  const API_KEY = env("ANTHROPIC_API_KEY");
  if (!s.SUPABASE_URL || !s.ANON || !s.SERVICE || !API_KEY) return json(500, { error: "The site isn't fully configured yet." });

  // 1. Who is asking?
  const { user, error } = await signedInUser(request, s);
  if (error) return error;

  // 2. Validate input before counting it against the limit
  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Bad request." }); }
  const mode = Object.hasOwn(SYSTEM, body.mode) ? body.mode : null;
  if (!mode) return json(400, { error: "Unknown question type." });
  const car = String(body.car || "").slice(0, 300);
  const text = String(body.text || "").slice(0, 2000);
  let image = null;
  if (body.image && typeof body.image === "object") {
    const type = String(body.image.type || ""), data = String(body.image.data || "");
    if (!IMAGE_TYPES.includes(type) || !/^[A-Za-z0-9+/=]+$/.test(data) || data.length > 5_000_000) return json(400, { error: "That photo couldn't be used. Try a JPEG or PNG under 3 MB." });
    image = { type, data };
  }
  if ((mode === "vin" || mode === "light") && !image) return json(400, { error: "Add a photo first." });
  if ((mode === "schedule" || mode === "price") && !car) return json(400, { error: "Pick a car first." });
  if (mode === "price" && !text) return json(400, { error: "Say what repair you want priced." });

  // 3. Daily limit
  const limit = parseInt(env("DAILY_QUESTION_LIMIT", "30"), 10);
  const bump = await fetch(`${s.SUPABASE_URL}/rest/v1/rpc/bump_ask`, {
    method: "POST", headers: serviceHeaders(s), body: JSON.stringify({ uid: user.id, lim: limit }),
  });
  if (!bump.ok) {
    const detail = (await bump.text().catch(() => "")).slice(0, 200);
    return json(500, { error: `Couldn't check your daily limit (${bump.status}): ${detail}` });
  }
  if ((await bump.json()) > limit) return json(429, { error: "Daily limit reached. It resets at midnight." });

  // 4. Build the message
  const parts = [];
  if (image) parts.push({ type: "image", source: { type: "base64", media_type: image.type, data: image.data } });
  const lines = [];
  if (car) lines.push(`Vehicle: ${car}`);
  if (mode === "light") lines.push(text ? `What the driver says: ${text}` : "Explain the light(s) in this photo.");
  if (mode === "price") lines.push(`Repair to price: ${text}`);
  if (mode === "schedule") lines.push("Draft the typical maintenance schedule as JSON.");
  if (mode === "vin") lines.push("Read the VIN.");
  parts.push({ type: "text", text: lines.join("\n") });

  // 5. Ask Claude and stream the answer back
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...(env("ANTHROPIC_WORKSPACE_ID") ? { "anthropic-workspace-id": env("ANTHROPIC_WORKSPACE_ID") } : {}),
    },
    body: JSON.stringify({
      model: env("MODEL", "claude-sonnet-5-5"),
      max_tokens: MAX_TOKENS[mode],
      system: SYSTEM[mode],
      stream: true,
      messages: [{ role: "user", content: parts }],
    }),
  });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.log("Anthropic error", upstream.status, detail.slice(0, 500));
    let msg = "";
    try { msg = JSON.parse(detail).error.message; } catch (_) { msg = detail.slice(0, 200); }
    return json(502, { error: `Claude couldn't answer (${upstream.status}): ${msg}` });
  }
  return new Response(upstream.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
};

export const config = { path: "/api/ask" };
