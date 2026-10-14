// Shows every date box as day/month/year (e.g. 14/10/2026), whatever the visitor's browser language.
// The underlying value stays YYYY-MM-DD, so the rest of the site code is unchanged.
(function () {
  "use strict";
  if (!window.flatpickr) return;
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  document.querySelectorAll('input[type="date"]').forEach((inp) => {
    const fp = window.flatpickr(inp, {
      dateFormat: "Y-m-d", altInput: true, altFormat: "d/m/Y", disableMobile: true,
      minDate: inp.getAttribute("min") || null, maxDate: inp.getAttribute("max") || null,
    });
    // When code sets inp.value, update the visible picker too.
    let syncing = false;
    Object.defineProperty(inp, "value", {
      configurable: true,
      get() { return proto.get.call(inp); },
      set(v) {
        proto.set.call(inp, v);
        if (syncing) return;
        syncing = true;
        try { fp.setDate(v || null, false); } finally { syncing = false; }
      },
    });
    // Keep min/max limits in sync when code changes them.
    new MutationObserver(() => {
      fp.set("minDate", inp.getAttribute("min") || null);
      fp.set("maxDate", inp.getAttribute("max") || null);
    }).observe(inp, { attributes: true, attributeFilter: ["min", "max"] });
  });
})();
