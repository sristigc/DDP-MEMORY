import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, normalizeFile, serviceOf, ticketRegex, touchedIds, UNKNOWN_PERSON, HUB_ID } from "../lib/model.mjs";
import { parseOwners, OWNER_TAG } from "../lib/source.mjs";
import { makeDummyWorld } from "../lib/dummy.mjs";

const PREFIXES = ["HDP", "DPB", "DDP"];

test("normalizeFile keeps repo files, drops dirs and temp paths", () => {
  const f = normalizeFile("C:\\DDP\\novopay-platform-consents\\src\\main\\java\\in\\novopay\\consents\\service\\ConsentService.java");
  assert.equal(f.service, "novopay-platform-consents");
  assert.equal(f.name, "ConsentService.java");
  assert.equal(f.id, "f:novopay-platform-consents/src/main/java/in/novopay/consents/service/ConsentService.java");
  assert.equal(normalizeFile("C:\\DDP\\novopay-platform-banking-origination\\src\\main\\java"), null);
  assert.equal(normalizeFile("C:\\Users\\x\\scratchpad\\team-pulse.html"), null);
  assert.equal(normalizeFile(undefined), null);
});

test("serviceOf and ticketRegex", () => {
  assert.equal(serviceOf("C:\\DDP\\trustt-platform-term-deposit"), "trustt-platform-term-deposit");
  assert.equal(serviceOf("C:\\DDP"), null);
  const found = "see HDP-10976 and DPB-1975, not SHA-256 or UTF-8".match(ticketRegex(PREFIXES));
  assert.deepEqual(found, ["HDP-10976", "DPB-1975"]);
});

test("files touched by two people become shared and link their globes", () => {
  const file = "C:\\DDP\\novopay-platform-consents\\src\\A.java";
  const sessions = [
    { id: "s1", cwd: "C:\\DDP\\novopay-platform-consents", firstPrompt: "fix HDP-1 please" },
    { id: "s2", cwd: "C:\\DDP", firstPrompt: "refactor" },
  ];
  const obsBySession = new Map([
    ["s1", [{ id: "o1", type: "file_edit", files: [file] }]],
    ["s2", [{ id: "o2", type: "file_read", files: [file], narrative: "check HDP-1" }]],
  ]);
  const ownerOf = new Map([["s1", "a@x.com"], ["s2", "b@x.com"]]);
  const g = buildGraph({ sessions, obsBySession, ownerOf, ticketPrefixes: PREFIXES });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("f:novopay-platform-consents/src/A.java").shared, true);
  assert.equal(byId.get("t:HDP-1").shared, true);
  const bridge = g.links.find((l) => l.type === "shared");
  assert.ok(bridge, "person-person shared link exists");
  assert.equal(bridge.weight >= 2, true);
  assert.equal(g.stats.people, 2);
});

test("DDP hub links every person", () => {
  const sessions = [{ id: "s1" }, { id: "s2" }];
  const g = buildGraph({ sessions, obsBySession: new Map(), ownerOf: new Map([["s1", "a@x.com"], ["s2", "b@x.com"]]), ticketPrefixes: PREFIXES });
  const hub = g.nodes.find((n) => n.id === HUB_ID);
  assert.equal(hub.type, "project");
  assert.deepEqual(g.links.filter((l) => l.type === "member").map((l) => l.source).sort(), ["p:a@x.com", "p:b@x.com"]);
});

test("each person gets direct 'works' threads to their items, one per owner for shared items", () => {
  const f = "C:\\DDP\\novopay-platform-actor\\X.java";
  const obsBySession = new Map([["s1", [{ id: "o1", type: "file_edit", files: [f] }]], ["s2", [{ id: "o2", type: "file_read", files: [f] }]]]);
  const g = buildGraph({ sessions: [{ id: "s1" }, { id: "s2" }], obsBySession, ownerOf: new Map([["s1", "a@x.com"], ["s2", "b@x.com"]]), ticketPrefixes: PREFIXES });
  const works = g.links.filter((l) => l.type === "works" && l.target === "f:novopay-platform-actor/X.java");
  assert.deepEqual(works.map((l) => l.source).sort(), ["p:a@x.com", "p:b@x.com"]);
});

test("sessions without an owner go to the unassigned globe", () => {
  const g = buildGraph({ sessions: [{ id: "s1", cwd: "" }], obsBySession: new Map(), ownerOf: new Map(), ticketPrefixes: PREFIXES });
  assert.ok(g.nodes.some((n) => n.id === `p:${UNKNOWN_PERSON}`));
});

test("private files are capped per person, shared files are kept", () => {
  const obs = Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, type: "file_read", files: [`C:\\DDP\\novopay-platform-actor\\F${i}.java`] }));
  const g = buildGraph({ sessions: [{ id: "s1" }], obsBySession: new Map([["s1", obs]]), ownerOf: new Map([["s1", "a@x.com"]]), ticketPrefixes: PREFIXES, maxFilesPerPerson: 3 });
  assert.equal(g.stats.files, 3);
  assert.ok(!g.links.some((l) => l.target.startsWith("f:") && !g.nodes.find((n) => n.id === l.target)), "no dangling links");
});

test("parseOwners reads galaxy owner memories and ignores others", () => {
  const owners = parseOwners([
    { content: `${OWNER_TAG} {"sessionId":"s1","person":"A@X.com"}` },
    { content: "unrelated memory" },
    { content: `${OWNER_TAG} not-json` },
  ]);
  assert.equal(owners.get("s1"), "a@x.com");
  assert.equal(owners.size, 1);
});

test("touchedIds maps an observation to graph node ids", () => {
  const t = touchedIds({ files: ["C:\\DDP\\novopay-platform-batch\\Job.java"], narrative: "DPB-7" }, "s9", PREFIXES);
  assert.equal(t.sessionNode, "x:s9");
  assert.deepEqual(t.ids.sort(), ["f:novopay-platform-batch/Job.java", "s:novopay-platform-batch", "t:DPB-7"].sort());
});

test("dummy world produces 5 people with shared context", () => {
  const w = makeDummyWorld();
  const g = buildGraph({ ...w, activeSessions: w.activeSessions(), ticketPrefixes: PREFIXES });
  assert.equal(g.stats.people, 5);
  assert.ok(g.stats.sharedNodes > 5);
  assert.ok(g.nodes.filter((n) => n.type === "person" && n.active).length === 2);
  assert.ok(w.tick().length >= 0);
});
