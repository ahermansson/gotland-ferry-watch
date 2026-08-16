const tbody = document.querySelector("#watch-table tbody");
const form = document.querySelector("#add-form");

async function loadWatches() {
  const res = await fetch("/api/watches");
  const watches = await res.json();
  tbody.innerHTML = "";
  for (const w of watches) {
    const tr = document.createElement("tr");

    const when = w.time ? `${w.date} ${w.time}` : w.date;
    const lastChecked = w.lastCheckedAt ? new Date(w.lastCheckedAt).toLocaleString("sv-SE") : "–";

    tr.innerHTML = `
      <td>${escapeHtml(w.label)}</td>
      <td>${escapeHtml(w.origin)} → ${escapeHtml(w.destination)}</td>
      <td>${escapeHtml(when)}</td>
      <td class="status-${w.lastStatus}">${statusLabel(w.lastStatus)}</td>
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
  const data = Object.fromEntries(new FormData(form).entries());
  await fetch("/api/watches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  form.reset();
  await loadWatches();
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
    await fetch(`/api/watches/${id}/check`, { method: "POST" });
    await loadWatches();
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

loadWatches();
setInterval(loadWatches, 15_000);
