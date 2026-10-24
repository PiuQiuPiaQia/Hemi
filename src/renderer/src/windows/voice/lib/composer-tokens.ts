/** Pure editor compatibility entry. */
export {
  isWordChar, INLINE_REFERENCE_KINDS, isInlineReference, tokenOfSkill, tokenOfReference,
  detectComposerToken, findSkillTokenRange, findReferenceTokenRange, tokenRangeInText,
  syncSkillsWithText, syncReferencesWithText, insertTagToken, deleteTagBackward,
  deleteTagForward, snapCaretToTagBoundary, segmentTaggedText, toExternalPlainText,
  uniqueTokenLabel, type ComposerTokenState, type TagDeletion, type TagSegment,
} from '@hemi/conversation-flow/core';
