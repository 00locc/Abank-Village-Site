// Abank Village Guest House — booking API (Cloudflare Worker + D1)
//
// Public:   GET  /api/config
//           GET  /api/availability?check_in=YYYY-MM-DD&check_out=YYYY-MM-DD
//           POST /api/bookings                      create a hold + start payment
//           GET  /api/bookings/:ref?t=TOKEN         guest status (private link)
//           POST /api/bookings/lookup               guest status by ref + email
//           POST /api/bookings/:ref/pay             retry payment for a pending booking
// Payments: GET  /api/pay/paystack/callback, POST /api/pay/paystack/webhook
//           GET  /api/pay/paypal/return, GET /api/pay/paypal/cancel
//           GET|POST /api/pay/demo                  preview-only simulated payment
// Admin:    /api/admin/*                            session-cookie protected

const HOLD_MINUTES = 20;
const MAX_NIGHTS = 30;
const MAX_ROOMS_PER_BOOKING = 5;
const MAX_DAYS_AHEAD = 365;
const SESSION_HOURS = 12;
const PBKDF2_ITERATIONS = 100000;
const SESSION_COOKIE = "__Host-av_admin";
const PRODUCTION_HOSTS = ["abankvillage.com", "www.abankvillage.com"];
const OCCUPYING = "(b.status IN ('confirmed','checked_in') OR (b.status = 'pending_payment' AND b.hold_expires_at > ?{NOW}))";
const ADMIN_STATUSES = ["confirmed", "checked_in", "completed", "cancelled"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!env.SITE_URL) env.SITE_URL = url.origin;
    try {
      const res = await route(request, env, ctx, url);
      return withSecurityHeaders(res);
    } catch (err) {
      if (err instanceof HttpError) return withSecurityHeaders(json({ error: err.message }, err.status));
      console.error("Unhandled error", err && err.stack ? err.stack : err);
      return withSecurityHeaders(json({ error: "Something went wrong. Please try again or call 0262 226 592." }, 500));
    }
  },

  async scheduled(_event, env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE bookings SET status = 'expired', updated_at = ?1 WHERE status = 'pending_payment' AND hold_expires_at < ?2").bind(now, now - 30 * 60000),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now),
      env.DB.prepare("DELETE FROM guest_sessions WHERE expires_at < ?1").bind(now),
      env.DB.prepare("DELETE FROM guest_tokens WHERE expires_at < ?1").bind(now),
      env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(now - 24 * 3600000),
    ]);
  },
};

// ───────────────────────── routing ─────────────────────────

async function route(request, env, ctx, url) {
  const p = url.pathname;
  const m = request.method;

  if (p === "/api/config" && m === "GET") return getConfig(env, url);
  if (p === "/api/availability" && m === "GET") return getAvailability(env, url);
  if (p === "/api/bookings" && m === "POST") return createBooking(request, env, ctx, url);
  if (p === "/api/bookings/lookup" && m === "POST") return lookupBooking(request, env);
  let mm = p.match(/^\/api\/bookings\/(AV-[A-Z0-9]{6})$/);
  if (mm && m === "GET") return getBookingByToken(env, mm[1], url.searchParams.get("t") || "");
  mm = p.match(/^\/api\/bookings\/(AV-[A-Z0-9]{6})\/pay$/);
  if (mm && m === "POST") return retryPayment(request, env, url, mm[1]);
  mm = p.match(/^\/api\/bookings\/(AV-[A-Z0-9]{6})\/cancel$/);
  if (mm && m === "POST") return guestCancel(request, env, ctx, url, mm[1]);

  if (p === "/api/pay/paystack/callback" && m === "GET") return paystackCallback(env, ctx, url);
  if (p === "/api/pay/paystack/webhook" && m === "POST") return paystackWebhook(request, env, ctx);
  if (p === "/api/pay/paypal/return" && m === "GET") return paypalReturn(env, ctx, url);
  if (p === "/api/pay/paypal/cancel" && m === "GET") return paypalCancel(env, url);
  if (p === "/api/pay/demo") return demoPay(request, env, ctx, url);

  if (p.startsWith("/api/guest/")) return guestRoute(request, env, ctx, url);
  if (p.startsWith("/api/admin/")) return adminRoute(request, env, ctx, url);
  throw new HttpError(404, "Not found");
}

// ───────────────────────── helpers ─────────────────────────

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function withSecurityHeaders(res) {
  const r = new Response(res.body, res);
  r.headers.set("x-content-type-options", "nosniff");
  r.headers.set("referrer-policy", "no-referrer");
  r.headers.set("x-frame-options", "DENY");
  if (!r.headers.has("cache-control")) r.headers.set("cache-control", "no-store");
  return r;
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

function siteUrl(env, url) {
  return (env.SITE_URL || url.origin).replace(/\/$/, "");
}

async function readJson(request, maxBytes = 8192) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new HttpError(415, "Expected JSON");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request too large");
  try { return JSON.parse(text); } catch { throw new HttpError(400, "Invalid JSON"); }
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "local";
}

