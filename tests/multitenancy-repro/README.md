# Reproducing the uws + changeStreams multitenancy bug

Self-contained reproduction recipe for the cross-tenant data leakage
documented in [`docs/Platforms/FOSS/Docker/Meteor3/multitenancy.md`](../../docs/Platforms/FOSS/Docker/Meteor3/multitenancy.md)
and worked around by commit
[`7b88f4c21`](https://github.com/wekan/wekan/commit/7b88f4c21a05810966e49833b393f4bd02d70d47)
("Use only oplog sockjs so that multitenancy works"). Read end-to-end
and you should be able to reproduce on a fresh checkout with no prior
context.

## What this reproduces

When **two Wekan processes** run on the **same host kernel network
namespace** (`network_mode: "host"`), both with `DDP_TRANSPORT=uws` +
`METEOR_REACTIVITY_ORDER=changeStreams,oplog,polling`, and both
connected to the same MongoDB server (even with distinct logical
databases), a browser request hitting tenant A gets **processed by
tenant B's process** ~50% of the time. The write lands in tenant B's
database; reactive data published by tenant B reaches tenant A's
browser.

In production with multiple customer domains behind a reverse proxy
the visible symptom is "reload `boards.wekan.team`, see
`customer2.com`'s data". In this local repro we observe the cleaner
internal form: a registration submitted to `localhost:8081` writes
its user into `wekan_tenant2.users` (and vice versa).

**Where the bug actually lives**: it is not in Wekan code. It is two
interacting issues in Meteor 3.5-beta.10's `packages/ddp-server/`
transport layer. The full technical writeup, root cause analysis, and
the fix are in the Meteor source tree at
[`/Users/italojose/dev/meteor-dev/meteor-source/packages/ddp-server/MULTITENANCY-BUG.md`](../../../meteor-source/packages/ddp-server/MULTITENANCY-BUG.md)
on branch `fix/uws-transport-settings-and-port-collision`.

## Prerequisites

### macOS — enable Docker Desktop host networking

`network_mode: "host"` on Docker Desktop for Mac falls back to a no-op
unless host networking is explicitly enabled. Without it the macOS
host cannot hit container ports on `localhost`.

1. Docker Desktop → **Settings** → **Resources** → **Network**
2. Enable **"Enable host networking"** (in some Docker Desktop
   versions it lives under **Features in development** → **Beta
   features**)
3. Apply & Restart Docker Desktop

Verify after restart — the `host` driver must be present:

```sh
docker info | grep -i "Network:"
# Expect: " Network: bridge host ipvlan macvlan null overlay"
```

Linux hosts have host networking out of the box.

### Node + `ws` on the host

```sh
node --version                       # 18+ (tested with 25.9.0)
ls node_modules/ws/package.json      # ships with Wekan's package-lock
```

### No port conflicts

The repro binds `127.0.0.1:8081`, `127.0.0.1:8082`, and
`127.0.0.1:27018` in the VM's host netns. If you already have
something on those ports (another local `mongod` on 27018, dev
servers on 8081/8082), stop it or edit
`docker-compose.multitenancy.yml` to pick different ports.

```sh
lsof -nP -iTCP:27018 -sTCP:LISTEN
lsof -nP -iTCP:8081  -sTCP:LISTEN
lsof -nP -iTCP:8082  -sTCP:LISTEN
# Expect: no output for each
```

The canonical wekan stack (`docker-compose.yml`) binds `127.0.0.1:27017`
and `0.0.0.0:80`, neither of which conflict with this repro — you can
leave it running.

## Run

### 1. Bring up the two-tenant stack

```sh
docker compose -f docker-compose.multitenancy.yml up -d
```

This boots three containers in shared host netns:

- `wekan-db-mt` — MongoDB 7 replica set `rs0` on `127.0.0.1:27018`
- `wekan-tenant1` — Wekan on port 8081, MongoDB database `wekan_tenant1`
- `wekan-tenant2` — Wekan on port 8082, MongoDB database `wekan_tenant2`

Both Wekan instances have `DDP_TRANSPORT=uws` and
`METEOR_REACTIVITY_ORDER=changeStreams,oplog,polling` set explicitly,
and each `MONGO_URL` carries `appName=wekan-tenantN` so MongoDB
profile attribution is unambiguous in the verification step below.

Wait for both Wekan instances to serve HTTP 200 (Meteor startup takes
30–60 s on first boot):

```sh
until curl -sS -o /dev/null -w "%{http_code}" http://localhost:8081/ \
  | grep -qE "200|302"; do sleep 2; done
until curl -sS -o /dev/null -w "%{http_code}" http://localhost:8082/ \
  | grep -qE "200|302"; do sleep 2; done
echo ready
```

### 2. Verify the precondition state

This is what makes the run trustworthy. The smoking gun is in
`/proc/net/tcp`:

```sh
docker exec wekan-tenant1 sh -c \
  'cat /proc/1/net/tcp | awk "NR>1 && \$4==\"0A\" {print \$2}"' \
  | sort | uniq -c
```

You want to see, among other listeners, this row:

```
2 0100007F:1389    # 127.0.0.1:5001 — uWS internal proxy port,
                   # TWO listeners (one per Meteor process) sharing
                   # via SO_REUSEPORT. This is THE bug.
```

`0x1F91` (8081) and `0x1F92` (8082) each have exactly one listener,
as expected. The "2" on `0x1389` (5001) is what makes the kernel
mis-route inbound WebSocket upgrades between the two processes.

### 3. Trigger the bug

The `run-experiment.sh` helper drops both tenant DBs, enables Mongo
profile level 2, restarts the tenants, waits for them to come back
up, runs `barrage.js`, and reports per-round leak counts. Default 3
rounds × 16 concurrent registrations each.

```sh
tests/multitenancy-repro/run-experiment.sh "REPRO" 3 27018
```

`barrage.js` opens 16 concurrent WebSocket connections — 8 to
`ws://127.0.0.1:8081/websocket`, 8 to `:8082` — and on each one sends
a DDP `method` frame calling Wekan's `ATCreateUserServer` with a
username that encodes its intended target tenant
(`BARRAGE-t1-rN-…` for connections to 8081, `BARRAGE-t2-rN-…` for
8082).

### 4. Verify the bug fired

Each round's output looks like:

```
===================== REPRO round 1/3 =====================
  fail: target=t1 r=2 err=Internal server error
  tenant1 DB: 11 users  (t1-named=5 correct, t2-named=6 LEAK)
  tenant2 DB: 5 users   (t2-named=2 correct, t1-named=3 LEAK)
  LEAKS this round: 9 / 16
```

The "Internal server error" lines are expected and are themselves
part of the bug — the registration write actually succeeds, but the
follow-up profile setup fails because the receiving process is the
wrong one. The interesting number is the per-round LEAKS count:
~50 % across rounds.

The Mongo profile attribution confirms the routing direction. Each
insert was issued by the MongoClient whose `appName` matches the
process — but the username payload was destined for the other:

```sh
docker exec wekan-db-mt mongosh --quiet --host 127.0.0.1 --port 27018 \
  --eval '
const t1 = db.getSiblingDB("wekan_tenant1");
const t2 = db.getSiblingDB("wekan_tenant2");
print("LEAKS in tenant1: " +
  t1.users.find({username: /^BARRAGE-t2-/}, {username:1}).toArray()
    .map(u => u.username).join(", "));
print("LEAKS in tenant2: " +
  t2.users.find({username: /^BARRAGE-t1-/}, {username:1}).toArray()
    .map(u => u.username).join(", "));
'
```

The bug is **non-deterministic** — concurrent traffic is required to
fire the race. A single sequential registration on a warm system can
pass cleanly. If a round shows 0 leaks, drop the DBs and try again;
3 rounds × 16 calls reliably surfaces the bug at the
~50 % expected rate.

### 5. Tear down

```sh
docker compose -f docker-compose.multitenancy.yml down -v
```

`-v` removes the named volumes so the next run starts from empty
databases.

## Files in this directory

- `README.md` — this file.
- `barrage.js` — 16-call concurrent registration trigger over raw WS.
  Uses `simpleddp`'s underlying `ws` package; reads
  `BARRAGE_T1_URL` / `BARRAGE_T2_URL` env overrides if set.
- `run-experiment.sh` — round runner: drops DBs, restarts tenants,
  waits for HTTP, runs `barrage.js`, reports leak counts.
- `../../docker-compose.multitenancy.yml` — the two-tenant stack the
  experiment runs against.

## Fix

The bug is in Meteor 3.5-beta.10, not in Wekan. The fix lives in the
Meteor source tree on branch
`fix/uws-transport-settings-and-port-collision`, with the full bug
writeup at
[`/Users/italojose/dev/meteor-dev/meteor-source/packages/ddp-server/MULTITENANCY-BUG.md`](../../../meteor-source/packages/ddp-server/MULTITENANCY-BUG.md).

Once that lands upstream in a 3.5 release, Wekan can revert commit
`7b88f4c21` and re-enable `DDP_TRANSPORT=uws` +
`METEOR_REACTIVITY_ORDER=changeStreams,oplog,polling` as the
defaults — provided operators running multiple instances in a shared
kernel netns also configure a distinct
`Meteor.settings.packages["ddp-server"].uws.port` per process.
