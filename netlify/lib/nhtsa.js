// NHTSA's free public APIs: the vPIC VIN decoder and the recalls-by-vehicle lookup.
// Plain fetch, so this file works in Netlify Edge Functions (Deno) and in the Node reminder script.

// A VIN has 17 characters and never uses I, O or Q. Character 9 is a check digit (North American VINs).
const VALUES = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
export function cleanVin(v) { return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
export function vinShapeOk(v) { return /^[A-HJ-NPR-Z0-9]{17}$/.test(v); }
export function vinCheckOk(v) {
  if (!vinShapeOk(v)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) { const c = v[i]; sum += (/\d/.test(c) ? +c : VALUES[c]) * WEIGHTS[i]; }
  const r = sum % 11;
  return v[8] === (r === 10 ? "X" : String(r));
}

const titleCase = s => String(s || "").toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase())
  .replace(/\b(Bmw|Gmc|Ram|Mini|Kia|Vw)\b/g, m => ({ Bmw: "BMW", Gmc: "GMC", Ram: "RAM", Mini: "MINI", Kia: "Kia", Vw: "VW" }[m]));

export async function decodeVin(vin) {
  const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`);
  if (!r.ok) throw new Error(`NHTSA VIN decoder returned ${r.status}`);
  const j = await r.json();
  const d = (j && Array.isArray(j.Results) && j.Results[0]) || {};
  const v = k => (d[k] == null ? "" : String(d[k]).trim());
  if (!v("Make") || !v("ModelYear")) return { ok: false, error: v("ErrorText") || "NHTSA couldn't decode this VIN." };
  const disp = parseFloat(v("DisplacementL"));
  const engine = [
    disp ? `${disp.toFixed(1)}L` : "",
    v("EngineCylinders") ? `${v("EngineCylinders")}-cyl` : "",
    v("ElectrificationLevel") && !/^none$/i.test(v("ElectrificationLevel")) ? v("ElectrificationLevel") : v("FuelTypePrimary"),
  ].filter(Boolean).join(" ");
  return {
    ok: true,
    year: parseInt(v("ModelYear"), 10) || null,
    make: titleCase(v("Make")),
    model: v("Model"),
    trim: [v("Trim"), v("Series")].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(" ").slice(0, 60),
    engine: engine.slice(0, 80),
    decoded: {
      body: v("BodyClass"), drive: v("DriveType"), fuel: v("FuelTypePrimary"), fuel2: v("FuelTypeSecondary"),
      electrification: v("ElectrificationLevel"), transmission: v("TransmissionStyle"), engineModel: v("EngineModel"),
      doors: v("Doors"), plant: [v("PlantCity"), v("PlantCountry")].filter(Boolean).join(", "),
      manufacturer: v("Manufacturer"), note: v("ErrorCode") && v("ErrorCode") !== "0" ? v("ErrorText").slice(0, 300) : "",
    },
  };
}

export function vehicleKey(make, model, year) {
  return [make, model, year].map(x => String(x || "").trim().toUpperCase()).join("|");
}

// NHTSA dates look like "16/03/2023" (day first) or ISO; return YYYY-MM-DD or "".
function isoDate(s) {
  s = String(s || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) { let [, a, b, y] = m; a = +a; b = +b; const [d, mo] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b]; return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
  return "";
}

export async function fetchRecalls(make, model, year) {
  const u = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`;
  const r = await fetch(u);
  if (r.status === 400 || r.status === 404) return []; // NHTSA has nothing for that make/model/year
  if (!r.ok) throw new Error(`NHTSA recalls returned ${r.status}`);
  const j = await r.json();
  const list = Array.isArray(j.results) ? j.results : Array.isArray(j.Results) ? j.Results : [];
  const seen = new Set();
  return list.map(x => ({
    campaign: String(x.NHTSACampaignNumber || "").trim(),
    date: isoDate(x.ReportReceivedDate),
    component: String(x.Component || "").slice(0, 200),
    summary: String(x.Summary || "").slice(0, 2000),
    consequence: String(x.Consequence || x.Conequence || "").slice(0, 1200),
    remedy: String(x.Remedy || "").slice(0, 1200),
    manufacturer: String(x.Manufacturer || "").slice(0, 100),
    parkIt: !!x.parkIt, parkOutside: !!x.parkOutSide, ota: !!x.overTheAirUpdate,
  })).filter(x => x.campaign && !seen.has(x.campaign) && seen.add(x.campaign))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}
