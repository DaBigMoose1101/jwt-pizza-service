jest.mock('mysql2/promise', () => require('./testUtils.js').createMockMysql());
jest.mock('bcrypt', () => require('./testUtils.js').mockBcrypt);

const request = require('supertest');
const app = require('../service');
const version = require('../version.json');

test('root returns a welcome message', async () => {
  const res = await request(app).get('/');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'welcome to JWT Pizza', version: version.version });
});

test('docs list every endpoint', async () => {
  const res = await request(app).get('/api/docs');
  expect(res.status).toBe(200);
  expect(res.body.version).toBe(version.version);
  expect(res.body.endpoints).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'POST', path: '/api/auth' })]));
  expect(res.body.config).toHaveProperty('factory');
});

test('unknown endpoints return 404', async () => {
  const res = await request(app).get('/api/nope');
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ message: 'unknown endpoint' });
});
