export const cleanupFailure = message => Object.assign(new Error(message), {code:'cleanup-unconfirmed'});
export function commandDeadline(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {timer=setTimeout(()=>reject(cleanupFailure(message)), ms);})])
    .finally(()=>clearTimeout(timer));
}
