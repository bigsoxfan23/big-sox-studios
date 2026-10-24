export const SERVICES = Object.freeze(['jellyfin','palworld','status']);
export function authorizeMember(member, service) {
 return Boolean(member && member.status === 'active' && ['owner','trusted','member'].includes(member.role) &&
  (service === undefined || (SERVICES.includes(service) && Array.isArray(member.grants) && member.grants.includes(service))));
}
export function mayManageMembers(member) {
 return authorizeMember(member) && member.role === 'owner';
}
