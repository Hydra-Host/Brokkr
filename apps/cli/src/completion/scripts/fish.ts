export const FISH_SCRIPT = `# brokkr fish completion
function __brokkr_complete
  set -l tokens (commandline -opc)
  set -l partial (commandline -ct)
  # Drop the program name (first token) and append the partial (possibly empty) as the last word.
  set -e tokens[1]
  brokkr __complete -- $tokens $partial 2>/dev/null
end
complete -c brokkr -f -a "(__brokkr_complete)"
`;
