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

// Delete user is not implemented yet, so this test is expected to fail. Change test.failing to test once it is.
test.failing('admin can delete a user', async () => {
  const user = await registerUser();

  const deleteRes = await request(app).delete(`/api/user/${user.id}`).set('Authorization', `Bearer ${admin.token}`);
  expect(deleteRes.status).toBe(200);

  const loginRes = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(loginRes.status).toBe(404);
});
