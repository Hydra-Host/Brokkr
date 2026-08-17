export const ZSH_SCRIPT = `# brokkr zsh completion
_brokkr_complete() {
  # words[1] is the program name; skip it. words[CURRENT] is the partial.
  local -a input=("\${(@)words[2,CURRENT]}")
  local -a candidates=("\${(@f)$(brokkr __complete -- "\${input[@]}" 2>/dev/null)}")
  compadd -a candidates
}
compdef _brokkr_complete brokkr
`;
