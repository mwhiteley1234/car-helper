// GET /api/vin?vin=...                     -> decoded year, make, model, trim, engine (NHTSA vPIC)
// GET /api/recalls?make=&model=&year=      -> recalls for that make/model/year (NHTSA), saved to recall_sets
// Both need a signed-in user, so this isn't an open proxy.
import { json, settings, signedInUser, serviceHeaders } from "../lib/auth.js";
import { cleanVin, vinShapeOk, decodeVin, fetchRecalls, vehicleKey } from "../lib/nhtsa.js";

export default async (request) => {
  const s = settings();
  const { error } = await signedInUser(request, s);
  if (error) return error;
  const url = new URL(request.url);

  if (url.pathname === "/api/vin") {
    const vin = cleanVin(url.searchParams.get("vin"));
    if (!vinShapeOk(vin)) return json(400, { error: "A VIN is 17 letters and numbers, without I, O or Q." });
    try { return json(200, await decodeVin(vin)); }
    catch (e) { return json(502, { error: "NHTSA's VIN decoder didn't answer. Try again, or enter the details by hand." }); }
  }

  // /api/recalls
  const make = String(url.searchParams.get("make") || "").trim().slice(0, 40);
  const model = String(url.searchParams.get("model") || "").trim().slice(0, 60);
  const year = parseInt(url.searchParams.get("year"), 10);
  if (!make || !model || !(year > 1950 && year < 2100)) return json(400, { error: "Recalls need the year, make and model." });
  const vkey = vehicleKey(make, model, year);
  try {
    const items = await fetchRecalls(make, model, year);
    if (s.SERVICE) {
      await fetch(`${s.SUPABASE_URL}/rest/v1/recall_sets?on_conflict=vkey`, {
        method: "POST",
        headers: { ...serviceHeaders(s), prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ vkey, items, checked_at: new Date().toISOString() }),
      }).catch(() => {});
    }
    return json(200, { vkey, items, checked_at: new Date().toISOString() });
  } catch (e) {
    return json(502, { error: "NHTSA's recall lookup didn't answer. The app will try again later." });
  }
};

export const config = { path: ["/api/vin", "/api/recalls"] };
