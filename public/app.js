const $ = (sel) => document.querySelector(sel);
const sessionId = crypto.randomUUID();

async function init() {
  const res = await fetch("/verify").then((r) => r.json());
  const item = $("#item");
  for (const c of res.catalog) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.id} — ${c.description}`;
    item.appendChild(opt);
  }
  const att = res.attestation;
  const cls = att.source === "tee" ? "tee" : "local";
  const label = att.source === "tee" ? "Source Code Verified · TEE" : "Local dev (not attested)";
  $("#attest").innerHTML =
    `<span class="${cls}">● ${label}</span> · ` +
    `${att.gitSha.slice(0, 7)} · ${att.attestationHash.slice(0, 16)}…`;
}

function subscribe() {
  const ev = new EventSource(`/api/events?sessionId=${sessionId}`);
  ev.onmessage = (e) => {
    const data = JSON.parse(e.data);
    appendEvent(data);
    if (data.kind === "hitl_requested") showHitl(data);
    if (data.kind === "hitl_resolved") hideHitl();
  };
}

function appendEvent(ev) {
  const li = document.createElement("li");
  const ts = new Date(ev.ts).toLocaleTimeString();
  const dataStr = ev.data ? JSON.stringify(ev.data) : "";
  li.innerHTML = `
    <span class="ts">${ts}</span>
    <span class="kind ${ev.kind}">${ev.kind}</span>
    <span>
      <div class="msg"></div>
      ${dataStr ? `<div class="data"></div>` : ""}
    </span>`;
  li.querySelector(".msg").textContent = ev.message;
  if (dataStr) li.querySelector(".data").textContent = dataStr;
  $("#events").appendChild(li);
}

function showHitl(ev) {
  $("#hitlPrompt").textContent =
    `Confirm ${ev.data.amountUsdc} USDC to ${ev.data.merchantId} for ${ev.data.itemId}?`;
  $("#hitl").hidden = false;
}
function hideHitl() {
  $("#hitl").hidden = true;
}
async function confirm(approved) {
  await fetch("/api/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, approved }),
  });
}

function renderReceipt(r) {
  const explorer =
    r.txHash && r.txHash !== "0x"
      ? `https://basescan.org/tx/${r.txHash}`
      : null;
  $("#receipt").innerHTML = `
    <h3>Receipt</h3>
    <dl>
      <dt>Item</dt><dd>${r.request.item}</dd>
      <dt>Amount</dt><dd>${r.amountUsdc} USDC</dd>
      <dt>Merchant</dt><dd>${r.merchantId}</dd>
      <dt>Tx</dt><dd>${explorer ? `<a href="${explorer}" target="_blank">${r.txHash}</a>` : r.txHash}</dd>
      <dt>Asset</dt><dd>${r.asset.byteLength} bytes · ${r.asset.contentType}</dd>
      <dt>Asset sha256</dt><dd>${r.asset.sha256}</dd>
      <dt>Attestation (${r.attestation.source})</dt><dd>${r.attestation.attestationHash}</dd>
      <dt>App / Git</dt><dd>${r.attestation.appId} · ${r.attestation.gitSha}</dd>
    </dl>`;
  $("#receipt").hidden = false;
}

$("#purchase").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#submit").disabled = true;
  $("#events").innerHTML = "";
  $("#receipt").hidden = true;
  const body = {
    sessionId,
    item: $("#item").value,
    maxUsdc: Number($("#maxUsdc").value),
  };
  try {
    const r = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.receipt) renderReceipt(r.receipt);
  } finally {
    $("#submit").disabled = false;
  }
});
$("#approve").addEventListener("click", () => confirm(true));
$("#reject").addEventListener("click", () => confirm(false));

init();
subscribe();
