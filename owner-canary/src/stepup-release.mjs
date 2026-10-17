// Source-owned release constants. Never populated from HTTP or environment.
export const STEPUP_CONTRACT = 'application-webauthn-stepup-v1';
// Owner-confirmed public bootstrap bytes; evidence and full fingerprint: WEBAUTHN.md.
// This grants no message/send authority. No candidate lookup or runtime override.
export const PRODUCTION_CREDENTIAL_PIN = Object.freeze({
 credentialID: 'MANaCK7rJfDfUuXeSlx46S4ypCw',
 publicKey: 'pQECAyYgASFYINcxjXlys_igeNRhUyf9UKeHO_H1Vs3aak-7y7CzVdInIlggkRNP2BSEiVzRHn7DReQZzhdf88DJVrCEo_Ptk_qHdsE',
 algorithm: -7,
 rpID: 'canary.bigsoxstudios.com',
 origin: 'https://canary.bigsoxstudios.com',
 owner: '19e39702-51ab-52dc-9172-91bcb059ec5d',
 email: 'fridman.greg@gmail.com',
 epoch: 'owner-canary-webauthn-v1-20261016'
});
// Exact message-specific chat confirmation, including configuration/epoch binding.
export const FINAL_OWNER_CONFIRMATION = Object.freeze({
 envelopeDigest: '7ec49e8c8316385f3923f92380277d956ad847c20de5e6181fbbf455793d9880',
 configDigest: 'c5be1b5e09368b115cd7bc65ba5108577efc5bb9c2996aac7d68eaef4a21a4df',
 epoch: 'owner-canary-webauthn-v1-20261016'
});
// Chat consent authorizes this release; it supplies no WebAuthn proof.
export const OWNER_CONFIRMED_RELEASE = true;
export const CONFIRMED_CAMPAIGN_ID = '3ed38bbd-997c-4ce5-abad-e131b115ede4';
