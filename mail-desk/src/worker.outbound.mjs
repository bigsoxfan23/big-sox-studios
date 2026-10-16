// Future standalone HTTP candidate: no email/scheduler/asset handlers or config.
// Intentionally blocked pending independently verified ingress and Access MFA.
import { createProductionCandidate } from './outbound.candidate.mjs';
export default createProductionCandidate();