function cleanText(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const enc = new TextEncoder();

function b64url(buf) {
  let s = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

async function sha256Hex(s) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

async function hmac(alg, key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: alg }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = enc.encode(a), bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

function requireSecret(env, name) {
  const v = env[name];
  if (!v) throw new Error(`Missing secret ${name}`);
  return v;
}

// Signing key for guest status links: APP_SECRET if set, otherwise a random key generated once and kept in D1.
async function appSecret(env) {
  if (env.APP_SECRET) return env.APP_SECRET;
  if (env.__appSecret) return env.__appSecret;
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('app_secret', ?1)").bind(b64url(randomBytes(32))).run();
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'app_secret'").first();
  env.__appSecret = row.value;
  return row.value;
}

async function guestToken(env, ref) {
  return b64url(await hmac("SHA-256", await appSecret(env), "booking:" + ref)).slice(0, 32);
}

function newRef() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const b = randomBytes(6);
  return "AV-" + [...b].map((x) => alphabet[x % alphabet.length]).join("");
}

async function rateLimit(env, key, limit, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start < ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
     RETURNING count`
  ).bind(key, now, now - windowMs).first();
  if (row && row.count > limit) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.");
}

// ───────────────────────── dates ─────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d) || d.toISOString().slice(0, 10) !== s) return null;
  return d;
}

function todayGhana() {
  return new Date().toISOString().slice(0, 10); // Ghana is UTC+0 all year
}

function addDays(s, n) {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function validateStay(checkIn, checkOut) {
  const a = parseDate(checkIn), b = parseDate(checkOut);
  if (!a || !b) throw new HttpError(400, "Please choose valid check-in and check-out dates.");
  const today = todayGhana();
  if (checkIn < today) throw new HttpError(400, "Check-in date can't be in the past.");
  if (checkIn > addDays(today, MAX_DAYS_AHEAD)) throw new HttpError(400, "Bookings open up to one year ahead.");
  const nights = Math.round((b - a) / 86400000);
  if (nights < 1) throw new HttpError(400, "Check-out must be at least one day after check-in.");
  if (nights > MAX_NIGHTS) throw new HttpError(400, `Online bookings are limited to ${MAX_NIGHTS} nights. Call us for longer stays.`);
  return nights;
}

function fmtDeadline(b) {
  return new Date(cancelDeadline(b)).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC" }) + " (Ghana time)";
}

function fmtDate(s) {
  return new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// ───────────────────────── availability ─────────────────────────

// Highest number of rooms of this type occupied on any night in [checkIn, checkOut).
// Params: ?1 room_type_id, ?2 check_in, ?3 check_out, ?4 now, ?5 booking id to exclude
const MAX_USED_SQL = `
  (SELECT COALESCE(MAX(used), 0) FROM (
     WITH RECURSIVE n(d) AS (
       SELECT ?2
       UNION ALL SELECT date(d, '+1 day') FROM n WHERE date(d, '+1 day') < ?3
     )
     SELECT (SELECT COALESCE(SUM(b.rooms), 0) FROM bookings b
             WHERE b.room_type_id = ?1 AND b.check_in <= n.d AND b.check_out > n.d
               AND b.id != ?5 AND ${OCCUPYING.replace("?{NOW}", "?4")}) AS used
     FROM n))`;

async function availabilityFor(env, checkIn, checkOut, includeInactive = false) {
  const now = Date.now();
  const types = await env.DB.prepare(
    `SELECT id, name, price_ghs, total_rooms, active, sort FROM room_types ${includeInactive ? "" : "WHERE active = 1"} ORDER BY sort`
  ).all();
  const stmts = types.results.map((t) =>
    env.DB.prepare(`SELECT ${MAX_USED_SQL} AS used`).bind(t.id, checkIn, checkOut, now, 0)
  );
  const used = stmts.length ? await env.DB.batch(stmts) : [];
  return types.results.map((t, i) => {
    const u = used[i].results[0].used || 0;
    return { id: t.id, name: t.name, price_ghs: t.price_ghs, total_rooms: t.total_rooms, active: !!t.active, available: Math.max(0, t.total_rooms - u) };
  });
}

async function getAvailability(env, url) {
  const checkIn = url.searchParams.get("check_in") || todayGhana();
  const checkOut = url.searchParams.get("check_out") || addDays(checkIn, 1);
  const nights = validateStay(checkIn, checkOut);
  const rooms = await availabilityFor(env, checkIn, checkOut);
  return json({ check_in: checkIn, check_out: checkOut, nights, rooms }, 200, { "cache-control": "no-store" });
}

// ───────────────────────── config ─────────────────────────

function isDemo(env, url) {
  return env.PAYMENT_MODE === "demo" && !PRODUCTION_HOSTS.includes(url.hostname);
}

function providersEnabled(env, url) {
  const demo = isDemo(env, url);
  return {
    paystack: demo || !!env.PAYSTACK_SECRET_KEY,
    paypal: demo || (!!env.PAYPAL_CLIENT_ID && !!env.PAYPAL_CLIENT_SECRET),
  };
}

async function getSetting(env, key, fallback) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first();
  return row ? row.value : fallback;
}

async function getConfig(env, url) {
  return json({
    turnstile_site_key: env.TURNSTILE_SITE_KEY || null,
    demo_payments: isDemo(env, url),
    providers: providersEnabled(env, url),
    ghs_per_usd: Number(await getSetting(env, "ghs_per_usd", "15.5")),
    max_nights: MAX_NIGHTS,
    max_rooms: MAX_ROOMS_PER_BOOKING,
    today: todayGhana(),
  });
}

// ───────────────────────── bot check ─────────────────────────

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) {
    if (env.PAYMENT_MODE === "demo") return; // local/preview without Turnstile configured
    throw new Error("Missing secret TURNSTILE_SECRET_KEY");
  }
  if (typeof token !== "string" || !token) throw new HttpError(400, "Please complete the security check.");
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  if (ip !== "local") body.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const data = await r.json();
  if (!data.success) throw new HttpError(400, "Security check failed. Please refresh the page and try again.");
}

// ───────────────────────── bookings ─────────────────────────

async function createBooking(request, env, ctx, url) {
  const ip = clientIp(request);
  await rateLimit(env, "book:" + ip, 10, 3600000);
  const body = await readJson(request);

  const roomType = cleanText(body.room_type, 40);
  const checkIn = cleanText(body.check_in, 10);
  const checkOut = cleanText(body.check_out, 10);
  const rooms = Number(body.rooms);
  const name = cleanText(body.name, 100);
  const email = cleanText(body.email, 254).toLowerCase();
  const phone = cleanText(body.phone, 30);
  const notes = cleanText(body.notes, 500);
  const provider = body.provider;

  const nights = validateStay(checkIn, checkOut);
  if (!Number.isInteger(rooms) || rooms < 1 || rooms > MAX_ROOMS_PER_BOOKING) throw new HttpError(400, `You can book between 1 and ${MAX_ROOMS_PER_BOOKING} rooms online.`);
  if (name.length < 2) throw new HttpError(400, "Please enter your full name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "Please enter a valid email address.");
  if (!/^\+?[0-9 ()-]{9,20}$/.test(phone)) throw new HttpError(400, "Please enter a valid phone number.");
  if (!["paystack", "paypal"].includes(provider)) throw new HttpError(400, "Please choose a payment method.");
  if (!providersEnabled(env, url)[provider]) throw new HttpError(400, "That payment method isn't available right now.");

  await verifyTurnstile(env, body.turnstile_token, ip);

  const now = Date.now();
  let ref, result;
  for (let attempt = 0; attempt < 3; attempt++) {
    ref = newRef();
    try {
      // Single atomic statement: only inserts if enough rooms are free on every night.
      result = await env.DB.prepare(
        `INSERT INTO bookings (ref, room_type_id, check_in, check_out, nights, rooms, guest_name, email, phone, notes,
                               price_ghs, amount_ghs, provider, status, payment_status, hold_expires_at, ip, created_at, updated_at)
         SELECT ?6, rt.id, ?2, ?3, ?7, ?8, ?9, ?10, ?11, ?12,
                rt.price_ghs, rt.price_ghs * ?7 * ?8, ?13, 'pending_payment', 'unpaid', ?14, ?15, ?4, ?4
         FROM room_types rt
         WHERE rt.id = ?1 AND rt.active = 1 AND rt.total_rooms - ${MAX_USED_SQL} >= ?8`
      ).bind(roomType, checkIn, checkOut, now, 0, ref, nights, rooms, name, email, phone, notes || null,
             provider, now + HOLD_MINUTES * 60000, ip).run();
      break;
    } catch (e) {
      if (String(e).includes("UNIQUE") && attempt < 2) continue;
      throw e;
    }
  }
  if (!result.meta.changes) {
    const avail = (await availabilityFor(env, checkIn, checkOut)).find((r) => r.id === roomType);
    if (!avail) throw new HttpError(400, "That room type isn't available for online booking.");
    throw new HttpError(409, avail.available
      ? `Only ${avail.available} room${avail.available === 1 ? "" : "s"} of this type left for those dates.`
      : "Sorry, this room type is fully booked for those dates. Try different dates or another room.");
  }

  const booking = await env.DB.prepare("SELECT * FROM bookings WHERE ref = ?1").bind(ref).first();
  await logEvent(env, booking.id, "guest", "Booking created — awaiting payment.");
  const token = await guestToken(env, ref);
  const payUrl = await startPayment(env, url, booking, token);
  return json({ ref, token, amount_ghs: booking.amount_ghs, hold_minutes: HOLD_MINUTES, redirect: payUrl });
}

async function retryPayment(request, env, url, ref) {
  await rateLimit(env, "retry:" + clientIp(request), 10, 3600000);
  const body = await readJson(request);
  const booking = await bookingForToken(env, ref, body.t);
  if (booking.status !== "pending_payment" || booking.payment_status !== "unpaid") throw new HttpError(400, "This booking doesn't need payment.");
  const provider = body.provider || booking.provider;
  if (!["paystack", "paypal"].includes(provider) || !providersEnabled(env, url)[provider]) throw new HttpError(400, "That payment method isn't available right now.");
  const now = Date.now();
  // Re-take the hold (re-checks availability, excluding this booking itself).
  const res = await env.DB.prepare(
    `UPDATE bookings SET hold_expires_at = ?6, provider = ?7, updated_at = ?4
     WHERE id = ?5 AND status = 'pending_payment'
       AND (SELECT total_rooms FROM room_types WHERE id = ?1) - ${MAX_USED_SQL} >= ?8`
  ).bind(booking.room_type_id, booking.check_in, booking.check_out, now, booking.id, now + HOLD_MINUTES * 60000, provider, booking.rooms).run();
  if (!res.meta.changes) throw new HttpError(409, "Sorry, those rooms were taken while your booking was unpaid. Please start a new booking.");
  booking.provider = provider;
  return json({ redirect: await startPayment(env, url, booking, body.t) });
}

async function bookingForToken(env, ref, token) {
  if (typeof token !== "string" || !safeEqual(token, await guestToken(env, ref))) throw new HttpError(404, "Booking not found.");
  const b = await env.DB.prepare("SELECT * FROM bookings WHERE ref = ?1").bind(ref).first();
  if (!b) throw new HttpError(404, "Booking not found.");
  return b;
}

async function publicBooking(env, b) {
  const rt = await env.DB.prepare("SELECT name FROM room_types WHERE id = ?1").bind(b.room_type_id).first();
  const events = await env.DB.prepare("SELECT at, message FROM booking_events WHERE booking_id = ?1 AND public = 1 ORDER BY at, id").bind(b.id).all();
  return {
    ref: b.ref, room: rt ? rt.name : b.room_type_id, check_in: b.check_in, check_out: b.check_out,
    nights: b.nights, rooms: b.rooms, guest_name: b.guest_name, email: b.email, phone: b.phone,
    amount_ghs: b.amount_ghs, provider: b.provider, status: b.status, payment_status: b.payment_status,
    hold_expires_at: b.status === "pending_payment" ? b.hold_expires_at : null,
    cancel_deadline: cancelDeadline(b), can_cancel: canGuestCancel(b),
    created_at: b.created_at, events: events.results,
  };
}

async function getBookingByToken(env, ref, token) {
  const b = await bookingForToken(env, ref, token);
  return json({ booking: await publicBooking(env, b) });
}

async function lookupBooking(request, env) {
  await rateLimit(env, "lookup:" + clientIp(request), 15, 3600000);
  const body = await readJson(request);
  const ref = cleanText(body.ref, 12).toUpperCase();
  const email = cleanText(body.email, 254).toLowerCase();
  const b = /^AV-[A-Z0-9]{6}$/.test(ref)
    ? await env.DB.prepare("SELECT * FROM bookings WHERE ref = ?1 AND email = ?2").bind(ref, email).first()
    : null;
  if (!b) throw new HttpError(404, "We couldn't find a booking with that reference and email.");
  return json({ booking: await publicBooking(env, b), token: await guestToken(env, ref) });
}

async function logEvent(env, bookingId, actor, message, isPublic = true) {
  await env.DB.prepare("INSERT INTO booking_events (booking_id, at, actor, message, public) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(bookingId, Date.now(), actor, message, isPublic ? 1 : 0).run();
}

// ───────────────────────── guest cancellation ─────────────────────────
// Free cancellation with an automatic full refund until 48 hours before check-in (check-in is 12:00 PM Ghana time).

const CANCEL_HOURS_BEFORE = 48;

function cancelDeadline(b) {
  return Date.parse(b.check_in + "T12:00:00Z") - CANCEL_HOURS_BEFORE * 3600000;
}

function canGuestCancel(b) {
  if (b.status === "pending_payment" && b.payment_status === "unpaid") return true;
  return b.status === "confirmed" && b.payment_status === "paid" && Date.now() < cancelDeadline(b);
}

async function guestCancel(request, env, ctx, url, ref) {
  await rateLimit(env, "cancel:" + clientIp(request), 10, 3600000);
  const body = await readJson(request);
  const b = await bookingForToken(env, ref, body.t);
  if (!canGuestCancel(b)) {
    throw new HttpError(400, b.status === "confirmed" && Date.now() >= cancelDeadline(b)
      ? `Online cancellation closes ${CANCEL_HOURS_BEFORE} hours before check-in. Please call 0262 226 592.`
      : "This booking can't be cancelled online. Please call 0262 226 592.");
  }
  const now = Date.now();

  if (b.payment_status === "unpaid") {
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled', updated_at = ?2 WHERE id = ?1 AND status = 'pending_payment'").bind(b.id, now).run();
    await logEvent(env, b.id, "guest", "Booking cancelled by guest before payment.");
    return json({ ok: true, refunded: false });
  }

  // Claim the cancellation atomically so a double-click can't refund twice.
  const claim = await env.DB.prepare(
    "UPDATE bookings SET status = 'cancelled', updated_at = ?2 WHERE id = ?1 AND status = 'confirmed' AND payment_status = 'paid'"
  ).bind(b.id, now).run();
  if (!claim.meta.changes) throw new HttpError(409, "This booking was already updated. Refresh the page.");
  await logEvent(env, b.id, "guest", "Booking cancelled by guest. Room released.");

  let result;
  try { result = await refundPayment(env, b); }
  catch (e) { console.error("Refund failed", b.ref, e.message); result = { ok: false, detail: e.message }; }

  const amount = b.pay_currency === "USD" ? `US$${(b.pay_amount_minor / 100).toFixed(2)}` : `GH₵ ${b.amount_ghs.toLocaleString()}`;
  if (result.ok) {
    await env.DB.prepare("UPDATE bookings SET payment_status = 'refunded', updated_at = ?2 WHERE id = ?1").bind(b.id, Date.now()).run();
    const when = b.provider === "paypal" ? "PayPal usually shows it within a few days." : "Mobile Money refunds usually arrive within a few days; card refunds can take up to 10 working days.";
    const msg = `Your booking has been cancelled and a full refund of ${amount} has been issued. ${when}`;
    await logEvent(env, b.id, "system", msg);
    await logEvent(env, b.id, "system", `Refund reference: ${result.ref || "n/a"}`, false);
    ctx.waitUntil(sendStatusEmail(env, b, msg));
    ctx.waitUntil(notifyHotel(env, `Guest cancelled ${b.ref} (refunded)`,
      `${b.guest_name} cancelled booking ${b.ref} (${b.check_in} to ${b.check_out}). ${amount} was refunded automatically via ${providerLabel(b.provider)}. The room is available again.`));
    return json({ ok: true, refunded: true });
  }
  const msg = `Your booking has been cancelled. We'll refund ${amount} to you shortly — our team has been notified.`;
  await logEvent(env, b.id, "system", msg);
  await logEvent(env, b.id, "system", `Automatic refund failed: ${result.detail || "unknown error"}`, false);
  ctx.waitUntil(sendStatusEmail(env, b, msg));
  ctx.waitUntil(notifyHotel(env, `ACTION NEEDED: refund ${b.ref} manually`,
    `${b.guest_name} (${b.phone}, ${b.email}) cancelled booking ${b.ref}, but the automatic refund of ${amount} via ${providerLabel(b.provider)} failed. Please refund them in the ${providerLabel(b.provider)} dashboard, then press "Mark refunded" in the admin dashboard.`));
  return json({ ok: true, refunded: false });
}

// Full refund through whichever provider took the payment.
async function refundPayment(env, b) {
  if (!b.provider_ref || String(b.provider_ref).startsWith("demo-")) return { ok: true, ref: "demo" }; // preview test payments
  if (b.provider === "paystack") {
    const r = await fetch("https://api.paystack.co/refund", {
      method: "POST",
      headers: { authorization: `Bearer ${requireSecret(env, "PAYSTACK_SECRET_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify({ transaction: b.provider_ref }),
    });
    const d = await r.json();
    if (!r.ok || !d.status) return { ok: false, detail: d.message || `Paystack ${r.status}` };
    return { ok: true, ref: String(d.data?.id || "") };
  }
  if (b.provider === "paypal") {
    const access = await paypalToken(env);
    const or = await fetch(`${paypalBase(env)}/v2/checkout/orders/${encodeURIComponent(b.provider_ref)}`, { headers: { authorization: `Bearer ${access}` } });
    const order = await or.json();
    const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
    if (!or.ok || !capture) return { ok: false, detail: "PayPal capture not found" };
    const r = await fetch(`${paypalBase(env)}/v2/payments/captures/${capture.id}/refund`, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json", "paypal-request-id": `refund-${b.ref}` },
      body: "{}",
    });
    const d = await r.json();
    if (!r.ok || !["COMPLETED", "PENDING"].includes(d.status)) return { ok: false, detail: d.message || d.name || `PayPal ${r.status}` };
    return { ok: true, ref: d.id };
  }
  return { ok: false, detail: "No online payment to refund" };
}

// ───────────────────────── payments ─────────────────────────

async function startPayment(env, url, booking, token) {
  const base = siteUrl(env, url);
  // Real provider whenever its keys are configured; otherwise the preview-only simulated checkout.
  if (booking.provider === "paystack" && env.PAYSTACK_SECRET_KEY) return paystackInit(env, base, booking);
  if (booking.provider === "paypal" && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) return paypalCreate(env, base, booking, token);
  if (isDemo(env, url)) return `${base}/api/pay/demo?ref=${booking.ref}&t=${encodeURIComponent(token)}`;
  throw new HttpError(400, "Unknown payment method.");
}

// Marks a booking paid. Idempotent. If the hold lapsed and the rooms are gone, flags it for a refund.
async function finalizePaid(env, ctx, booking, provider, currency, amountMinor, providerRef) {
  if (booking.payment_status === "paid") return booking;
  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE bookings SET status = 'confirmed', payment_status = 'paid', provider = ?6, pay_currency = ?7,
            pay_amount_minor = ?8, provider_ref = COALESCE(?9, provider_ref), updated_at = ?4
     WHERE id = ?5 AND payment_status = 'unpaid' AND status IN ('pending_payment', 'expired')
       AND (SELECT total_rooms FROM room_types WHERE id = ?1) - ${MAX_USED_SQL} >= ?10`
  ).bind(booking.room_type_id, booking.check_in, booking.check_out, now, booking.id, provider, currency, amountMinor, providerRef, booking.rooms).run();

  if (res.meta.changes) {
    await logEvent(env, booking.id, "system", `Payment received via ${providerLabel(provider)}. Booking confirmed.`);
    const updated = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?1").bind(booking.id).first();
    ctx.waitUntil(sendConfirmationEmails(env, updated));
    return updated;
  }
  const fresh = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?1").bind(booking.id).first();
  if (fresh.payment_status === "paid") return fresh; // a parallel webhook/callback already did it
  // Paid, but the rooms are no longer free (or booking was cancelled). Record payment, flag for refund.
  await env.DB.prepare(
    `UPDATE bookings SET status = 'payment_conflict', payment_status = 'paid', provider = ?2, pay_currency = ?3,
            pay_amount_minor = ?4, provider_ref = COALESCE(?5, provider_ref), updated_at = ?6 WHERE id = ?1`
  ).bind(booking.id, provider, currency, amountMinor, providerRef, now).run();
  await logEvent(env, booking.id, "system", "Payment received, but the room was no longer available. Our team will contact you to rebook or refund.");
  const conflicted = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?1").bind(booking.id).first();
  ctx.waitUntil(notifyHotel(env, `ACTION NEEDED: paid booking ${booking.ref} has no room`,
    `Booking ${booking.ref} was paid after its hold expired and the rooms are now full. Contact ${booking.guest_name} (${booking.phone}, ${booking.email}) to rebook or refund.`));
  return conflicted;
}

function providerLabel(p) {
  return { paystack: "Mobile Money / Card (Paystack)", paypal: "PayPal", demo: "Demo", manual: "Hotel desk" }[p] || p;
}

// Sends the guest to their booking page. Called only from payment returns; if the booking was just paid,
// the guest is also signed in to My Bookings on this device (no account or password needed).
async function statusRedirect(env, url, ref) {
  const res = redirect(`${siteUrl(env, url)}/booking-status.html?ref=${ref}&t=${encodeURIComponent(await guestToken(env, ref))}`);
  const b = await env.DB.prepare("SELECT email, payment_status, updated_at FROM bookings WHERE ref = ?1").bind(ref).first();
  if (b && b.email && b.payment_status === "paid" && Date.now() - b.updated_at < 30 * 60000) {
    res.headers.append("set-cookie", await newGuestSession(env, b.email));
  }
  return res;
}

// Paystack — supports MTN MoMo, Telecel Cash, AirtelTigo Money and cards in GHS.
async function paystackInit(env, base, booking) {
  const secret = requireSecret(env, "PAYSTACK_SECRET_KEY");
  const reference = `${booking.ref}-${hex(randomBytes(3))}`;
  const r = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      email: booking.email,
      amount: booking.amount_ghs * 100, // pesewas
      currency: "GHS",
      reference,
      callback_url: `${base}/api/pay/paystack/callback`,
      channels: ["mobile_money", "card"],
      metadata: { booking_ref: booking.ref, cancel_action: `${base}/booking-status.html?ref=${booking.ref}` },
    }),
  });
  const data = await r.json();
  if (!r.ok || !data.status) {
    console.error("Paystack init failed", data);
    throw new HttpError(502, "Couldn't start the payment. Please try again.");
  }
  await env.DB.prepare("UPDATE bookings SET provider_ref = ?1, updated_at = ?2 WHERE id = ?3").bind(reference, Date.now(), booking.id).run();
  return data.data.authorization_url;
}

