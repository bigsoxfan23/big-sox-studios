// Pure authorization rules. Server-only use; no trust in client-provided roles.
export const ROLES = Object.freeze(['owner','trusted','member']);
export const SERVICES = Object.freeze(['jellyfin','palworld','status']);

export function authorizeMember(member, service) {
  if (!member || member.state !== 'active') return false;
  if (!SERVICES.includes(service)) return false;
  if (member.role === 'owner') return true;
  return Array.isArray(member.grants) && member.grants.includes(service);
}

export function mayManageMembers(member) {
  return Boolean(member && member.state === 'active' && member.role === 'owner');
}

export function resolveIdentity(identity, memberships) {
  if (!identity || !identity.provider || !identity.subject) return null;
  // Match the immutable (provider, subject) pair, never email alone.
  const match = memberships.find(m => m.provider === identity.provider && m.subject === identity.subject);
  return match?.member ?? null;
}
