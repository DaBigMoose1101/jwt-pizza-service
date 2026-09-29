jest.mock('mysql2/promise', () => require('./testUtils.js').createMockMysql());
jest.mock('bcrypt', () => require('./testUtils.js').mockBcrypt);

const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');
const { expectValidJwt } = require('./testUtils.js');

const admin = { name: 'order admin', email: 'orderadmin@test.com', password: 'admin' };
const diner = { name: 'pizza diner', email: 'diner@test.com', password: 'diner' };
const veggie = { title: 'Veggie', description: 'A garden of delight', image: 'pizza1.png', price: 0.0038 };
const factoryJwt = 'eyJpYXQiOjE3MDAwMDAwMDB9.eyJvcmRlciI6InBpenphIn0.c2lnbmF0dXJl';
const reportUrl = 'https://pizza-factory.cs329.click/api/report?id=1';

let adminToken;
let franchiseId;
let storeId;

function mockFactoryResponse(ok, body) {
  global.fetch.mockResolvedValueOnce({ ok, json: async () => body });
}

async function login(user) {
  const res = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(res.status).toBe(200);
  expectValidJwt(res.body.token);
  return res.body.token;
}

beforeAll(async () => {
  jest.spyOn(global, 'fetch').mockImplementation(() => {
    throw new Error('unexpected call to the pizza factory');
  });

  await DB.addUser({ ...admin, roles: [{ role: Role.Admin }] });
  adminToken = await login(admin);

  await request(app).put('/api/order/menu').set('Authorization', `Bearer ${adminToken}`).send(veggie);

  const franchiseRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'pizzaPocket', admins: [{ email: admin.email }] });
  franchiseId = franchiseRes.body.id;

  const storeRes = await request(app).post(`/api/franchise/${franchiseId}/store`).set('Authorization', `Bearer ${adminToken}`).send({ name: 'SLC' });
  storeId = storeRes.body.id;

  await request(app).post('/api/auth').send(diner);
});

afterAll(() => {
  jest.restoreAllMocks();
});

test('user logs in, orders a pizza, and verifies it', async () => {
  const dinerToken = await login(diner);

  const menuRes = await request(app).get('/api/order/menu');
  expect(menuRes.status).toBe(200);
  const pizza = menuRes.body.find((item) => item.title === veggie.title);
  expect(pizza).toMatchObject(veggie);

  mockFactoryResponse(true, { jwt: factoryJwt, reportUrl });
  const orderReq = { franchiseId, storeId, items: [{ menuId: pizza.id, description: pizza.description, price: pizza.price }] };
  const orderRes = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send(orderReq);

  expect(orderRes.status).toBe(200);
  expect(orderRes.body.order).toEqual({ ...orderReq, id: expect.any(Number) });
  expect(orderRes.body.followLinkToEndChaos).toBe(reportUrl);

  // Verify the pizza: the service returns the JWT the factory signed for this order.
  expectValidJwt(orderRes.body.jwt);
  expect(orderRes.body.jwt).toBe(factoryJwt);

  // Verify the factory was asked to make this exact order for this diner.
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [factoryUrl, factoryReq] = global.fetch.mock.calls[0];
  expect(factoryUrl).toMatch(/\/api\/order$/);
  expect(factoryReq.method).toBe('POST');
  expect(factoryReq.headers.authorization).toMatch(/^Bearer /);
  expect(JSON.parse(factoryReq.body)).toEqual({
    diner: { id: expect.any(Number), name: diner.name, email: diner.email },
    order: orderRes.body.order,
  });

  // Verify the order was recorded in the diner's history.
  const historyRes = await request(app).get('/api/order').set('Authorization', `Bearer ${dinerToken}`);
  expect(historyRes.status).toBe(200);
  expect(historyRes.body.page).toBe(1);
  expect(historyRes.body.orders).toEqual([
    {
      id: orderRes.body.order.id,
      franchiseId,
      storeId,
      date: expect.any(String),
      items: [{ id: expect.any(Number), menuId: pizza.id, description: pizza.description, price: pizza.price }],
    },
  ]);

  // Verify the store's revenue reflects the sale.
  const franchiseRes = await request(app).get('/api/franchise?name=pizzaPocket').set('Authorization', `Bearer ${adminToken}`);
  expect(franchiseRes.body.franchises[0].stores).toEqual([{ id: storeId, name: 'SLC', totalRevenue: pizza.price }]);
});

test('order fails when the factory rejects it', async () => {
  const dinerToken = await login(diner);
  mockFactoryResponse(false, { reportUrl });

  const res = await request(app)
    .post('/api/order')
    .set('Authorization', `Bearer ${dinerToken}`)
    .send({ franchiseId, storeId, items: [{ menuId: 1, description: veggie.description, price: veggie.price }] });

  expect(res.status).toBe(500);
  expect(res.body).toEqual({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: reportUrl });
});

test('order with an unknown menu item fails', async () => {
  const dinerToken = await login(diner);

  const res = await request(app)
    .post('/api/order')
    .set('Authorization', `Bearer ${dinerToken}`)
    .send({ franchiseId, storeId, items: [{ menuId: 999, description: 'Mystery', price: 1 }] });

  expect(res.status).toBe(500);
  expect(res.body.message).toBe('No ID found');
});

test('unauthenticated user cannot view or place orders', async () => {
  expect((await request(app).get('/api/order')).status).toBe(401);
  expect((await request(app).post('/api/order').send({})).status).toBe(401);
});

test('admin can add a menu item', async () => {
  const student = { title: 'Student', description: 'No topping, no sauce, just carbs', image: 'pizza9.png', price: 0.0001 };
  const res = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${adminToken}`).send(student);

  expect(res.status).toBe(200);
  expect(res.body).toContainEqual({ ...student, id: expect.any(Number) });
});

test('non-admin cannot add a menu item', async () => {
  const dinerToken = await login(diner);
  const res = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${dinerToken}`).send({ title: 'Hack', description: 'x', image: 'x.png', price: 0 });

  expect(res.status).toBe(403);
  expect(res.body.message).toBe('unable to add menu item');
});
