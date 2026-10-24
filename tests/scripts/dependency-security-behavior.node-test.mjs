// Behaviour regressions for the production npm audit remediation (the nine
// package entries cleared together on main). Each test drives the real
// installed vendor package that the application resolves; nothing here mocks
// the package under test. Lockfile floors live in
// dependency-security-overrides.node-test.mjs; these tests show the patched
// behaviour and keep legitimate behaviour as controls.
//
// Inputs that hang, exhaust the stack, or exhaust memory on a vulnerable
// release run in a child process with a heap cap and a timeout, so a
// regression fails the test instead of the runner. Servers listen on
// 127.0.0.1 port 0 and are closed in finally blocks.
//
// PRESTON_DEPS_MODULE_ROOT points the suite at the installed node_modules of
// another checkout (for example a pre-fix tree, to observe the red side). It
// is a test-only switch; the default is this repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const moduleRoot = path.resolve(process.env.PRESTON_DEPS_MODULE_ROOT || repoRoot);
const rootRequire = createRequire(path.join(moduleRoot, "package.json"));

/** A require bound to an installed package, resolving as its own code does. */
function requireBeside(fromRequire, packageName) {
  try {
    return createRequire(fromRequire.resolve(`${packageName}/package.json`));
  } catch {
    // Packages whose "exports" hide package.json: bind to the entry point instead.
    return createRequire(fromRequire.resolve(packageName));
  }
}

/**
 * Run `source` in a fresh Node process with a heap cap and a timeout. The
 * child receives the module root as process.argv[1] and prints one JSON line
 * as the last line of its output.
 */
