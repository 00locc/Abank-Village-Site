(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const LABEL = { pending_payment: "Awaiting payment", confirmed: "Confirmed", checked_in: "Checked in", completed: "Completed", cancelled: "Cancelled", expired: "Expired", payment_conflict: "Needs attention", paid: "Paid", unpaid: "Unpaid", refunded: "Refunded" };
  const PROVIDER = { paystack: "Paystack (MoMo/Card)", paypal: "PayPal", manual: "Hotel desk", demo: "Demo" };
  const today = new Date().toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const fmtDate = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const fmtTime = (ms) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const cedi = (n) => "GH₵ " + Number(n).toLocaleString("en-GH");
  let roomTypes = [];

  async function api(path, opts = {}) {
    const init = { credentials: "same-origin", ...opts };
    if (opts.body !== undefined) { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(opts.body); }
    const r = await fetch("/api/admin" + path, init);
    let d = {};
    try { d = await r.json(); } catch (_) {}
    if (r.status === 401 && path !== "/login") { showLogin(); throw new Error("Please log in."); }
    if (!r.ok) throw new Error(d.error || "Something went wrong.");
    return d;
  }

  function msg(id, text) { const e = $(id); if (!e) return; e.textContent = text || ""; e.hidden = !text; }
  function pill(s) { const sp = document.createElement("span"); sp.className = "pill p-" + s; sp.textContent = LABEL[s] || s; return sp; }
  function td(text) { const c = document.createElement("td"); if (text instanceof Node) c.appendChild(text); else c.textContent = text; return c; }

  function showLogin() { $("appView").hidden = true; $("loginView").hidden = false; $("loginForm").hidden = false; $("setupForm").hidden = true; }

  async function start() {
    try {
      const me = await api("/me");
      $("whoEmail").textContent = me.email;
      $("demoNote").hidden = !me.demo_payments;
      $("loginView").hidden = true; $("appView").hidden = false;
      await loadRoomTypes();
      loadBookings();
    } catch (_) { showLogin(); }
  }

  // ── auth ──
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("loginErr");
    try {
      await api("/login", { method: "POST", body: { email: $("loginEmail").value, password: $("loginPass").value } });
      $("loginPass").value = "";
      start();
    } catch (err) { msg("loginErr", err.message); }
  });
  $("showSetup").onclick = () => { $("loginForm").hidden = true; $("setupForm").hidden = false; };
  $("showLogin").onclick = () => { $("loginForm").hidden = false; $("setupForm").hidden = true; };
  $("setupForm").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("setupErr");
    try {
      await api("/setup", { method: "POST", body: { setup_token: $("setupToken").value, email: $("setupEmail").value, password: $("setupPass").value } });
      await api("/login", { method: "POST", body: { email: $("setupEmail").value, password: $("setupPass").value } });
      start();
    } catch (err) { msg("setupErr", err.message); }
  });
  $("logoutBtn").onclick = async () => { try { await api("/logout", { method: "POST", body: {} }); } catch (_) {} showLogin(); };

  // ── tabs ──
  document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
    if (b.dataset.tab === "rooms") loadRooms();
    if (b.dataset.tab === "bookings") loadBookings();
  }));

  // ── bookings ──
  let searchTimer;
  $("fStatus").onchange = loadBookings;
  $("fFrom").onchange = loadBookings;
  $("fQ").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadBookings, 300); };
  $("refreshBtn").onclick = loadBookings;

  async function loadBookings() {
    const qs = new URLSearchParams({ status: $("fStatus").value, q: $("fQ").value.trim(), from: $("fFrom").value || (["", "active"].includes($("fStatus").value) ? today : "") });
    const tbody = $("bookingRows");
    try {
      const { bookings } = await api("/bookings?" + qs);
      tbody.innerHTML = "";
      if (!bookings.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty">No bookings found.</td></tr>'; }
      bookings.forEach((b) => {
        const tr = document.createElement("tr");
        tr.append(td(b.ref), td(b.guest_name), td(b.phone), td(b.room_name + (b.rooms > 1 ? " × " + b.rooms : "")),
          td(fmtDate(b.check_in)), td(fmtDate(b.check_out)), td(cedi(b.amount_ghs)), td(pill(b.payment_status)), td(pill(b.status)));
        ["Ref", "Guest", "Phone", "Room", "Check-in", "Check-out", "Total", "Payment", "Status"].forEach((l, i) => { if (tr.children[i]) tr.children[i].dataset.label = l; });
        tr.onclick = () => openBooking(b.id);
        tbody.appendChild(tr);
      });
      renderStats(bookings);
    } catch (err) { tbody.innerHTML = ""; const r = document.createElement("tr"); r.append(td(err.message)); tbody.appendChild(r); }
  }

  function renderStats(list) {
    const arrivals = list.filter((b) => b.check_in === today && ["confirmed", "checked_in"].includes(b.status)).length;
    const departures = list.filter((b) => b.check_out === today && b.status === "checked_in").length;
    const inHouse = list.filter((b) => b.status === "checked_in").reduce((s, b) => s + b.rooms, 0);
    const attention = list.filter((b) => b.status === "payment_conflict").length;
    $("stats").innerHTML = "";
    [["Arriving today", arrivals], ["Departing today", departures], ["Rooms occupied", inHouse], ["Needs attention", attention]].forEach(([k, v]) => {
      const d = document.createElement("div"); d.className = "stat";
      const bb = document.createElement("b"); bb.textContent = v;
      const sp = document.createElement("span"); sp.textContent = k;
      d.append(bb, sp); $("stats").appendChild(d);
    });
  }

  function closeDrawer() { $("drawer").hidden = true; $("drawerBg").hidden = true; }
  $("drawerClose").onclick = closeDrawer;
  $("drawerBg").onclick = closeDrawer;

  async function openBooking(id) {
    const { booking: b, events } = await api("/bookings/" + id);
    const body = $("drawerBody");
    body.innerHTML = "";
    const h = document.createElement("h1"); h.textContent = b.ref; body.appendChild(h);
    const pills = document.createElement("div"); pills.style.cssText = "display:flex;gap:6px;margin-top:8px";
    pills.append(pill(b.status), pill(b.payment_status)); body.appendChild(pills);
    const dl = document.createElement("dl");
    [["Guest", b.guest_name], ["Phone", b.phone || "—"], ["Email", b.email || "—"], ["Room", b.room_name + (b.rooms > 1 ? " × " + b.rooms : "")],
     ["Check-in", fmtDate(b.check_in)], ["Check-out", fmtDate(b.check_out)], ["Nights", b.nights], ["Total", cedi(b.amount_ghs)],
     ["Paid via", PROVIDER[b.provider] || b.provider], ["Charged", b.pay_amount_minor && b.payment_status !== "unpaid" ? (b.pay_currency + " " + (b.pay_amount_minor / 100).toFixed(2)) : "—"],
     ["Payment ref", b.provider_ref || "—"], ["Notes", b.notes || "—"], ["Created", fmtTime(b.created_at)]]
      .forEach(([k, v]) => { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; dl.append(dt, dd); });
    body.appendChild(dl);

    const err = document.createElement("div"); err.className = "err"; err.hidden = true; body.appendChild(err);
    const note = document.createElement("input"); note.placeholder = "Optional message to the guest";
    const notifyLab = document.createElement("label"); notifyLab.className = "chk";
    const notify = document.createElement("input"); notify.type = "checkbox"; notify.checked = !!b.email;
    notifyLab.append(notify, document.createTextNode(" Email the guest about this change"));
    const actions = document.createElement("div"); actions.className = "actions";
    const act = (label, payload, cls, confirmText) => {
      const btn = document.createElement("button"); btn.textContent = label; if (cls) btn.className = cls;
      btn.onclick = async () => {
        if (confirmText && !window.confirm(confirmText)) return;
        btn.disabled = true; err.hidden = true;
        try {
          await api(`/bookings/${b.id}/status`, { method: "POST", body: { ...payload, note: note.value, notify: notify.checked } });
          closeDrawer(); loadBookings();
        } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; }
      };
      actions.appendChild(btn);
    };
    if (!["confirmed", "checked_in", "completed"].includes(b.status)) act("Confirm", { status: "confirmed" });
    if (["confirmed"].includes(b.status)) act("Check in", { status: "checked_in" });
    if (["checked_in"].includes(b.status)) act("Check out", { status: "completed" });
    if (!["cancelled", "completed", "expired"].includes(b.status)) act(b.payment_status === "paid" ? "Cancel (no refund)" : "Cancel booking", { status: "cancelled" }, b.payment_status === "paid" ? "ghost" : "danger", b.payment_status === "paid" ? "Cancel WITHOUT refunding the guest? The room will become available again." : "Cancel this booking? The room will become available again.");
    if (b.payment_status === "paid" && !["completed"].includes(b.status)) act("Cancel & refund", { action: "cancel_refund" }, "danger", "Cancel this booking and refund the guest in full automatically?");
    if (b.payment_status === "paid") act("Mark refunded", { payment_status: "refunded" }, "ghost", "Only use this if you already refunded the guest yourself in Paystack or PayPal. Continue?");
    if (actions.children.length) { body.append(note, notifyLab, actions); }
    if (b.status === "payment_conflict") {
      const w = document.createElement("div"); w.className = "err";
      w.textContent = "This guest paid after their hold ran out and the rooms were taken. Call them to move dates/room (then Confirm) or refund them.";
      body.insertBefore(w, dl);
    }

    const evH = document.createElement("h2"); evH.textContent = "History"; evH.style.marginTop = "18px"; body.appendChild(evH);
    const ul = document.createElement("ul"); ul.className = "events";
    events.slice().reverse().forEach((e) => {
      const li = document.createElement("li"); const sm = document.createElement("small");
      sm.textContent = `${fmtTime(e.at)} · ${e.actor}${e.public ? "" : " · internal"}`;
      li.append(sm, document.createTextNode(e.message)); ul.appendChild(li);
    });
    body.appendChild(ul);
    const addNote = document.createElement("form"); addNote.style.marginTop = "12px";
    const ni = document.createElement("input"); ni.placeholder = "Add an internal note"; ni.maxLength = 500;
    const nb = document.createElement("button"); nb.textContent = "Add note"; nb.style.marginTop = "8px";
    addNote.append(ni, nb);
    addNote.onsubmit = async (e) => { e.preventDefault(); if (!ni.value.trim()) return; await api(`/bookings/${b.id}/note`, { method: "POST", body: { note: ni.value, public: false } }); openBooking(b.id); };
    body.appendChild(addNote);

    $("drawer").hidden = false; $("drawerBg").hidden = false;
  }

  // ── add booking ──
  async function loadRoomTypes() {
    const d = await api(`/rooms?check_in=${today}`);
    roomTypes = d.rooms;
    $("aRoom").innerHTML = "";
    roomTypes.forEach((r) => { const o = document.createElement("option"); o.value = r.id; o.textContent = `${r.name} — ${cedi(r.price_ghs)}`; $("aRoom").appendChild(o); });
    $("aIn").value = today; $("aOut").value = addDays(today, 1);
  }
  $("addForm").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("addErr"); msg("addOk");
    try {
      const d = await api("/bookings", { method: "POST", body: { room_type: $("aRoom").value, rooms: Number($("aRooms").value), check_in: $("aIn").value, check_out: $("aOut").value,
        name: $("aName").value, phone: $("aPhone").value, email: $("aEmail").value, notes: $("aNotes").value, paid: $("aPaid").checked } });
      msg("addOk", `Booking ${d.ref} added.`);
      ["aName", "aPhone", "aEmail", "aNotes"].forEach((id) => ($(id).value = "")); $("aPaid").checked = false;
    } catch (err) { msg("addErr", err.message); }
  });

  // ── rooms ──
  $("rDate").value = today;
  $("rDate").onchange = loadRooms;
  async function loadRooms() {
    msg("roomsErr"); msg("roomsOk");
    const ci = $("rDate").value || today;
    const d = await api(`/rooms?check_in=${ci}&check_out=${addDays(ci, 1)}`);
    $("rate").value = d.ghs_per_usd;
    const tbody = $("roomRows"); tbody.innerHTML = "";
    d.rooms.forEach((r) => {
      const tr = document.createElement("tr");
      const price = document.createElement("input"); price.type = "number"; price.min = 1; price.value = r.price_ghs;
      const total = document.createElement("input"); total.type = "number"; total.min = 0; total.value = r.total_rooms;
      const active = document.createElement("input"); active.type = "checkbox"; active.checked = r.active;
      const save = document.createElement("button"); save.textContent = "Save";
      save.onclick = async () => {
        msg("roomsErr"); msg("roomsOk");
        try {
          await api(`/rooms/${r.id}`, { method: "PUT", body: { price_ghs: Number(price.value), total_rooms: Number(total.value), active: active.checked } });
          msg("roomsOk", `${r.name} saved.`); loadRooms(); loadRoomTypes();
        } catch (err) { msg("roomsErr", err.message); }
      };
      tr.append(td(r.name), td(price), td(total), td(`${r.available} of ${r.total_rooms}`), td(active), td(save));
      tr.style.cursor = "default";
      tbody.appendChild(tr);
    });
  }
  $("rateForm").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("roomsErr"); msg("roomsOk");
    try { await api("/settings", { method: "PUT", body: { ghs_per_usd: Number($("rate").value) } }); msg("roomsOk", "Exchange rate saved."); }
    catch (err) { msg("roomsErr", err.message); }
  });

  // ── account ──
  $("pwForm").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("pwErr");
    try { await api("/password", { method: "POST", body: { current: $("pwCur").value, new: $("pwNew").value } }); alert("Password changed. Please log in again."); showLogin(); }
    catch (err) { msg("pwErr", err.message); }
  });
  $("staffForm").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("staffErr"); msg("staffOk");
    try { await api("/admins", { method: "POST", body: { email: $("sEmail").value, password: $("sPass").value } }); msg("staffOk", "Staff login created."); $("sEmail").value = ""; $("sPass").value = ""; }
    catch (err) { msg("staffErr", err.message); }
  });

  start();
})();
