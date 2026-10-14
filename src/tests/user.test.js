jest.mock('mysql2/promise', () => require('./testUtils.js').createMockMysql());
jest.mock('bcrypt', () => require('./testUtils.js').mockBcrypt);

const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');
const { expectValidJwt } = require('./testUtils.js');

let userCount = 0;

async function registerUser(name) {
  userCount++;
  const user = { name: name ?? `user${userCount}`, email: `user${userCount}@test.com`, password: 'secret' };
  const res = await request(app).post('/api/auth').send(user);
  expect(res.status).toBe(200);
  expectValidJwt(res.body.token);
  return { ...user, id: res.body.user.id, token: res.body.token };
}

async function createAdmin() {
  userCount++;
  const admin = { name: `admin${userCount}`, email: `admin${userCount}@test.com`, password: 'admin' };
  await DB.addUser({ ...admin, roles: [{ role: Role.Admin }] });
  const res = await request(app).put('/api/auth').send(admin);
  expect(res.status).toBe(200);
  return { ...admin, id: res.body.user.id, token: res.body.token };
}

function listUsers(token, query) {
  return request(app).get(`/api/user?${query}`).set('Authorization', `Bearer ${token}`);
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
  expect((await request(app).delete('/api/user/1')).status).toBe(401);
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

test('admin cannot update another user', async () => {
  const admin = await createAdmin();
  const user = await registerUser();

  const res = await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${admin.token}`).send({ name: 'admin renamed', email: user.email });
  expect(res.status).toBe(403);
  expect(res.body.message).toBe('unauthorized');

  const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${user.token}`);
  expect(meRes.body).toMatchObject({ id: user.id, name: user.name, email: user.email });
});

test('admin can delete a user', async () => {
  const admin = await createAdmin();
  const user = await registerUser();

  const res = await request(app).delete(`/api/user/${user.id}`).set('Authorization', `Bearer ${admin.token}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ message: 'user deleted' });

  const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${user.token}`);
  expect(meRes.status).toBe(401);

  const loginRes = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(loginRes.status).toBe(404);
});

test('non-admin cannot delete a user', async () => {
  const user = await registerUser();
  const other = await registerUser();

  const otherRes = await request(app).delete(`/api/user/${other.id}`).set('Authorization', `Bearer ${user.token}`);
  expect(otherRes.status).toBe(403);
  expect(otherRes.body).toEqual({ message: 'unauthorized' });

  const selfRes = await request(app).delete(`/api/user/${user.id}`).set('Authorization', `Bearer ${user.token}`);
  expect(selfRes.status).toBe(403);

  const loginRes = await request(app).put('/api/auth').send({ email: other.email, password: other.password });
  expect(loginRes.status).toBe(200);
});

test('admin cannot delete themselves', async () => {
  const admin = await createAdmin();

  const res = await request(app).delete(`/api/user/${admin.id}`).set('Authorization', `Bearer ${admin.token}`);
  expect(res.status).toBe(403);
  expect(res.body).toEqual({ message: 'admins cannot delete themselves' });

  const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${admin.token}`);
  expect(meRes.status).toBe(200);
});

test('deleting an unknown user fails', async () => {
  const admin = await createAdmin();

  const res = await request(app).delete('/api/user/999999').set('Authorization', `Bearer ${admin.token}`);
  expect(res.status).toBe(404);
  expect(res.body.message).toBe('unknown user');
});

test('list users unauthorized', async () => {
  const listUsersRes = await request(app).get('/api/user');
  expect(listUsersRes.status).toBe(401);
});

test('admin can list a page of users', async () => {
  const admin = await createAdmin();
  const users = [await registerUser('pager a'), await registerUser('pager b'), await registerUser('pager c')];

  const res = await listUsers(admin.token, 'page=1&limit=2&name=pager*');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    users: users.slice(0, 2).map(({ id, name, email }) => ({ id, name, email, roles: [{ role: Role.Diner }] })),
    more: true,
  });
});

test('list users requires the admin role', async () => {
  const user = await registerUser();

  const res = await listUsers(user.token, 'page=1&limit=10&name=*');
  expect(res.status).toBe(403);
  expect(res.body).toEqual({ message: 'unauthorized' });
});

test('next page of users continues after the last user of the previous page', async () => {
  const admin = await createAdmin();
  await registerUser('next a');
  await registerUser('next b');
  await registerUser('next c');

  const firstPage = await listUsers(admin.token, 'page=1&limit=2&name=next*');
  expect(firstPage.body.more).toBe(true);
  const lastName = firstPage.body.users.at(-1).name;
  expect(lastName).toBe('next b');

  const nextPage = await listUsers(admin.token, 'page=2&limit=2&name=next*');
  expect(nextPage.status).toBe(200);
  expect(nextPage.body.more).toBe(false);
  expect(nextPage.body.users.map((u) => u.name)).toEqual(['next c']);
});