async function paystackVerifyAndFinalize(env, ctx, reference) {
  const secret = requireSecret(env, "PAYSTACK_SECRET_KEY");
  const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const data = await r.json();
  const ref = reference.split("-").slice(0, 2).join("-");
  const booking = await env.DB.prepare("SELECT * FROM bookings WHERE ref = ?1").bind(ref).first();
  if (!booking) return null;
  if (!r.ok || !data.status || data.data.status !== "success") return booking;
  if (data.data.currency !== "GHS" || data.data.amount !== booking.amount_ghs * 100) {
    await logEvent(env, booking.id, "system", `Paystack amount mismatch: got ${data.data.currency} ${data.data.amount}`, false);
    return booking;
  }
  return finalizePaid(env, ctx, booking, "paystack", "GHS", data.data.amount, reference);
}

async function paystackCallback(env, ctx, url) {
  const reference = url.searchParams.get("reference") || url.searchParams.get("trxref") || "";
  if (!/^AV-[A-Z0-9]{6}-[0-9a-f]{6}$/.test(reference)) throw new HttpError(400, "Invalid payment reference");
  const booking = await paystackVerifyAndFinalize(env, ctx, reference);
  if (!booking) throw new HttpError(404, "Booking not found");
  return statusRedirect(env, url, booking.ref);
}

