const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTenantParamHandler, requireTenantMatch } = require('../middleware/tenantMatch');

// Helper to create mock req/res/next
function mockReq(user, params = {}) {
  return { user, params, allowCrossTenant: undefined };
}

function mockRes() {
  let statusCode;
  let body;
  return {
    status(code) { statusCode = code; return this; },
    json(data) { body = data; },
    get statusCode() { return statusCode; },
    get body() { return body; }
  };
}

// ---------- createTenantParamHandler ----------

describe('createTenantParamHandler (router.param handler)', () => {
  const handler = createTenantParamHandler();

  it('blocks cross-tenant access → 403', (_, done) => {
    const req = mockReq({ tenantCode: 'apoyar', userType: 'tenant' });
    const res = mockRes();
    handler(req, res, () => { done(new Error('should not call next')); }, 'other_tenant');
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'Access denied' });
    done();
  });

  it('allows same-tenant access → next()', (_, done) => {
    const req = mockReq({ tenantCode: 'apoyar', userType: 'tenant' });
    const res = mockRes();
    handler(req, res, () => done(), 'apoyar');
  });

  it('master user bypasses → next()', (_, done) => {
    const req = mockReq({ tenantCode: 'master', userType: 'master' });
    const res = mockRes();
    handler(req, res, () => done(), 'any_tenant');
  });

  it('no user (public route) → next()', (_, done) => {
    const req = mockReq(undefined);
    const res = mockRes();
    handler(req, res, () => done(), 'some_tenant');
  });

  it('normalizes param: My-Tenant → my_tenant', (_, done) => {
    const req = mockReq({ tenantCode: 'my_tenant', userType: 'tenant' });
    const res = mockRes();
    handler(req, res, () => done(), 'My-Tenant');
  });

  it('allowCrossTenant override → next()', (_, done) => {
    const req = mockReq({ tenantCode: 'apoyar', userType: 'tenant' });
    req.allowCrossTenant = true;
    const res = mockRes();
    handler(req, res, () => done(), 'other_tenant');
  });

  it('rejects path traversal ../other → 403', (_, done) => {
    const req = mockReq({ tenantCode: 'apoyar', userType: 'tenant' });
    const res = mockRes();
    handler(req, res, () => { done(new Error('should not call next')); }, '../other');
    assert.equal(res.statusCode, 403);
    done();
  });

  it('rejects encoded slash %2F → 403', (_, done) => {
    // Express decodes %2F to / before param reaches handler
    const req = mockReq({ tenantCode: 'apoyar', userType: 'tenant' });
    const res = mockRes();
    handler(req, res, () => { done(new Error('should not call next')); }, 'other/tenant');
    assert.equal(res.statusCode, 403);
    done();
  });

  it('rejects SQL injection attempt → 403', (_, done) => {
    const req = mockReq({ tenantCode: 'apoyar', userType: 'tenant' });
    const res = mockRes();
    handler(req, res, () => { done(new Error('should not call next')); }, "apoyar'; DROP TABLE--");
    assert.equal(res.statusCode, 403);
    done();
  });

  it('empty string normalizes to empty → 403', (_, done) => {
    const req = mockReq({ tenantCode: 'apoyar', userType: 'tenant' });
    const res = mockRes();
    handler(req, res, () => { done(new Error('should not call next')); }, '');
    assert.equal(res.statusCode, 403);
    done();
  });
});

// ---------- requireTenantMatch (regular middleware) ----------

describe('requireTenantMatch (inline middleware)', () => {

  it('blocks cross-tenant access → 403', (_, done) => {
    const req = mockReq({ tenantCode: 'apoyar', userType: 'tenant' }, { tenantCode: 'other_tenant' });
    const res = mockRes();
    requireTenantMatch(req, res, () => { done(new Error('should not call next')); });
    assert.equal(res.statusCode, 403);
    done();
  });

  it('allows same-tenant access → next()', (_, done) => {
    const req = mockReq({ tenantCode: 'apoyar', userType: 'tenant' }, { tenantCode: 'apoyar' });
    const res = mockRes();
    requireTenantMatch(req, res, () => done());
  });

  it('master user bypasses → next()', (_, done) => {
    const req = mockReq({ tenantCode: 'master', userType: 'master' }, { tenantCode: 'any_tenant' });
    const res = mockRes();
    requireTenantMatch(req, res, () => done());
  });

  it('no user → next()', (_, done) => {
    const req = mockReq(undefined, { tenantCode: 'some_tenant' });
    const res = mockRes();
    requireTenantMatch(req, res, () => done());
  });

  it('no tenant param → next()', (_, done) => {
    const req = mockReq({ tenantCode: 'apoyar', userType: 'tenant' }, {});
    const res = mockRes();
    requireTenantMatch(req, res, () => done());
  });

  it('normalizes tenantId param', (_, done) => {
    const req = mockReq({ tenantCode: 'my_tenant', userType: 'tenant' }, { tenantId: 'My-Tenant' });
    const res = mockRes();
    requireTenantMatch(req, res, () => done());
  });

  it('allowCrossTenant override → next()', (_, done) => {
    const req = mockReq({ tenantCode: 'apoyar', userType: 'tenant' }, { tenantCode: 'other_tenant' });
    req.allowCrossTenant = true;
    const res = mockRes();
    requireTenantMatch(req, res, () => done());
  });
});
