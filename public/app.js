const tbody = document.querySelector("#watch-table tbody");
const form = document.querySelector("#add-form");
const formError = document.querySelector("#form-error");
const settingsForm = document.querySelector("#settings-form");
const settingsError = document.querySelector("#settings-error");
const settingsStatus = document.querySelector("#settings-status");

let vehicleLabels = {};

async function loadOptions() {
  const res = await fetch("/api/options");
  const { routes, vehicles } = await res.json();
  vehicleLabels = vehicles;

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
    const lastChecked = w.lastCheckedAt ? new Date(w.lastCheckedAt).toLocaleString("sv-SE") : "–";
    const trip = `${w.route.replace("-", " → ")}<br /><small>${escapeHtml(w.date)} kl ${escapeHtml(w.departureTime)} · ${w.adults} vuxna · ${escapeHtml(vehicleLabels[w.vehicle] ?? w.vehicle)}</small>`;

    tr.innerHTML = `
      <td>${escapeHtml(w.label)}</td>
      <td>${trip}</td>
      <td class="status-${w.lastStatus}">${statusLabel(w.lastStatus)}</td>
      <td class="detail">${escapeHtml(w.lastDetail ?? "–").replace(/\n/g, "<br />")}</td>
      <td>${escapeHtml(lastChecked)}</td>
      <td><input type="checkbox" data-action="toggle" data-id="${w.id}" ${w.active ? "checked" : ""} /></td>
      <td>
        <button class="secondary" data-action="check" data-id="${w.id}">Kolla nu</button>
        <button class="secondary" data-action="delete" data-id="${w.id}">Ta bort</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function statusLabel(status) {
  if (status === "available") return "Ledig plats!";
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

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.textContent = "";
  const data = Object.fromEntries(new FormData(form).entries());
  data.adults = Number(data.adults);

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
    form.reset();
    document.querySelector("#route-select").value = "Visby-Nynäshamn";
    document.querySelector("#vehicle-select").value = "car-under-225";
    await loadWatches();
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
  } else if (action === "check") {
    btn.disabled = true;
    btn.textContent = "Kollar...";
    try {
      const res = await fetch(`/api/watches/${id}/check`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        formError.textContent = `Kontrollen misslyckades: ${body.error ?? res.status}`;
      }
    } finally {
      await loadWatches();
    }
  }
});

tbody.addEventListener("change", async (e) => {
  const input = e.target.closest("input[data-action='toggle']");
  if (!input) return;
  await fetch(`/api/watches/${input.dataset.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active: input.checked }),
  });
});

const SETTING_KEYS = ["intervalMinutes", "jitterMinutes", "activeFrom", "activeTo"];

function renderSettings(settings, { fillInputs }) {
  // A server from before a setting existed answers without it. Filling the form with
  // `undefined` would blank the fields, and an absent window reads as "around the clock",
  // so say what happened instead of showing a setting that isn't the one in force.
  const missing = SETTING_KEYS.filter((key) => settings[key] === undefined);
  if (missing.length) {
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

  let next = "Väntar på schemaläggaren.";
  if (settings.checking) next = "En koll pågår just nu.";
  else if (settings.paused && settings.nextCheckAt)
    next = `Pausad – återupptas kl ${new Date(settings.nextCheckAt).toLocaleTimeString("sv-SE")}.`;
  else if (settings.nextCheckAt)
    next = `Nästa koll kl ${new Date(settings.nextCheckAt).toLocaleTimeString("sv-SE")}.`;

  const backoff =
    settings.consecutiveFailures > 0
      ? ` Väntetiden är uppdubblad efter ${settings.consecutiveFailures} misslyckad(e) cykel/cykler.`
      : "";
  settingsStatus.textContent = `Kollar med ${span} minuters mellanrum ${window}. ${next}${backoff}`;
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
  } catch (err) {
    settingsError.textContent = err.message;
  }
});

loadOptions().then(loadWatches);
loadSettings({ fillInputs: true });
setInterval(loadWatches, 15_000);
// Keep the "next check" line honest without clobbering a value being typed.
setInterval(() => loadSettings({ fillInputs: false }), 15_000);
