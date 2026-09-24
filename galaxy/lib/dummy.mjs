// Deterministic fake team data for local development (DUMMY=1). No real data involved.

const PEOPLE = ["asha@example.com", "ben@example.com", "chitra@example.com", "dev@example.com", "esha@example.com"];
const SERVICES = [
  "novopay-platform-banking-origination",
  "novopay-platform-consents",
  "novopay-platform-actor",
  "novopay-platform-batch",
  "novopay-platform-notifications",
  "trustt-platform-term-deposit",
];
const CLASSES = ["Service", "Controller", "Processor", "Repository", "Mapper", "Validator", "Builder", "Config"];
const DOMAINS = ["Consent", "Account", "Deposit", "Payment", "Customer", "Batch", "Notification", "Kyc", "Recon"];
const TYPES = ["file_read", "file_read", "file_edit", "file_write", "command_run", "search"];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function makeDummyWorld() {
  const rand = rng(42);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const fileFor = (svc) => {
    const pkg = svc.split("-").slice(2).join("");
    return `C:\\DDP\\${svc}\\src\\main\\java\\in\\novopay\\${pkg}\\${pick(DOMAINS)}${pick(CLASSES)}.java`;
  };
  const tickets = Array.from({ length: 24 }, (_, i) => `${i % 2 ? "HDP" : "DPB"}-${1000 + i * 37}`);

  // Each person leans on 2 "home" services and a slice of tickets; overlaps create shared context.
  const home = new Map(PEOPLE.map((p, i) => [p, [SERVICES[i % SERVICES.length], SERVICES[(i + 2) % SERVICES.length]]]));
  const sessions = [];
  const obsBySession = new Map();
  const ownerOf = new Map();
  let obsSeq = 0;
  const t0 = Date.now() - 14 * 24 * 3600e3;

  const makeObs = (sessionId, person, ts, ticket) => {
    const svc = rand() < 0.8 ? pick(home.get(person)) : pick(SERVICES);
    return {
      id: `obs_dummy_${++obsSeq}`,
      sessionId,
      type: pick(TYPES),
      title: rand() < 0.15 ? `Working on ${ticket}` : "Tool",
      narrative: rand() < 0.2 ? `Checked ${ticket} acceptance criteria` : "",
      files: [fileFor(svc)],
      timestamp: new Date(ts).toISOString(),
    };
  };

  PEOPLE.forEach((person, pi) => {
    for (let k = 0; k < 6 + pi; k++) {
      const id = `dummy-${pi}-${k}`;
      const ticket = tickets[(pi * 3 + k * 5) % tickets.length];
      const start = t0 + rand() * 13 * 24 * 3600e3;
      const obs = Array.from({ length: 8 + Math.floor(rand() * 20) }, (_, j) => makeObs(id, person, start + j * 60e3, ticket));
      sessions.push({
        id, project: "DDP", status: "completed", startedAt: new Date(start).toISOString(),
        cwd: `C:\\DDP\\${home.get(person)[0]}`,
        firstPrompt: `Fix ${ticket}: ${pick(DOMAINS).toLowerCase()} flow regression`,
        observationCount: obs.length,
      });
      obsBySession.set(id, obs);
      ownerOf.set(id, person);
    }
  });

  // Live simulator: 2 people have an open session and keep touching files.
  const liveIds = [];
  for (const pi of [0, 3]) {
    const person = PEOPLE[pi];
    const id = `dummy-live-${pi}`;
    const ticket = tickets[(pi + 7) % tickets.length];
    sessions.push({ id, project: "DDP", status: "active", startedAt: new Date().toISOString(), cwd: `C:\\DDP\\${home.get(person)[0]}`, firstPrompt: `Live: ${ticket} hotfix`, observationCount: 0 });
    obsBySession.set(id, []);
    ownerOf.set(id, person);
    liveIds.push({ id, person, ticket });
  }

  return {
    sessions, obsBySession, ownerOf,
    tick() {
      const out = [];
      for (const l of liveIds) {
        if (rand() < 0.35) continue;
        // Half the time touch a file someone else owns, to exercise shared-context pulses.
        const o = makeObs(l.id, rand() < 0.5 ? pick(PEOPLE) : l.person, Date.now(), l.ticket);
        obsBySession.get(l.id).push(o);
        sessions.find((s) => s.id === l.id).observationCount++;
        out.push({ sessionId: l.id, obs: o });
      }
      return out;
    },
    activeSessions() { return new Set(liveIds.map((l) => l.id)); },
  };
}
