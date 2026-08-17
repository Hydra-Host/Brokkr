// second copy of apps/local-sim/scripts/local/derived.py managed_tag_for_slot (no runtime boundary
// between the two); slot 0 keeps the legacy value so pre-slotting domains still match.
export const managedTagForSlot = (slot: number): string => (slot === 0 ? 'brokkr-local' : `brokkr-local-s${slot}`);
