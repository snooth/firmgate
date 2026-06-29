/**
 * Click-to-dial: intercept phone links and open the SIP dialpad.
 */
(function () {
  "use strict";

  if (document.documentElement.dataset.sipClickDialInit) return;
  document.documentElement.dataset.sipClickDialInit = "1";

  function digitsOnly(s) {
    return String(s || "").replace(/[^\d+]/g, "");
  }

  function parseTelHref(href) {
    const m = String(href || "").match(/^tel:(.+)$/i);
    if (!m) return "";
    try {
      return decodeURIComponent(m[1]).trim();
    } catch (_) {
      return m[1].trim();
    }
  }

  function looksLikePhone(text) {
    const d = digitsOnly(text);
    return d.length >= 6;
  }

  function dial(number, autoCall) {
    if (typeof window.ncSipDial === "function") {
      window.ncSipDial(number, { autoCall: autoCall !== false });
      return;
    }
    window.setTimeout(() => {
      if (typeof window.ncSipDial === "function") window.ncSipDial(number, { autoCall: autoCall !== false });
    }, 400);
  }

  document.addEventListener(
    "click",
    (ev) => {
      const link = ev.target.closest("a[href^='tel:']");
      if (link) {
        const num = parseTelHref(link.getAttribute("href"));
        if (!num || !looksLikePhone(num)) return;
        ev.preventDefault();
        ev.stopPropagation();
        dial(num, true);
        return;
      }

      const btn = ev.target.closest("[data-sip-dial]");
      if (btn) {
        const num = (btn.getAttribute("data-sip-dial") || btn.textContent || "").trim();
        if (!num || !looksLikePhone(num)) return;
        ev.preventDefault();
        ev.stopPropagation();
        dial(num, true);
      }
    },
    true,
  );

  /** Build a click-to-dial link for dynamic HTML (CRM tables, resource pool, etc.). */
  window.ncSipPhoneLink = function (phone, display) {
    const ph = String(phone || "").trim();
    if (!ph) return "—";
    const dial = digitsOnly(ph) || ph;
    const label = String(display != null ? display : ph)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    return `<a class="nc-sip-dial-link" href="tel:${encodeURIComponent(dial)}">${label}</a>`;
  };
})();
