# Car Helper

A private car-care app: your cars (decoded from the VIN), NHTSA recalls, a maintenance log with time- and mileage-based reminders, an AI-drafted typical maintenance schedule, dashboard-light photos explained by Claude, and rough Austin repair price ranges.

Same setup as Points Helper:

- **Front end:** `public/index.html` (single page, no build step). Due-date math lives in `public/due.js`, shared with the reminder script.
- **Sign-in and data:** Supabase (emailed 6-digit code, invite-only allowlist, row-level security so each person sees only their own cars).
- **AI:** Netlify Edge Function `/api/ask` calls the Claude API with a daily per-person limit. The instructions for each feature (reading a VIN, dashboard lights, schedules, prices) live on the server, so the safety rules can't be changed from the browser.
- **NHTSA:** `/api/vin` (vPIC VIN decoder) and `/api/recalls` (recalls by make, model and year). Both free, no key needed, signed-in users only.
- **Reminders:** a daily GitHub Action (`scripts/send-reminders.mjs`) refreshes recalls for every car and sends push notifications to phones that turned reminders on.
- **Stats:** an owner-only Stats tab (`admin_stats()` in Supabase).

## What it does

| Feature | How it works |
|---|---|
| Add a car | Photo of the VIN (Claude reads it; the app checks the VIN's check digit) or type it. NHTSA decodes year, make, model, trim and engine. Several cars per person. |
| Recalls | NHTSA's public API lists recalls by **year, make and model**, not by VIN, so some may not apply to your exact car. Each car links to NHTSA's VIN lookup to confirm. Mark each recall Open, Fixed or Not my car. Recalls NHTSA flags "park it" or "park outside" show a red warning. |
| Maintenance | Each item is due on whichever comes first: months since it was last done, or its miles at your driving pace (worked out from your odometer readings; 35 mi/day until there are two readings two weeks apart). Logging a service updates the item and saves the mileage. |
| Typical schedule | Drafted by Claude when you add a car, labeled "Typical, check your owner's manual". Every item is editable. |
| Dashboard light | Photo plus optional notes. Claude names the light and how serious it is. Red means pull over safely; it never says it's fine to keep driving with a warning light. A fixed safety banner shows above the answer regardless of what the AI says. Photos aren't stored. |
| Price ranges | Rough Austin ranges for a repair on your car, what changes the price, and "Final quote after inspection." No shop names or recommendations. |
| Reminders | New recall for your make/model/year; maintenance coming due (within 14 days or 500 miles) and when due; mileage update if no reading for 30 days. Each sent once; at most 5 per person per day. |

See **SETUP.md** for the step-by-step setup.

## Later
White-label version for auto repair shops: the shop's branding and prices, and a booking button. The data model already keeps cars, services and schedules per user, so a `shops` table and a `shop_id` on members is the natural next step.
