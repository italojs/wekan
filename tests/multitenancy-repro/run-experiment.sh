#!/bin/sh
# Runs N barrage rounds and reports leak counts for the currently-running
# multitenancy stack. Each round: drop DBs, restart tenants, wait until
# both tenants serve HTTP, run barrage, count "BARRAGE-tX-..." users
# that landed in the wrong DB.
#
#   tests/multitenancy-repro/run-experiment.sh <label> <rounds> [mongo_port] [barrage_runner]
#
# mongo_port defaults to 27018 (host-mode compose). Bridge-mode compose
# uses 27017 inside the wekan-db-mt container.
# barrage_runner defaults to "node tests/multitenancy-repro/barrage.js"
# (runs on the macOS host). Pass an alternative for the in-VM variant.

set -e
LABEL="${1:-experiment}"
ROUNDS="${2:-3}"
MONGO_PORT="${3:-27018}"
BARRAGE_CMD="${4:-node tests/multitenancy-repro/barrage.js}"

for r in $(seq 1 "$ROUNDS"); do
  echo "===================== ${LABEL} round ${r}/${ROUNDS} ====================="
  docker exec wekan-db-mt mongosh --quiet --host 127.0.0.1 --port "$MONGO_PORT" --eval '
    db.getSiblingDB("wekan_tenant1").dropDatabase();
    db.getSiblingDB("wekan_tenant2").dropDatabase();
    db.getSiblingDB("wekan_tenant1").setProfilingLevel(2);
    db.getSiblingDB("wekan_tenant2").setProfilingLevel(2);
  ' >/dev/null
  docker restart wekan-tenant1 wekan-tenant2 >/dev/null

  # Readiness from inside the VM netns so it works regardless of BIND_IP / host-mode quirks.
  T1_HTTP="${BARRAGE_T1_HTTP:-http://127.0.0.1:8081/}"
  T2_HTTP="${BARRAGE_T2_HTTP:-http://127.0.0.1:8082/}"
  until docker run --rm --network host alpine:3 sh -c \
    "wget -q -O /dev/null -T 3 '$T1_HTTP' && wget -q -O /dev/null -T 3 '$T2_HTTP'" \
    >/dev/null 2>&1; do sleep 2; done

  sh -c "$BARRAGE_CMD" 2>&1 | tail -1

  docker exec wekan-db-mt mongosh --quiet --host 127.0.0.1 --port "$MONGO_PORT" --eval '
    const t1 = db.getSiblingDB("wekan_tenant1");
    const t2 = db.getSiblingDB("wekan_tenant2");
    const u1 = t1.users.find({}, {username:1}).toArray();
    const u2 = t2.users.find({}, {username:1}).toArray();
    const t1_t1 = u1.filter(u=>u.username && u.username.startsWith("BARRAGE-t1-")).length;
    const t1_t2 = u1.filter(u=>u.username && u.username.startsWith("BARRAGE-t2-")).length;
    const t2_t1 = u2.filter(u=>u.username && u.username.startsWith("BARRAGE-t1-")).length;
    const t2_t2 = u2.filter(u=>u.username && u.username.startsWith("BARRAGE-t2-")).length;
    print("  tenant1 DB: " + u1.length + " users  (t1-named=" + t1_t1 + " correct, t2-named=" + t1_t2 + " LEAK)");
    print("  tenant2 DB: " + u2.length + " users  (t2-named=" + t2_t2 + " correct, t1-named=" + t2_t1 + " LEAK)");
    print("  LEAKS this round: " + (t1_t2 + t2_t1) + " / 16");
  '
done
