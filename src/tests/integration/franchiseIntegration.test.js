const { app, request, randomName, registerUser, createAdmin } = require('./integrationUtils.js');

let admin;
let franchisee;

beforeAll(async () => {
  admin = await createAdmin();
  franchisee = await registerUser();
});

async function createFranchise(name) {
  const res = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name, admins: [{ email: franchisee.email }] });
  expect(res.status).toBe(200);
  return res.body;
}

function findFranchises(name) {
  return request(app).get(`/api/franchise?name=${name}`);
}

test('admin can create and delete a franchise', async () => {
  const name = `franchise-${randomName()}`;

  const franchise = await createFranchise(name);
  expect(franchise).toMatchObject({ id: expect.any(Number), name, admins: [{ id: franchisee.id, name: franchisee.name, email: franchisee.email }] });

  const listRes = await findFranchises(name);
  expect(listRes.body.franchises).toEqual([expect.objectContaining({ id: franchise.id, name })]);

  const deleteRes = await request(app).delete(`/api/franchise/${franchise.id}`).set('Authorization', `Bearer ${admin.token}`);
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toEqual({ message: 'franchise deleted' });

  const afterDeleteRes = await findFranchises(name);
  expect(afterDeleteRes.body).toEqual({ franchises: [], more: false });
});

test('franchisee can create and delete a store', async () => {
  const name = `franchise-${randomName()}`;
  const franchise = await createFranchise(name);

  const createRes = await request(app).post(`/api/franchise/${franchise.id}/store`).set('Authorization', `Bearer ${franchisee.token}`).send({ name: 'SLC' });
  expect(createRes.status).toBe(200);
  expect(createRes.body).toEqual({ id: expect.any(Number), franchiseId: franchise.id, name: 'SLC' });
  const storeId = createRes.body.id;

  const listRes = await findFranchises(name);
  expect(listRes.body.franchises[0].stores).toEqual([{ id: storeId, name: 'SLC' }]);

  const deleteRes = await request(app).delete(`/api/franchise/${franchise.id}/store/${storeId}`).set('Authorization', `Bearer ${franchisee.token}`);
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toEqual({ message: 'store deleted' });

  const afterDeleteRes = await findFranchises(name);
  expect(afterDeleteRes.body.franchises[0].stores).toEqual([]);

  await request(app).delete(`/api/franchise/${franchise.id}`).set('Authorization', `Bearer ${admin.token}`);
});
