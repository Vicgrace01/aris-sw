import http from 'node:http';

const port = Number(process.env.PORT || 3000);
const req = http.request(
  { host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 4000 },
  res => {
    if (res.statusCode === 200) { console.log('healthcheck: ok'); process.exit(0); }
    console.error('healthcheck: status', res.statusCode);
    process.exit(1);
  }
);
req.on('error', e => { console.error('healthcheck: error', e.message); process.exit(1); });
req.on('timeout', () => { req.destroy(); console.error('healthcheck: timeout'); process.exit(1); });
req.end();