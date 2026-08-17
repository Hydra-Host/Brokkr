export const BASH_SCRIPT = `# brokkr bash completion
_brokkr_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  # Build the args array with default IFS — array slicing misbehaves under IFS=$'\\n'.
  local -a _brokkr_input
  _brokkr_input=("\${COMP_WORDS[@]:1:COMP_CWORD}")
  local IFS=$'\\n'
  local _brokkr_candidates
  _brokkr_candidates=$(brokkr __complete -- "\${_brokkr_input[@]}" 2>/dev/null)
  COMPREPLY=($(compgen -W "$_brokkr_candidates" -- "$cur"))
}
complete -o default -F _brokkr_complete brokkr
`;
