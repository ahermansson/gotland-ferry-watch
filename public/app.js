const tbody = document.querySelector("#watch-table tbody");
const form = document.querySelector("#add-form");
const formError = document.querySelector("#form-error");
const settingsForm = document.querySelector("#settings-form");
const settingsError = document.querySelector("#settings-error");
const settingsStatus = document.querySelector("#settings-status");
const countdownEl = document.querySelector("#countdown");
const countdownLabel = document.querySelector("#countdown-label");
const countdownProgressFill = document.querySelector("#countdown-progress-fill");
const newWatchDialog = document.querySelector("#new-watch-dialog");
const settingsDialog = document.querySelector("#settings-dialog");

document.querySelector("#new-watch-button").addEventListener("click", () => newWatchDialog.showModal());
document.querySelector("#settings-button").addEventListener("click", () => settingsDialog.showModal());
document.querySelectorAll('[data-action="close-dialog"]').forEach((btn) =>
  btn.addEventListener("click", () => btn.closest("dialog").close())
);

/** Blank slate for the next open — Avbryt and Esc both fire a dialog's "close" event, so
 * leftover input from an abandoned add doesn't greet the next person to open it. */
newWatchDialog.addEventListener("close", () => resetAddForm());

let vehicleLabels = {};
let fareClasses = [];
let salongOptions = [];
let bookingDefaults = null;
/** Watches with a manual check in flight. A check takes ~35 s and the table redraws every
 * 15 s, so without this the button springs back to "Kolla nu" mid-check and the check
 * looks like it never ran. */
const checking = new Set();
/** Watches whose booking panel is open, so a redraw doesn't fold it away mid-edit. */
const openPrefs = new Set();

// Inline so a row costs no extra request, and stroke-drawn so they take the button's own
// colour on hover and when disabled.
const ICON_RUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>`;
const ICON_PREFS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>`;
const ICON_DELETE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>`;

async function loadOptions() {
  const res = await fetch("/api/options");
  const { routes, vehicles, fareClasses: fares, salongs, bookingDefaults: defaults } = await res.json();
  vehicleLabels = vehicles;
  fareClasses = fares ?? [];
  salongOptions = salongs ?? [];
  bookingDefaults = defaults ?? null;

  const routeSelect = document.querySelector("#route-select");
  routeSelect.innerHTML = routes
    .map((r) => `<option value="${r}">${escapeHtml(r.replace("-", " → "))}</option>`)
    .join("");
  routeSelect.value = "Visby-Nynäshamn";

  const vehicleSelect = document.querySelector("#vehicle-select");
  vehicleSelect.innerHTML = Object.entries(vehicles)
    .map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`)
    .join("");
  vehicleSelect.value = "car-under-225";
}

/**
 * The booking settings, rendered from the options the server reports rather than a copy
 * of them here — a lounge the server would reject must not be offerable in the form.
 * The same markup serves the add form and the per-watch panel, so the two cannot drift.
 */
function renderBookingPrefs(prefs) {
  const p = prefs ?? bookingDefaults ?? { fareOrder: [], salongs: [], maxPrice: null, seatReservation: false };
  // Ranked: ticked classes in their saved order first, the rest after.
  const ranked = [...p.fareOrder, ...fareClasses.filter((f) => !p.fareOrder.includes(f))];

  const fareRows = ranked
    .map(
      (fare) => `
      <li data-fare="${escapeHtml(fare)}">
        <label><input type="checkbox" data-fare-on ${p.fareOrder.includes(fare) ? "checked" : ""} /> ${escapeHtml(fare)}</label>
        <span class="rank-buttons">
          <button type="button" class="step" data-move="up" aria-label="Flytta upp">↑</button>
          <button type="button" class="step" data-move="down" aria-label="Flytta ner">↓</button>
        </span>
      </li>`
    )
    .join("");

  const salongBoxes = salongOptions
    .map(
      (name) => `
      <label class="chip"><input type="checkbox" data-salong="${escapeHtml(name)}" ${p.salongs.includes(name) ? "checked" : ""} /> ${escapeHtml(name)}</label>`
    )
    .join("");

  return `
    <div class="booking-prefs">
      <p class="prefs-title">Biljettklass, bästa först</p>
      <ul class="rank">${fareRows}</ul>
      <p class="prefs-title">Salonger som duger — den billigaste av dem bokas</p>
      <div class="chips">${salongBoxes}</div>
      <div class="row">
        <label>Takpris för hela resan (kr)
          <input type="number" min="1" step="1" data-pref="maxPrice" value="${p.maxPrice ?? ""}" placeholder="t.ex. 6000" />
        </label>
        <label class="inline-check seat">
          <input type="checkbox" data-pref="seatReservation" ${p.seatReservation ? "checked" : ""} />
          Boka platsreservation (kostar extra)
        </label>
      </div>
    </div>`;
}

