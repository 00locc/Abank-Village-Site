(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const LABEL = { pending_payment: "Awaiting payment", confirmed: "Confirmed", checked_in: "Checked in", completed: "Completed", cancelled: "Cancelled", payment_conflict: "Needs attention" };
  const fmt = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  let tsWidget = null, tsToken = "", siteKey = null;

  async function api(path, opts = {}) {
    const init = { credentials: "same-origin", ...opts };
    if (opts.body !== undefined) { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(opts.body); }
    const r = await fetch(path, init);
    let d = {}; try { d = await r.json(); } catch (_) {}
    if (!r.ok) { const e = new Error(d.error || "Something went wrong."); e.status = r.status; throw e; }
    return d;
  }
  function show(id, text) { const e = $(id); e.textContent = text || ""; e.hidden = !text; }

  function card(b) {
    const a = document.createElement("a");
    a.className = "bk-item";
    a.href = `booking-status.html?ref=${encodeURIComponent(b.ref)}&t=${encodeURIComponent(b.token)}`;
    const left = document.createElement("div");
    const room = document.createElement("div"); room.className = "room"; room.textContent = b.room + (b.rooms > 1 ? ` × ${b.rooms}` : "");
    const dates = document.createElement("div"); dates.className = "dates"; dates.textContent = `${fmt(b.check_in)} → ${fmt(b.check_out)} · ${b.nights} night${b.nights > 1 ? "s" : ""}`;
    const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = b.ref;
    left.append(room, dates, meta);
    const right = document.createElement("div"); right.className = "right";
    const st = document.createElement("span"); st.className = "status s-" + b.status; st.textContent = LABEL[b.status] || b.status;
    const pay = { paid: ["Payment received", "s-confirmed"], unpaid: ["Not paid", "s-pending_payment"], refunded: ["Refunded", "s-cancelled"] }[b.payment_status] || [b.payment_status, ""];
    const ps = document.createElement("span"); ps.className = "status " + pay[1]; ps.textContent = pay[0];
    const amt = document.createElement("span"); amt.className = "amt"; amt.textContent = "GH₵ " + Number(b.amount_ghs).toLocaleString("en-GH");
    right.append(st, ps, amt);
    a.append(left, right);
    return a;
  }

  async function loadList() {
    try {
      const d = await api("/api/guest/bookings");
      $("loginForm").hidden = true; $("signingIn").hidden = true; $("listView").hidden = false;
      $("sub").textContent = "All your stays with Abank Village. Tap a booking for full details and updates.";
      $("who").textContent = "Signed in as " + d.email;
      const up = d.bookings.filter((b) => b.check_out >= d.today && ["confirmed", "checked_in", "pending_payment", "payment_conflict"].includes(b.status)).reverse();
      const past = d.bookings.filter((b) => !up.includes(b));
      $("upcoming").innerHTML = ""; $("past").innerHTML = "";
      up.forEach((b) => $("upcoming").appendChild(card(b)));
      past.forEach((b) => $("past").appendChild(card(b)));
      if (!up.length) $("upcoming").innerHTML = '<p class="empty">No upcoming stays. <a href="book.html">Book a room</a>.</p>';
      $("pastH").hidden = !past.length;
      return true;
    } catch (e) {
      if (e.status !== 401) show("listErr", e.message);
      return false;
    }
  }

  function renderTurnstile() {
    if (!siteKey || tsWidget !== null) return;
    if (!window.turnstile) { setTimeout(renderTurnstile, 300); return; }
    tsWidget = window.turnstile.render($("ts"), { sitekey: siteKey, callback: (t) => (tsToken = t), "expired-callback": () => (tsToken = "") });
  }

  $("loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault(); show("loginErr"); show("loginOk");
    if (siteKey && !tsToken) return show("loginErr", "Please complete the security check.");
    $("loginBtn").disabled = true;
    try {
      const d = await api("/api/guest/login", { method: "POST", body: { email: $("email").value.trim(), turnstile_token: tsToken } });
      show("loginOk", d.message);
      if (d.preview_link) {
        const a = document.createElement("a"); a.href = d.preview_link; a.textContent = " Preview mode: open the sign-in link.";
        $("loginOk").appendChild(a);
      }
    } catch (e) { show("loginErr", e.message); }
    finally {
      $("loginBtn").disabled = false;
      if (window.turnstile && tsWidget !== null) { window.turnstile.reset(tsWidget); tsToken = ""; }
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    try { await api("/api/guest/logout", { method: "POST", body: {} }); } catch (_) {}
    location.replace("my-bookings.html");
  });

  (async function init() {
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    if (token) {
      history.replaceState(null, "", "my-bookings.html"); // drop the one-time token from the address bar
      $("loginForm").hidden = true; $("signingIn").hidden = false;
      try { await api("/api/guest/session", { method: "POST", body: { token } }); }
      catch (e) { $("signingIn").hidden = true; $("loginForm").hidden = false; show("loginErr", e.message); }
    }
    if (await loadList()) return;
    $("signingIn").hidden = true; $("loginForm").hidden = false;
    try { const cfg = await api("/api/config"); siteKey = cfg.turnstile_site_key; renderTurnstile(); } catch (_) {}
  })();
})();
