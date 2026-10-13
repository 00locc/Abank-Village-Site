(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const LABEL = { pending_payment: "Awaiting payment", confirmed: "Confirmed", checked_in: "Checked in", completed: "Completed", cancelled: "Cancelled", payment_conflict: "Needs attention" };
  const fmt = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

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
    const meta = document.createElement("div"); meta.className = "meta";
    meta.textContent = b.ref + (["confirmed", "pending_payment"].includes(b.status) ? " · Tap to view, pay or cancel" : " · Tap for details");
    left.append(room, dates, meta);
    const right = document.createElement("div"); right.className = "right";
    const st = document.createElement("span"); st.className = "status s-" + b.status; st.textContent = LABEL[b.status] || b.status;
    let pay = { paid: ["Payment received", "s-confirmed"], unpaid: ["Not paid", "s-pending_payment"], refunded: ["Refunded", "s-completed"] }[b.payment_status] || [b.payment_status, ""];
    if (b.payment_status === "paid" && ["cancelled", "payment_conflict"].includes(b.status)) pay = ["Refund pending", "s-pending_payment"];
    const ps = document.createElement("span"); ps.className = "status " + pay[1]; ps.textContent = pay[0];
    const amt = document.createElement("span"); amt.className = "amt"; amt.textContent = "GH₵ " + Number(b.amount_ghs).toLocaleString("en-GH");
    right.append(st, ps, amt);
    a.append(left, right);
    return a;
  }

  async function loadList() {
    try {
      const d = await api("/api/guest/bookings");
      $("signingIn").hidden = true; $("listView").hidden = false;
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
      if (e.status === 401) return false;
      $("signingIn").hidden = true; $("listView").hidden = false; show("listErr", e.message);
      return true;
    }
  }

  $("logoutBtn").addEventListener("click", async () => {
    try { await api("/api/guest/logout", { method: "POST", body: {} }); } catch (_) {}
    location.replace("/");
  });

  (async function init() {
    if (!(await loadList())) { location.replace("account.html?next=my-bookings"); return; }
    try { const me = await api("/api/guest/me"); if (me.is_staff) $("staffLink").hidden = false; } catch (_) {}
  })();
})();
