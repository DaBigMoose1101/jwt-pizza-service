jest.mock('mysql2/promise', () => require('./testUtils.js').createMockMysql());
jest.mock('bcrypt', () => require('./testUtils.js').mockBcrypt);

const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');
const { expectValidJwt } = require('./testUtils.js');

const admin = { name: 'admin2', email: 'admin2@test.com', password: 'admin2' };

async function login(user) {
  const res = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(res.status).toBe(200);
  expectValidJwt(res.body.token);
  return res.body.token;
}

async function registerDiner(name) {
  const diner = { name, email: `${name}@test.com`, password: 'diner' };
  const res = await request(app).post('/api/auth').send(diner);
  expect(res.status).toBe(200);
  return { ...diner, id: res.body.user.id, token: res.body.token };
}

// The register endpoint always assigns the diner role, so admins are created through the DB layer.
test('register a new admin user', async () => {
  const user = await DB.addUser({ ...admin, roles: [{ role: Role.Admin }] });

  expect(user).toMatchObject({ name: admin.name, email: admin.email, roles: [{ role: Role.Admin }] });
  expect(user.id).toEqual(expect.any(Number));
  expect(user.password).toBeUndefined();
});

test('admin logs in, creates franchise1, and deletes it', async () => {
  const loginRes = await request(app).put('/api/auth').send({ email: admin.email, password: admin.password });
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);
  expect(loginRes.body.user).toMatchObject({ name: admin.name, email: admin.email, roles: [{ role: Role.Admin }] });
  const adminToken = loginRes.body.token;

  const createRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'franchise1', admins: [{ email: admin.email }] });
  expect(createRes.status).toBe(200);
  expect(createRes.body).toMatchObject({ name: 'franchise1', admins: [{ email: admin.email, name: admin.name }] });
  const franchiseId = createRes.body.id;

  const listRes = await request(app).get('/api/franchise?name=franchise1');
  expect(listRes.body.franchises).toEqual([expect.objectContaining({ id: franchiseId, name: 'franchise1' })]);

  const deleteRes = await request(app).delete(`/api/franchise/${franchiseId}`).set('Authorization', `Bearer ${adminToken}`);
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toEqual({ message: 'franchise deleted' });

  const afterDeleteRes = await request(app).get('/api/franchise?name=franchise1');
  expect(afterDeleteRes.body).toEqual({ franchises: [], more: false });
});

describe('franchise and store routes', () => {
  let adminToken;
  let franchisee;
  let franchiseId;

  beforeAll(async () => {
    adminToken = await login(admin);
    franchisee = await registerDiner('franchisee');

    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'pizzaPocket', admins: [{ email: franchisee.email }] });
    franchiseId = res.body.id;
  });

  test('non-admin cannot create a franchise', async () => {
    const diner = await registerDiner('notadmin');
    const res = await request(app).post('/api/franchise').set('Authorization', `Bearer ${diner.token}`).send({ name: 'nope', admins: [] });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('unable to create a franchise');
  });

  test('unauthenticated user cannot create a franchise', async () => {
    const res = await request(app).post('/api/franchise').send({ name: 'nope', admins: [] });
    expect(res.status).toBe(401);
  });

  test('creating a franchise with an unknown admin fails', async () => {
    const res = await request(app)
      .post('/api/franchise')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'ghost', admins: [{ email: 'nobody@test.com' }] });
    expect(res.status).toBe(404);
  });

  test('admin sees franchise admins and stores in the franchise list', async () => {
    const res = await request(app).get('/api/franchise?name=pizza*').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.franchises).toEqual([
      {
        id: franchiseId,
        name: 'pizzaPocket',
        admins: [{ id: franchisee.id, name: franchisee.name, email: franchisee.email }],
        stores: [],
      },
    ]);
  });

  test('franchisee can list their own franchises', async () => {
    const res = await request(app).get(`/api/franchise/${franchisee.id}`).set('Authorization', `Bearer ${franchisee.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ id: franchiseId, name: 'pizzaPocket' })]);
  });

  test("user cannot list someone else's franchises", async () => {
    const other = await registerDiner('snoop');
    const res = await request(app).get(`/api/franchise/${franchisee.id}`).set('Authorization', `Bearer ${other.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('user with no franchises gets an empty list', async () => {
    const res = await request(app).get(`/api/franchise/${franchisee.id + 100}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.body).toEqual([]);
  });

  test('adding a franchisee user links them to an existing franchise', async () => {
    const user = await DB.addUser({ name: 'co-owner', email: 'coowner@test.com', password: 'pw', roles: [{ role: Role.Franchisee, object: 'pizzaPocket' }] });

    const res = await request(app).get(`/api/franchise/${user.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.body).toEqual([expect.objectContaining({ id: franchiseId, name: 'pizzaPocket' })]);
  });

  test('franchisee can create and delete a store', async () => {
    const createRes = await request(app).post(`/api/franchise/${franchiseId}/store`).set('Authorization', `Bearer ${franchisee.token}`).send({ name: 'SLC' });
    expect(createRes.status).toBe(200);
    expect(createRes.body).toEqual({ id: expect.any(Number), franchiseId, name: 'SLC' });
    const storeId = createRes.body.id;

    const listRes = await request(app).get('/api/franchise?name=pizzaPocket');
    expect(listRes.body.franchises[0].stores).toEqual([{ id: storeId, name: 'SLC' }]);

    const deleteRes = await request(app).delete(`/api/franchise/${franchiseId}/store/${storeId}`).set('Authorization', `Bearer ${franchisee.token}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ message: 'store deleted' });

    const afterDeleteRes = await request(app).get('/api/franchise?name=pizzaPocket');
    expect(afterDeleteRes.body.franchises[0].stores).toEqual([]);
  });

  test('non-owner cannot create or delete a store', async () => {
    const diner = await registerDiner('stranger');

    const createRes = await request(app).post(`/api/franchise/${franchiseId}/store`).set('Authorization', `Bearer ${diner.token}`).send({ name: 'Provo' });
    expect(createRes.status).toBe(403);

    const deleteRes = await request(app).delete(`/api/franchise/${franchiseId}/store/1`).set('Authorization', `Bearer ${diner.token}`);
    expect(deleteRes.status).toBe(403);
  });
});
