// Turns whatever was pasted into SUPABASE_URL into the bare project address, e.g. https://abcd.supabase.co
// Accepts: https://abcd.supabase.co/, https://abcd.supabase.co/rest/v1/, abcd.supabase.co,
// and the dashboard address https://supabase.com/dashboard/project/abcd/...
export function supabaseBase(raw) {
  let v = String(raw || "").trim();
  if (!v) return "";
  const dash = v.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dash) return `https://${dash[1]}.supabase.co`;
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  try {
    return new URL(v).origin;
  } catch {
    return v.replace(/\/+$/, "");
  }
}
