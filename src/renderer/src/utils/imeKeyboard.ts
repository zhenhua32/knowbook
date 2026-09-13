/** 229 is emitted by some IMEs even when isComposing is false. */
export function isImeKeyboardEvent(event: { isComposing?: boolean; keyCode?: number }, composing = false): boolean {
  return composing || event.isComposing === true || event.keyCode === 229
}
