// Built from a string: inline U+2028/U+2029 are JS line terminators that break regex-literal parsing. Matches Unicode splitlines() boundaries so adversarial fstab inputs don't diverge in the EFI dedup pass.
const LINE_BOUNDARY_CLASS = '[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]';
const LINE_BOUNDARY_RE = new RegExp(`\\r\\n|${LINE_BOUNDARY_CLASS}`, 'g');
const LINE_BOUNDARY_END_RE = new RegExp(`(?:\\r\\n|${LINE_BOUNDARY_CLASS})$`);

function splitLines(text: string): string[] {
  const lines = text.split(LINE_BOUNDARY_RE);
  if (lines.length > 0 && lines[lines.length - 1] === '' && LINE_BOUNDARY_END_RE.test(text)) {
    lines.pop();
  }
  return lines;
}

export function cleanFstab(rawFstab: string): string {
  const cleanedLines: string[] = [];
  let efiSeen = false;

  for (const line of splitLines(rawFstab)) {
    const stripped = line.trim();

    if (stripped.startsWith('#') || stripped === '') {
      cleanedLines.push(line);
      continue;
    }

    const parts = line.split(/\s+/).filter((p) => p !== '');
    const mountPoint = parts[1];
    if (parts.length < 2 || mountPoint === undefined) {
      cleanedLines.push(line);
      continue;
    }

    if (mountPoint.startsWith('/boot/efi')) {
      const normalizedLine = line.replace(mountPoint, '/boot/efi');
      if (efiSeen) {
        cleanedLines.push(`# ${normalizedLine}`);
        continue;
      }
      efiSeen = true;
      cleanedLines.push(normalizedLine);
      continue;
    }

    cleanedLines.push(line);
  }

  return cleanedLines.join('\n') + '\n\n';
}
