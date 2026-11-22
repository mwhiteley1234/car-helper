// Shared bits for the edge functions: settings, JSON replies, and "who is signed in".
import { supabaseBase } from "./supabase.js";

export const env = (k, d) => { const v = Netlify.env.get(k); return v == null || v === "" ? d : String(v).trim(); };

export const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

export function settings() {
  return {
    SUPABASE_URL: supabaseBase(env("SUPABASE_URL")),
    ANON: env("SUPABASE_ANON_KEY"),
    SERVICE: env("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

// Returns the Supabase user for the request's bearer token, or a Response to send back.
export async function signedInUser(request, s) {
  if (!s.SUPABASE_URL || !s.ANON) return { error: json(500, { error: "The site isn't fully configured yet." }) };
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: json(401, { error: "Sign in first." }) };
  const who = await fetch(`${s.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: s.ANON, authorization: `Bearer ${token}` } });
  if (!who.ok) return { error: json(401, { error: "Your sign-in expired. Reload and sign in again." }) };
  return { user: await who.json() };
}

export const serviceHeaders = s => ({ apikey: s.SERVICE, authorization: `Bearer ${s.SERVICE}`, "content-type": "application/json" });
