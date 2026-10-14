const { app, request, Role, expectValidJwt, randomName, registerUser } = require('./integrationUtils.js');

test('register a new diner', async () => {
  const user = { name: `diner-${randomName()}`, email: `${randomName()}@test.com`, password: 'diner' };

  const res = await request(app).post('/api/auth').send(user);
  expect(res.status).toBe(200);
  expectValidJwt(res.body.token);
  expect(res.body.user).toEqual({ id: expect.any(Number), name: user.name, email: user.email, roles: [{ role: Role.Diner }] });
});

test('login with a registered user', async () => {
  const user = await registerUser();

  const res = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(res.status).toBe(200);
  expectValidJwt(res.body.token);
  expect(res.body.user).toMatchObject({ id: user.id, name: user.name, email: user.email, roles: [{ role: Role.Diner }] });
});

test('login with the wrong password fails', async () => {
  const user = await registerUser();

  const res = await request(app).put('/api/auth').send({ email: user.email, password: 'wrong' });
  expect(res.status).toBe(404);
  expect(res.body.message).toBe('unknown user');
});

test('logout invalidates the token', async () => {
  const user = await registerUser();

  const logoutRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${user.token}`);
  expect(logoutRes.status).toBe(200);
  expect(logoutRes.body).toEqual({ message: 'logout successful' });

  const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${user.token}`);
  expect(meRes.status).toBe(401);
});

test('user can update their own information', async () => {
  const user = await registerUser();
  const updated = { name: `renamed-${randomName()}`, email: `${randomName()}@test.com`, password: 'newpassword' };

  const res = await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${user.token}`).send(updated);
  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({ id: user.id, name: updated.name, email: updated.email });
  expectValidJwt(res.body.token);

  const newLoginRes = await request(app).put('/api/auth').send({ email: updated.email, password: updated.password });
  expect(newLoginRes.status).toBe(200);

  const oldLoginRes = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(oldLoginRes.status).toBe(404);
});
