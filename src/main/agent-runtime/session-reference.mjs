const referencePattern = /^(session|main)-[A-Za-z0-9_-]{1,100}$/;
export function isNativeSessionReference(value) {
  return value?.storage === 'pi' && value.version === 1 && typeof value.ref === 'string' && referencePattern.test(value.ref);
}
export function nativeSessionReference(ref) {
  if (typeof ref !== 'string' || !referencePattern.test(ref)) throw new Error('会话引用无效');
  return { storage: 'pi', version: 1, ref };
}
