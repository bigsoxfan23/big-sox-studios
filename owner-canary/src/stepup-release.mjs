// Only a separately reviewed source change may populate these. Never from HTTP/env.
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
export const FINAL_OWNER_CONFIRMATION = null;
