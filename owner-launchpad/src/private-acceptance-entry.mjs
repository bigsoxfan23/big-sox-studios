// Separate staging-only entrypoint. Production continues to use worker.mjs.
import {createWorker} from './worker.mjs';
import {createAcceptanceWorker} from '../../acceptance/worker.mjs';
export function createOwnerAcceptanceEntry(options={}) {
 return createAcceptanceWorker({...options,role:'owner',base:createWorker(options)});
}
export default createOwnerAcceptanceEntry();