/** Reads back what renderBookingPrefs produced. `autoBook` comes from the caller's switch. */
function readBookingPrefs(root, autoBook) {
  const fareOrder = [...root.querySelectorAll(".rank li")]
    .filter((li) => li.querySelector("[data-fare-on]").checked)
    .map((li) => li.dataset.fare);
  const salongs = [...root.querySelectorAll("[data-salong]")]
    .filter((box) => box.checked)
    .map((box) => box.dataset.salong);
  const maxPrice = root.querySelector('[data-pref="maxPrice"]').value;
  return {
    autoBook,
    fareOrder,
    salongs,
    maxPrice: maxPrice === "" ? null : Number(maxPrice),
    seatReservation: root.querySelector('[data-pref="seatReservation"]').checked,
  };
}

// The rank buttons move a whole row, since the order is the setting.
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-move]");
  if (!btn) return;
  const li = btn.closest("li");
  const sibling = btn.dataset.move === "up" ? li.previousElementSibling : li.nextElementSibling;
  if (!sibling) return;
  li.parentElement.insertBefore(btn.dataset.move === "up" ? li : sibling, btn.dataset.move === "up" ? sibling : li);
});

async function loadWatches() {
  let watches;
  try {
    const res = await fetch("/api/watches");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    watches = await res.json();
  } catch (err) {
    formError.textContent = `Kunde inte hämta bevakningar: ${err.message}`;
    return;
  }

  tbody.innerHTML = "";
  for (const w of watches) {
    const tr = document.createElement("tr");
    const lastChecked = w.lastCheckedAt ? clockTime(w.lastCheckedAt) : "–";
    const back = w.returnTime
      ? `<br /><small>retur ${escapeHtml(w.returnDate)} kl ${escapeHtml(w.returnTime)}</small>`
      : "";
    const trip = `${w.route.replace("-", " → ")}<br /><small>${escapeHtml(w.date)} kl ${escapeHtml(w.departureTime)} · ${w.adults} vuxna · ${escapeHtml(vehicleLabels[w.vehicle] ?? w.vehicle)}</small>${back}`;

    tr.innerHTML = `
      <td>
        <label class="toggle">
          <input type="checkbox" data-action="toggle" data-id="${w.id}" ${w.active ? "checked" : ""} />
          <span class="toggle-track"></span>
        </label>
      </td>
      <td>${trip}</td>
      <td>${statusIndicator(w.lastStatus, w.lastDetail)}</td>
      <td>${escapeHtml(lastChecked)}</td>
      <td class="actions">
        ${iconButton({
          action: "check",
          id: w.id,
          icon: ICON_RUN,
          label: checking.has(w.id) ? "Kollar…" : "Kör nu",
          busy: checking.has(w.id),
        })}
        ${iconButton({ action: "prefs", id: w.id, icon: ICON_PREFS, label: "Bokningsinställningar" })}
        ${iconButton({ action: "delete", id: w.id, icon: ICON_DELETE, label: "Ta bort", danger: true })}
      </td>
    `;
    tbody.appendChild(tr);

    // Always visible, unlike the editable panel below it — this is what makes an
    // auto-booked watch's settings show up on the row itself, not just after a click.
    const summary = document.createElement("tr");
    summary.className = "auto-summary-row";
    summary.innerHTML = `<td colspan="5">
      <div class="auto-summary">
        <label class="toggle">
          <input type="checkbox" data-action="auto" data-id="${w.id}" ${w.booking?.autoBook ? "checked" : ""} />
          <span class="toggle-track"></span>
        </label>
        <span class="auto-summary-text">${describeBookingPrefs(w.booking)}</span>
      </div>
    </td>`;
    tbody.appendChild(summary);

    // Kept in the DOM but hidden, so opening the panel costs no round trip and the
    // 15 s redraw can restore whatever was open.
    const panel = document.createElement("tr");
    panel.className = "prefs-row";
    panel.dataset.prefsFor = w.id;
    panel.hidden = !openPrefs.has(w.id);
    panel.innerHTML = `<td colspan="5">${renderBookingPrefs(w.booking)}
      <div class="prefs-actions">
        <button type="button" data-action="save-prefs" data-id="${w.id}">Spara</button>
        <span class="error" data-prefs-error="${w.id}"></span>
      </div></td>`;
    tbody.appendChild(panel);
  }
}

