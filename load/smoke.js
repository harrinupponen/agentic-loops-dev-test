import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const PASSWORD = 'correct-horse-battery-staple';

// Thresholds are the gate. If a change makes the hot path slower or error-prone,
// CI goes red — "handles load" stops being an opinion.
export const options = {
  scenarios: {
    smoke: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 20 },
        { duration: '20s', target: 20 },
        { duration: '5s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{endpoint:list}': ['p(95)<200'],
    'http_req_duration{endpoint:create}': ['p(95)<300'],
    'http_req_duration{endpoint:health}': ['p(95)<50'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  const res = http.get(`${BASE}/healthz`);
  if (res.status !== 200) throw new Error(`Target not healthy: ${res.status}`);
}

export default function () {
  const jar = http.cookieJar();
  const email = `load-${randomString(12)}@example.com`;

  const register = http.post(
    `${BASE}/api/auth/register`,
    JSON.stringify({ email, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'register' } },
  );
  check(register, { 'registered': (r) => r.status === 201 });
  if (register.status !== 201) return;

  const create = http.post(
    `${BASE}/api/todos`,
    JSON.stringify({ title: `load test ${randomString(8)}` }),
    { headers: { 'Content-Type': 'application/json' }, jar, tags: { endpoint: 'create' } },
  );
  check(create, { 'created': (r) => r.status === 201 });

  const list = http.get(`${BASE}/api/todos?limit=20`, { jar, tags: { endpoint: 'list' } });
  check(list, { 'listed': (r) => r.status === 200 });

  const health = http.get(`${BASE}/healthz`, { tags: { endpoint: 'health' } });
  check(health, { 'healthy': (r) => r.status === 200 });

  sleep(1);
}
