import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
// Command doubles exercise real scripts and on-disk state without a Docker
// daemon, root privileges, credentials, or production network traffic.
const mock = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.argv[1]), args = process.argv.slice(2), root = process.env.CNP_TEST_DIR;
const file = n => path.join(root, n);
const read = n => fs.existsSync(file(n)) ? fs.readFileSync(file(n), 'utf8') : '';
const live = () => read('live').trim();
const images = () => read('images').trim().split('\\n');
fs.appendFileSync(file('calls'), JSON.stringify({name,args,release:process.env.REALTIME_RELEASE})+'\\n');
const fail = process.env.CNP_FAIL;
if(name === 'git') {
  if(args.includes('rev-parse')) console.log(process.env.CNP_HEAD);
  if(args.includes('status') && fail === 'dirty') console.log(' M source.ts');
} else if(name === 'docker') {
  if(args[0] === 'image') process.exit(images().includes(args.at(-1).split(':').at(-1)) ? 0 : 1);
  if(args[0] === 'build') fs.appendFileSync(file('images'), args[args.indexOf('--tag')+1].split(':').at(-1)+'\\n');
  if(args[0] === 'compose' && args.includes('up')) {
    fs.writeFileSync(file('live'), process.env.REALTIME_RELEASE);
    if(fail === 'up' && live() === process.env.CNP_CANDIDATE) process.exit(1);
  }
  if(args[0] === 'inspect') {
    if(fail === 'health' && live() === process.env.CNP_CANDIDATE) process.exit(1);
    console.log(args.join(' ').includes('NetworkMode') ? 'host' : 'running healthy');
  }
} else if(name === 'ss') {
  console.log('LISTEN 0 128 127.0.0.1:3010 0.0.0.0:*');
  if(fail === 'binding' && live() === process.env.CNP_CANDIDATE) console.log('LISTEN 0 128 0.0.0.0:3010 0.0.0.0:*');
} else if(name === 'curl') {
  const url = args.at(-1);
  if(url === 'https://worker.cloudnexus360.com/' || url === 'http://127.0.0.1:3000/') process.exit(22);
  if(fail === 'recovery' && url.includes('realtime.cloudnexuspilot.com/health')) process.exit(22);
  if(live() === process.env.CNP_CANDIDATE) {
    if(fail === 'tls' && url.includes('realtime.cloudnexuspilot.com/health')) process.exit(22);
    if(fail === 'worker' && url.includes('worker.cloudnexus360.com')) process.exit(22);
  }
  if(args.includes('--write-out')) process.stdout.write(fail === 'origin' && live() === process.env.CNP_CANDIDATE ? '101' : '403');
  if(fail === 'caddy-endpoint') process.exit(22);
} else if(name === 'caddy') {
  const site = path.join(process.env.CADDY_ROOT, 'sites-enabled/realtime.cloudnexuspilot.com.caddy');
  if(fail === 'caddy-validation' && fs.existsSync(site) && !fs.readFileSync(site, 'utf8').includes('OLD FRAGMENT')) process.exit(1);
} else if(name === 'systemctl') {
  const n = Number(read('reloads') || 0) + 1; fs.writeFileSync(file('reloads'), String(n));
  if((fail === 'caddy-reload' && n === 1) || fail === 'caddy-recovery') process.exit(1);
}
`;

function fixture(t, { current = A, previous = B, pending = "", head = C } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pilot-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"), ops = join(repo, "ops/realtime"), stateDir = join(dir, "state"), bin = join(dir, "bin"), caddy = join(dir, "caddy");
  for (const folder of [ops, stateDir, bin, join(repo, "apps/pilot-realtime-api"), join(caddy, "sites-enabled")]) mkdirSync(folder, { recursive: true });
  cpSync(resolve("ops/realtime"), ops, { recursive: true });
  writeFileSync(join(repo, "apps/pilot-realtime-api/.env"), ["NODE_ENV", "CORS_ORIGIN", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "OPENAI_API_KEY", "DEEPGRAM_API_KEY"].map(k => `${k}=test-only`).join("\n"));
  writeFileSync(join(caddy, "Caddyfile"), "# WORKER MUST BE PRESERVED\nimport /etc/caddy/sites-enabled/*\n");
  const site = join(caddy, "sites-enabled/realtime.cloudnexuspilot.com.caddy");
  writeFileSync(site, "# OLD FRAGMENT\n");
  const state = join(stateDir, "releases.env");
  const stateText = (cur, prev, pend) => `CURRENT_RELEASE=${cur}\nPREVIOUS_RELEASE=${prev}\nPENDING_RELEASE=${pend}\n`;
  if (current || pending) writeFileSync(state, stateText(current, previous, pending));
  writeFileSync(join(dir, "images"), [current, previous].filter(Boolean).join("\n") + "\n");
  writeFileSync(join(dir, "live"), pending || current);
  writeFileSync(join(bin, "mock.cjs"), mock, { mode: 0o755 });
  for (const command of ["git", "docker", "ss", "curl", "caddy", "systemctl"]) symlinkSync(join(bin, "mock.cjs"), join(bin, command));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CNP_TEST_DIR: dir, CNP_HEAD: head, CNP_CANDIDATE: head, REALTIME_STATE_DIR: stateDir, CADDY_ROOT: caddy };
  return {
    dir, site, state, caddy, stateText,
    run(script = "deploy-realtime.sh", fail = "") {
      return spawnSync("bash", [join(ops, script), ...(script === "deploy-realtime.sh" ? [head] : [])], { env: { ...env, CNP_FAIL: fail }, encoding: "utf8", timeout: 10_000 });
    },
    live: () => readFileSync(join(dir, "live"), "utf8"),
    saved: () => readFileSync(state, "utf8"),
    calls: () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse),
  };
}
function expectStatus(result, expected) {
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
}

test("successful deploy records candidate and actual last-good release", t => {
  const f = fixture(t); expectStatus(f.run(), 0);
  assert.equal(f.live(), C); assert.equal(f.saved(), f.stateText(C, A, ""));
  const ups = f.calls().filter(c => c.name === "docker" && c.args.includes("up"));
  assert.ok(ups.every(c => c.args.includes("--no-build") && c.args.includes("--no-deps") && c.args.at(-1) === "pilot-realtime-api"));
});
for (const failure of ["up", "health", "tls", "origin", "worker", "binding"]) {
  test(`failed ${failure} restores A and preserves B instead of skipping A`, t => {
    const f = fixture(t); expectStatus(f.run("deploy-realtime.sh", failure), 1);
    assert.equal(f.live(), A); assert.equal(f.saved(), f.stateText(A, B, ""));
  });
}
test("same-SHA retry preserves previous release and reuses its image", t => {
  const f = fixture(t, { head: A }); expectStatus(f.run(), 0);
  assert.equal(f.saved(), f.stateText(A, B, ""));
  assert.ok(!f.calls().some(c => c.name === "docker" && c.args[0] === "build"));
});
test("failed recovery retains pending journal; rollback recovers A without skipping to B", t => {
  const f = fixture(t); expectStatus(f.run("deploy-realtime.sh", "recovery"), 1);
  assert.equal(f.saved(), f.stateText(A, B, C));
  expectStatus(f.run(), 1); // Deploy cannot overwrite unresolved state.
  expectStatus(f.run("rollback-realtime.sh"), 0);
  assert.equal(f.live(), A); assert.equal(f.saved(), f.stateText(A, B, ""));
});
test("normal rollback swaps releases and never builds", t => {
  const f = fixture(t); expectStatus(f.run("rollback-realtime.sh"), 0);
  assert.equal(f.live(), B); assert.equal(f.saved(), f.stateText(B, A, ""));
  assert.ok(!f.calls().some(c => c.args[0] === "build"));
});
test("failed rollback restores the original current release", t => {
  const f = fixture(t, { head: B }); expectStatus(f.run("rollback-realtime.sh", "tls"), 1);
  assert.equal(f.live(), A); assert.equal(f.saved(), f.stateText(A, B, ""));
});
test("first deployment succeeds without inventing previous release", t => {
  const f = fixture(t, { current: "", previous: "" }); expectStatus(f.run(), 0);
  assert.equal(f.saved(), f.stateText(C, "", ""));
});
test("failed first deployment keeps pending state and refuses fictitious rollback", t => {
  const f = fixture(t, { current: "", previous: "" }); expectStatus(f.run("deploy-realtime.sh", "tls"), 1);
  assert.equal(f.saved(), f.stateText("", "", C));
  expectStatus(f.run("rollback-realtime.sh"), 1);
});
test("dirty worktree fails before replacing the container", t => {
  const f = fixture(t); expectStatus(f.run("deploy-realtime.sh", "dirty"), 1);
  assert.equal(f.live(), A); assert.equal(f.saved(), f.stateText(A, B, ""));
});
for (const failure of ["caddy-validation", "caddy-reload", "caddy-endpoint", "caddy-recovery"]) {
  for (const oldFragment of [true, false]) {
    test(`${failure} restores ${oldFragment ? "previous fragment" : "absence of fragment"} and preserves main Caddyfile`, t => {
      const f = fixture(t); if (!oldFragment) rmSync(f.site);
      const main = readFileSync(join(f.caddy, "Caddyfile"), "utf8");
      const result = f.run("install-caddy-site.sh", failure); expectStatus(result, 1);
      assert.equal(readFileSync(join(f.caddy, "Caddyfile"), "utf8"), main);
      if (oldFragment) assert.equal(readFileSync(f.site, "utf8"), "# OLD FRAGMENT\n");
      else assert.equal(existsSync(f.site), false);
      if (failure === "caddy-reload") assert.equal(readFileSync(join(f.dir, "reloads"), "utf8"), "2");
      if (failure === "caddy-recovery") assert.match(result.stderr, /manual recovery required/);
    });
  }
}
test("successful Caddy install preserves worker configuration", t => {
  const f = fixture(t), main = readFileSync(join(f.caddy, "Caddyfile"), "utf8");
  expectStatus(f.run("install-caddy-site.sh"), 0);
  assert.equal(readFileSync(join(f.caddy, "Caddyfile"), "utf8"), main);
  assert.match(readFileSync(f.site, "utf8"), /realtime.cloudnexuspilot.com/);
});