async function paystackWebhook(request, env, ctx) {
  if (!env.PAYSTACK_SECRET_KEY) return new Response("not configured", { status: 503 });
  const raw = await request.text();
  const sig = request.headers.get("x-paystack-signature") || "";
  const expected = hex(await hmac("SHA-512", requireSecret(env, "PAYSTACK_SECRET_KEY"), raw));
  if (!safeEqual(sig, expected)) return new Response("bad signature", { status: 401 });
  const evt = JSON.parse(raw);
  if (evt.event === "charge.success" && evt.data && /^AV-[A-Z0-9]{6}-[0-9a-f]{6}$/.test(evt.data.reference || "")) {
    // Re-verify with Paystack rather than trusting the payload amount.
    await paystackVerifyAndFinalize(env, ctx, evt.data.reference);
  }
  return new Response("ok");
}

// PayPal — charged in USD (PayPal doesn't support GHS), converted at the admin-set rate.
function paypalBase(env) {
  return env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

async function paypalToken(env) {
  const id = requireSecret(env, "PAYPAL_CLIENT_ID"), secret = requireSecret(env, "PAYPAL_CLIENT_SECRET");
  const r = await fetch(`${paypalBase(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: "Basic " + btoa(`${id}:${secret}`), "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await r.json();
  if (!r.ok) { console.error("PayPal auth failed", data); throw new HttpError(502, "Couldn't reach PayPal. Please try again."); }
  return data.access_token;
}

async function usdCents(env, ghs) {
  const rate = Number(await getSetting(env, "ghs_per_usd", "15.5"));
  if (!(rate > 0)) throw new Error("Bad ghs_per_usd setting");
  return Math.ceil((ghs / rate) * 100);
}

async function paypalCreate(env, base, booking, token) {
  const cents = await usdCents(env, booking.amount_ghs);
  const access = await paypalToken(env);
  const r = await fetch(`${paypalBase(env)}/v2/checkout/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json", "paypal-request-id": `${booking.ref}-${hex(randomBytes(4))}` },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: booking.ref,
        custom_id: booking.ref,
        description: `Abank Village Guest House — ${booking.nights} night(s), booking ${booking.ref}`,
        amount: { currency_code: "USD", value: (cents / 100).toFixed(2) },
      }],
      payment_source: { paypal: { experience_context: {
        brand_name: "Abank Village Guest House",
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING",
        return_url: `${base}/api/pay/paypal/return`,
        cancel_url: `${base}/api/pay/paypal/cancel?ref=${booking.ref}&t=${encodeURIComponent(token)}`,
      } } },
    }),
  });
  const data = await r.json();
  if (!r.ok) { console.error("PayPal create failed", data); throw new HttpError(502, "Couldn't start PayPal checkout. Please try again."); }
  await env.DB.prepare("UPDATE bookings SET provider_ref = ?1, pay_currency = 'USD', pay_amount_minor = ?2, updated_at = ?3 WHERE id = ?4")
    .bind(data.id, cents, Date.now(), booking.id).run();
  const link = (data.links || []).find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!link) throw new HttpError(502, "PayPal didn't return a checkout link.");
  return link.href;
}

