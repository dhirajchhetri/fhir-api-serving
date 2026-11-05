import { generateKeyPairSync } from 'crypto';
import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), 'dev-keys');
fs.mkdirSync(dir, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(path.join(dir, 'jwt-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
fs.writeFileSync(path.join(dir, 'jwt-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
process.stdout.write(`wrote ${dir}/jwt-public.pem and jwt-private.pem\n`);
