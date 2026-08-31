import { options as smokeOptions } from './smoke.js';
export { default, setup } from './smoke.js';

// Nightly: sustained load for long enough to surface leaks, pool exhaustion and
// connection churn that a 30-second smoke will never show.
export const options = {
  ...smokeOptions,
  scenarios: {
    soak: {
      executor: 'constant-vus',
      vus: 50,
      duration: '15m',
    },
  },
  thresholds: {
    ...smokeOptions.thresholds,
    http_req_failed: ['rate<0.005'],
  },
};
