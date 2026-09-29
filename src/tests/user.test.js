jest.mock('mysql2/promise', () => require('./testUtils.js').createMockMysql());
jest.mock('bcrypt', () => require('./testUtils.js').mockBcrypt);

const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');
const { expectValidJwt } = require('./testUtils.js');

let userCount = 0;

async function registerUser() {
  userCount++;
  const user = { name: `user${userCount}`, email: `user${userCount}@test.com`, password: 'secret' };
  const res = await request(app).post('/api/auth').send(user);
  expect(res.status).toBe(200);
  expectValidJwt(res.body.token);
  return { ...user, id: res.body.user.id, token: res.body.token };
}

test('register requires name, email, and password', async () => {
  const res = await request(app).post('/api/auth').send({ email: 'incomplete@test.com' });
  expect(res.status).toBe(400);
  expect(res.body.message).toBe('name, email, and password are required');
});

test('register creates a diner', async () => {
  const res = await request(app).post('/api/auth').send({ name: 'new diner', email: 'newdiner@test.com', password: 'pw' });
  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({ name: 'new diner', email: 'newdiner@test.com', roles: [{ role: Role.Diner }] });
  expect(res.body.user.password).toBeUndefined();
});

test('login with the wrong password fails', async () => {
  const user = await registerUser();
  const res = await request(app).put('/api/auth').send({ email: user.email, password: 'wrong' });
  expect(res.status).toBe(404);
  expect(res.body.message).toBe('unknown user');
});

test('get the authenticated user', async () => {
  const user = await registerUser();
  const res = await request(app).get('/api/user/me').set('Authorization', `Bearer ${user.token}`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ id: user.id, name: user.name, email: user.email, roles: [{ role: Role.Diner }] });
});

test('requests without a valid token are unauthorized', async () => {
  expect((await request(app).get('/api/user/me')).status).toBe(401);
  expect((await request(app).get('/api/user/me').set('Authorization', 'Bearer not.a.token')).status).toBe(401);
});

test('tampered token is rejected', async () => {
  const user = await registerUser();
  const [header, , signature] = user.token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ id: user.id, roles: [{ role: Role.Admin }] })).toString('base64url');

  const res = await request(app).get('/api/user/me').set('Authorization', `Bearer ${header}.${forgedPayload}.${signature}`);
  expect(res.status).toBe(401);
});

test('logout invalidates the token', async () => {
  const user = await registerUser();

  const logoutRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${user.token}`);
  expect(logoutRes.status).toBe(200);
  expect(logoutRes.body).toEqual({ message: 'logout successful' });

  const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${user.token}`);
  expect(meRes.status).toBe(401);
});

test('user can update themselves', async () => {
  const user = await registerUser();
  const updated = { name: 'renamed', email: 'renamed@test.com', password: 'newsecret' };

  const res = await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${user.token}`).send(updated);
  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({ id: user.id, name: updated.name, email: updated.email });
  expectValidJwt(res.body.token);

  const loginRes = await request(app).put('/api/auth').send({ email: updated.email, password: updated.password });
  expect(loginRes.status).toBe(200);
});

test('user cannot update someone else', async () => {
  const user = await registerUser();
  const other = await registerUser();

  const res = await request(app).put(`/api/user/${other.id}`).set('Authorization', `Bearer ${user.token}`).send({ name: 'hacked' });
  expect(res.status).toBe(403);
  expect(res.body.message).toBe('unauthorized');
});

test('admin can update another user', async () => {
  const admin = { name: 'user admin', email: 'useradmin@test.com', password: 'admin' };
  await DB.addUser({ ...admin, roles: [{ role: Role.Admin }] });
  const adminToken = (await request(app).put('/api/auth').send(admin)).body.token;
  const user = await registerUser();

  const res = await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${adminToken}`).send({ name: 'admin renamed', email: user.email });
  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({ id: user.id, name: 'admin renamed', email: user.email });
});

test('list and delete users are not implemented yet', async () => {
  const user = await registerUser();

  const listRes = await request(app).get('/api/user').set('Authorization', `Bearer ${user.token}`);
  expect(listRes.body).toEqual({ message: 'not implemented', users: [], more: false });

  const deleteRes = await request(app).delete(`/api/user/${user.id}`).set('Authorization', `Bearer ${user.token}`);
  expect(deleteRes.body).toEqual({ message: 'not implemented' });
});
