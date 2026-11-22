// GET /api/config — the two public Supabase values the page needs to start.
// The anon key is designed to be public; your data is protected by the row-level security rules in supabase/schema.sql.
import { supabaseBase } from "../lib/supabase.js";

export default () =>
  new Response(
    JSON.stringify({
      supabaseUrl: supabaseBase(Netlify.env.get("SUPABASE_URL")),
      supabaseAnonKey: (Netlify.env.get("SUPABASE_ANON_KEY") || "").trim(),
      vapidPublicKey: (Netlify.env.get("VAPID_PUBLIC_KEY") || "").trim(), // public by design; turns on phone notifications
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );

export const config = { path: "/api/config" };
