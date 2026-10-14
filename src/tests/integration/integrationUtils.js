// Integration tests run against a real MySQL database. Default to a throwaway test database so they
// never write to the development database. This must run before anything loads config.js.
process.env.DB_NAME ??= 'pizza_test';

const request = require('supertest');
const app = require('../../service');
const { Role, DB } = require('../../database/database.js');
const { expectValidJwt } = require('../testUtils.js');

// The test database persists between runs, so names and emails must be unique per run.
function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

async function registerUser(name = `diner-${randomName()}`) {
  const user = { name, email: `${randomName()}@test.com`, password: 'diner' };
  const res = await request(app).post('/api/auth').send(user);
  expect(res.status).toBe(200);
  expectValidJwt(res.body.token);
  return { ...user, id: res.body.user.id, token: res.body.token };
}

// The register endpoint always assigns the diner role, so admins are created through the DB layer.
async function createAdmin() {
  const admin = { name: `admin-${randomName()}`, email: `${randomName()}@test.com`, password: 'admin' };
  await DB.addUser({ ...admin, roles: [{ role: Role.Admin }] });
  const res = await request(app).put('/api/auth').send({ email: admin.email, password: admin.password });
  expect(res.status).toBe(200);
  expectValidJwt(res.body.token);
  return { ...admin, id: res.body.user.id, token: res.body.token };
}

module.exports = { app, request, Role, expectValidJwt, randomName, registerUser, createAdmin };
