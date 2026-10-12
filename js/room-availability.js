// Menu: "My Bookings" appears only once the guest is signed in.
(function () {
  const item = document.getElementById("navAccountItem");
  if (!item) return;
  fetch("/api/guest/me", { credentials: "same-origin" }).then((r) => { if (r.ok) item.hidden = false; }).catch(() => {});
})();

// Shows tonight's availability on the home page room cards.
(function () {
  "use strict";
  const spans = document.querySelectorAll(".room-avail");
  if (!spans.length) return;
  fetch("/api/availability").then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d) return;
    spans.forEach((span) => {
      const a = d.rooms.find((x) => x.id === span.dataset.room);
      const btn = document.querySelector(`.room-book-btn[data-room="${span.dataset.room}"]`);
      if (!a) { if (btn) btn.classList.add("disabled"); return; }
      if (!a.available) { span.textContent = "Fully booked tonight"; span.className = "room-avail none"; }
      else if (a.available <= 3 && a.total_rooms > 3) { span.textContent = `Only ${a.available} left tonight`; span.className = "room-avail low"; }
      else { span.textContent = `${a.available} available tonight`; span.className = "room-avail"; }
    });
  }).catch(() => {});
})();
