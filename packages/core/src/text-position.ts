export function assertCodeUnitBoundary(
  content: string,
  offset: number,
): void {
  if (offset < 0 || offset > content.length || !Number.isInteger(offset)) {
    throw new Error('Anchor selection is outside source content');
  }

  const previous = content.charCodeAt(offset - 1);
  const current = content.charCodeAt(offset);
  const splitsSurrogatePair =
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff;

  if (splitsSurrogatePair) {
    throw new Error('Anchor selection must align with a Unicode character boundary');
  }
}

export function codePointOffset(content: string, codeUnitOffset: number): number {
  assertCodeUnitBoundary(content, codeUnitOffset);
  return Array.from(content.slice(0, codeUnitOffset)).length;
}
