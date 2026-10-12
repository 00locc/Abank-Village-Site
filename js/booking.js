// Abank Village — online booking widget
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const form = $("bookingForm");
  if (!form) return;

  const el = {
    inp: $("bkIn"), out: $("bkOut"), rooms: $("bkRooms"), nights: $("bkNights"), list: $("bkRoomList"),
    name: $("bkName"), phone: $("bkPhone"), email: $("bkEmail"), notes: $("bkNotes"),
    summary: $("bkSummary"), sumLine: $("bkSumLine"), total: $("bkTotal"), error: $("bkError"),
    submit: $("bkSubmit"), demo: $("bkDemo"), ts: $("bkTurnstile"), usd: $("bkUsdNote"),
    payPaystack: $("bkPayPaystack"), payPaypal: $("bkPayPaypal"),
  };

  let cfg = null, avail = [], selected = new URLSearchParams(location.search).get("room"), tsWidget = null, tsToken = "", loadSeq = 0, busy = false;

  const fmt = (n) => Number(n).toLocaleString("en-GH");
  const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const nightsBetween = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
  const niceDate = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

  function showError(msg) {
    el.error.textContent = msg || "";
    el.error.hidden = !msg;
  }

  async function api(path, opts) {
    const r = await fetch(path, opts);
    let data = {};
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  }

  function leftText(a) {
    if (!a.available) return { text: "Fully booked", cls: "none" };
    if (a.available <= 3 && a.total_rooms > 3) return { text: `Only ${a.available} left`, cls: "low" };
    return { text: `${a.available} room${a.available === 1 ? "" : "s"} available`, cls: "" };
  }

  function renderRoomCards() {
    document.querySelectorAll(".room-avail").forEach((span) => {
      const a = avail.find((x) => x.id === span.dataset.room);
      const btn = document.querySelector(`.room-book-btn[data-room="${span.dataset.room}"]`);
      if (!a) { span.textContent = ""; return; }
      const t = leftText(a);
      span.textContent = `${t.text} · ${niceDate(el.inp.value)}`;
      span.className = "room-avail " + t.cls;
      if (btn) btn.classList.toggle("disabled", !a.available);
    });
  }

  function renderList() {
    const need = Number(el.rooms.value);
    el.list.innerHTML = "";
    if (!avail.length) { el.list.innerHTML = '<p class="bk-hint">No rooms are available for online booking right now. Please call us.</p>'; return; }
    avail.forEach((a) => {
      const t = leftText(a);
      const enough = a.available >= need;
      const lab = document.createElement("label");
      lab.className = "bk-room" + (enough ? "" : " full") + (selected === a.id ? " selected" : "");
      lab.innerHTML = `<input type="radio" name="bkRoom" value="${a.id}" ${enough ? "" : "disabled"} ${selected === a.id && enough ? "checked" : ""}>
        <span><span class="bk-room-name"></span><br><span class="bk-room-left ${t.cls}"></span></span>
        <span class="bk-room-price">GH₵ ${fmt(a.price_ghs)} <small>/ night</small></span>`;
      lab.querySelector(".bk-room-name").textContent = a.name;
      lab.querySelector(".bk-room-left").textContent = enough || !a.available ? t.text : `Only ${a.available} left — fewer than ${need} rooms`;
      lab.querySelector("input").addEventListener("change", () => { selected = a.id; renderList(); update(); });
      el.list.appendChild(lab);
    });
    if (selected) {
      const a = avail.find((x) => x.id === selected);
      if (!a || a.available < need) selected = null;
    }
  }

  function update() {
    const n = nightsBetween(el.inp.value, el.out.value);
    const rooms = Number(el.rooms.value);
    const a = avail.find((x) => x.id === selected);
    el.nights.textContent = n > 0
      ? `${n} night${n > 1 ? "s" : ""} · ${niceDate(el.inp.value)} → ${niceDate(el.out.value)} · Check-in from 12:00 PM, check-out by 11:00 AM`
      : "Check-in from 12:00 PM · Check-out by 11:00 AM";
    if (a && n > 0) {
      const total = a.price_ghs * n * rooms;
      el.summary.hidden = false;
      el.sumLine.textContent = `${a.name}${rooms > 1 ? ` × ${rooms}` : ""} · GH₵ ${fmt(a.price_ghs)} × ${n} night${n > 1 ? "s" : ""}`;
      el.total.textContent = fmt(total);
      if (cfg && cfg.ghs_per_usd) el.usd.textContent = `Charged in US dollars (about US$${(Math.ceil(total / cfg.ghs_per_usd * 100) / 100).toFixed(2)})`;
      el.submit.disabled = busy;
      el.submit.textContent = busy ? "Please wait…" : `Pay GH₵ ${fmt(total)} & Book`;
    } else {
      el.summary.hidden = true;
      el.submit.disabled = true;
      el.submit.textContent = n > 0 ? "Choose a room" : "Choose your dates";
    }
  }

  async function loadAvailability() {
    showError("");
    let ci = el.inp.value, co = el.out.value;
    if (!ci || !co) return;
    if (co <= ci) { co = addDays(ci, 1); el.out.value = co; }
    el.out.min = addDays(ci, 1);
    el.out.max = addDays(ci, cfg ? cfg.max_nights : 30);
    if (co > el.out.max) { co = el.out.max; el.out.value = co; }
    const seq = ++loadSeq;
    try {
      const data = await api(`/api/availability?check_in=${ci}&check_out=${co}`);
      if (seq !== loadSeq) return;
      avail = data.rooms;
      renderList(); renderRoomCards(); update();
    } catch (e) {
      if (seq !== loadSeq) return;
      el.list.innerHTML = "";
      showError(e.message);
      update();
    }
  }

  function renderTurnstile() {
    if (!cfg || !cfg.turnstile_site_key || tsWidget !== null) return;
    if (!window.turnstile) { setTimeout(renderTurnstile, 300); return; }
    tsWidget = window.turnstile.render(el.ts, {
      sitekey: cfg.turnstile_site_key,
      callback: (t) => { tsToken = t; },
      "expired-callback": () => { tsToken = ""; },
      "error-callback": () => { tsToken = ""; },
    });
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (busy) return;
    showError("");
    const provider = (form.querySelector('input[name="bkProvider"]:checked') || {}).value;
    const body = {
      room_type: selected, check_in: el.inp.value, check_out: el.out.value, rooms: Number(el.rooms.value),
      name: el.name.value.trim(), email: el.email.value.trim(), phone: el.phone.value.trim(), notes: el.notes.value.trim(),
      provider, turnstile_token: tsToken,
    };
    if (body.name.length < 2) return showError("Please enter your full name."), el.name.focus();
    if (!/^\+?[0-9 ()-]{9,20}$/.test(body.phone)) return showError("Please enter a valid phone number."), el.phone.focus();
    if (!el.email.checkValidity() || !body.email) return showError("Please enter a valid email address."), el.email.focus();
    if (cfg && cfg.turnstile_site_key && !tsToken) return showError("Please complete the security check above the button.");
    busy = true; update();
    try {
      const data = await api("/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      try { sessionStorage.setItem("av_last_booking", JSON.stringify({ ref: data.ref, t: data.token })); } catch (_) {}
      window.location.href = data.redirect;
    } catch (e) {
      busy = false;
      showError(e.message);
      if (window.turnstile && tsWidget !== null) { window.turnstile.reset(tsWidget); tsToken = ""; }
      loadAvailability();
    }
  });

  el.inp.addEventListener("change", loadAvailability);
  el.out.addEventListener("change", loadAvailability);
  el.rooms.addEventListener("change", () => { renderList(); update(); });

  document.querySelectorAll(".room-book-btn").forEach((b) => b.addEventListener("click", () => {
    selected = b.dataset.room;
    renderList(); update();
  }));

  // If the guest comes back from a cancelled checkout, page shows normal state.
  window.addEventListener("pageshow", (e) => { if (e.persisted) { busy = false; update(); } });

  // Returning guests who are signed in get their details filled in.
  async function prefillGuest() {
    try {
      const me = await api("/api/guest/me", { credentials: "same-origin" });
      if (!el.name.value) el.name.value = me.name || "";
      if (!el.phone.value) el.phone.value = me.phone || "";
      el.email.value = me.email;
      $("bkGuestText").textContent = `Booking as ${me.name || me.email} (${me.email}).`;
      $("bkGuest").hidden = false;
    } catch (_) {
      $("bkSignInHint").hidden = false;
    }
  }
  $("bkSignOut").addEventListener("click", async (e) => {
    e.preventDefault();
    try { await fetch("/api/guest/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" }); } catch (_) {}
    el.name.value = ""; el.phone.value = ""; el.email.value = "";
    $("bkGuest").hidden = true; $("bkSignInHint").hidden = false;
  });

  (async function init() {
    try {
      cfg = await api("/api/config");
    } catch (_) {
      el.list.innerHTML = '<p class="bk-hint">Online booking is temporarily unavailable. Please call 0262 226 592.</p>';
      return;
    }
    el.demo.hidden = !cfg.demo_payments;
    el.payPaystack.hidden = !cfg.providers.paystack;
    el.payPaypal.hidden = !cfg.providers.paypal;
    const first = form.querySelector('.bk-pay-opt:not([hidden]) input');
    if (first) first.checked = true;
    if (!cfg.providers.paystack && !cfg.providers.paypal) {
      el.list.innerHTML = '<p class="bk-hint">Online payment is being set up. Please call 0262 226 592 to book.</p>';
      return;
    }
    el.inp.min = cfg.today;
    el.inp.max = addDays(cfg.today, 365);
    prefillGuest();
    el.inp.value = cfg.today;
    el.out.value = addDays(cfg.today, 1);
    el.rooms.innerHTML = Array.from({ length: cfg.max_rooms }, (_, i) => `<option>${i + 1}</option>`).join("");
    renderTurnstile();
    loadAvailability();
  })();
})();
