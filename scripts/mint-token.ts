import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';

const role = process.argv[2] ?? 'clinician';
const keyPath = process.env.JWT_PRIVATE_KEY_PATH ?? path.join(process.cwd(), 'dev-keys', 'jwt-private.pem');
if (!fs.existsSync(keyPath)) {
  process.stderr.write('missing dev key. run npm run keys first\n');
  process.exit(1);
}
const privateKey = fs.readFileSync(keyPath);
const profiles: Record<string, Record<string, unknown>> = {
  clinician: {
    sub: 'user-clinician-harbor',
    'cognito:groups': ['clinician'],
    'custom:tenant_id': 'tenant-demo',
    'custom:facility_ids': 'fac-harbor',
  },
  analyst: {
    sub: 'user-analyst-1',
    'cognito:groups': ['analyst'],
    'custom:tenant_id': 'tenant-demo',
  },
  patient: {
    sub: 'user-patient-1001',
    'cognito:groups': ['patient'],
    'custom:tenant_id': 'tenant-demo',
    'custom:patient_id': 'pat-1001',
  },
  partner: {
    sub: 'user-partner-1',
    'cognito:groups': ['partner'],
    'custom:tenant_id': 'tenant-demo',
  },
  auditor: {
    sub: 'user-auditor-1',
    'cognito:groups': ['auditor'],
    'custom:tenant_id': 'tenant-demo',
  },
};
const claims = profiles[role];
if (!claims) {
  process.stderr.write(`unknown role ${role}. use clinician, analyst, patient, partner, or auditor\n`);
  process.exit(1);
}
const token = jwt.sign(claims, privateKey, {
  algorithm: 'RS256',
  expiresIn: '12h',
  issuer: process.env.JWT_ISSUER ?? 'local-dev',
  audience: process.env.JWT_AUDIENCE ?? 'woundcare-api',
});
process.stdout.write(`${token}\n`);