async function paypalReturn(env, ctx, url) {
  const orderId = url.searchParams.get("token") || "";
  if (!/^[A-Z0-9]{10,30}$/.test(orderId)) throw new HttpError(400, "Invalid PayPal order");
  const booking = await env.DB.prepare("SELECT * FROM bookings WHERE provider_ref = ?1 AND provider = 'paypal'").bind(orderId).first();
  if (!booking) throw new HttpError(404, "Booking not found");
  if (booking.payment_status !== "paid") {
    const access = await paypalToken(env);
    const r = await fetch(`${paypalBase(env)}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json", "paypal-request-id": `cap-${orderId}` },
    });
    const data = await r.json();
    const cap = data?.purchase_units?.[0]?.payments?.captures?.[0];
    const already = data?.details?.[0]?.issue === "ORDER_ALREADY_CAPTURED";
    if (r.ok && data.status === "COMPLETED" && cap && cap.status === "COMPLETED") {
      const paidCents = Math.round(Number(cap.amount.value) * 100);
      if (cap.amount.currency_code === "USD" && paidCents === booking.pay_amount_minor) {
        await finalizePaid(env, ctx, booking, "paypal", "USD", paidCents, orderId);
      } else {
        await logEvent(env, booking.id, "system", `PayPal amount mismatch: ${cap.amount.currency_code} ${cap.amount.value}`, false);
      }
    } else if (!already) {
      console.error("PayPal capture failed", data);
      await logEvent(env, booking.id, "system", "PayPal payment was not completed.");
    }
  }
  return statusRedirect(env, url, booking.ref);
}

async function paypalCancel(env, url) {
  const ref = url.searchParams.get("ref") || "";
  const t = url.searchParams.get("t") || "";
  return redirect(`${siteUrl(env, url)}/booking-status.html?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(t)}&cancelled=1`);
}

// Preview-only fake checkout so the whole flow can be tested without real money.
async function demoPay(request, env, ctx, url) {
  if (!isDemo(env, url)) throw new HttpError(404, "Not found");
  if (request.method === "GET") {
    const ref = url.searchParams.get("ref") || "", t = url.searchParams.get("t") || "";
    const b = await bookingForToken(env, ref, t);
    const usd = b.provider === "paypal" ? ` (≈ US$${(await usdCents(env, b.amount_ghs) / 100).toFixed(2)})` : "";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demo checkout</title><meta name="robots" content="noindex">
<style>body{font-family:system-ui,sans-serif;background:#F5FAFD;color:#12293C;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
.c{background:#fff;border:1px solid #CFE0EC;border-radius:18px;padding:28px;max-width:420px;width:100%;box-shadow:0 10px 40px rgba(14,36,54,.1)}
.tag{display:inline-block;background:#FFF4D6;color:#7A5A00;font-size:12px;font-weight:700;padding:4px 10px;border-radius:20px;letter-spacing:.05em}
h1{font-size:20px;margin:14px 0 6px}p{color:#34566F;font-size:14px;line-height:1.6}.amt{font-size:28px;font-weight:700;color:#17588C;margin:10px 0 18px}
button{width:100%;padding:13px;border-radius:30px;border:0;font-size:15px;font-weight:600;cursor:pointer;margin-top:10px}
.ok{background:#17588C;color:#fff}.no{background:#E4EFF6;color:#12293C}</style></head><body><div class="c">
<span class="tag">PREVIEW — NO REAL MONEY</span><h1>${escapeHtml(providerLabel(b.provider))}</h1>
<p>Booking ${escapeHtml(b.ref)} · ${escapeHtml(b.guest_name)}</p><div class="amt">GH₵ ${b.amount_ghs.toLocaleString()}${usd}</div>
<p>This page stands in for the real Paystack / PayPal checkout while the booking system is being tested.</p>
<form method="post"><input type="hidden" name="ref" value="${escapeHtml(b.ref)}"><input type="hidden" name="t" value="${escapeHtml(t)}">
<button class="ok" name="outcome" value="success" type="submit">Simulate successful payment</button>
<button class="no" name="outcome" value="cancel" type="submit">Cancel payment</button></form></div></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
  const form = await request.formData();
  const ref = String(form.get("ref") || ""), t = String(form.get("t") || "");
  const b = await bookingForToken(env, ref, t);
  if (form.get("outcome") === "success") {
    const isPP = b.provider === "paypal";
    await finalizePaid(env, ctx, b, b.provider, isPP ? "USD" : "GHS", isPP ? await usdCents(env, b.amount_ghs) : b.amount_ghs * 100, "demo-" + hex(randomBytes(4)));
    return statusRedirect(env, url, ref);
  }
  return redirect(`${siteUrl(env, url)}/booking-status.html?ref=${ref}&t=${encodeURIComponent(t)}&cancelled=1`);
}

// ───────────────────────── email ─────────────────────────

// Sends via Resend (https://resend.com). Returns true if the email was accepted.
async function sendEmail(env, to, subject, text, html) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !to) { console.log(`[email skipped] ${subject} -> ${to}`); return false; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: `Abank Village Guest House <${env.EMAIL_FROM}>`, to: [to], subject, text, html,
        reply_to: env.HOTEL_EMAIL || undefined,
      }),
    });
    if (!r.ok) { console.error("Email send failed", r.status, await r.text()); return false; }
    return true;
  } catch (e) {
    console.error("Email send failed", e.message);
    return false;
  }
}

async function notifyHotel(env, subject, text) {
  if (env.HOTEL_EMAIL) await sendEmail(env, env.HOTEL_EMAIL, subject, text, `<p>${escapeHtml(text)}</p>`);
}

async function sendConfirmationEmails(env, b) {
  const rt = await env.DB.prepare("SELECT name FROM room_types WHERE id = ?1").bind(b.room_type_id).first();
  const link = `${(env.SITE_URL || "").replace(/\/$/, "")}/booking-status.html?ref=${b.ref}&t=${encodeURIComponent(await guestToken(env, b.ref))}`;
  const rows = [
    ["Booking reference", b.ref], ["Room", `${rt?.name || b.room_type_id}${b.rooms > 1 ? ` × ${b.rooms}` : ""}`],
    ["Check-in", `${fmtDate(b.check_in)} from 12:00 PM`], ["Check-out", `${fmtDate(b.check_out)} by 11:00 AM`],
    ["Nights", String(b.nights)], ["Total paid", `GH₵ ${b.amount_ghs.toLocaleString()}`],
  ];
  const text = `Hi ${b.guest_name},\n\nYour stay at Abank Village Guest House is confirmed.\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    `\n\nCheck your booking status anytime: ${link}\n\nFree cancellation with a full refund until ${fmtDeadline(b)}. To cancel: ${link}&cancel=1\n\nQuestions? Call 0262 226 592 or 0233 344 425.\n\nAbank Village Guest House, near KNUST-Emena, Kumasi`;
  const html = `<div style="font-family:Arial,sans-serif;color:#12293C;max-width:520px">
<h2 style="color:#17588C;margin:0 0 8px">Your stay is confirmed</h2><p>Hi ${escapeHtml(b.guest_name)}, thank you for booking with Abank Village Guest House.</p>
<table style="border-collapse:collapse;width:100%;font-size:14px">${rows.map(([k, v]) =>
    `<tr><td style="padding:8px 0;color:#7C93A5;border-bottom:1px solid #E4EFF6">${k}</td><td style="padding:8px 0;font-weight:600;text-align:right;border-bottom:1px solid #E4EFF6">${escapeHtml(v)}</td></tr>`).join("")}</table>
<p style="margin:22px 0"><a href="${escapeHtml(link)}" style="background:#17588C;color:#fff;padding:12px 26px;border-radius:30px;text-decoration:none;font-weight:600">View booking status</a></p>
<p style="font-size:13px;color:#34566F">Free cancellation with a full refund until ${escapeHtml(fmtDeadline(b))}. <a href="${escapeHtml(link)}&cancel=1" style="color:#8A1F17">Cancel booking</a></p>
<p style="font-size:13px;color:#34566F">Questions? Call <a href="tel:0262226592">0262 226 592</a> or <a href="tel:0233344425">0233 344 425</a>.<br>Abank Village Guest House, near KNUST-Emena, Kumasi</p></div>`;
  await sendEmail(env, b.email, `Booking confirmed — ${b.ref}`, text, html);
  await notifyHotel(env, `New booking ${b.ref}: ${rt?.name || b.room_type_id}, ${b.check_in} → ${b.check_out}`,
    `${b.guest_name} (${b.phone}, ${b.email}) booked ${b.rooms} × ${rt?.name || b.room_type_id} for ${b.nights} night(s), ${b.check_in} to ${b.check_out}. Paid GH₵ ${b.amount_ghs} via ${providerLabel(b.provider)}.${b.notes ? " Notes: " + b.notes : ""}`);
}

async function sendStatusEmail(env, b, message) {
  const link = `${(env.SITE_URL || "").replace(/\/$/, "")}/booking-status.html?ref=${b.ref}&t=${encodeURIComponent(await guestToken(env, b.ref))}`;
  await sendEmail(env, b.email, `Booking update — ${b.ref}`,
    `Hi ${b.guest_name},\n\n${message}\n\nView your booking: ${link}\n\nAbank Village Guest House — 0262 226 592`,
    `<div style="font-family:Arial,sans-serif;color:#12293C"><p>Hi ${escapeHtml(b.guest_name)},</p><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(link)}">View your booking</a></p><p style="font-size:13px;color:#34566F">Abank Village Guest House — 0262 226 592</p></div>`);
}

// ───────────────────────── guest "My bookings" (emailed sign-in link, no passwords) ─────────────────────────

const GUEST_COOKIE = "__Host-av_guest";
const GUEST_LINK_MINUTES = 30;
const GUEST_SESSION_DAYS = 7;

// Creates a My Bookings session for this email and returns the Set-Cookie header value.
async function newGuestSession(env, email) {
  const session = b64url(randomBytes(32));
  await env.DB.prepare("INSERT INTO guest_sessions (token_hash, email, expires_at) VALUES (?1, ?2, ?3)")
    .bind(await sha256Hex(session), email, Date.now() + GUEST_SESSION_DAYS * 86400000).run();
  return `${GUEST_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${GUEST_SESSION_DAYS * 86400}`;
}

async function currentGuest(request, env) {
  const tok = getCookie(request, GUEST_COOKIE);
  if (!tok || tok.length > 100) return null;
  return env.DB.prepare("SELECT email FROM guest_sessions WHERE token_hash = ?1 AND expires_at > ?2")
    .bind(await sha256Hex(tok), Date.now()).first();
}

async function guestRoute(request, env, ctx, url) {
  const p = url.pathname.slice("/api/guest".length);
  const m = request.method;
  checkOrigin(request, url);

  // Step 1: guest asks for a sign-in link. Same answer whether or not the email has bookings.
  if (p === "/login" && m === "POST") {
    const ip = clientIp(request);
    await rateLimit(env, "guest-login-ip:" + ip, 10, 3600000);
    const body = await readJson(request);
    const email = cleanText(body.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "Please enter a valid email address.");
    await rateLimit(env, "guest-login-email:" + email, 5, 3600000);
    await verifyTurnstile(env, body.turnstile_token, ip);
    const has = await env.DB.prepare("SELECT 1 FROM bookings WHERE email = ?1 AND status != 'expired' LIMIT 1").bind(email).first();
    const reply = { ok: true, message: "If that email has bookings with us, a sign-in link is on its way. It works for 30 minutes." };
    if (!has) return json(reply);
    const token = b64url(randomBytes(32));
    await env.DB.prepare("INSERT INTO guest_tokens (token_hash, email, expires_at) VALUES (?1, ?2, ?3)")
      .bind(await sha256Hex(token), email, Date.now() + GUEST_LINK_MINUTES * 60000).run();
    const link = `${siteUrl(env, url)}/my-bookings.html#token=${token}`;
    const sent = await sendEmail(env, email, "Your Abank Village sign-in link",
      `Use this link to see your bookings at Abank Village Guest House:\n\n${link}\n\nIt works once and expires in ${GUEST_LINK_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
      `<div style="font-family:Arial,sans-serif;color:#12293C;max-width:520px"><h2 style="color:#17588C">Sign in to see your bookings</h2>
<p>Tap the button below to see your bookings at Abank Village Guest House.</p>
<p style="margin:22px 0"><a href="${escapeHtml(link)}" style="background:#17588C;color:#fff;padding:12px 26px;border-radius:30px;text-decoration:none;font-weight:600">View my bookings</a></p>
<p style="font-size:13px;color:#34566F">The link works once and expires in ${GUEST_LINK_MINUTES} minutes. If you didn't ask for it, ignore this email.</p></div>`);
    // Preview only: show the link on screen when email isn't set up, so the flow can be tested.
    if (!sent && isDemo(env, url)) reply.preview_link = link;
    return json(reply);
  }

  // Step 2: the link from the email is exchanged (once) for a session cookie.
  if (p === "/session" && m === "POST") {
    await rateLimit(env, "guest-session:" + clientIp(request), 30, 3600000);
    const body = await readJson(request);
    const token = String(body.token || "");
    if (token.length < 20 || token.length > 100) throw new HttpError(400, "This sign-in link is invalid.");
    const row = await env.DB.prepare("DELETE FROM guest_tokens WHERE token_hash = ?1 AND expires_at > ?2 RETURNING email")
      .bind(await sha256Hex(token), Date.now()).first();
    if (!row) throw new HttpError(400, "This sign-in link has expired or was already used. Request a new one.");
    return json({ ok: true, email: row.email }, 200, { "set-cookie": await newGuestSession(env, row.email) });
  }

  if (p === "/logout" && m === "POST") {
    const tok = getCookie(request, GUEST_COOKIE);
    if (tok) await env.DB.prepare("DELETE FROM guest_sessions WHERE token_hash = ?1").bind(await sha256Hex(tok)).run();
    return json({ ok: true }, 200, { "set-cookie": `${GUEST_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  if (p === "/bookings" && m === "GET") {
    const guest = await currentGuest(request, env);
    if (!guest) throw new HttpError(401, "Please sign in.");
    const rows = await env.DB.prepare(
      `SELECT b.ref, b.check_in, b.check_out, b.nights, b.rooms, b.amount_ghs, b.status, b.payment_status, rt.name AS room
       FROM bookings b JOIN room_types rt ON rt.id = b.room_type_id
       WHERE b.email = ?1 AND b.status != 'expired' ORDER BY b.check_in DESC LIMIT 100`
    ).bind(guest.email).all();
    const bookings = await Promise.all(rows.results.map(async (b) => ({ ...b, token: await guestToken(env, b.ref) })));
    return json({ email: guest.email, today: todayGhana(), bookings });
  }

  throw new HttpError(404, "Not found");
}

// ───────────────────────── admin ─────────────────────────

async function pbkdf2(password, saltHex, iterations) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

function getCookie(request, name) {
  const c = request.headers.get("cookie") || "";
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function currentAdmin(request, env) {
  const tok = getCookie(request, SESSION_COOKIE);
  if (!tok || tok.length > 100) return null;
  return env.DB.prepare(
    "SELECT a.id, a.email FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?1 AND s.expires_at > ?2"
  ).bind(await sha256Hex(tok), Date.now()).first();
}

function checkOrigin(request, url) {
  if (request.method === "GET") return;
  const origin = request.headers.get("origin");
  if (!origin || origin !== url.origin) throw new HttpError(403, "Bad origin");
}

function validPassword(pw) {
  if (typeof pw !== "string" || pw.length < 10 || pw.length > 200) throw new HttpError(400, "Password must be at least 10 characters.");
}

async function createAdmin(env, email, password) {
  const salt = hex(randomBytes(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  await env.DB.prepare("INSERT INTO admins (email, pass_hash, salt, iterations, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(email, hash, salt, PBKDF2_ITERATIONS, Date.now()).run();
}

async function adminRoute(request, env, ctx, url) {
  const p = url.pathname.slice("/api/admin".length);
  const m = request.method;
  checkOrigin(request, url);

  // First-time setup: creates the first admin. Needs the ADMIN_SETUP_TOKEN secret; disabled once an admin exists.
  if (p === "/setup" && m === "POST") {
    await rateLimit(env, "setup:" + clientIp(request), 5, 3600000);
    const body = await readJson(request);
    const count = (await env.DB.prepare("SELECT COUNT(*) AS c FROM admins").first()).c;
    const setupToken = env.ADMIN_SETUP_TOKEN || (await getSetting(env, "admin_setup_token", ""));
    if (count > 0 || !setupToken || !safeEqual(String(body.setup_token || ""), setupToken)) throw new HttpError(403, "Setup is not available.");
    const email = cleanText(body.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "Enter a valid email.");
    validPassword(body.password);
    await createAdmin(env, email, body.password);
    await env.DB.prepare("DELETE FROM settings WHERE key = 'admin_setup_token'").run();
    return json({ ok: true });
  }

  if (p === "/login" && m === "POST") {
    const ip = clientIp(request);
    const body = await readJson(request);
    const email = cleanText(body.email, 254).toLowerCase();
    await rateLimit(env, "login-ip:" + ip, 20, 15 * 60000);
    await rateLimit(env, "login-user:" + email, 8, 15 * 60000);
    const admin = await env.DB.prepare("SELECT * FROM admins WHERE email = ?1").bind(email).first();
    const pw = typeof body.password === "string" ? body.password.slice(0, 200) : "";
    const hash = await pbkdf2(pw, admin ? admin.salt : "00".repeat(16), admin ? admin.iterations : PBKDF2_ITERATIONS);
    if (!admin || !safeEqual(hash, admin.pass_hash)) throw new HttpError(401, "Incorrect email or password.");
    const token = b64url(randomBytes(32));
    await env.DB.prepare("INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?1, ?2, ?3)")
      .bind(await sha256Hex(token), admin.id, Date.now() + SESSION_HOURS * 3600000).run();
    return json({ ok: true, email: admin.email }, 200, { "set-cookie": sessionCookie(token, SESSION_HOURS * 3600) });
  }

  if (p === "/logout" && m === "POST") {
    const tok = getCookie(request, SESSION_COOKIE);
    if (tok) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256Hex(tok)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  const admin = await currentAdmin(request, env);
  if (!admin) throw new HttpError(401, "Please log in.");
  const actor = "admin:" + admin.email;

  if (p === "/me" && m === "GET") {
    return json({ email: admin.email, demo_payments: isDemo(env, url) });
  }

  if (p === "/password" && m === "POST") {
    const body = await readJson(request);
    const row = await env.DB.prepare("SELECT * FROM admins WHERE id = ?1").bind(admin.id).first();
    if (!safeEqual(await pbkdf2(String(body.current || "").slice(0, 200), row.salt, row.iterations), row.pass_hash)) throw new HttpError(400, "Current password is incorrect.");
    validPassword(body.new);
    const salt = hex(randomBytes(16));
    await env.DB.batch([
      env.DB.prepare("UPDATE admins SET pass_hash = ?1, salt = ?2, iterations = ?3 WHERE id = ?4").bind(await pbkdf2(body.new, salt, PBKDF2_ITERATIONS), salt, PBKDF2_ITERATIONS, admin.id),
      env.DB.prepare("DELETE FROM sessions WHERE admin_id = ?1").bind(admin.id),
    ]);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  if (p === "/admins" && m === "POST") {
    const body = await readJson(request);
    const email = cleanText(body.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "Enter a valid email.");
    validPassword(body.password);
    try { await createAdmin(env, email, body.password); } catch { throw new HttpError(409, "That email already has an account."); }
    return json({ ok: true });
  }

  if (p === "/bookings" && m === "GET") {
    const status = url.searchParams.get("status") || "";
    const q = cleanText(url.searchParams.get("q") || "", 100);
    const from = url.searchParams.get("from") || "";
    const where = [], args = [];
    if (status === "active") where.push("b.status IN ('confirmed','checked_in','payment_conflict')");
    else if (status) { where.push(`b.status = ?${args.length + 1}`); args.push(status); }
    else where.push("NOT (b.status = 'pending_payment' AND b.hold_expires_at < " + (Date.now() - 3600000) + ") AND b.status != 'expired'");
    if (q) { where.push(`(b.ref LIKE ?${args.length + 1} OR b.guest_name LIKE ?${args.length + 1} OR b.email LIKE ?${args.length + 1} OR b.phone LIKE ?${args.length + 1})`); args.push(`%${q}%`); }
    if (parseDate(from)) { where.push(`b.check_out > ?${args.length + 1}`); args.push(from); }
    const rows = await env.DB.prepare(
      `SELECT b.*, rt.name AS room_name FROM bookings b JOIN room_types rt ON rt.id = b.room_type_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY b.check_in ASC, b.id DESC LIMIT 300`
    ).bind(...args).all();
    return json({ bookings: rows.results });
  }

  let mm = p.match(/^\/bookings\/(\d+)$/);
  if (mm && m === "GET") {
    const b = await env.DB.prepare("SELECT b.*, rt.name AS room_name FROM bookings b JOIN room_types rt ON rt.id = b.room_type_id WHERE b.id = ?1").bind(Number(mm[1])).first();
    if (!b) throw new HttpError(404, "Not found");
    const ev = await env.DB.prepare("SELECT * FROM booking_events WHERE booking_id = ?1 ORDER BY at, id").bind(b.id).all();
    return json({ booking: b, events: ev.results });
  }

  mm = p.match(/^\/bookings\/(\d+)\/status$/);
  if (mm && m === "POST") {
    const body = await readJson(request);
    const id = Number(mm[1]);
    const b = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first();
    if (!b) throw new HttpError(404, "Not found");
    const note = cleanText(body.note, 300);
    const notify = body.notify !== false;
    // Cancel and refund automatically through PayPal/Paystack.
    if (body.action === "cancel_refund") {
      if (b.payment_status !== "paid") throw new HttpError(400, "This booking has no payment to refund.");
      const claim = await env.DB.prepare("UPDATE bookings SET status = CASE WHEN status = 'completed' THEN status ELSE 'cancelled' END, updated_at = ?2 WHERE id = ?1 AND payment_status = 'paid'").bind(id, Date.now()).run();
      if (!claim.meta.changes) throw new HttpError(409, "Booking already updated — refresh.");
      let r;
      try { r = await refundPayment(env, b); } catch (e) { r = { ok: false, detail: e.message }; }
      if (!r.ok) {
        await logEvent(env, id, actor, `Booking cancelled. Automatic refund failed: ${r.detail}`, false);
        throw new HttpError(502, `Booking cancelled, but the automatic refund failed (${r.detail}). Refund in the ${providerLabel(b.provider)} dashboard, then press "Mark refunded".`);
      }
      await env.DB.prepare("UPDATE bookings SET payment_status = 'refunded', updated_at = ?2 WHERE id = ?1").bind(id, Date.now()).run();
      const msg = "Your booking has been cancelled and a full refund has been issued." + (note ? " " + note : "");
      await logEvent(env, id, actor, msg);
      if (notify) ctx.waitUntil(sendStatusEmail(env, b, msg));
      return json({ ok: true });
    }
    if (body.payment_status === "refunded") {
      if (b.payment_status !== "paid") throw new HttpError(400, "Only paid bookings can be marked refunded.");
      await env.DB.prepare("UPDATE bookings SET payment_status = 'refunded', status = CASE WHEN status IN ('completed') THEN status ELSE 'cancelled' END, updated_at = ?2 WHERE id = ?1").bind(id, Date.now()).run();
      const msg = "Your payment has been refunded." + (note ? " " + note : "");
      await logEvent(env, id, actor, msg);
      if (notify) ctx.waitUntil(sendStatusEmail(env, b, msg));
      return json({ ok: true });
    }
    const status = body.status;
    if (!ADMIN_STATUSES.includes(status)) throw new HttpError(400, "Invalid status");
    if (status === "confirmed" && !["confirmed", "checked_in"].includes(b.status)) {
      // Re-confirming takes rooms back, so availability must be re-checked.
      const res = await env.DB.prepare(
        `UPDATE bookings SET status = 'confirmed', updated_at = ?4 WHERE id = ?5
         AND (SELECT total_rooms FROM room_types WHERE id = ?1) - ${MAX_USED_SQL} >= ?6`
      ).bind(b.room_type_id, b.check_in, b.check_out, Date.now(), id, b.rooms).run();
      if (!res.meta.changes) throw new HttpError(409, "Not enough rooms free on those dates to confirm this booking.");
    } else {
      await env.DB.prepare("UPDATE bookings SET status = ?1, updated_at = ?2 WHERE id = ?3").bind(status, Date.now(), id).run();
    }
    const labels = { confirmed: "Your booking is confirmed.", checked_in: "You've been checked in. Enjoy your stay!", completed: "You've checked out. Thank you for staying with us!", cancelled: "Your booking has been cancelled." };
    const msg = labels[status] + (note ? " " + note : "");
    await logEvent(env, id, actor, msg);
    if (notify && status !== "checked_in" && status !== "completed") ctx.waitUntil(sendStatusEmail(env, b, msg));
    return json({ ok: true });
  }

  mm = p.match(/^\/bookings\/(\d+)\/note$/);
  if (mm && m === "POST") {
    const body = await readJson(request);
    const note = cleanText(body.note, 500);
    if (!note) throw new HttpError(400, "Note is empty");
    await logEvent(env, Number(mm[1]), actor, note, !!body.public);
    return json({ ok: true });
  }

  // Phone / walk-in bookings so they also reduce online availability.
  if (p === "/bookings" && m === "POST") {
    const body = await readJson(request);
    const roomType = cleanText(body.room_type, 40);
    const checkIn = cleanText(body.check_in, 10), checkOut = cleanText(body.check_out, 10);
    const a = parseDate(checkIn), bdate = parseDate(checkOut);
    if (!a || !bdate || bdate <= a) throw new HttpError(400, "Choose valid dates.");
    const nights = Math.round((bdate - a) / 86400000);
    if (nights > 90) throw new HttpError(400, "Maximum 90 nights.");
    const rooms = Number(body.rooms);
    if (!Number.isInteger(rooms) || rooms < 1 || rooms > 50) throw new HttpError(400, "Invalid number of rooms.");
    const name = cleanText(body.name, 100);
    if (name.length < 2) throw new HttpError(400, "Enter the guest's name.");
    const email = cleanText(body.email, 254).toLowerCase();
    const phone = cleanText(body.phone, 30);
    const paid = body.paid === true;
    const now = Date.now();
    const ref = newRef();
    const res = await env.DB.prepare(
      `INSERT INTO bookings (ref, room_type_id, check_in, check_out, nights, rooms, guest_name, email, phone, notes,
                             price_ghs, amount_ghs, provider, status, payment_status, hold_expires_at, ip, created_at, updated_at)
       SELECT ?6, rt.id, ?2, ?3, ?7, ?8, ?9, ?10, ?11, ?12, rt.price_ghs, rt.price_ghs * ?7 * ?8, 'manual', 'confirmed', ?13, 0, NULL, ?4, ?4
       FROM room_types rt WHERE rt.id = ?1 AND rt.total_rooms - ${MAX_USED_SQL} >= ?8`
    ).bind(roomType, checkIn, checkOut, now, 0, ref, nights, rooms, name, email, phone || "", cleanText(body.notes, 500) || null, paid ? "paid" : "unpaid").run();
    if (!res.meta.changes) throw new HttpError(409, "Not enough rooms of that type free on those dates.");
    const b = await env.DB.prepare("SELECT * FROM bookings WHERE ref = ?1").bind(ref).first();
    await logEvent(env, b.id, actor, "Booking added by hotel staff.");
    return json({ ok: true, ref });
  }

  if (p === "/rooms" && m === "GET") {
    const checkIn = parseDate(url.searchParams.get("check_in")) ? url.searchParams.get("check_in") : todayGhana();
    const checkOut = parseDate(url.searchParams.get("check_out")) && url.searchParams.get("check_out") > checkIn ? url.searchParams.get("check_out") : addDays(checkIn, 1);
    return json({ check_in: checkIn, check_out: checkOut, rooms: await availabilityFor(env, checkIn, checkOut, true), ghs_per_usd: Number(await getSetting(env, "ghs_per_usd", "15.5")) });
  }

  mm = p.match(/^\/rooms\/([a-z0-9-]{1,40})$/);
  if (mm && m === "PUT") {
    const body = await readJson(request);
    const price = Number(body.price_ghs), total = Number(body.total_rooms);
    if (!Number.isInteger(price) || price < 1 || price > 100000) throw new HttpError(400, "Invalid price");
    if (!Number.isInteger(total) || total < 0 || total > 500) throw new HttpError(400, "Invalid room count");
    const res = await env.DB.prepare("UPDATE room_types SET price_ghs = ?1, total_rooms = ?2, active = ?3 WHERE id = ?4")
      .bind(price, total, body.active === false ? 0 : 1, mm[1]).run();
    if (!res.meta.changes) throw new HttpError(404, "Room type not found");
    return json({ ok: true });
  }

  if (p === "/settings" && m === "PUT") {
    const body = await readJson(request);
    const rate = Number(body.ghs_per_usd);
    if (!(rate >= 1 && rate <= 1000)) throw new HttpError(400, "Invalid exchange rate");
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ghs_per_usd', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(rate.toFixed(2)).run();
    return json({ ok: true });
  }

  throw new HttpError(404, "Not found");
}
