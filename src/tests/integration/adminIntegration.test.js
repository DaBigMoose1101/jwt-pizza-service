const { app, request, Role, randomName, registerUser, createAdmin } = require('./integrationUtils.js');

let admin;

beforeAll(async () => {
  admin = await createAdmin();
});

function listUsers(query) {
  return request(app).get(`/api/user?${query}`).set('Authorization', `Bearer ${admin.token}`);
}

test('admin can page through the list of users', async () => {
  const prefix = `list-${randomName()}`;
  const users = [await registerUser(`${prefix}-a`), await registerUser(`${prefix}-b`), await registerUser(`${prefix}-c`)];
  const expected = users.map(({ id, name, email }) => ({ id, name, email, roles: [{ role: Role.Diner }] }));

  const firstPage = await listUsers(`page=1&limit=2&name=${prefix}*`);
  expect(firstPage.status).toBe(200);
  expect(firstPage.body).toEqual({ users: expected.slice(0, 2), more: true });

  const nextPage = await listUsers(`page=2&limit=2&name=${prefix}*`);
  expect(nextPage.status).toBe(200);
  expect(nextPage.body).toEqual({ users: expected.slice(2), more: false });
});

test('admin can delete a user', async () => {
  const user = await registerUser();

  const deleteRes = await request(app).delete(`/api/user/${user.id}`).set('Authorization', `Bearer ${admin.token}`);
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toEqual({ message: 'user deleted' });

  const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${user.token}`);
  expect(meRes.status).toBe(401);

  const loginRes = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(loginRes.status).toBe(404);
});

test('admin cannot delete themselves', async () => {
  const deleteRes = await request(app).delete(`/api/user/${admin.id}`).set('Authorization', `Bearer ${admin.token}`);
  expect(deleteRes.status).toBe(403);
  expect(deleteRes.body).toEqual({ message: 'admins cannot delete themselves' });

  const loginRes = await request(app).put('/api/auth').send({ email: admin.email, password: admin.password });
  expect(loginRes.status).toBe(200);
});

test('non-admin cannot delete a user', async () => {
  const user = await registerUser();
  const other = await registerUser();

  const deleteRes = await request(app).delete(`/api/user/${other.id}`).set('Authorization', `Bearer ${user.token}`);
  expect(deleteRes.status).toBe(403);

  const loginRes = await request(app).put('/api/auth').send({ email: other.email, password: other.password });
  expect(loginRes.status).toBe(200);
});