function iconButton({ action, id, icon, label, busy = false, danger = false }) {
  const classes = ["icon-btn", danger ? "danger" : "", busy ? "spinning" : ""].filter(Boolean);
  return (
    `<button class="${classes.join(" ")}" data-action="${action}" data-id="${id}"` +
    ` title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${busy ? " disabled" : ""}>` +
    `${icon}</button>`
  );
}

/**
 * A coloured shape instead of a status column full of text — red square: nothing to book,
 * amber square: half a return trip is open, green dot: book it, blue dot: already booked.
 * The full detail (which lounge, why it failed, ...) survives as the title tooltip rather
 * than disappearing — it's just not taking up a column of its own any more.
 */
function statusIndicator(status, detail) {
  const title = `${statusLabel(status)}${detail ? ` — ${detail.replace(/\*\*/g, "")}` : ""}`;
  return `<span class="status-dot status-${status}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></span>`;
}

/** The one-line summary shown on every watch row, so auto-booking settings don't hide
 * behind a click. Off gets a plain "av" — nothing configured is worth summarizing then. */
function describeBookingPrefs(booking) {
  if (!booking?.autoBook) return "Autoboka: av";
  const fares = booking.fareOrder?.length ? booking.fareOrder.join(" → ") : "ingen biljettklass vald";
  const salongs = booking.salongs?.length ? booking.salongs.join(", ") : "ingen salong vald";
  const price = booking.maxPrice != null ? `max ${booking.maxPrice} kr` : "inget takpris";
  const seat = booking.seatReservation ? " · + platsreservation" : "";
  return `🤖 Auto: ${escapeHtml(fares)} · ${escapeHtml(salongs)} · ${escapeHtml(price)}${escapeHtml(seat)}`;
}

function statusLabel(status) {
  if (status === "booked") return "Bokad";
  if (status === "available") return "Ledig plats!";
  // Only a return watch can land here: one leg open, the other not.
  if (status === "partial") return "Halv träff";
  if (status === "full") return "Fullbokad";
  return "Okänt";
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// +/- buttons drive the numeric fields, clamped to each input's own min/max.
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button.step");
  if (!btn) return;
  const input = btn.closest("form")?.querySelector(`[name="${btn.dataset.target}"]`);
  if (!input) return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 99);
  const next = Number(input.value || min) + Number(btn.dataset.delta);
  input.value = String(Math.min(max, Math.max(min, next)));
});

// The return fields only make sense for a return watch, and an empty one must not be
// submitted half-filled — so clearing them is part of switching it off.
const roundTrip = document.querySelector("#round-trip");
const returnFields = document.querySelector("#return-fields");
roundTrip.addEventListener("change", () => {
  returnFields.hidden = !roundTrip.checked;
  if (!roundTrip.checked) {
    form.returnDate.value = "";
    form.returnTime.value = "";
  }
});

const autoBookBox = document.querySelector("#auto-book");
const bookingBlock = document.querySelector("#booking-block");
autoBookBox.addEventListener("change", () => {
  bookingBlock.hidden = !autoBookBox.checked;
});

/** Back to a blank add-form -- used after a successful add and on every dialog close
 * (Avbryt, Esc, backdrop), so an abandoned attempt never lingers for the next open. */
function resetAddForm() {
  form.reset();
  formError.textContent = "";
  returnFields.hidden = true;
  bookingBlock.hidden = true;
  bookingBlock.innerHTML = renderBookingPrefs(null);
  document.querySelector("#route-select").value = "Visby-Nynäshamn";
  document.querySelector("#vehicle-select").value = "car-under-225";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.textContent = "";
  const data = Object.fromEntries(new FormData(form).entries());
  data.adults = Number(data.adults);
  data.booking = readBookingPrefs(bookingBlock, autoBookBox.checked);

  try {
    const res = await fetch("/api/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    newWatchDialog.close(); // triggers the "close" listener above, which resets the form
    await loadWatches();
    await loadSettings({ fillInputs: false });
  } catch (err) {
    formError.textContent = err.message;
  }
});

tbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === "delete") {
    if (!confirm("Ta bort denna bevakning?")) return;
    await fetch(`/api/watches/${id}`, { method: "DELETE" });
    await loadWatches();
    await loadSettings({ fillInputs: false });
  } else if (action === "prefs") {
    const panel = tbody.querySelector(`[data-prefs-for="${id}"]`);
    panel.hidden = !panel.hidden;
    if (panel.hidden) openPrefs.delete(id);
    else openPrefs.add(id);
  } else if (action === "save-prefs") {
    const panel = tbody.querySelector(`[data-prefs-for="${id}"]`);
    const errorEl = panel.querySelector(`[data-prefs-error="${id}"]`);
    const autoBox = tbody.querySelector(`input[data-action="auto"][data-id="${id}"]`);
    errorEl.textContent = "";
    errorEl.classList.remove("ok");
    const res = await fetch(`/api/watches/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking: readBookingPrefs(panel, autoBox.checked) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      errorEl.textContent = body.error ?? `HTTP ${res.status}`;
      // Nothing was saved, so a checked Auto box would be showing an intent that failed.
      if (autoBox.checked) autoBox.checked = false;
      return;
    }
    // Left open on purpose: you just set this, and closing it here would fold the panel
    // away before you've had a chance to see what got saved.
    await loadWatches();
    const freshError = tbody.querySelector(`[data-prefs-error="${id}"]`);
    if (freshError) {
      freshError.textContent = "Sparat.";
      freshError.classList.add("ok");
      setTimeout(() => freshError.classList.remove("ok"), 2000);
    }
  } else if (action === "check") {
    checking.add(id);
    await loadWatches();
    try {
      const res = await fetch(`/api/watches/${id}/check`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        formError.textContent = `Kontrollen misslyckades: ${body.error ?? res.status}`;
      }
    } finally {
      checking.delete(id);
      await loadWatches();
    }
  }
});

tbody.addEventListener("change", async (e) => {
  const auto = e.target.closest("input[data-action='auto']");
  if (auto) {
    const panel = tbody.querySelector(`[data-prefs-for="${auto.dataset.id}"]`);

    // Turning it on needs a price cap and at least one fare/lounge first, which an
    // untouched panel won't have — open it for editing instead of firing off a save
    // that's only going to be refused. "Spara" in the panel is what actually turns it on.
    if (auto.checked) {
      panel.hidden = false;
      openPrefs.add(auto.dataset.id);
      // Left checked: it shows intent, and "Spara" below reads this same checkbox to
      // decide what to save. Nothing is actually persisted until that click succeeds.
      return;
    }

    const res = await fetch(`/api/watches/${auto.dataset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking: readBookingPrefs(panel, false) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      panel.hidden = false;
      openPrefs.add(auto.dataset.id);
      panel.querySelector(`[data-prefs-error="${auto.dataset.id}"]`).textContent = body.error ?? `HTTP ${res.status}`;
    }
    return;
  }

  const input = e.target.closest("input[data-action='toggle']");
  if (!input) return;
  await fetch(`/api/watches/${input.dataset.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active: input.checked }),
  });
  // The server starts or idles the timer on this, so don't wait out the 15 s poll to say so.
  await loadSettings({ fillInputs: false });
});

const SETTING_KEYS = ["intervalMinutes", "jitterMinutes", "activeFrom", "activeTo"];

/** Last payload from /api/settings, so the countdown can tick between polls. */
let schedulerState = null;
let lastDueRefresh = 0;
/** The span the progress bar is draining across, captured the moment a given nextCheckAt
 * is first seen -- there's no cycle-start timestamp from the server to measure it from. */
let countdownSpan = { for: null, totalMs: 0 };

function formatRemaining(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (n) => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return hours > 0 ? `${hours}:${rest}` : rest;
}

const clockTime = (iso) =>
  new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });

/**
 * Counts down to the start of the next cycle — a cycle checks every watch in turn, so
 * there is no single "next check" to aim at once more than one watch is active.
 */
function renderCountdown() {
  const state = schedulerState;
  const show = (label, value, tone) => {
    countdownLabel.textContent = label;
    countdownEl.textContent = value;
    countdownEl.className = `countdown${tone ? ` ${tone}` : ""}`;
  };
  // The bar only means something while an actual countdown is running below it -- every
  // other state (idle, checking, paused) leaves it full rather than at some stale fraction.
  const showFull = (label, value, tone) => {
    show(label, value, tone);
    countdownProgressFill.style.width = "100%";
  };

  if (!state) return showFull("Nästa cykel", "–", "idle");
  if (state.checking) return showFull("Pågår nu", "Kollar…", "idle");
  // Nothing is being watched, so there is no cycle to count down to. Say that rather than
  // showing a clock that runs out and does nothing.
  if (state.idle) return showFull("", "Ingen aktiv bevakning", "idle text");
  if (!state.nextCheckAt) return showFull("Nästa cykel", "–", "idle");
  // Outside the window the wait is hours, which is a clock time, not a countdown.
  if (state.paused) return showFull("Nästa cykel startar", clockTime(state.nextCheckAt), "paused");

  const remaining = new Date(state.nextCheckAt) - Date.now();
  if (remaining <= 0) {
    // The cycle is due; ask the server rather than sitting at 00:00 until the next poll.
    if (Date.now() - lastDueRefresh > 5000) {
      lastDueRefresh = Date.now();
      loadSettings({ fillInputs: false });
    }
    return showFull("Pågår nu", "Kollar…", "idle");
  }
  show("Nästa cykel startar om", formatRemaining(remaining));
  renderCountdownProgress(state.nextCheckAt, remaining);
}

/**
 * Full right after a cycle and empty by the next one. There's no cycle-start time from the
 * server to measure against, so the span is captured the first moment a given nextCheckAt
 * is seen -- whatever "remaining" was then becomes "total", and the fraction drains from
 * there as the seconds tick down to that same nextCheckAt.
 */
function renderCountdownProgress(nextCheckAt, remaining) {
  if (countdownSpan.for !== nextCheckAt) countdownSpan = { for: nextCheckAt, totalMs: remaining };
  const fraction = countdownSpan.totalMs > 0 ? Math.min(1, Math.max(0, remaining / countdownSpan.totalMs)) : 0;
  countdownProgressFill.style.width = `${fraction * 100}%`;
}

function renderSettings(settings, { fillInputs }) {
  // A server from before a setting existed answers without it. Filling the form with
  // `undefined` would blank the fields, and an absent window reads as "around the clock",
  // so say what happened instead of showing a setting that isn't the one in force.
  const missing = SETTING_KEYS.filter((key) => settings[key] === undefined);
  if (missing.length) {
    schedulerState = null;
    renderCountdown();
    settingsStatus.textContent =
      `Servern svarade utan ${missing.join(", ")}. Den kör troligen en äldre version än` +
      " sidan — starta om den (npm start).";
    return;
  }

  if (fillInputs) {
    settingsForm.intervalMinutes.value = settings.intervalMinutes;
    settingsForm.jitterMinutes.value = settings.jitterMinutes;
    settingsForm.activeFrom.value = settings.activeFrom;
    settingsForm.activeTo.value = settings.activeTo;
  }
  const { intervalMinutes: base, jitterMinutes: jitter, activeFrom, activeTo } = settings;
  const span = jitter > 0 ? `${base}–${base + jitter}` : String(base);
  const window =
    activeFrom === activeTo ? "dygnet runt" : `mellan ${activeFrom} och ${activeTo}`;

  const backoff =
    settings.consecutiveFailures > 0
      ? ` Väntetiden är uppdubblad efter ${settings.consecutiveFailures} misslyckad(e) cykel/cykler.`
      : "";
  settingsStatus.textContent = settings.idle
    ? `Inget kollas just nu. Slå på en bevakning eller lägg till en ny, så körs kontrollerna` +
      ` med ${span} minuters mellanrum ${window}.`
    : `Kollar med ${span} minuters mellanrum ${window}.${backoff}`;

  schedulerState = settings;
  renderCountdown();
}

async function loadSettings({ fillInputs }) {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderSettings(await res.json(), { fillInputs });
  } catch (err) {
    settingsStatus.textContent = `Kunde inte hämta intervallet: ${err.message}`;
  }
}

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  settingsError.textContent = "";
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intervalMinutes: Number(settingsForm.intervalMinutes.value),
        jitterMinutes: Number(settingsForm.jitterMinutes.value),
        activeFrom: settingsForm.activeFrom.value,
        activeTo: settingsForm.activeTo.value,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    renderSettings(body, { fillInputs: true });
    settingsDialog.close();
  } catch (err) {
    settingsError.textContent = err.message;
  }
});

loadOptions().then(() => {
  // The form's booking fields are built from the server's options, so they wait for them.
  bookingBlock.innerHTML = renderBookingPrefs(null);
  return loadWatches();
});
loadSettings({ fillInputs: true });
renderCountdown();
setInterval(renderCountdown, 1000);
setInterval(loadWatches, 15_000);
// Keep the "next check" line honest without clobbering a value being typed.
setInterval(() => loadSettings({ fillInputs: false }), 15_000);
