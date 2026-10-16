// Staging has no transport injection point. This simulator accepts data only.
const simulations = new WeakMap();
export function offlineDelivery({ outcome = 'sent', hold = false } = {}) {
 if (!['sent','failed','UNKNOWN','invalid','throw'].includes(outcome) || typeof hold !== 'boolean') throw Error('invalid_simulation');
 const handle = Object.freeze({});
 let release;
 const gate = hold ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
 simulations.set(handle, { outcome, gate, calls: 0 });
 return { handle, calls: () => simulations.get(handle).calls, release: () => release?.() };
}
export function stagingProvider(env, simulation) {
 if (env.SEND_MODE !== 'mock') throw new Error('staging_send_disabled');
 const state = simulation === undefined ? null : simulations.get(simulation);
 if (simulation !== undefined && !state) throw Error('staging_provider_denied');
 return async intent => {
  if (state) {
   state.calls++;
   await state.gate;
   if (state.outcome === 'throw') throw Error('synthetic_timeout');
   if (state.outcome === 'invalid') return {};
   if (state.outcome !== 'sent') return { status: state.outcome };
  }
  return { status: 'sent', id: `mock-${intent.id}` };
 };
}