function runIsolated(source, { timeoutMs = 20_000, heapMb = 192 } = {}) {
  const child = spawnSync(process.execPath, [`--max-old-space-size=${heapMb}`, "-e", source, moduleRoot], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  const lines = (child.stdout || "").trim().split("\n");
  let result = null;
  try {
    result = JSON.parse(lines[lines.length - 1]);
  } catch {
    result = null;
  }
  return {
    result,
    status: child.status,
    signal: child.signal,
    timedOut: child.error?.code === "ETIMEDOUT",
    stderr: (child.stderr || "").slice(-600),
  };
}

function describeChild(run) {
  return `status=${run.status} signal=${run.signal} timedOut=${run.timedOut} stderr=${run.stderr}`;
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await fn(server.address().port);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function getJson(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(JSON.parse(body)));
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// proxy-addr: GHSA-jqcg-44mw-7w3h (IPv4-mapped or zero-leading IPv6 trust subnet)
// ---------------------------------------------------------------------------

test("proxy-addr: express and the SDK express copy resolve the audited proxy-addr", () => {
  const rootProxyAddr = rootRequire.resolve("proxy-addr");
  assert.equal(requireBeside(rootRequire, "express").resolve("proxy-addr"), rootProxyAddr);
  const sdkRequire = createRequire(rootRequire.resolve("@modelcontextprotocol/sdk/package.json"));
  const sdkExpress = createRequire(sdkRequire.resolve("express/package.json"));
  assert.equal(sdkExpress.resolve("proxy-addr"), rootProxyAddr);
});

test("proxy-addr: short-prefix IPv6 trust subnets no longer trust every IPv4 client", () => {
  const { compile } = rootRequire("proxy-addr");
  for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
    for (const trust of [compile(subnet), compile([subnet, "192.0.2.0/24"])]) {
      assert.equal(trust("203.0.113.7", 0), false, `${subnet} trusted 203.0.113.7`);
      assert.equal(trust("::ffff:cb00:7107", 0), false, `${subnet} trusted ::ffff:cb00:7107`);
    }
  }
});

test("proxy-addr: correctly written trust subnets still admit their own block (control)", () => {
  const { compile } = rootRequire("proxy-addr");
  for (const subnet of ["10.0.0.0/8", "::ffff:10.0.0.0/104"]) {
    for (const trust of [compile(subnet), compile([subnet, "192.0.2.0/24"])]) {
      assert.equal(trust("10.1.2.3", 0), true, `${subnet} rejected 10.1.2.3`);
      assert.equal(trust("::ffff:10.1.2.3", 0), true, `${subnet} rejected ::ffff:10.1.2.3`);
      assert.equal(trust("203.0.113.7", 0), false, `${subnet} trusted 203.0.113.7`);
    }
  }
  assert.equal(compile("::/1")("::1", 0), true, "::/1 must still admit native ::1");
});

test("proxy-addr via express: req.ip ignores X-Forwarded-For unless the hop is trusted", async () => {
  const express = rootRequire("express");
  const seen = async (trustProxy) => {
    const app = express();
    if (trustProxy !== undefined) app.set("trust proxy", trustProxy);
    app.get("/", (req, res) => res.json({ ip: req.ip, ips: req.ips }));
    return withServer(app, (port) => getJson(port, { "X-Forwarded-For": "198.51.100.9" }));
  };
  // Controls: the default trusts nothing; loopback trusts this test client.
  assert.deepEqual(await seen(undefined), { ip: "127.0.0.1", ips: [] });
  assert.deepEqual(await seen("loopback"), { ip: "198.51.100.9", ips: ["198.51.100.9"] });
  // Security case: a mapped 10/8 subnet written with a short prefix must not trust 127.0.0.1.
  assert.deepEqual(await seen("::ffff:10.0.0.0/8"), { ip: "127.0.0.1", ips: [] });
});

// ---------------------------------------------------------------------------
// compression: GHSA-vc2v-76pw-4v95 (zlib stream leaked on premature close)
// ---------------------------------------------------------------------------

// Record the real streams that compression creates. The zlib factories are
// non-writable but configurable, so swap the descriptor and restore it after.
function spyOnZlib(factoryName) {
  const descriptor = Object.getOwnPropertyDescriptor(zlib, factoryName);
  const original = descriptor.value;
  const created = [];
  Object.defineProperty(zlib, factoryName, {
    ...descriptor,
    value: function spied(...args) {
      const stream = original.apply(this, args);
      created.push(stream);
      return stream;
    },
  });
  return {
    created,
    restore() {
      Object.defineProperty(zlib, factoryName, descriptor);
    },
  };
}

const ENCODINGS = [
  { encoding: "gzip", factory: "createGzip", decode: zlib.gunzipSync },
  { encoding: "deflate", factory: "createDeflate", decode: zlib.inflateSync },
];

async function abortCompressedResponse({ encoding, factory }, closeBeforeStream) {
  const compression = rootRequire("compression");
  const middleware = compression({ threshold: 0 });
  const spy = spyOnZlib(factory);
  const requestSeen = deferred();
  const streamCreated = deferred();
  const responseClosed = deferred();
  try {
    await withServer(
      (req, res) => {
        res.on("error", () => {});
        res.on("close", () => responseClosed.resolve());
        middleware(req, res, () => {
          res.setHeader("Content-Type", "text/plain");
          if (closeBeforeStream) {
            requestSeen.resolve();
            // Write only after the client is gone, so the stream is created on a closed response.
            responseClosed.promise.then(() => {
              res.write("late body");
              streamCreated.resolve();
            });
          } else {
            res.write("x".repeat(16 * 1024));
            streamCreated.resolve();
            requestSeen.resolve();
          }
        });
      },
      async (port) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/", headers: { "Accept-Encoding": encoding } });
        req.on("error", () => {});
        await withTimeout(requestSeen.promise, 5_000, "request");
        req.destroy();
        await withTimeout(Promise.all([responseClosed.promise, streamCreated.promise]), 5_000, "close");
        await new Promise((resolve) => setImmediate(resolve));
      },
    );
  } finally {
    spy.restore();
  }
  return spy.created;
}

