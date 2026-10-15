import { createECDH } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** One server identity for Web Push. This file must stay outside publication. */
export async function generateBrowserPush(output, subject) {
  const url = new URL(subject);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !url.hostname.includes('.') ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost')
  )
    throw Error('Use the public HTTPS application URL as the contact.');
  const key = createECDH('prime256v1');
  key.generateKeys();
  const text = [
    'CONCLAVE_SECOND_LOOK_PUSH_ENABLED=false',
    `CONCLAVE_PUSH_VAPID_SUBJECT=${url.href}`,
    `CONCLAVE_PUSH_VAPID_PUBLIC_KEY=${key.getPublicKey().toString('base64url')}`,
    `CONCLAVE_PUSH_VAPID_PRIVATE_KEY=${key.getPrivateKey().toString('base64url')}`,
    '',
  ].join('\n');
  const file = await open(resolve(output), 'wx', 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const [output, subject, ...extra] = process.argv.slice(2);
  if (!output || !subject || extra.length) {
    console.error(
      'Usage: node scripts/generate-browser-push.mjs PRIVATE_OUTPUT_FILE PUBLIC_HTTPS_URL',
    );
    process.exitCode = 1;
  } else {
    try {
      await generateBrowserPush(output, subject);
      console.log(
        'Created private browser-push configuration with mode 600. Delivery remains disabled until activation.',
      );
    } catch {
      console.error(
        'No configuration was replaced. Use a new private filename and a valid public HTTPS URL.',
      );
      process.exitCode = 1;
    }
  }
}
