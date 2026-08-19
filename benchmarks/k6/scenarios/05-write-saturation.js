/**
 * Scenario 5 — Write Saturation Test
 *
 * Συνεχίζει από το 03-stress.js (30 VUs) και ανεβαίνει μέχρι να βρούμε
 * το saturation point των writes (POST /api/kyc):
 * Vault encrypt + IPFS upload + Fabric invoke.
 *
 * Run:
 *   k6 run -e BASE_URL=https://e-kyc.cloud-ip.cc \
 *           -e USER_PASS=<pass> \
 *           05-write-saturation.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { login, BASE_URL } from '../utils/auth.js';

const submitTrend = new Trend('submit_kyc_ms', true);
const errorRate   = new Rate('error_rate');
const txCounter   = new Counter('successful_txns');

const DUMMY_DOC = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARC' +
  'AABAAEDASIA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwAB/9k=';

export const options = {
  stages: [
    { duration: '30s', target: 30  },  // baseline (ήδη δοκιμασμένο)
    { duration: '60s', target: 50  },
    { duration: '60s', target: 100 },
    { duration: '60s', target: 150 },
    { duration: '60s', target: 200 },
    { duration: '30s', target: 0   },
  ],
  thresholds: {
    error_rate:    ['rate<0.10'],
    submit_kyc_ms: ['p(95)<10000'],
  },
};

export function setup() {
  const token = login('user', __ENV.USER_PASS || 'lzBWBR0t1xUwsKmQ');
  return { token };
}

export default function (data) {
  const did = `did:indy:test:bench${Date.now()}${Math.random().toString(36).slice(2, 7)}`;

  const payload = JSON.stringify({
    did,
    documents: [
      { type: 'passport', fileName: 'passport.jpg', contentBase64: DUMMY_DOC },
      { type: 'selfie',   fileName: 'selfie.jpg',   contentBase64: DUMMY_DOC },
    ],
  });

  const res = http.post(`${BASE_URL}/api/kyc`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.token}`,
    },
  });

  const ok = check(res, { 'submit 201': r => r.status === 201 });
  errorRate.add(!ok);
  submitTrend.add(res.timings.duration);
  if (ok) txCounter.add(1);

  sleep(0.5);
}
