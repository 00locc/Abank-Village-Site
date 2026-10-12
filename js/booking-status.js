(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let ref = (params.get("ref") || "").toUpperCase();
  let token = params.get("t") || "";
  let pollTimer = null;

  const STATUS = {
    pending_payment: ["Awaiting payment", "We're holding your room while you complete payment."],
    confirmed: ["Confirmed", "Your stay is confirmed. A confirmation has been sent to your email. We look forward to welcoming you!"],
    checked_in: ["Checked in", "You're checked in. Enjoy your stay!"],
    completed: ["Completed", "Thank you for staying with us. We hope to see you again."],
    cancelled: ["Cancelled", "This booking has been cancelled."],
    expired: ["Expired", "Payment wasn't completed in time, so the room was released. Please make a new booking."],
    payment_conflict: ["Needs attention", "We received your payment but the room was taken while your hold had lapsed. Our team will contact you shortly to rebook or refund you in full."],
  };

  const fmtDate = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const fmtTime = (ms) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  async function api(path, opts) {
    const r = await fetch(path, opts);
    let d = {};
    try { d = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(d.error || "Something went wrong.");
    return d;
  }

  function row(dl, k, v) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    dl.append(dt, dd);
  }

  function render(b) {
    $("lookup").hidden = true;
    $("view").hidden = false;
    $("sub").textContent = `Hi ${b.guest_name.split(" ")[0]}, here's the latest on your stay.`;
    const [label, msg] = STATUS[b.status] || [b.status, ""];
    const st = $("vStatus");
    st.textContent = label;
    st.className = "status s-" + b.status;
    $("vRef").textContent = b.ref;
    let m = msg;
    if (b.status === "pending_payment" && b.hold_expires_at) {
      const mins = Math.max(0, Math.round((b.hold_expires_at - Date.now()) / 60000));
      m += mins > 0 ? ` Your hold ends in about ${mins} minute${mins === 1 ? "" : "s"}.` : " Your hold has ended — you can still try to pay if rooms are free.";
    }
    $("vMsg").textContent = m;
    const dl = $("vDetails"); dl.innerHTML = "";
    row(dl, "Room", b.room + (b.rooms > 1 ? ` × ${b.rooms}` : ""));
    row(dl, "Check-in", fmtDate(b.check_in) + ", from 12:00 PM");
    row(dl, "Check-out", fmtDate(b.check_out) + ", by 11:00 AM");
    row(dl, "Nights", String(b.nights));
    row(dl, "Guest", b.guest_name);
    row(dl, "Payment", { paid: "Received ✓", unpaid: "Not paid yet", refunded: "Refunded" }[b.payment_status] || b.payment_status);
    row(dl, b.payment_status === "paid" ? "Total paid" : b.payment_status === "refunded" ? "Refunded" : "Total due", "GH₵ " + Number(b.amount_ghs).toLocaleString("en-GH"));
    $("payActions").hidden = !(b.status === "pending_payment" && b.payment_status === "unpaid");
    const box = $("cancelBox");
    box.hidden = !b.can_cancel;
    if (b.can_cancel) {
      const dl2 = new Date(b.cancel_deadline).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC" }) + " Ghana time";
      $("cancelText").textContent = b.payment_status === "paid"
        ? `Free cancellation until ${dl2}. You'll get a full refund of GH₵ ${Number(b.amount_ghs).toLocaleString("en-GH")} automatically.`
        : "Changed your mind? You can cancel this unpaid booking.";
      if (params.get("cancel") && !box.dataset.shown) {
        box.dataset.shown = "1";
        box.classList.add("highlight");
        box.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } else if (b.status === "confirmed" && b.payment_status === "paid") {
      // Past the deadline: say so instead of showing the button.
      box.hidden = false; $("cancelBtn").hidden = true;
      $("cancelText").textContent = "Online cancellation has closed (48 hours before check-in). To change or cancel, call 0262 226 592.";
    }
    const ev = $("vEvents"); ev.innerHTML = "";
    b.events.slice().reverse().forEach((e) => {
      const li = document.createElement("li");
      const t = document.createElement("time"); t.textContent = fmtTime(e.at);
      li.append(t, document.createTextNode(e.message));
      ev.appendChild(li);
    });
    clearTimeout(pollTimer);
    if (b.status === "pending_payment") pollTimer = setTimeout(load, 15000);
  }

  async function load() {
    try {
      const d = await api(`/api/bookings/${encodeURIComponent(ref)}?t=${encodeURIComponent(token)}`);
      render(d.booking);
    } catch (e) {
      $("lookup").hidden = false; $("view").hidden = true;
      $("lRef").value = ref;
      const err = $("lookupErr"); err.textContent = "That link didn't work. Enter your reference and email instead."; err.hidden = false;
    }
  }

  $("lookup").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("lBtn"), err = $("lookupErr");
    err.hidden = true; btn.disabled = true;
    try {
      const d = await api("/api/bookings/lookup", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: $("lRef").value.trim(), email: $("lEmail").value.trim() }) });
      ref = d.booking.ref; token = d.token;
      history.replaceState(null, "", `?ref=${ref}&t=${encodeURIComponent(token)}`);
      render(d.booking);
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    } finally { btn.disabled = false; }
  });

  document.querySelectorAll("#payActions button").forEach((b) => b.addEventListener("click", async () => {
    const err = $("payErr"); err.hidden = true;
    document.querySelectorAll("#payActions button").forEach((x) => (x.disabled = true));
    try {
      const d = await api(`/api/bookings/${encodeURIComponent(ref)}/pay`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ t: token, provider: b.dataset.provider }) });
      location.href = d.redirect;
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      document.querySelectorAll("#payActions button").forEach((x) => (x.disabled = false));
    }
  }));

  $("cancelBtn").addEventListener("click", async () => {
    const paid = /full refund/.test($("cancelText").textContent);
    if (!window.confirm(paid ? "Cancel this booking? You'll receive a full refund and the room will be released." : "Cancel this booking?")) return;
    const btn = $("cancelBtn"), err = $("cancelErr");
    err.hidden = true; btn.disabled = true; btn.textContent = "Cancelling…";
    try {
      await api(`/api/bookings/${encodeURIComponent(ref)}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: token }) });
      history.replaceState(null, "", `?ref=${ref}&t=${encodeURIComponent(token)}`);
      await load();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    finally { btn.disabled = false; btn.textContent = "Cancel booking"; }
  });

  if (params.get("cancelled")) $("cancelNote").hidden = false;
  if (ref && token) load();
  else if (ref) $("lRef").value = ref;
})();
