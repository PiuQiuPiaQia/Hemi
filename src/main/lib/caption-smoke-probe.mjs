// A status pill has no caption spans; [].every(...) must not mark it ready.
export function isVisibleCaptionSample(state, expectedText = null) {
  return state?.visible === 'true'
    && Array.isArray(state.lineOpacities)
    && state.lineOpacities.length > 0
    && state.lineOpacities.every(opacity => Number.isFinite(opacity) && opacity >= 0.9)
    && (expectedText === null || state.lines?.includes(expectedText) === true);
}
