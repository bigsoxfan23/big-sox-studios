// Separate staging-only entrypoint. No deployment configuration changed.
import {createApprovedOtpAssembly} from './approved-otp-assembly.mjs';
import {createAcceptanceWorker} from '../acceptance/worker.mjs';
export function createMemberAcceptanceEntry(options={}) {
 return createAcceptanceWorker({...options,role:'member',base:createApprovedOtpAssembly(options)});
}
export default createMemberAcceptanceEntry();