for (const variant of ENCODINGS) {
  for (const closeBeforeStream of [false, true]) {
    const when = closeBeforeStream ? "before" : "after";
    test(`compression: ${variant.encoding} stream is released when the client closes ${when} it is created`, async () => {
      const created = await abortCompressedResponse(variant, closeBeforeStream);
      assert.equal(created.length, 1, `expected one ${variant.factory} stream`);
      const [stream] = created;
      assert.equal(stream.destroyed, true, "compression stream was not destroyed");
      assert.equal(stream._handle ?? null, null, "native zlib handle was not released");
    });
  }

  test(`compression: a finished ${variant.encoding} response decodes to the original body (control)`, async () => {
    const compression = rootRequire("compression");
    const middleware = compression({ threshold: 0 });
    const body = "hello compressed world\n".repeat(200);
    await withServer(
      (req, res) =>
        middleware(req, res, () => {
          res.setHeader("Content-Type", "text/plain");
          res.end(body);
        }),
      async (port) => {
        for (const accept of [variant.encoding, "identity"]) {
          const { headers, raw } = await new Promise((resolve, reject) => {
            http
              .get({ host: "127.0.0.1", port, path: "/", headers: { "Accept-Encoding": accept } }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({ headers: res.headers, raw: Buffer.concat(chunks) }));
              })
              .on("error", reject);
          });
          if (accept === "identity") {
            assert.equal(headers["content-encoding"], undefined);
            assert.equal(raw.toString("utf8"), body);
          } else {
            assert.equal(headers["content-encoding"], variant.encoding);
            assert.equal(variant.decode(raw).toString("utf8"), body);
          }
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// brace-expansion: GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p, GHSA-q2hr-2g5m-vwhr
// ---------------------------------------------------------------------------

// Each production consumer resolves its own nested brace-expansion copy.
const BRACE_CONSUMERS = [
  { label: "readdir-glob > minimatch@5", chain: ["readdir-glob"] },
  { label: "glob > minimatch@9", chain: ["glob"] },
  { label: "minimatch@10", chain: [] },
];

function consumerRequire(chain) {
  let req = rootRequire;
  for (const name of chain) req = requireBeside(req, name);
  return req;
}

function braceExpansionPathFor(chain) {
  return requireBeside(consumerRequire(chain), "minimatch").resolve("brace-expansion");
}

function expandIsolated(chain, buildInput) {
  const bracePath = braceExpansionPathFor(chain);
  const source = `
    const { expand } = require(${JSON.stringify(bracePath)});
    const input = (${buildInput})();
    try {
      const out = expand(input);
      console.log(JSON.stringify({ threw: false, count: out.length, first: String(out[0]).slice(0, 40) }));
    } catch (error) {
      console.log(JSON.stringify({ threw: true, name: error.name, message: String(error.message).slice(0, 200) }));
    }`;
  return runIsolated(source);
}

const BRACE_ATTACKS = [
  {
    id: "GHSA-qhr7-859c-m2p7 nested groups",
    build: `() => "{".repeat(5000) + "a,b" + "}".repeat(5000)`,
  },
  {
    id: "GHSA-6j4f-fj2g-mc7p chained groups in a comma set",
    build: `() => "{" + "{a}".repeat(20000) + ",b}"`,
  },
];

for (const consumer of BRACE_CONSUMERS) {
  for (const attack of BRACE_ATTACKS) {
    test(`brace-expansion (${consumer.label}): ${attack.id} completes without stack exhaustion`, () => {
      const run = expandIsolated(consumer.chain, attack.build);
      assert.ok(run.result, `child produced no result: ${describeChild(run)}`);
      assert.equal(run.result.threw, false, `expand threw ${run.result.name}: ${run.result.message}`);
      assert.ok(run.result.count >= 1);
    });
  }

  test(`brace-expansion (${consumer.label}): GHSA-q2hr-2g5m-vwhr bounds the {a},b} rewrite loop`, () => {
    // Upstream caps restarts at EXPANSION_MAX_REWRITES (1000); past it the
    // remainder stays literal instead of rescanning a growing string.
    const run = expandIsolated(consumer.chain, `() => "{a}" + "}".repeat(1500) + ",z}"`);
    assert.ok(run.result, `child produced no result: ${describeChild(run)}`);
    assert.equal(run.result.threw, false);
    assert.equal(run.result.count, 1, "expected the over-limit rewrite to stay literal");
  });

  test(`brace-expansion (${consumer.label}): ordinary expansion is unchanged (control)`, () => {
    const { expand } = rootRequire(braceExpansionPathFor(consumer.chain));
    assert.deepEqual(expand("{a,b}"), ["a", "b"]);
    assert.deepEqual(expand("{1..3}"), ["1", "2", "3"]);
    assert.deepEqual(expand("x{a,{b,c}}y"), ["xay", "xby", "xcy"]);
    assert.deepEqual(expand("{a},b}"), ["a}", "b"]);
  });

  test(`brace-expansion (${consumer.label}): the consuming minimatch still matches plain globs (control)`, () => {
    const loaded = consumerRequire(consumer.chain)("minimatch");
    const minimatch = typeof loaded === "function" ? loaded : loaded.minimatch;
    assert.equal(minimatch("manual/guide.md", "manual/*.md"), true);
    assert.equal(minimatch("manual/guide.txt", "manual/*.md"), false);
  });
}

test("brace-expansion: minimatch@10 brace patterns expand through the consumer API (control)", () => {
  const { minimatch, braceExpand } = rootRequire("minimatch");
  assert.deepEqual(braceExpand("{a,b}"), ["a", "b"]);
  assert.deepEqual(braceExpand("{1..3}"), ["1", "2", "3"]);
  assert.equal(minimatch("code/a.ts", "code/*.{js,ts}"), true);
  assert.equal(minimatch("code/a.md", "code/*.{js,ts}"), false);
});

// ---------------------------------------------------------------------------
// fast-copy: GHSA-jggr-w7fw-pc2j (unbounded recursion depth)
// ---------------------------------------------------------------------------

function nested(depth) {
  const root = {};
  let node = root;
  for (let i = 0; i < depth; i += 1) {
    node.child = {};
    node = node.child;
  }
  node.leaf = true;
  return root;
}

function isMaxDepthError(error) {
  return error instanceof RangeError && error.name === "MaxDepthExceededError";
}

test("fast-copy: copy and copyStrict stop at the default depth with MaxDepthExceededError", () => {
  const { copy, copyStrict } = rootRequire("fast-copy");
  const deep = nested(1_001);
  assert.throws(() => copy(deep), isMaxDepthError);
  assert.throws(() => copyStrict(deep), isMaxDepthError);
});

test("fast-copy: createCopier honours an explicit maxDepth in both directions", () => {
  const { createCopier } = rootRequire("fast-copy");
  assert.throws(() => createCopier({ maxDepth: 5 })(nested(10)), isMaxDepthError);
  const generous = createCopier({ maxDepth: 1_500 });
  assert.equal(JSON.stringify(generous(nested(1_200))), JSON.stringify(nested(1_200)));
});

test("fast-copy: ordinary nested and circular values copy faithfully (control)", () => {
  const { copy, copyStrict } = rootRequire("fast-copy");
  const value = { a: [1, { b: new Date(0) }], m: new Map([["k", { v: 1 }]]), deep: nested(50) };
  value.self = value;
  for (const fn of [copy, copyStrict]) {
    const out = fn(value);
    assert.notEqual(out, value);
    assert.equal(out.self, out);
    assert.equal(out.a[1].b.getTime(), 0);
    assert.notEqual(out.a[1], value.a[1]);
    assert.equal(out.m.get("k").v, 1);
    assert.equal(JSON.stringify(out.deep), JSON.stringify(value.deep));
  }
});

test("fast-copy: pino-pretty still formats an ordinary log line (control)", () => {
  const { prettyFactory } = rootRequire("pino-pretty");
  const pretty = prettyFactory({ colorize: false });
  const line = pretty({ level: 30, time: 0, msg: "hello audit", pid: 1, hostname: "h", ctx: { a: { b: 1 } } });
  assert.match(line, /INFO/);
  assert.match(line, /hello audit/);
});

// ---------------------------------------------------------------------------
// fast-uri: GHSA-hrr3-gc8f-f4qj (host case after percent-decoding)
// ---------------------------------------------------------------------------

test("fast-uri: scheme-relative percent-encoded host folds to the same lowercase host", () => {
  const { parse, normalize, equal } = rootRequire("fast-uri");
  assert.equal(parse("//%41.com").host, "a.com");
  assert.equal(parse("//A.com").host, "a.com");
  assert.equal(parse("//a.com").host, "a.com");
  assert.equal(normalize("//%41.com"), normalize("//a.com"));
  assert.equal(equal("//%41.com", "//a.com"), true);
  assert.equal(equal("//%41.com", "//A.com"), true);
});

test("fast-uri: scheme-bearing and ordinary relative references are unchanged (control)", () => {
  const { parse, equal, resolve } = rootRequire("fast-uri");
  assert.equal(parse("http://%41.com/x").host, "a.com");
  assert.equal(equal("http://%41.com/", "http://a.com/"), true);
  assert.equal(equal("//a.com", "//b.com"), false);
  const relative = parse("manual/guide.md?x=1");
  assert.equal(relative.host, undefined);
  assert.equal(relative.path, "manual/guide.md");
  assert.equal(resolve("http://a.com/b/c", "../d"), "http://a.com/d");
});

// ---------------------------------------------------------------------------
// ip-address: GHSA-rpw4-54j3-4h4q, GHSA-2vr4-cq9g-pvrc, GHSA-j6r3-76f7-8jcv, GHSA-h3mg-xc3c-68pw
// ---------------------------------------------------------------------------

test("ip-address: isLinkLocal covers the whole fe80::/10 block", () => {
  const { Address6 } = rootRequire("ip-address");
  assert.equal(new Address6("fe81::1").isLinkLocal(), true);
  assert.equal(new Address6("febf:ffff::1").isLinkLocal(), true);
  assert.equal(new Address6("fe80::1").isLinkLocal(), true);
  assert.equal(new Address6("fec0::1").isLinkLocal(), false);
});

test("ip-address: NAT64 local-use 64:ff9b:1::/48 is classified as private", () => {
  const { Address6 } = rootRequire("ip-address");
  for (const candidate of ["64:ff9b:1:7f00:0:100::", "64:ff9b:1::7f00:1"]) {
    assert.equal(new Address6(candidate).isPrivate(), true, `${candidate} not classified as private`);
  }
  assert.equal(new Address6("2001:4860:4860::8888").isPrivate(), false);
});

test("ip-address: subnet membership never crosses address families", () => {
  const { Address4, Address6 } = rootRequire("ip-address");
  assert.equal(new Address6("a00::1").isInSubnet(new Address4("10.0.0.0/8")), false);
  assert.equal(new Address4("32.0.0.1").isInSubnet(new Address6("2000::/3")), false);
  assert.equal(new Address6("a00::1").isHostInSubnet(new Address4("10.0.0.0/8")), false);
  assert.equal(new Address4("32.0.0.1").isHostInSubnet(new Address6("2000::/3")), false);
  // Controls: same-family membership is unchanged.
  assert.equal(new Address4("10.1.2.3").isInSubnet(new Address4("10.0.0.0/8")), true);
  assert.equal(new Address4("11.1.2.3").isInSubnet(new Address4("10.0.0.0/8")), false);
  assert.equal(new Address6("2001:db8::1").isInSubnet(new Address6("2001:db8::/32")), true);
  assert.equal(new Address6("2001:db9::1").isInSubnet(new Address6("2001:db8::/32")), false);
});

test("ip-address: a long invalid string is rejected without an input-sized diagnostic", () => {
  const run = runIsolated(
    `
    const { createRequire } = require("module");
    const path = require("path");
    const { Address6, AddressError } = createRequire(path.join(process.argv[1], "package.json"))("ip-address");
    const input = "!".repeat(1 << 20);
    const valid = Address6.isValid(input);
    try {
      new Address6(input);
      console.log(JSON.stringify({ valid, threw: false }));
    } catch (error) {
      const size = String(error.message || "").length + String(error.parseMessage || "").length;
      console.log(JSON.stringify({ valid, threw: true, isAddressError: error instanceof AddressError, size }));
    }`,
    { heapMb: 96 },
  );
  assert.ok(run.result, `child produced no result: ${describeChild(run)}`);
  assert.equal(run.result.valid, false);
  assert.equal(run.result.threw, true);
  assert.equal(run.result.isAddressError, true);
  assert.ok(run.result.size < 4096, `diagnostic grew with the input: ${run.result.size} chars`);
});

test("ip-address: ordinary IPv4, IPv6 and mapped addresses parse and classify (control)", () => {
  const { Address4, Address6 } = rootRequire("ip-address");
  assert.equal(new Address4("192.0.2.10").correctForm(), "192.0.2.10");
  assert.equal(new Address6("2001:db8:0:0:0:0:0:1").correctForm(), "2001:db8::1");
  assert.equal(new Address6("::ffff:192.0.2.10").is4(), true);
  assert.equal(new Address6("::1").isLoopback(), true);
});

test("ip-address via express-rate-limit: ipKeyGenerator keeps the /64 and IPv4 key policy (control)", () => {
  const erlRequire = requireBeside(rootRequire, "express-rate-limit");
  assert.equal(erlRequire.resolve("ip-address"), rootRequire.resolve("ip-address"));
  const { ipKeyGenerator } = rootRequire("express-rate-limit");
  assert.equal(ipKeyGenerator("2001:db8:1:2:3:4:5:6", 64), "2001:db8:1:2::/64");
  assert.equal(ipKeyGenerator("2001:db8:1:2:ffff::1", 64), "2001:db8:1:2::/64");
  assert.equal(ipKeyGenerator("203.0.113.7", 64), "203.0.113.7");
  assert.equal(ipKeyGenerator("::ffff:203.0.113.7", 64), "203.0.113.7");
});

// ---------------------------------------------------------------------------
// source-map-js: GHSA-68fv-2mgg-jv7q (indexed map section offset)
// ---------------------------------------------------------------------------

test("source-map-js: an indexed map with a huge section offset is rejected up front", () => {
  const run = runIsolated(
    `
    const { createRequire } = require("module");
    const path = require("path");
    const { SourceMapConsumer, SourceNode } = createRequire(path.join(process.argv[1], "package.json"))("source-map-js");
    const inner = { version: 3, sources: ["a.js"], names: [], mappings: "AAAA" };
    const indexed = { version: 3, sections: [{ offset: { line: 20000000, column: 0 }, map: inner }] };
    try {
      const node = SourceNode.fromStringWithSourceMap("x", new SourceMapConsumer(indexed));
      console.log(JSON.stringify({ threw: false, length: node.toString().length }));
    } catch (error) {
      console.log(JSON.stringify({ threw: true, message: String(error.message).slice(0, 200) }));
    }`,
    { heapMb: 128, timeoutMs: 15_000 },
  );
  assert.ok(run.result, `child produced no result: ${describeChild(run)}`);
  assert.equal(run.result.threw, true);
  assert.match(run.result.message, /offset line must not exceed/);
});

test("source-map-js: a normal indexed map still round-trips through SourceNode (control)", () => {
  const { SourceMapConsumer, SourceNode } = rootRequire("source-map-js");
  const code = "first();\nsecond();\n";
  const section = (source, content) => ({ version: 3, sources: [source], sourcesContent: [content], names: [], mappings: "AAAA" });
  const indexed = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: section("a.js", "first();") },
      { offset: { line: 1, column: 0 }, map: section("b.js", "second();") },
    ],
  };
  const consumer = new SourceMapConsumer(indexed);
  assert.deepEqual(consumer.sources, ["a.js", "b.js"]);
  const node = SourceNode.fromStringWithSourceMap(code, new SourceMapConsumer(indexed));
  assert.equal(node.toString(), code);
  const regenerated = node.toStringWithSourceMap({ file: "out.js" }).map.toJSON();
  assert.deepEqual(regenerated.sources, ["a.js", "b.js"]);
  assert.deepEqual(regenerated.sourcesContent, ["first();", "second();"]);
});

// ---------------------------------------------------------------------------
// multer: GHSA-3pph-fpjx-jg34 (orphaned disk write on an aborted upload)
// ---------------------------------------------------------------------------

const BOUNDARY = "preston-audit-boundary";

/**
 * Send a multipart request that never finishes. With `completeFile`, the file
 * part is closed by the next delimiter (its stream ends cleanly) and the
 * request stops inside a later text field; otherwise it stops mid-file.
 */
function startMultipartUpload(port, { completeFile = false } = {}) {
  const req = http.request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/",
    headers: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`, "Transfer-Encoding": "chunked" },
  });
  req.on("error", () => {});
  const fileHead =
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n` +
    "Content-Type: text/plain\r\n\r\n";
  const body = completeFile
    ? `${fileHead}complete file body\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\npartial`
    : `${fileHead}partial file body`;
  req.write(body);
  return { req, bytes: Buffer.byteLength(body) };
}

/** Resolve once the server has read `bytes()` request-body bytes (multer parses them first). */
function trackReceived(req, bytes, onAll) {
  let received = 0;
  req.on("data", (chunk) => {
    received += chunk.length;
    if (received >= bytes()) onAll();
  });
}

async function settle(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("multer: an upload aborted before diskStorage names the file leaves no orphan", async () => {
  const multer = rootRequire("multer");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preston-multer-abort-"));
  const filenameRequested = deferred();
  const allReceived = deferred();
  const middlewareDone = deferred();
  let releaseFilename;
  let sentBytes = Infinity;
  try {
    const storage = multer.diskStorage({
      destination: dir,
      filename: (_req, _file, cb) => {
        releaseFilename = () => cb(null, "upload.bin");
        filenameRequested.resolve();
      },
    });
    // Observe (without altering) when the real disk engine finishes writing.
    const engineFinished = deferred();
    const handleFile = storage._handleFile.bind(storage);
    storage._handleFile = (req, file, cb) =>
      handleFile(req, file, (err, info) => {
        cb(err, info);
        engineFinished.resolve({ err, info });
      });
    const upload = multer({ storage }).single("file");
    await withServer(
      (req, res) => {
        upload(req, res, (err) => {
          middlewareDone.resolve(err);
          if (!res.headersSent) res.end();
        });
        trackReceived(req, () => sentBytes, allReceived.resolve);
      },
      async (port) => {
        const client = startMultipartUpload(port, { completeFile: true });
        sentBytes = client.bytes;
        // Abort only after the whole file part (and its closing delimiter) was parsed.
        await withTimeout(Promise.all([filenameRequested.promise, allReceived.promise]), 5_000, "parsed upload");
        client.req.destroy();
        const err = await withTimeout(middlewareDone.promise, 5_000, "multer completion");
        assert.ok(err, "an aborted upload must reach next(err)");
        // The engine finishes naming and writing the file only after the abort cleanup ran.
        releaseFilename();
        const finished = await withTimeout(engineFinished.promise, 5_000, "disk engine write");
        assert.equal(finished.err ?? null, null, "the complete file part should have been written");
        await settle(() => fs.readdirSync(dir).length === 0, 3_000);
        assert.deepEqual(fs.readdirSync(dir), [], "aborted upload left a file on disk");
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("multer: an aborted memoryStorage upload reports an error and no file (control)", async () => {
  const multer = rootRequire("multer");
  const upload = multer({ storage: multer.memoryStorage() }).single("file");
  const allReceived = deferred();
  const middlewareDone = deferred();
  let sentBytes = Infinity;
  await withServer(
    (req, res) => {
      upload(req, res, (err) => {
        middlewareDone.resolve({ err, file: req.file });
        if (!res.headersSent) res.end();
      });
      trackReceived(req, () => sentBytes, allReceived.resolve);
    },
    async (port) => {
      const client = startMultipartUpload(port);
      sentBytes = client.bytes;
      await withTimeout(allReceived.promise, 5_000, "upload bytes");
      client.req.destroy();
      const { err, file } = await withTimeout(middlewareDone.promise, 5_000, "multer completion");
      assert.ok(err, "an aborted upload must reach next(err)");
      assert.equal(file, undefined);
    },
  );
});

// ---------------------------------------------------------------------------
// @modelcontextprotocol/sdk: GHSA-6qxp-vccf-f47h
// ---------------------------------------------------------------------------
// The application uses only the stdio client, which the advisory lists as not
// affected, and configures no SDK OAuth provider; the floor test holds the
// patched release. This control keeps the exact CommonJS imports working.

test("@modelcontextprotocol/sdk: the stdio client entry points load under CommonJS (control)", () => {
  const { Client } = rootRequire("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = rootRequire("@modelcontextprotocol/sdk/client/stdio.js");
  assert.equal(typeof Client, "function");
  assert.equal(typeof StdioClientTransport, "function");
  const client = new Client({ name: "audit-control", version: "0.0.0" }, { capabilities: {} });
  assert.equal(typeof client.connect, "function");
});
