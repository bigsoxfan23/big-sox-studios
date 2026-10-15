// This is the ONLY provider imported by the staging entry point.
export async function mockSend(intent) { return { status: 'sent', id: `mock-${intent.id}` }; }
export function stagingProvider(env) {
 if (env.SEND_MODE !== 'mock') throw new Error('staging_send_disabled');
 return mockSend;
}
