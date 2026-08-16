const tbody = document.querySelector("#watch-table tbody");
const form = document.querySelector("#add-form");
const formError = document.querySelector("#form-error");

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

  document.querySelector("#vehicle-select").innerHTML = Object.entries(vehicles)
    .map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`)
    .join("");
  document.querySelector("#vehicle-select").value = "car-under-225";
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

loadOptions().then(loadWatches);
setInterval(loadWatches, 15_000);
