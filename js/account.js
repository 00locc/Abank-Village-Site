(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const next = params.get("next") === "book" ? "book.html" + (params.get("room") ? "?room=" + encodeURIComponent(params.get("room")) : "") : "my-bookings.html";
  let email = "", siteKey = null;
  const widgets = {}, tokens = {};

  async function api(path, body) {
    const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let d = {}; try { d = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(d.error || "Something went wrong.");
    return d;
  }
  const form = (id) => $(id);
  const err = (id, msg) => { const e = form(id).querySelector(".err"); e.textContent = msg || ""; e.hidden = !msg; };
  const note = (id, msg) => { const e = form(id).querySelector(".note"); if (!e) return; e.textContent = msg || ""; e.hidden = !msg; };
  const val = (id, name) => form(id).elements[name].value.trim();

  const TITLES = { signin: ["Welcome back", "Sign in to book and manage your stays."], signup: ["Create your account", "One account for all your bookings at Abank Village."],
    verify: ["Check your email", ""], forgot: ["Reset password", ""], reset: ["Set a new password", ""] };

  function show(v) {
    document.querySelectorAll("[data-view]").forEach((f) => (f.hidden = f.id !== v));
    $("tabs").hidden = !["signin", "signup"].includes(v);
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    $("title").textContent = TITLES[v][0];
    $("sub").textContent = TITLES[v][1]; $("sub").hidden = !TITLES[v][1];
    renderTs(v);
    const first = form(v).querySelector("input"); if (first) setTimeout(() => first.focus(), 50);
  }

  function renderTs(v) {
    const box = form(v).querySelector(".ts");
    if (!box || !siteKey || widgets[v] !== undefined) return;
    if (!window.turnstile) { setTimeout(() => renderTs(v), 300); return; }
    widgets[v] = window.turnstile.render(box, { sitekey: siteKey, callback: (t) => (tokens[v] = t), "expired-callback": () => (tokens[v] = "") });
  }
  function resetTs(v) { if (window.turnstile && widgets[v] !== undefined) { window.turnstile.reset(widgets[v]); tokens[v] = ""; } }

  function previewCode(id, d) { if (d.preview_code) note(id, `Preview mode (email not set up): your code is ${d.preview_code}`); }

  function goVerify(d) {
    $("verifyText").textContent = `We sent a 6-digit code to ${email}. Enter it below to confirm your email.`;
    show("verify"); note("verify", ""); previewCode("verify", d);
  }

  async function submit(id, fn) {
    const btn = form(id).querySelector("button[type=submit]");
    err(id, ""); btn.disabled = true;
    try { await fn(); } catch (e) { err(id, e.message); } finally { btn.disabled = false; }
  }

  form("signin").addEventListener("submit", (e) => { e.preventDefault(); submit("signin", async () => {
    email = val("signin", "email").toLowerCase();
    const d = await api("/api/guest/signin", { email, password: form("signin").elements.password.value });
    if (d.needs_verification) return goVerify(d);
    location.replace(next);
  }); });

  form("signup").addEventListener("submit", (e) => { e.preventDefault(); submit("signup", async () => {
    if (siteKey && !tokens.signup) throw new Error("Please complete the security check.");
    email = val("signup", "email").toLowerCase();
    try {
      const d = await api("/api/guest/signup", { name: val("signup", "name"), email, phone: val("signup", "phone"),
        password: form("signup").elements.password.value, turnstile_token: tokens.signup });
      goVerify(d);
    } finally { resetTs("signup"); }
  }); });

  form("verify").addEventListener("submit", (e) => { e.preventDefault(); submit("verify", async () => {
    await api("/api/guest/verify", { email, code: val("verify", "code") });
    location.replace(next);
  }); });

  $("resend").addEventListener("click", async () => {
    err("verify", ""); note("verify", "");
    try { const d = await api("/api/guest/resend-code", { email }); note("verify", "A new code is on its way."); previewCode("verify", d); }
    catch (e) { err("verify", e.message); }
  });

  form("forgot").addEventListener("submit", (e) => { e.preventDefault(); submit("forgot", async () => {
    if (siteKey && !tokens.forgot) throw new Error("Please complete the security check.");
    email = val("forgot", "email").toLowerCase();
    try {
      const d = await api("/api/guest/forgot", { email, turnstile_token: tokens.forgot });
      show("reset"); note("reset", d.message); if (d.preview_code) note("reset", `${d.message} Preview mode: your code is ${d.preview_code}`);
    } finally { resetTs("forgot"); }
  }); });

  form("reset").addEventListener("submit", (e) => { e.preventDefault(); submit("reset", async () => {
    await api("/api/guest/reset", { email, code: val("reset", "code"), password: form("reset").elements.password.value });
    location.replace(next);
  }); });

  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.v)));
  document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => show(b.dataset.go)));

  (async function init() {
    // Already signed in? Skip straight to where they were going.
    try { const r = await fetch("/api/guest/me", { credentials: "same-origin" }); if (r.ok) { location.replace(next); return; } } catch (_) {}
    try { const c = await (await fetch("/api/config")).json(); siteKey = c.turnstile_site_key; } catch (_) {}
    show(params.get("mode") === "signup" ? "signup" : "signin");
  })();
})();
