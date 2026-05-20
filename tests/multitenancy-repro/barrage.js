// Barrage of concurrent ATCreateUserServer DDP calls against tenant1 + tenant2
// to try to capture the cross-tenant write race with deterministic appName
// attribution in MongoDB profiling.
//
// Runs on the macOS host (Docker Desktop host networking is required so
// localhost:8081/:8082 reach the two Wekan processes that share the
// LinuxKit VM netns).
//
//   node tests/multitenancy-repro/barrage.js

const WebSocket = require('ws');
const crypto = require('crypto');

// Override via env vars to point at non-default endpoints (e.g. distinct
// loopback IPs for the BIND_IP experiment): BARRAGE_T1_URL, BARRAGE_T2_URL.
const TARGETS = [
  { name: 't1', url: process.env.BARRAGE_T1_URL || 'ws://127.0.0.1:8081/websocket' },
  { name: 't2', url: process.env.BARRAGE_T2_URL || 'ws://127.0.0.1:8082/websocket' },
];
const ROUNDS = 8;               // number of parallel registration pairs to fire
const STAGGER_MS = 0;           // 0 = fully parallel; raise to step them
const TIMEOUT_MS = 10000;

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function ddpRegister(target, round) {
  return new Promise((resolve) => {
    const ws = new WebSocket(target.url);
    const username = `BARRAGE-${target.name}-r${round}-${Date.now()}`;
    const email = `${username}@${target.name}.local`;
    const password = `BarPwd_${round}!`;
    const passwordObj = { algorithm: 'sha-256', digest: sha256(password) };
    const methodId = `m${target.name}${round}`;
    const result = { target: target.name, round, username, ts0: Date.now() };
    const timer = setTimeout(() => {
      result.timeout = true;
      try { ws.close(); } catch {}
      resolve(result);
    }, TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(JSON.stringify({ msg: 'connect', version: '1', support: ['1', 'pre2', 'pre1'] }));
    });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.msg === 'connected') {
        // ATCreateUserServer's `options` shape:
        // { username, email, password: SRP_obj, profile: {} }
        ws.send(JSON.stringify({
          msg: 'method', method: 'ATCreateUserServer',
          params: [{ username, email, password: passwordObj, profile: {} }],
          id: methodId,
        }));
      } else if (m.msg === 'result' && m.id === methodId) {
        result.error = m.error && (m.error.reason || m.error.message);
        result.value = m.result;
        result.elapsedMs = Date.now() - result.ts0;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(result);
      }
    });
    ws.on('error', (err) => {
      result.wsError = err.message;
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function main() {
  const tasks = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (const t of TARGETS) {
      const delay = r * STAGGER_MS;
      tasks.push((async () => {
        if (delay) await new Promise(rs => setTimeout(rs, delay));
        return ddpRegister(t, r);
      })());
    }
  }
  const results = await Promise.all(tasks);
  const successes = results.filter(r => !r.error && !r.timeout && !r.wsError);
  const failures = results.filter(r => r.error || r.timeout || r.wsError);
  console.log(`barrage complete: ${successes.length} succeeded, ${failures.length} failed/erred`);
  for (const f of failures.slice(0, 5)) {
    console.log(`  fail: target=${f.target} r=${f.round} err=${f.error || f.wsError || 'timeout'}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
