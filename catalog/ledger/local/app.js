const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let selected = null,
  item = null,
  state;
async function api(path, body) {
  const r = await fetch(
    path,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const x = await r.json();
  if (!r.ok) throw Error(x.error ?? x.message);
  return x;
}
async function run(fn) {
  $("#status").textContent = "";
  $("#status").className = "";
  try {
    await fn();
    await refresh();
  } catch (e) {
    $("#status").textContent = e.message;
    $("#status").className = "error";
  }
}
const role = () => $("#role").value;
const rpc = (op, args = {}, actor = role()) =>
  api("/api/rpc", { role: actor, op, args });
async function mutate(op, args = {}) {
  await rpc(op, {
    item_id: item.id,
    expected_version: item.version,
    ...(role() === "github" ? { binding: item.head_sha } : {}),
    ...args,
  });
}
async function refresh() {
  state = await api("/api/state");
  $("#notice").textContent = state.mode;
  $("#items").innerHTML =
    state.items
      .map(
        (x) =>
          `<button class="item ${x.id === selected ? "active" : ""}" data-item="${x.id}"><strong>${esc(x.title)}</strong><br><span class="stage">${esc(x.stage)}</span> <small>${x.kind} · v${x.version}</small></button>`,
      )
      .join("") || "<small>No work yet.</small>";
  $("#items")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () =>
          run(async () => {
            selected = b.dataset.item;
          })),
    );
  $("#outbox").innerHTML =
    state.outbox
      .slice(0, 12)
      .map(
        (o) =>
          `<p><span class="stage">${esc(o.status)}</span> ${esc(o.role)} · ${esc(o.kind)} <small>attempt ${o.attempts} · ${o.item_id.slice(0, 8)}</small> ${o.status === "claimed" ? `<button class="secondary" data-ack="${o.id}" data-role="${o.role}">Acknowledge notice</button>` : ""}</p>`,
      )
      .join("") || "<p>No wakes yet.</p>";
  document
    .querySelectorAll("[data-ack]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          run(() =>
            rpc(
              "complete_wake",
              {
                outbox_id: b.dataset.ack,
                note: "SIMULATED human notice delivered in playground",
              },
              b.dataset.role,
            ),
          )),
    );
  if (!selected) return;
  item = await rpc("get_item", { item_id: selected });
  const a = item.allowed_actions;
  $("#detail").innerHTML =
    `<h2>${esc(item.title)}</h2><p><span class="stage">${esc(item.stage)}</span> · version ${item.version} · spec ${item.spec_version}</p><small>${item.id}${item.head_sha ? "<br>Head " + item.head_sha : ""}</small><p>${esc(item.spec.problem)}</p><ul>${(item.spec.acceptance_criteria ?? []).map((c) => `<li>${esc(c)}</li>`).join("")}</ul>${item.blocked_on ? `<div class="notice">Blocked on ${esc(item.blocked_on.role)}: ${esc(item.blocked_on.question)}</div>` : ""}${item.approval ? `<p>May I approval: ${esc(item.approval.status)}</p>` : ""}<div class="actions"><strong>Available transitions</strong><div>${a.transitions.map((t) => `<button data-transition="${esc(t)}">Move to ${esc(t)}</button>`).join("") || "<p><small>No transitions available to this actor. Record required evidence, wait for the May I decision, or change actor.</small></p>"}</div>${a.evidence.map((t) => `<button class="secondary" data-evidence="${t}">Record ${t}</button>`).join("")}${a.set_head ? '<button class="secondary" id="head">Simulate new commit</button>' : ""}${a.attach ? '<button class="secondary" id="artifacts">Attach simulated PR & preview</button><button class="secondary" id="deploy">Attach simulated deployment</button>' : ""}${a.block && !item.blocked_on ? '<button class="secondary" id="block">Ask a human</button>' : ""}${a.resolve_block ? '<button id="resolve">Resolve question</button>' : ""}</div>${a.update_spec ? `<details><summary>Edit specification${item.kind === "plan" ? " & proposed children" : ""}</summary><p><small>Each proposed child needs key, kind, title and spec. Approval creates all children atomically.</small></p><textarea id="spec" style="min-height:260px">${esc(JSON.stringify(item.spec, null, 2))}</textarea><input id="spec-note" placeholder="Why is the spec changing?"><button id="save-spec">Save spec</button></details>` : ""}<details><summary>Artifacts</summary><pre>${esc(JSON.stringify(item.artifacts, null, 2))}</pre></details><details open><summary>Event history</summary><div class="timeline">${[
      ...item.events,
    ]
      .reverse()
      .map(
        (e) =>
          `<div class="event"><strong>${esc(e.kind)}</strong> <small>${new Date(e.created_at).toLocaleTimeString()}</small><pre>${esc(JSON.stringify(e.payload, null, 2))}</pre></div>`,
      )
      .join("")}</div></details>`;
  document
    .querySelectorAll("[data-transition]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          run(() =>
            mutate("transition", {
              to_stage: b.dataset.transition,
              note: "Local playground action",
            }),
          )),
    );
  document
    .querySelectorAll("[data-evidence]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          run(() =>
            mutate("evidence", {
              type: b.dataset.evidence,
              binding: item.head_sha ?? String(item.spec_version),
              payload: {
                summary:
                  "SIMULATED evidence recorded manually in the local playground.",
              },
            }),
          )),
    );
  if ($("#head"))
    $("#head").onclick = () =>
      run(() =>
        mutate("set_head", {
          head_sha: crypto.randomUUID().replaceAll("-", "") + "01234567",
          observed_at: new Date().toISOString(),
        }),
      );
  if ($("#artifacts"))
    $("#artifacts").onclick = () =>
      run(async () => {
        if (!item.head_sha) throw Error("Simulate a commit first.");
        await mutate("attach", {
          type: "pr",
          value: `https://github.com/local/prototype/pull/${item.id.slice(0, 8)}`,
        });
        item = await rpc("get_item", { item_id: selected });
        await mutate("attach", {
          type: "preview_url",
          value: location.origin + "/preview",
          binding: item.head_sha,
        });
      });
  if ($("#deploy"))
    $("#deploy").onclick = () =>
      run(() =>
        mutate("attach", {
          type: "deployment",
          value: location.origin + "/preview",
          binding: item.head_sha,
        }),
      );
  if ($("#block"))
    $("#block").onclick = () => {
      const question = prompt("Question for the engineer");
      if (question) run(() => mutate("block", { role: "engineer", question }));
    };
  if ($("#resolve"))
    $("#resolve").onclick = () => {
      const answer = prompt("Human answer");
      if (answer) run(() => mutate("resolve_block", { answer }));
    };
  if ($("#save-spec"))
    $("#save-spec").onclick = () =>
      run(() =>
        mutate("update_spec", {
          spec: JSON.parse($("#spec").value),
          note: $("#spec-note").value,
        }),
      );
}
$("#create").onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    const f = new FormData(e.target);
    const spec = {
      problem: f.get("problem"),
      acceptance_criteria: f.get("criteria").split("\n").filter(Boolean),
      out_of_scope: [],
      decisions: [],
      open_questions: [],
    };
    if (f.get("kind") === "plan")
      spec.proposed_children = [
        {
          key: "welcome",
          kind: "feature",
          title: "Build welcome page",
          spec: {
            problem: "Welcome visitors",
            acceptance_criteria: ["A welcome page is reachable"],
          },
        },
      ];
    const result = await rpc(
      "create_item",
      {
        project_id: state.projects[0].id,
        kind: f.get("kind"),
        title: f.get("title"),
        spec,
      },
      "intake",
    );
    selected = result.id;
    $("#role").value = "intake";
  });
};
$("#connect").onsubmit = (e) => {
  e.preventDefault();
  run(() => api("/api/connect", Object.fromEntries(new FormData(e.target))));
};
$("#role").onchange = () => run(async () => {});
$("#refresh").onclick = () => run(async () => {});
await run(async () => {});
// Refresh after an approval tab closes or focus returns, without erasing form edits on a timer.
window.addEventListener("focus", () => {
  if (!["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName))
    run(async () => {});
});
