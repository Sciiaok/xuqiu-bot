#!/usr/bin/env node
// Wraps `next dev` with an auto-managed local Redis lifecycle.
//
// - If something is already listening on 127.0.0.1:6379, reuse it untouched.
// - Otherwise spawn an ephemeral redis-server (no RDB, no AOF) as a child
//   and tear it down when next dev exits or we receive SIGINT/SIGTERM.

import { spawn } from 'node:child_process';
import net from 'node:net';

const REDIS_HOST = '127.0.0.1';
const REDIS_PORT = 6379;
const NEXT_PORT = '3002';

function probePort(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

async function waitForRedis(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(REDIS_HOST, REDIS_PORT)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let ownedRedis = null;
let nextChild = null;
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (nextChild && nextChild.exitCode === null) {
    nextChild.kill('SIGTERM');
  }
  if (ownedRedis && ownedRedis.exitCode === null) {
    ownedRedis.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code ?? 0), 400).unref();
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

(async () => {
  if (await probePort(REDIS_HOST, REDIS_PORT)) {
    console.log(`[dev] Redis already up on ${REDIS_HOST}:${REDIS_PORT}, reusing`);
  } else {
    console.log(`[dev] Starting ephemeral Redis on ${REDIS_HOST}:${REDIS_PORT}…`);
    ownedRedis = spawn(
      'redis-server',
      [
        '--port', String(REDIS_PORT),
        '--bind', REDIS_HOST,
        '--save', '',
        '--appendonly', 'no',
        '--daemonize', 'no',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    ownedRedis.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.error('[dev] `redis-server` not found on PATH. Try `brew install redis`.');
      } else {
        console.error('[dev] redis-server failed to start:', err.message);
      }
      shutdown(1);
    });

    ownedRedis.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Ready to accept connections')) {
        console.log('[dev] Redis ready');
      }
    });
    ownedRedis.stderr.on('data', (chunk) => process.stderr.write(`[redis] ${chunk}`));

    ownedRedis.on('exit', (code, signal) => {
      if (!shuttingDown) {
        console.error(`[dev] redis-server exited unexpectedly (code=${code}, signal=${signal})`);
        shutdown(1);
      }
    });

    if (!(await waitForRedis(5000))) {
      console.error('[dev] Redis did not come up within 5s, aborting');
      shutdown(1);
      return;
    }
  }

  nextChild = spawn('next', ['dev', '-p', NEXT_PORT], {
    stdio: 'inherit',
    env: process.env,
  });

  nextChild.on('error', (err) => {
    console.error('[dev] failed to launch next dev:', err.message);
    shutdown(1);
  });

  nextChild.on('exit', (code, signal) => {
    shutdown(code ?? (signal ? 1 : 0));
  });
})();
