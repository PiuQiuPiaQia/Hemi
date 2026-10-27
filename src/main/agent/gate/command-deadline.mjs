export const cleanupFailure = message => Object.assign(new Error(message), {code:'cleanup-unconfirmed'});
const blocked = new WeakMap();
export function blockCommandCleanup(journal, error) {if(journal)blocked.set(journal,error);}
export function assertCommandCleanup(journal) {const error=blocked.get(journal);if(error)throw error;}
export function clearCommandCleanup(journal) {blocked.delete(journal);}
export function commandDeadline(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {timer=setTimeout(()=>reject(cleanupFailure(message)), ms);})])
    .finally(()=>clearTimeout(timer));
}
